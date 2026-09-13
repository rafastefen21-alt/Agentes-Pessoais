// API da área do cliente ("Minha assistente"): cada pessoa entra com e-mail e senha
// definidos pelo admin e vê só os próprios dados: gastos, resumo do mês e agenda.
import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as db from '../db.js';
import { checkPassword, clientLogin, clientLogout, clientPersonId, requireClient } from '../auth.js';
import { monthlySummary, regenerateMonthly } from '../monthly.js';
import { connectInstance, instanceStatus } from '../whatsapp.js';
import { ROLES } from '../agent.js';

export const clientApi = Router();

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  logger.error('Erro na API do cliente', { path: req.path, err: String(e.message) });
  res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ ok: false, error: String(e.message) });
});

// Proteção simples contra tentativas repetidas de senha (por IP)
const attempts = new Map();
function tooMany(ip) {
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
  return a.n >= 10;
}
function noteFail(ip) {
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  a.n += 1; attempts.set(ip, a);
}

clientApi.post('/login', wrap(async (req, res) => {
  const ip = req.ip || 'x';
  if (tooMany(ip)) return res.status(429).json({ ok: false, error: 'Muitas tentativas. Aguarde 15 minutos.' });
  const { email, password } = req.body || {};
  const person = email ? await db.getPersonByLoginEmail(String(email).trim()) : null;
  if (!person || !person.active || !checkPassword(password, person.login_pass)) {
    noteFail(ip);
    return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos' });
  }
  clientLogin(res, person.id);
  res.json({ ok: true, person: { id: person.id, name: person.name } });
}));

clientApi.post('/logout', (req, res) => { clientLogout(res); res.json({ ok: true }); });

clientApi.get('/me', wrap(async (req, res) => {
  const id = clientPersonId(req);
  const person = id ? await db.getPerson(id) : null;
  if (!person || !person.active) return res.json({ ok: true, authed: false });
  res.json({ ok: true, authed: true, person: { id: person.id, name: person.name, timezone: person.timezone } });
}));

clientApi.get('/summary', requireClient, wrap(async (req, res) => {
  const person = await db.getPerson(req.clientPersonId);
  if (!person || !person.active) return res.status(401).json({ ok: false, error: 'não autenticado' });
  const s = await monthlySummary(person, String(req.query.month || ''), { autoGenerate: true });
  res.json({ ok: true, usdBrl: config.claude.usdBrl, person: { id: person.id, name: person.name }, ...s });
}));

// ---------- conexões do WhatsApp: a própria pessoa pode reconectar se cair ----------
async function loadClient(req, res) {
  const person = await db.getPerson(req.clientPersonId);
  if (!person || !person.active) { res.status(401).json({ ok: false, error: 'não autenticado' }); return null; }
  return person;
}
function roleOf(req, person) {
  if (req.query.role === 'assistant') {
    if (person.notify_mode !== 'assistant') throw Object.assign(new Error('Esta conta não usa número de assistente'), { status: 400 });
    return ROLES.assistant;
  }
  return ROLES.person;
}
const publicConn = (person, cols) => ({ state: person[cols.state], phone: person[cols.phone] || '' });

clientApi.get('/connections', requireClient, wrap(async (req, res) => {
  const person = await loadClient(req, res); if (!person) return;
  res.json({
    ok: true,
    person: publicConn(person, ROLES.person),
    assistant: person.notify_mode === 'assistant' ? publicConn(person, ROLES.assistant) : null,
  });
}));
clientApi.get('/whatsapp/status', requireClient, wrap(async (req, res) => {
  const person = await loadClient(req, res); if (!person) return;
  res.json({ ok: true, ...(await instanceStatus(person, roleOf(req, person))) });
}));
clientApi.post('/whatsapp/connect', requireClient, wrap(async (req, res) => {
  const person = await loadClient(req, res); if (!person) return;
  const cols = roleOf(req, person);
  logger.info('Cliente pediu reconexão', { person: person.name, role: req.query.role || 'person' });
  res.json({ ok: true, ...(await connectInstance(person, cols)) });
}));

clientApi.post('/summary/regenerate', requireClient, wrap(async (req, res) => {
  const person = await db.getPerson(req.clientPersonId);
  if (!person || !person.active) return res.status(401).json({ ok: false, error: 'não autenticado' });
  const report = await regenerateMonthly(person, String(req.query.month || ''), { minAgeSec: 6 * 3600 });
  res.json({ ok: true, report });
}));
