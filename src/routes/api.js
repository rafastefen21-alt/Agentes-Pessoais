// API JSON usada pelo portal (protegida por sessão de admin).
import { Router } from 'express';
import { config, validateConfig } from '../config.js';
import { logger } from '../logger.js';
import * as db from '../db.js';
import * as evo from '../evolution.js';
import * as email from '../email.js';
import { encrypt } from '../crypto.js';
import { syncCalendar, upcomingEvents } from '../calendar.js';
import { claudeConfigured } from '../ai/claude.js';
import { notifyPerson, sendDigest, pollEmail } from '../agent.js';
import { lastEvents } from './webhooks.js';

export const api = Router();

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  logger.error('Erro na API', { path: req.path, err: String(e.message) });
  res.status(e.status && e.status >= 400 && e.status < 600 ? 502 : 500).json({ ok: false, error: String(e.message) });
});

function slug(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'pessoa';
}
function publicPerson(p) {
  if (!p) return p;
  const { imap_pass, wa_qr, ...rest } = p;
  return { ...rest, has_imap_pass: Boolean(imap_pass), has_qr: Boolean(wa_qr) };
}
async function loadPerson(req, res) {
  const p = await db.getPerson(Number(req.params.id));
  if (!p) { res.status(404).json({ ok: false, error: 'Pessoa não encontrada' }); return null; }
  return p;
}

// ---------- custos ----------
const DAY = 86400;
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); }
function startOfMonth() { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); }
async function usageBlock(personId) {
  const now = Math.floor(Date.now() / 1000);
  return {
    today: await db.usageSummary(personId, startOfToday()),
    last7d: await db.usageSummary(personId, now - 7 * DAY),
    month: await db.usageSummary(personId, startOfMonth()),
    last30d: await db.usageSummary(personId, now - 30 * DAY),
    total: await db.usageSummary(personId, 0),
  };
}
api.get('/usage', wrap(async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  const people = Object.fromEntries((await db.listPeople()).map((p) => [p.id, p.name]));
  const label = (r) => ({ ...r, name: people[r.person_id] || '(pessoa excluída)' });
  res.json({
    ok: true, usdBrl: config.claude.usdBrl,
    month: (await db.usageByPerson(startOfMonth())).map(label),
    last30d: (await db.usageByPerson(now - 30 * DAY)).map(label),
    totals: await usageBlock(null),
  });
}));
api.get('/people/:id/usage', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const now = Math.floor(Date.now() / 1000);
  res.json({
    ok: true, usdBrl: config.claude.usdBrl,
    ...(await usageBlock(p.id)),
    byKind30d: await db.usageByKind(p.id, now - 30 * DAY),
    daily: await db.usageDaily(p.id, now - 30 * DAY),
  });
}));

// ---------- status geral ----------
api.get('/status', wrap(async (req, res) => {
  let evolution = { ok: false };
  if (evo.configured()) {
    try { evolution = await evo.ping(); } catch (e) { evolution = { ok: false, error: String(e.message) }; }
  }
  res.json({
    ok: true,
    appUrl: config.appUrl,
    database: db.dialect,
    evolution: { configured: evo.configured(), url: config.evolution.url, ...evolution, assistantInstance: config.evolution.assistantInstance },
    claude: { configured: claudeConfigured(), model: config.claude.model },
    problems: validateConfig(),
    lastEvents: lastEvents.slice(0, 20),
  });
}));

api.get('/email-presets', (req, res) => res.json({ ok: true, presets: email.IMAP_PRESETS }));

// ---------- pessoas ----------
api.get('/people', wrap(async (req, res) => {
  const people = [];
  const month = startOfMonth();
  for (const p of await db.listPeople()) people.push({ ...publicPerson(p), stats: await db.stats(p.id), usage_month: await db.usageSummary(p.id, month) });
  res.json({ ok: true, people, usdBrl: config.claude.usdBrl });
}));

api.post('/people', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ ok: false, error: 'Nome é obrigatório' });
  const phone = String(b.phone || '').replace(/\D/g, '');
  const person = await db.insertPerson({
    name: String(b.name).trim(), phone, timezone: b.timezone || 'America/Sao_Paulo',
    context_notes: b.context_notes || '', ignore_groups: b.ignore_groups === false ? 0 : 1,
    notify_mode: b.notify_mode === 'assistant' ? 'assistant' : 'self',
  });
  const instance = `${config.evolution.instancePrefix}-${slug(person.name)}-${person.id}`;
  await db.setPersonFields(person.id, { instance_name: instance });
  res.json({ ok: true, person: publicPerson(await db.getPerson(person.id)) });
}));

api.get('/people/:id', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  res.json({
    ok: true,
    person: publicPerson(p),
    stats: await db.stats(p.id),
    items: await db.listItems(p.id, 60),
    alerts: await db.recentAlerts(p.id, 40),
    messages: await db.recentMessages(p.id, 60),
    calendar: await upcomingEvents(p.id, 7),
  });
}));

api.put('/people/:id', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const b = req.body || {};
  const data = {};
  for (const k of ['name', 'timezone', 'language', 'notify_mode', 'imap_host', 'imap_user', 'imap_folder', 'calendar_ics_url', 'digest_times', 'quiet_start', 'quiet_end', 'context_notes']) {
    if (b[k] !== undefined) data[k] = b[k] === null ? null : String(b[k]).trim();
  }
  if (b.phone !== undefined) data.phone = String(b.phone).replace(/\D/g, '');
  if (b.imap_port !== undefined) data.imap_port = Number(b.imap_port) || 993;
  if (b.urgent_threshold !== undefined) data.urgent_threshold = Math.min(4, Math.max(1, Number(b.urgent_threshold) || 3));
  for (const k of ['ignore_groups', 'email_enabled', 'active']) if (b[k] !== undefined) data[k] = b[k] ? 1 : 0;
  if (b.imap_pass) data.imap_pass = encrypt(String(b.imap_pass));
  const credsChanged = (data.imap_host !== undefined && data.imap_host !== p.imap_host)
    || (data.imap_user !== undefined && data.imap_user !== p.imap_user) || Boolean(b.imap_pass);
  if (credsChanged) await db.setPersonFields(p.id, { imap_uidvalidity: 0, imap_last_uid: 0 }); // recomeça do ponto atual
  const updated = await db.updatePerson(p.id, data);
  res.json({ ok: true, person: publicPerson(updated) });
}));

api.delete('/people/:id', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  if (p.instance_name && evo.configured()) {
    try { await evo.deleteInstance(p.instance_name); } catch (e) { logger.warn('Não foi possível apagar instância', { err: String(e.message) }); }
  }
  await db.deletePerson(p.id);
  res.json({ ok: true });
}));

// ---------- WhatsApp ----------
api.post('/people/:id/whatsapp/connect', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  if (!config.appUrl) return res.status(400).json({ ok: false, error: 'Defina APP_URL no .env (URL pública deste servidor) antes de conectar.' });
  const instance = p.instance_name;
  let state = null;
  try { state = await evo.connectionState(instance); } catch (e) { if (e.status !== 404) throw e; }
  let qr = null;
  if (!state || state === 'unknown') {
    const created = await evo.createInstance(instance);
    qr = created?.qrcode?.base64 || created?.base64 || null;
    state = 'connecting';
  } else if (state === 'open') {
    await db.setPersonFields(p.id, { wa_state: 'open', wa_qr: null });
    return res.json({ ok: true, state: 'open' });
  } else {
    // garante que o webhook aponta para cá (caso APP_URL tenha mudado)
    try { await evo.setWebhook(instance); } catch (e) { logger.warn('setWebhook falhou', { err: String(e.message) }); }
  }
  if (!qr) {
    try { const c = await evo.connect(instance); qr = c.base64; } catch (e) { logger.warn('connect falhou', { err: String(e.message) }); }
  }
  await db.setPersonFields(p.id, { wa_state: state, ...(qr ? { wa_qr: qr, wa_qr_at: Math.floor(Date.now() / 1000) } : {}) });
  res.json({ ok: true, state, qr: qr || (await db.getPerson(p.id)).wa_qr });
}));

api.get('/people/:id/whatsapp/status', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  let state = p.wa_state;
  if (evo.configured() && p.instance_name) {
    try { state = await evo.connectionState(p.instance_name); } catch (e) { state = e.status === 404 ? 'missing' : state; }
  }
  let qr = p.wa_qr;
  if (state === 'open') qr = null;
  else if (evo.configured() && (!qr || (p.wa_qr_at && Date.now() / 1000 - p.wa_qr_at > 40))) {
    // QR expira em ~40s: pede um novo
    try {
      const c = await evo.connect(p.instance_name);
      if (c.base64) { qr = c.base64; await db.setPersonFields(p.id, { wa_qr: qr, wa_qr_at: Math.floor(Date.now() / 1000) }); }
    } catch { /* ignora */ }
  }
  if (state !== p.wa_state) await db.setPersonFields(p.id, { wa_state: state });
  if (state === 'open' && (!p.phone || p.phone.length < 8)) {
    const num = await evo.fetchProfileNumber(p.instance_name);
    if (num) await db.setPersonFields(p.id, { phone: num });
  }
  res.json({ ok: true, state, qr, phone: (await db.getPerson(p.id)).phone });
}));

api.post('/people/:id/whatsapp/logout', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  try { await evo.logout(p.instance_name); } catch (e) { if (e.status !== 404) throw e; }
  await db.setPersonFields(p.id, { wa_state: 'close', wa_qr: null });
  res.json({ ok: true });
}));

api.post('/people/:id/whatsapp/reset', wrap(async (req, res) => {
  // Apaga a instância na Evolution e recria na próxima conexão
  const p = await loadPerson(req, res); if (!p) return;
  try { await evo.deleteInstance(p.instance_name); } catch (e) { if (e.status !== 404) throw e; }
  await db.setPersonFields(p.id, { wa_state: 'disconnected', wa_qr: null });
  res.json({ ok: true });
}));

api.get('/people/:id/whatsapp/webhook', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const info = await evo.findWebhook(p.instance_name);
  res.json({ ok: true, expected: evo.webhookUrl(p.instance_name), info });
}));
api.post('/people/:id/whatsapp/webhook', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const r = await evo.setWebhook(p.instance_name);
  res.json({ ok: true, result: r });
}));

// ---------- e-mail ----------
api.post('/people/:id/email/test', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const r = await email.testConnection(p);
  await db.setPersonFields(p.id, { email_status: `ok (teste) ${new Date().toISOString()}` });
  res.json({ ok: true, ...r });
}));
api.post('/people/:id/email/poll', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  await pollEmail(p);
  res.json({ ok: true, status: (await db.getPerson(p.id)).email_status });
}));

// ---------- agenda ----------
api.post('/people/:id/calendar/sync', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const r = await syncCalendar(p);
  await db.setPersonFields(p.id, { calendar_status: `ok ${r.count} eventos ${new Date().toISOString()}` });
  res.json({ ok: true, ...r, events: await upcomingEvents(p.id, 7) });
}));

// ---------- ações do assistente ----------
api.post('/people/:id/digest', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const text = await sendDigest(p, { label: 'até agora' });
  res.json({ ok: true, text });
}));
api.post('/people/:id/notify', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const text = String(req.body?.text || '').trim() || `Olá, ${p.name.split(' ')[0]}! Sou sua assistente. Estou lendo suas mensagens e vou te avisar do que for importante. Mande *ajuda* para ver o que eu faço.`;
  const r = await notifyPerson(p, text, 'system');
  res.json({ ok: true, id: r.id });
}));
api.post('/people/:id/items/:itemId/status', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const it = await db.getItem(Number(req.params.itemId));
  if (!it || it.person_id !== p.id) return res.status(404).json({ ok: false, error: 'Item não encontrado' });
  const status = ['open', 'notified', 'replied', 'done', 'dismissed'].includes(req.body?.status) ? req.body.status : 'done';
  await db.setItemStatus(it.id, status);
  res.json({ ok: true });
}));
api.post('/people/:id/items/:itemId/send', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const it = await db.getItem(Number(req.params.itemId));
  if (!it || it.person_id !== p.id) return res.status(404).json({ ok: false, error: 'Item não encontrado' });
  if (it.channel !== 'whatsapp') return res.status(400).json({ ok: false, error: 'Só envio respostas de WhatsApp por aqui' });
  const text = String(req.body?.text || it.suggested_reply || '').trim();
  if (!text) return res.status(400).json({ ok: false, error: 'Sem texto' });
  const r = await evo.sendText(p.instance_name, it.chat_id, text);
  await db.insertMessage({ person_id: p.id, channel: 'whatsapp', external_id: r.id || `sent-${Date.now()}`, chat_id: it.chat_id, sender_name: p.name, sender_id: p.phone, direction: 'out', text, ts: Math.floor(Date.now() / 1000) });
  await db.setItemStatus(it.id, 'replied');
  res.json({ ok: true });
}));
