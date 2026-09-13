// Página pública de conexão: o admin gera um link com token (validade de 7 dias)
// e manda para a pessoa. Ela abre, escaneia os QR codes e pronto — sem login.
import { Router } from 'express';
import { logger } from '../logger.js';
import * as db from '../db.js';
import { connectInstance, instanceStatus } from '../whatsapp.js';
import { ROLES } from '../agent.js';

export const connectApi = Router();

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  logger.error('Erro na API de conexão', { path: req.path, err: String(e.message) });
  res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ ok: false, error: String(e.message) });
});

async function loadByToken(req, res) {
  const token = String(req.params.token || '');
  const person = token.length >= 20 ? await db.getPersonByConnectToken(token) : null;
  const now = Math.floor(Date.now() / 1000);
  if (!person || !person.active || !person.connect_token_exp || person.connect_token_exp < now) {
    res.status(404).json({ ok: false, error: 'Este link de conexão não é válido ou expirou. Peça um novo.' });
    return null;
  }
  return person;
}
function roleOf(req, person) {
  if (req.query.role === 'assistant') {
    if (person.notify_mode !== 'assistant') throw Object.assign(new Error('Esta conta não usa número de assistente'), { status: 400 });
    return ROLES.assistant;
  }
  return ROLES.person;
}
const pub = (person, cols) => ({ state: person[cols.state], phone: person[cols.phone] || '' });

connectApi.get('/:token/info', wrap(async (req, res) => {
  const person = await loadByToken(req, res); if (!person) return;
  res.json({
    ok: true, name: person.name, expires_at: person.connect_token_exp,
    person: pub(person, ROLES.person),
    assistant: person.notify_mode === 'assistant' ? pub(person, ROLES.assistant) : null,
  });
}));
connectApi.get('/:token/status', wrap(async (req, res) => {
  const person = await loadByToken(req, res); if (!person) return;
  res.json({ ok: true, ...(await instanceStatus(person, roleOf(req, person))) });
}));
connectApi.post('/:token/connect', wrap(async (req, res) => {
  const person = await loadByToken(req, res); if (!person) return;
  logger.info('Conexão pelo link', { person: person.name, role: req.query.role || 'person' });
  res.json({ ok: true, ...(await connectInstance(person, roleOf(req, person))) });
}));
