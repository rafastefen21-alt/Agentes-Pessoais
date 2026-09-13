// Camada de banco. Dois backends com a mesma interface (todas as funções são async):
//   • Postgres (Supabase)  → quando DATABASE_URL está definida  (produção)
//   • SQLite (node:sqlite) → quando não está                     (uso local, sem instalar nada)
// O SQL é escrito no dialeto Postgres ($1, $2… / RETURNING / ON CONFLICT) e
// traduzido para o SQLite quando necessário.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

// ---------- esquema ----------
// {{ID}} e {{NOW}} são substituídos conforme o backend.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id {{ID}},
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  language TEXT NOT NULL DEFAULT 'pt-BR',
  instance_name TEXT UNIQUE,
  wa_state TEXT NOT NULL DEFAULT 'disconnected',
  wa_qr TEXT,
  wa_qr_at BIGINT,
  assistant_instance_name TEXT UNIQUE,
  assistant_state TEXT NOT NULL DEFAULT 'disconnected',
  assistant_qr TEXT,
  assistant_qr_at BIGINT,
  assistant_phone TEXT DEFAULT '',
  login_email TEXT,
  login_pass TEXT,
  style_profile TEXT,
  profile_updated_at BIGINT,
  profile_status TEXT DEFAULT '',
  notify_mode TEXT NOT NULL DEFAULT 'assistant',
  ignore_groups INTEGER NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  imap_host TEXT, imap_port INTEGER DEFAULT 993, imap_user TEXT, imap_pass TEXT,
  imap_folder TEXT DEFAULT 'INBOX',
  imap_last_uid BIGINT DEFAULT 0,
  imap_uidvalidity BIGINT DEFAULT 0,
  email_status TEXT DEFAULT '',
  calendar_ics_url TEXT,
  calendar_status TEXT DEFAULT '',
  digest_times TEXT NOT NULL DEFAULT '08:00,13:00,18:00',
  quiet_start TEXT DEFAULT '22:00',
  quiet_end TEXT DEFAULT '07:00',
  urgent_threshold INTEGER NOT NULL DEFAULT 3,
  context_notes TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS messages (
  id {{ID}},
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_id TEXT,
  chat_id TEXT NOT NULL,
  sender_name TEXT, sender_id TEXT,
  direction TEXT NOT NULL,
  subject TEXT,
  text TEXT NOT NULL,
  ts BIGINT NOT NULL,
  triaged INTEGER NOT NULL DEFAULT 0,
  UNIQUE(person_id, channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_person_ts ON messages(person_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(person_id, chat_id, ts);

CREATE TABLE IF NOT EXISTS items (
  id {{ID}},
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  contact_name TEXT,
  urgency INTEGER NOT NULL,
  category TEXT,
  summary TEXT NOT NULL,
  needs_reply INTEGER NOT NULL DEFAULT 0,
  suggested_reply TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  notified_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT {{NOW}},
  last_message_ts BIGINT,
  owner TEXT NOT NULL DEFAULT 'contact',
  due_ts BIGINT,
  reminded_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_items_person_status ON items(person_id, status);

CREATE TABLE IF NOT EXISTS alerts (
  id {{ID}},
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  external_id TEXT,
  created_at BIGINT NOT NULL DEFAULT {{NOW}}
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id {{ID}},
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  uid TEXT, summary TEXT, location TEXT, description TEXT,
  start_ts BIGINT NOT NULL, end_ts BIGINT,
  all_day INTEGER DEFAULT 0,
  UNIQUE(person_id, uid, start_ts)
);

CREATE TABLE IF NOT EXISTS api_usage (
  id {{ID}},
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX IF NOT EXISTS idx_usage_person ON api_usage(person_id, created_at);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY, v TEXT
);
`;

// No Supabase, tabelas sem RLS ficam expostas pela API pública (anon key).
// Ligamos o RLS sem políticas: só a conexão direta (este servidor) acessa.
const PG_SECURITY = ['people', 'messages', 'items', 'alerts', 'calendar_events', 'api_usage', 'kv']
  .map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`).join('\n');

// Colunas adicionadas depois da primeira versão (bancos já criados recebem via ALTER TABLE)
const MIGRATIONS = [
  'ALTER TABLE people ADD COLUMN assistant_instance_name TEXT',
  "ALTER TABLE people ADD COLUMN assistant_state TEXT NOT NULL DEFAULT 'disconnected'",
  'ALTER TABLE people ADD COLUMN assistant_qr TEXT',
  'ALTER TABLE people ADD COLUMN assistant_qr_at BIGINT',
  "ALTER TABLE people ADD COLUMN assistant_phone TEXT DEFAULT ''",
  'ALTER TABLE people ADD COLUMN login_email TEXT',
  'ALTER TABLE people ADD COLUMN login_pass TEXT',
  'ALTER TABLE people ADD COLUMN style_profile TEXT',
  'ALTER TABLE people ADD COLUMN profile_updated_at BIGINT',
  "ALTER TABLE people ADD COLUMN profile_status TEXT DEFAULT ''",
  "ALTER TABLE items ADD COLUMN owner TEXT NOT NULL DEFAULT 'contact'",
  'ALTER TABLE items ADD COLUMN due_ts BIGINT',
  'ALTER TABLE items ADD COLUMN reminded_at BIGINT',
];
const isDuplicateColumn = (e) => /duplicate column|already exists/i.test(String(e.message));

export function schemaSql(dialect = 'postgres') {
  const isPg = dialect === 'postgres';
  const sql = SCHEMA
    .replaceAll('{{ID}}', isPg ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT')
    .replaceAll('{{NOW}}', isPg ? 'EXTRACT(EPOCH FROM NOW())::BIGINT' : '(unixepoch())');
  return isPg ? sql + '\n' + PG_SECURITY : sql;
}

// ---------- backends ----------
let backend = null;
export let dialect = 'sqlite';

async function initPostgres() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 5,
  });
  pool.on('error', (e) => logger.error('Postgres pool', { err: String(e.message) }));
  // BIGINT (OID 20) vem como string por padrão → número
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  if (/\[YOUR-PASSWORD\]/i.test(config.databaseUrl)) {
    throw new Error('DATABASE_URL ainda contém [YOUR-PASSWORD]. Substitua pela senha do banco do Supabase.');
  }
  let client;
  try {
    client = await pool.connect();
  } catch (e) {
    if (e.code === '28P01') {
      throw new Error('Supabase recusou a senha do banco (28P01). Confira: (1) a senha em DATABASE_URL é a do banco (Project Settings → Database), não a da conta; '
        + '(2) se a senha tem caracteres como @ # % & / : ?, eles precisam ser codificados na URL (ex.: @ → %40) — ou redefina a senha só com letras e números em Database → Reset database password; '
        + '(3) na URL do pooler (porta 6543) o usuário é "postgres.<ref-do-projeto>", não apenas "postgres".');
    }
    if (e.code === 'ENOTFOUND' || e.code === 'ENETUNREACH' || e.code === 'ECONNREFUSED') {
      throw new Error(`Não foi possível alcançar o Postgres (${e.code}). No Railway use a URL do Transaction pooler (porta 6543), que funciona sem IPv6.`);
    }
    throw e;
  }
  try {
    for (const stmt of schemaSql('postgres').split(';').map((s) => s.trim()).filter(Boolean)) {
      try { await client.query(stmt); } catch (e) {
        // RLS já ligado ou sem permissão: não é fatal
        if (!/row level security|permission denied/i.test(e.message)) throw e;
      }
    }
    for (const stmt of MIGRATIONS) {
      try { await client.query(stmt); } catch (e) { if (!isDuplicateColumn(e)) throw e; }
    }
  } finally { client.release(); }
  return {
    all: async (sql, params = []) => (await pool.query(sql, params)).rows,
    get: async (sql, params = []) => (await pool.query(sql, params)).rows[0],
    run: async (sql, params = []) => { const r = await pool.query(sql, params); return { changes: r.rowCount, row: r.rows[0] }; },
    close: () => pool.end(),
  };
}

async function initSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(config.dataDir, 'assistente.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schemaSql('sqlite'));
  for (const stmt of MIGRATIONS) {
    try { db.exec(stmt); } catch (e) { if (!isDuplicateColumn(e)) throw e; }
  }
  const tr = (sql) => sql.replace(/\$\d+/g, '?');
  return {
    all: async (sql, params = []) => db.prepare(tr(sql)).all(...params),
    get: async (sql, params = []) => db.prepare(tr(sql)).get(...params),
    run: async (sql, params = []) => {
      const st = db.prepare(tr(sql));
      if (/RETURNING/i.test(sql)) { const row = st.get(...params); return { changes: row ? 1 : 0, row }; }
      const r = st.run(...params); return { changes: Number(r.changes), row: undefined };
    },
    close: () => db.close(),
  };
}

/** Inicializa o banco (chamar uma vez antes de subir o servidor). */
export async function init() {
  if (backend) return backend;
  if (config.databaseUrl) {
    dialect = 'postgres';
    backend = await initPostgres();
    logger.info('Banco: Postgres (Supabase)');
  } else {
    dialect = 'sqlite';
    backend = await initSqlite();
    logger.info('Banco: SQLite local', { file: path.join(config.dataDir, 'assistente.db') });
  }
  return backend;
}
const all = (sql, p) => backend.all(sql, p);
const get = (sql, p) => backend.get(sql, p);
const run = (sql, p) => backend.run(sql, p);
export const close = () => backend?.close();

// ---------- kv ----------
export async function kvGet(k) {
  const r = await get('SELECT v FROM kv WHERE k = $1', [k]);
  return r ? r.v : null;
}
export async function kvSet(k, v) {
  await run('INSERT INTO kv(k, v) VALUES($1, $2) ON CONFLICT(k) DO UPDATE SET v = EXCLUDED.v', [k, v]);
}

// ---------- pessoas ----------
const PERSON_COLS = [
  'name', 'phone', 'timezone', 'language', 'instance_name', 'notify_mode', 'ignore_groups',
  'email_enabled', 'imap_host', 'imap_port', 'imap_user', 'imap_pass', 'imap_folder',
  'calendar_ics_url', 'digest_times', 'quiet_start', 'quiet_end', 'urgent_threshold',
  'context_notes', 'active',
];

export function listPeople() {
  return all('SELECT * FROM people ORDER BY id');
}
export function getPerson(id) {
  return get('SELECT * FROM people WHERE id = $1', [id]);
}
export function getPersonByLoginEmail(email) {
  return get('SELECT * FROM people WHERE LOWER(login_email) = LOWER($1)', [email]);
}
/** Acha a pessoa por qualquer uma das duas instâncias (a dela ou a da assistente). */
export function getPersonByInstance(instance) {
  return get('SELECT * FROM people WHERE instance_name = $1 OR assistant_instance_name = $2', [instance, instance]);
}
export async function insertPerson(data) {
  const cols = PERSON_COLS.filter((c) => data[c] !== undefined);
  const sql = `INSERT INTO people(${cols.join(',')}) VALUES(${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`;
  const r = await run(sql, cols.map((c) => data[c]));
  return getPerson(r.row.id);
}
export async function updatePerson(id, data) {
  const cols = PERSON_COLS.filter((c) => data[c] !== undefined);
  if (!cols.length) return getPerson(id);
  const sql = `UPDATE people SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`;
  await run(sql, [...cols.map((c) => data[c]), id]);
  return getPerson(id);
}
export async function setPersonFields(id, fields) {
  // Campos internos (estado, QR, etc.) — sem whitelist do formulário
  const cols = Object.keys(fields);
  if (!cols.length) return;
  await run(`UPDATE people SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = $${cols.length + 1}`,
    [...cols.map((c) => fields[c]), id]);
}
export async function deletePerson(id) {
  await run('DELETE FROM people WHERE id = $1', [id]);
}

// ---------- mensagens ----------
export async function insertMessage(m) {
  const r = await run(`INSERT INTO messages
    (person_id, channel, external_id, chat_id, sender_name, sender_id, direction, subject, text, ts)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`, [
    m.person_id, m.channel, m.external_id || null, m.chat_id, m.sender_name || null,
    m.sender_id || null, m.direction, m.subject || null, m.text, m.ts,
  ]);
  return r.row ? r.row.id : null;
}
export async function recentChatMessages(personId, chatId, limit = 30) {
  const rows = await all(`SELECT * FROM messages WHERE person_id = $1 AND chat_id = $2 ORDER BY ts DESC LIMIT $3`, [personId, chatId, limit]);
  return rows.reverse();
}
export function untriagedMessages(personId, chatId) {
  return all(`SELECT * FROM messages WHERE person_id = $1 AND chat_id = $2 AND triaged = 0 AND direction = 'in' ORDER BY ts`, [personId, chatId]);
}
export async function markTriaged(ids) {
  if (!ids.length) return;
  await run(`UPDATE messages SET triaged = 1 WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`, ids);
}
export function recentMessages(personId, limit = 50) {
  return all('SELECT * FROM messages WHERE person_id = $1 ORDER BY ts DESC LIMIT $2', [personId, limit]);
}
export function messagesSince(personId, sinceTs) {
  return all('SELECT * FROM messages WHERE person_id = $1 AND ts >= $2 ORDER BY ts', [personId, sinceTs]);
}

/** Amostra das mensagens mais recentes de uma direção (para aprender o estilo). */
export function sampleMessages(personId, direction, limit = 200) {
  return all(`SELECT chat_id, sender_name, text, ts FROM messages WHERE person_id = $1 AND direction = $2 AND channel = 'whatsapp'
    AND LENGTH(text) > 1 ORDER BY ts DESC LIMIT $3`, [personId, direction, limit]);
}
/** Contatos com mais mensagens trocadas. */
export async function topContacts(personId, limit = 25) {
  const rows = await all(`SELECT chat_id, MAX(CASE WHEN direction = 'in' THEN sender_name END) AS name,
      SUM(CASE WHEN direction = 'in' THEN 1 ELSE 0 END) AS received, SUM(CASE WHEN direction = 'out' THEN 1 ELSE 0 END) AS sent, MAX(ts) AS last_ts
    FROM messages WHERE person_id = $1 AND channel = 'whatsapp' GROUP BY chat_id ORDER BY (received + sent) DESC LIMIT $2`, [personId, limit]);
  return rows.map((r) => ({ ...r, received: Number(r.received), sent: Number(r.sent) }));
}

// ---------- pendências ----------
export async function upsertItem(it) {
  // Um item aberto por conversa: se já existir, atualiza
  const existing = await get(`SELECT id FROM items WHERE person_id = $1 AND channel = $2 AND chat_id = $3
    AND status IN ('open','notified') ORDER BY id DESC LIMIT 1`, [it.person_id, it.channel, it.chat_id]);
  if (existing) {
    await run(`UPDATE items SET contact_name = $1, urgency = $2, category = $3, summary = $4, needs_reply = $5,
      suggested_reply = $6, deadline = $7, last_message_ts = $8, status = 'open' WHERE id = $9`, [
      it.contact_name, it.urgency, it.category, it.summary, it.needs_reply ? 1 : 0,
      it.suggested_reply || null, it.deadline || null, it.last_message_ts, existing.id]);
    return existing.id;
  }
  const r = await run(`INSERT INTO items (person_id, channel, chat_id, contact_name, urgency, category, summary,
    needs_reply, suggested_reply, deadline, last_message_ts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [
    it.person_id, it.channel, it.chat_id, it.contact_name, it.urgency, it.category, it.summary,
    it.needs_reply ? 1 : 0, it.suggested_reply || null, it.deadline || null, it.last_message_ts]);
  return r.row.id;
}
/** Compromisso assumido pela própria pessoa (owner = 'me'). Evita duplicar a mesma descrição na mesma conversa. */
export async function insertCommitment(c) {
  const dup = await get(`SELECT id FROM items WHERE person_id = $1 AND chat_id = $2 AND owner = 'me' AND status IN ('open','notified') AND LOWER(summary) = LOWER($3)`,
    [c.person_id, c.chat_id, c.summary]);
  if (dup) { await run('UPDATE items SET due_ts = COALESCE($1, due_ts), deadline = COALESCE($2, deadline), last_message_ts = $3 WHERE id = $4', [c.due_ts || null, c.deadline || null, c.last_message_ts, dup.id]); return dup.id; }
  const r = await run(`INSERT INTO items (person_id, channel, chat_id, contact_name, urgency, category, summary, needs_reply, suggested_reply, deadline, last_message_ts, owner, due_ts)
    VALUES ($1,$2,$3,$4,$5,$6,$7,0,NULL,$8,$9,'me',$10) RETURNING id`,
    [c.person_id, c.channel, c.chat_id, c.contact_name, c.urgency || 2, 'compromisso', c.summary, c.deadline || null, c.last_message_ts, c.due_ts || null]);
  return r.row.id;
}
/** Compromissos da pessoa com vencimento até `untilTs` que ainda não foram lembrados. */
export function dueCommitments(personId, untilTs) {
  return all(`SELECT * FROM items WHERE person_id = $1 AND owner = 'me' AND status IN ('open','notified') AND due_ts IS NOT NULL
    AND due_ts <= $2 AND reminded_at IS NULL ORDER BY due_ts`, [personId, untilTs]);
}
export async function markReminded(id) {
  await run('UPDATE items SET reminded_at = $1, status = $2 WHERE id = $3', [Math.floor(Date.now() / 1000), 'notified', id]);
}
/** Conversas recentes com nome e última mensagem (para a pessoa pedir "resume a conversa com X"). */
export async function recentChats(personId, limit = 40) {
  const rows = await all(`SELECT chat_id, MAX(CASE WHEN direction = 'in' THEN sender_name END) AS name, MAX(ts) AS last_ts, COUNT(*) AS n
    FROM messages WHERE person_id = $1 AND channel = 'whatsapp' GROUP BY chat_id ORDER BY last_ts DESC LIMIT $2`, [personId, limit]);
  const out = [];
  for (const r of rows) {
    const last = await get('SELECT text, direction FROM messages WHERE person_id = $1 AND chat_id = $2 ORDER BY ts DESC LIMIT 1', [personId, r.chat_id]);
    out.push({ ...r, n: Number(r.n), last_text: last ? last.text.slice(0, 80) : '' });
  }
  return out;
}
export function getItem(id) {
  return get('SELECT * FROM items WHERE id = $1', [id]);
}
export function openItems(personId) {
  return all(`SELECT * FROM items WHERE person_id = $1 AND status IN ('open','notified') ORDER BY urgency DESC, last_message_ts DESC`, [personId]);
}
export function listItems(personId, limit = 100) {
  return all('SELECT * FROM items WHERE person_id = $1 ORDER BY id DESC LIMIT $2', [personId, limit]);
}
export async function setItemStatus(id, status, extra = {}) {
  const cols = Object.keys(extra);
  await run(`UPDATE items SET status = $1${cols.map((c, i) => `, ${c} = $${i + 2}`).join('')} WHERE id = $${cols.length + 2}`,
    [status, ...cols.map((c) => extra[c]), id]);
}
export async function resolveItemsForChat(personId, channel, chatId, status = 'replied') {
  await run(`UPDATE items SET status = $1 WHERE person_id = $2 AND channel = $3 AND chat_id = $4 AND status IN ('open','notified')`,
    [status, personId, channel, chatId]);
}

// ---------- alertas (conversa com a assistente) ----------
export async function insertAlert(personId, kind, text, externalId = null) {
  const r = await run('INSERT INTO alerts (person_id, kind, text, external_id) VALUES ($1,$2,$3,$4) RETURNING id', [personId, kind, text, externalId]);
  return r.row.id;
}
export async function recentAlerts(personId, limit = 30) {
  const rows = await all('SELECT * FROM alerts WHERE person_id = $1 ORDER BY id DESC LIMIT $2', [personId, limit]);
  return rows.reverse();
}
export async function alertExternalIdExists(personId, externalId) {
  if (!externalId) return false;
  return Boolean(await get('SELECT 1 AS x FROM alerts WHERE person_id = $1 AND external_id = $2', [personId, externalId]));
}

// ---------- agenda ----------
export async function replaceCalendarEvents(personId, events) {
  await run('DELETE FROM calendar_events WHERE person_id = $1', [personId]);
  for (const e of events) {
    await run(`INSERT INTO calendar_events (person_id, uid, summary, location, description, start_ts, end_ts, all_day)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [personId, e.uid, e.summary, e.location, e.description, e.start_ts, e.end_ts, e.all_day ? 1 : 0]);
  }
}
export function calendarEventsBetween(personId, fromTs, toTs) {
  return all(`SELECT * FROM calendar_events WHERE person_id = $1 AND start_ts < $2 AND COALESCE(end_ts, start_ts) >= $3 ORDER BY start_ts`,
    [personId, toTs, fromTs]);
}

// ---------- consultas por período (relatório mensal / área do cliente) ----------
export async function itemsBetween(personId, fromTs, toTs, limit = 200) {
  return all(`SELECT * FROM items WHERE person_id = $1 AND created_at >= $2 AND created_at < $3
    ORDER BY urgency DESC, created_at DESC LIMIT $4`, [personId, fromTs, toTs, limit]);
}
export async function periodStats(personId, fromTs, toTs) {
  const msgs = await all(`SELECT channel, COUNT(*) AS c FROM messages WHERE person_id = $1 AND ts >= $2 AND ts < $3 AND direction = 'in' GROUP BY channel`, [personId, fromTs, toTs]);
  const contacts = await get(`SELECT COUNT(DISTINCT chat_id) AS c FROM messages WHERE person_id = $1 AND ts >= $2 AND ts < $3 AND direction = 'in'`, [personId, fromTs, toTs]);
  const items = await all(`SELECT status, COUNT(*) AS c FROM items WHERE person_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY status`, [personId, fromTs, toTs]);
  const urgent = await get(`SELECT COUNT(*) AS c FROM items WHERE person_id = $1 AND created_at >= $2 AND created_at < $3 AND urgency >= 3`, [personId, fromTs, toTs]);
  const alerts = await all(`SELECT kind, COUNT(*) AS c FROM alerts WHERE person_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY kind`, [personId, fromTs, toTs]);
  const n = (v) => Number(v || 0);
  return {
    messages: Object.fromEntries(msgs.map((m) => [m.channel, n(m.c)])),
    contacts: n(contacts?.c),
    items: Object.fromEntries(items.map((i) => [i.status, n(i.c)])),
    itemsTotal: items.reduce((a, i) => a + n(i.c), 0),
    urgent: n(urgent?.c),
    alerts: Object.fromEntries(alerts.map((a) => [a.kind, n(a.c)])),
  };
}

// ---------- uso da API (custos) ----------
export async function insertUsage(u) {
  await run(`INSERT INTO api_usage (person_id, kind, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
    u.person_id ?? null, u.kind, u.model || null, u.input_tokens || 0, u.output_tokens || 0,
    u.cache_read_tokens || 0, u.cache_write_tokens || 0, u.cost_usd || 0, Math.floor(Date.now() / 1000)]);
}
const USAGE_SUMS = `COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens, COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens, COALESCE(SUM(cost_usd),0) AS cost_usd`;
// O Postgres devolve SUM/COUNT como string → número
const numify = (r) => Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [k, typeof v === 'string' && /^[0-9.]+$/.test(v) ? Number(v) : v]));
/** Totais de uso. personId null = todas as pessoas. */
export async function usageSummary(personId, sinceTs = 0) {
  const r = personId
    ? await get(`SELECT ${USAGE_SUMS} FROM api_usage WHERE person_id = $1 AND created_at >= $2`, [personId, sinceTs])
    : await get(`SELECT ${USAGE_SUMS} FROM api_usage WHERE created_at >= $1`, [sinceTs]);
  return numify(r);
}
export async function usageByKind(personId, sinceTs = 0) {
  const rows = await all(`SELECT kind, ${USAGE_SUMS} FROM api_usage WHERE person_id = $1 AND created_at >= $2 GROUP BY kind ORDER BY kind`, [personId, sinceTs]);
  return rows.map(numify);
}
export async function usageByPerson(sinceTs = 0) {
  const rows = await all(`SELECT person_id, ${USAGE_SUMS} FROM api_usage WHERE created_at >= $1 GROUP BY person_id ORDER BY cost_usd DESC`, [sinceTs]);
  return rows.map(numify);
}
export async function usageDaily(personId, sinceTs = 0) {
  const day = dialect === 'postgres' ? "to_char(to_timestamp(created_at), 'YYYY-MM-DD')" : "date(created_at, 'unixepoch')";
  const rows = await all(`SELECT ${day} AS day, ${USAGE_SUMS} FROM api_usage WHERE person_id = $1 AND created_at >= $2 GROUP BY ${day} ORDER BY day DESC`, [personId, sinceTs]);
  return rows.map(numify);
}

// ---------- estatísticas ----------
export async function stats(personId) {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const msgs = await all(`SELECT channel, COUNT(*) AS c FROM messages WHERE person_id = $1 AND ts >= $2 AND direction = 'in' GROUP BY channel`, [personId, since]);
  const open = await get(`SELECT COUNT(*) AS c FROM items WHERE person_id = $1 AND status IN ('open','notified')`, [personId]);
  const urgent = await get(`SELECT COUNT(*) AS c FROM items WHERE person_id = $1 AND status IN ('open','notified') AND urgency >= 3`, [personId]);
  const lastMsg = await get('SELECT MAX(ts) AS t FROM messages WHERE person_id = $1', [personId]);
  return {
    last24h: Object.fromEntries(msgs.map((m) => [m.channel, Number(m.c)])),
    openItems: Number(open.c), urgentItems: Number(urgent.c), lastMessageTs: lastMsg.t,
  };
}
