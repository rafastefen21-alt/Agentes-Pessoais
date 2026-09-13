// Conexão das instâncias de WhatsApp (pessoa e assistente). Usado pelo portal do
// admin e pela área do cliente, para que a própria pessoa consiga reconectar.
import { config } from './config.js';
import { logger } from './logger.js';
import * as db from './db.js';
import * as evo from './evolution.js';

const now = () => Math.floor(Date.now() / 1000);
function fail(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

/** Cria a instância se não existir, garante o webhook e devolve o QR (quando houver). */
export async function connectInstance(person, cols) {
  if (!config.appUrl) throw fail('APP_URL não definida no servidor; a Evolution não conseguiria chamar o webhook.');
  if (!evo.configured()) throw fail('Evolution API não configurada no servidor.');
  const instance = person[cols.inst];
  if (!instance) throw fail('Pessoa sem nome de instância');
  let state = null;
  try { state = await evo.connectionState(instance); } catch (e) { if (e.status !== 404) throw e; }
  let qr = null;
  if (!state || state === 'unknown') {
    try {
      const created = await evo.createInstance(instance);
      qr = created?.qrcode?.base64 || created?.base64 || null;
    } catch (e) {
      // A Evolution às vezes demora e o Railway responde 502/503/504 mesmo tendo criado a instância.
      if (![502, 503, 504].includes(e.status)) throw e;
      logger.warn('Evolution não respondeu à criação; verificando se a instância existe', { instance, status: e.status });
      let exists = false;
      for (let i = 0; i < 4 && !exists; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        try { await evo.connectionState(instance); exists = true; } catch (e2) { if (e2.status !== 404) exists = false; }
      }
      if (!exists) throw fail('A Evolution não respondeu à criação da instância (502). Aguarde 30 s e clique em Conectar de novo.', 502);
    }
    state = 'connecting';
  } else if (state === 'open') {
    await db.setPersonFields(person.id, { [cols.state]: 'open', [cols.qr]: null });
    return { state: 'open', qr: null };
  } else {
    // garante que o webhook aponta para cá (caso APP_URL tenha mudado)
    try { await evo.setWebhook(instance); } catch (e) { logger.warn('setWebhook falhou', { instance, err: String(e.message) }); }
  }
  if (!qr) {
    try { const c = await evo.connect(instance); qr = c.base64; } catch (e) { logger.warn('connect falhou', { instance, err: String(e.message) }); }
  }
  await db.setPersonFields(person.id, { [cols.state]: state, ...(qr ? { [cols.qr]: qr, [cols.qrAt]: now() } : {}) });
  return { state, qr: qr || (await db.getPerson(person.id))[cols.qr] };
}

/** Estado atual da instância; renova o QR (expira em ~40 s) enquanto não conecta. */
export async function instanceStatus(person, cols) {
  const instance = person[cols.inst];
  let state = person[cols.state];
  if (evo.configured() && instance) {
    try { state = await evo.connectionState(instance); } catch (e) { state = e.status === 404 ? 'missing' : state; }
  }
  let qr = person[cols.qr];
  if (state === 'open') qr = null;
  else if (evo.configured() && instance && (!qr || (person[cols.qrAt] && now() - person[cols.qrAt] > 40))) {
    try {
      const c = await evo.connect(instance);
      if (c.base64) { qr = c.base64; await db.setPersonFields(person.id, { [cols.qr]: qr, [cols.qrAt]: now() }); }
    } catch { /* ignora: sem QR novo por enquanto */ }
  }
  if (state !== person[cols.state]) await db.setPersonFields(person.id, { [cols.state]: state });
  if (state === 'open' && (!person[cols.phone] || person[cols.phone].length < 8)) {
    const num = await evo.fetchProfileNumber(instance);
    if (num) await db.setPersonFields(person.id, { [cols.phone]: num });
  }
  return { state, qr, phone: (await db.getPerson(person.id))[cols.phone] };
}
