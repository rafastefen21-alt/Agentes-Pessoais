// Cliente da Evolution API (multi-instância). Usa fetch nativo do Node.
import { config } from './config.js';
import { logger } from './logger.js';
import { sessionSecret } from './crypto.js';

export function configured() {
  return Boolean(config.evolution.url && config.evolution.apikey);
}

async function evo(method, path, body) {
  if (!configured()) throw new Error('Evolution API não configurada (EVOLUTION_URL / EVOLUTION_APIKEY)');
  const url = `${config.evolution.url}/${path.replace(/^\//, '')}`;
  const res = await fetch(url, {
    method,
    headers: { apikey: config.evolution.apikey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data = {};
  try { data = txt ? JSON.parse(txt) : {}; } catch { data = { raw: txt }; }
  if (!res.ok) {
    const err = new Error(`Evolution ${method} ${path} → ${res.status}: ${txt.slice(0, 300)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const WEBHOOK_EVENTS = ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'SEND_MESSAGE'];

/** Token do webhook: EVOLUTION_WEBHOOK_TOKEN, ou derivado do segredo do app. */
export function webhookToken() {
  return config.evolution.webhookToken || sessionSecret().slice(0, 32);
}

export function webhookUrl(instance) {
  return `${config.appUrl}/webhooks/evolution/${encodeURIComponent(instance)}?token=${encodeURIComponent(webhookToken())}`;
}

export async function ping() {
  const res = await fetch(config.evolution.url, { headers: { apikey: config.evolution.apikey } });
  const txt = await res.text();
  let data = {}; try { data = JSON.parse(txt); } catch { data = { raw: txt.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, version: data.version, data };
}

export async function fetchInstances() {
  return evo('GET', 'instance/fetchInstances');
}

export async function createInstance(instance) {
  return evo('POST', 'instance/create', {
    instanceName: instance,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    syncFullHistory: false,
    webhook: {
      url: webhookUrl(instance),
      byEvents: false,
      base64: true,
      events: WEBHOOK_EVENTS,
    },
  });
}

export async function setWebhook(instance) {
  const body = { webhook: { enabled: true, url: webhookUrl(instance), byEvents: false, base64: true, events: WEBHOOK_EVENTS } };
  try {
    return await evo('POST', `webhook/set/${instance}`, body);
  } catch (e) {
    // Algumas versões aceitam o formato "plano"
    if (e.status === 400) return evo('POST', `webhook/set/${instance}`, body.webhook);
    throw e;
  }
}

export async function findWebhook(instance) {
  return evo('GET', `webhook/find/${instance}`);
}

/** Retorna { base64, code, count } — o QR pode não vir de imediato. */
export async function connect(instance) {
  const data = await evo('GET', `instance/connect/${instance}`);
  return { base64: data.base64 || data.qrcode?.base64 || null, code: data.code || data.pairingCode || null, count: data.count };
}

export async function connectionState(instance) {
  const data = await evo('GET', `instance/connectionState/${instance}`);
  return data.instance?.state || data.state || 'unknown';
}

export async function logout(instance) {
  return evo('DELETE', `instance/logout/${instance}`);
}
export async function deleteInstance(instance) {
  try { await logout(instance); } catch { /* pode já estar deslogada */ }
  return evo('DELETE', `instance/delete/${instance}`);
}

/** Envia texto. `number` = só dígitos com DDI, ou JID completo (grupo). */
export async function sendText(instance, number, text) {
  const raw = String(number);
  const num = raw.includes('@') ? raw : raw.replace(/\D/g, '');
  const data = await evo('POST', `message/sendText/${instance}`, { number: num, text });
  return { ok: true, id: data?.key?.id || null, data };
}

export async function findMessages(instance, remoteJid, { pageSize = 50 } = {}) {
  const r = await evo('POST', `chat/findMessages/${instance}`, { where: { key: { remoteJid } }, page: 1, offset: pageSize });
  const m = r?.messages || r || {};
  return Array.isArray(m.records) ? m.records : Array.isArray(m) ? m : [];
}

export async function fetchProfileNumber(instance) {
  // Descobre o número conectado (owner) da instância
  try {
    const list = await fetchInstances();
    const arr = Array.isArray(list) ? list : list?.instances || [];
    const found = arr.find((i) => (i.name || i.instance?.instanceName || i.instanceName) === instance);
    const owner = found?.ownerJid || found?.instance?.owner || found?.owner || '';
    return String(owner).split('@')[0].split(':')[0].replace(/\D/g, '') || null;
  } catch (e) {
    logger.warn('Não foi possível obter número da instância', { instance, err: String(e.message) });
    return null;
  }
}

// ---------- utilidades de payload ----------
export function jidToNumber(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}
export function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}
export function extractText(message) {
  if (!message) return { text: '', type: 'unsupported' };
  if (typeof message.conversation === 'string') return { text: message.conversation, type: 'text' };
  if (message.extendedTextMessage?.text) return { text: String(message.extendedTextMessage.text), type: 'text' };
  if (message.imageMessage) return { text: message.imageMessage.caption ? `[imagem] ${message.imageMessage.caption}` : '[imagem]', type: 'image' };
  if (message.videoMessage) return { text: message.videoMessage.caption ? `[vídeo] ${message.videoMessage.caption}` : '[vídeo]', type: 'video' };
  if (message.audioMessage) return { text: '[áudio]', type: 'audio' };
  if (message.documentMessage) return { text: `[documento] ${message.documentMessage.fileName || ''}`.trim(), type: 'document' };
  if (message.stickerMessage) return { text: '[figurinha]', type: 'sticker' };
  if (message.contactMessage) return { text: `[contato] ${message.contactMessage.displayName || ''}`.trim(), type: 'contact' };
  if (message.locationMessage) return { text: '[localização]', type: 'location' };
  if (message.reactionMessage) return { text: '', type: 'reaction' };
  if (message.protocolMessage) return { text: '', type: 'protocol' };
  if (message.ephemeralMessage?.message) return extractText(message.ephemeralMessage.message);
  if (message.viewOnceMessageV2?.message) return extractText(message.viewOnceMessageV2.message);
  return { text: '', type: 'unsupported' };
}
