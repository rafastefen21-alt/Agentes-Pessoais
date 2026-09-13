// API JSON usada pelo portal (protegida por sessão de admin).
import { Router } from 'express';
import { config, validateConfig } from '../config.js';
import { logger } from '../logger.js';
import * as db from '../db.js';
import * as evo from '../evolution.js';
import * as email from '../email.js';
import { encrypt } from '../crypto.js';
import { hashPassword } from '../auth.js';
import { monthlySummary, regenerateMonthly } from '../monthly.js';
import { connectInstance, instanceStatus } from '../whatsapp.js';
import { learnProfile } from '../learn.js';
import { syncCalendar, upcomingEvents } from '../calendar.js';
import { claudeConfigured } from '../ai/claude.js';
import { notifyPerson, sendDigest, pollEmail, ROLES } from '../agent.js';
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
  const { imap_pass, wa_qr, assistant_qr, login_pass, ...rest } = p;
  return { ...rest, has_imap_pass: Boolean(imap_pass), has_qr: Boolean(wa_qr), has_assistant_qr: Boolean(assistant_qr), has_login: Boolean(login_pass) };
}
/** ?role=person (WhatsApp da pessoa) ou ?role=assistant (número da assistente). */
function roleOf(req) {
  return req.query.role === 'assistant' ? ROLES.assistant : ROLES.person;
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
    evolution: { configured: evo.configured(), url: config.evolution.url, ...evolution },
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
    notify_mode: b.notify_mode === 'self' ? 'self' : 'assistant',
  });
  const base = `${config.evolution.instancePrefix}-${slug(person.name)}-${person.id}`;
  await db.setPersonFields(person.id, { instance_name: base, assistant_instance_name: `${base}-bot` });
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
  if (evo.configured()) {
    for (const inst of [p.instance_name, p.assistant_instance_name].filter(Boolean)) {
      try { await evo.deleteInstance(inst); } catch (e) { logger.warn('Não foi possível apagar instância', { inst, err: String(e.message) }); }
    }
  }
  await db.deletePerson(p.id);
  res.json({ ok: true });
}));

// ---------- acesso do cliente à área "Minha assistente" ----------
api.put('/people/:id/client-access', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const b = req.body || {};
  const fields = {};
  if (b.login_email !== undefined) fields.login_email = String(b.login_email || '').trim().toLowerCase() || null;
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ ok: false, error: 'Senha muito curta (mínimo 6 caracteres)' });
    fields.login_pass = hashPassword(b.password);
  }
  if (b.revoke) { fields.login_pass = null; }
  if (fields.login_email) {
    const other = await db.getPersonByLoginEmail(fields.login_email);
    if (other && other.id !== p.id) return res.status(400).json({ ok: false, error: 'Este e-mail já está em uso por outra pessoa' });
  }
  await db.setPersonFields(p.id, fields);
  res.json({ ok: true, person: publicPerson(await db.getPerson(p.id)) });
}));

// ---------- perfil aprendido (estilo e contexto) ----------
api.get('/people/:id/profile', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  let profile = null; try { profile = p.style_profile ? JSON.parse(p.style_profile) : null; } catch { profile = null; }
  res.json({ ok: true, profile, status: p.profile_status || '', updated_at: p.profile_updated_at || null });
}));
api.post('/people/:id/profile/learn', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const profile = await learnProfile(p, { force: true });
  const fresh = await db.getPerson(p.id);
  res.json({ ok: true, profile, status: fresh.profile_status || '' });
}));

// ---------- relatório mensal (visão do admin) ----------
api.get('/people/:id/monthly', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  res.json({ ok: true, usdBrl: config.claude.usdBrl, ...(await monthlySummary(p, String(req.query.month || ''))) });
}));
api.post('/people/:id/monthly/regenerate', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  res.json({ ok: true, report: await regenerateMonthly(p, String(req.query.month || '')) });
}));

// ---------- WhatsApp ----------
api.post('/people/:id/whatsapp/connect', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  res.json({ ok: true, ...(await connectInstance(p, roleOf(req))) });
}));

api.get('/people/:id/whatsapp/status', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  res.json({ ok: true, ...(await instanceStatus(p, roleOf(req))) });
}));

api.post('/people/:id/whatsapp/logout', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const cols = roleOf(req);
  try { await evo.logout(p[cols.inst]); } catch (e) { if (e.status !== 404) throw e; }
  await db.setPersonFields(p.id, { [cols.state]: 'close', [cols.qr]: null });
  res.json({ ok: true });
}));

api.post('/people/:id/whatsapp/reset', wrap(async (req, res) => {
  // Apaga a instância na Evolution e recria na próxima conexão
  const p = await loadPerson(req, res); if (!p) return;
  const cols = roleOf(req);
  try { await evo.deleteInstance(p[cols.inst]); } catch (e) { if (e.status !== 404) throw e; }
  await db.setPersonFields(p.id, { [cols.state]: 'disconnected', [cols.qr]: null });
  res.json({ ok: true });
}));

api.get('/people/:id/whatsapp/webhook', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const inst = p[roleOf(req).inst];
  const info = await evo.findWebhook(inst);
  res.json({ ok: true, expected: evo.webhookUrl(inst), info });
}));
api.post('/people/:id/whatsapp/webhook', wrap(async (req, res) => {
  const p = await loadPerson(req, res); if (!p) return;
  const r = await evo.setWebhook(p[roleOf(req).inst]);
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
