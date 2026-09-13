// Webhook público chamado pela Evolution API. Protegido por token na URL.
import { Router } from 'express';
import { webhookToken } from '../evolution.js';
import { logger } from '../logger.js';
import { handleEvolutionEvent } from '../agent.js';

export const webhooks = Router();

// Últimos eventos recebidos (diagnóstico no portal)
export const lastEvents = [];
function remember(instance, body) {
  lastEvents.unshift({
    at: new Date().toISOString(), instance, event: body.event,
    state: body.data?.state, hasQr: Boolean(body.data?.qrcode?.base64 || body.data?.base64),
    fromMe: body.data?.key?.fromMe, remoteJid: body.data?.key?.remoteJid,
  });
  if (lastEvents.length > 50) lastEvents.length = 50;
}

webhooks.post('/evolution/:instance', (req, res) => {
  const token = req.query.token;
  if (!token || token !== webhookToken()) {
    return res.status(401).json({ ok: false });
  }
  const body = req.body || {};
  const instance = req.params.instance || body.instance;
  remember(instance, body);
  res.json({ ok: true }); // responde rápido; processa depois
  handleEvolutionEvent(instance, body).catch((e) => logger.error('Erro no webhook', { instance, err: String(e.message) }));
});

// Algumas versões da Evolution, com byEvents=true, adicionam o nome do evento no caminho
webhooks.post('/evolution/:instance/*', (req, res) => {
  const token = req.query.token;
  if (!token || token !== webhookToken()) {
    return res.status(401).json({ ok: false });
  }
  const body = req.body || {};
  const instance = req.params.instance || body.instance;
  remember(instance, body);
  res.json({ ok: true });
  handleEvolutionEvent(instance, body).catch((e) => logger.error('Erro no webhook', { instance, err: String(e.message) }));
});
