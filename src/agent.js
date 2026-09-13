// Núcleo do assistente: recebe mensagens (WhatsApp/e-mail), agrupa por conversa,
// tria com a IA, avisa a pessoa quando é urgente, manda resumos periódicos e
// responde quando a pessoa fala com o assistente no próprio WhatsApp.
import { config } from './config.js';
import { logger } from './logger.js';
import * as db from './db.js';
import * as evo from './evolution.js';
import * as email from './email.js';
import { syncCalendar, upcomingEvents, formatEvents } from './calendar.js';
import * as ai from './ai/claude.js';

const MARK = config.agent.marker;
const debounces = new Map(); // key person:chat → timeout
const emailLocks = new Set();

// ---------- utilidades ----------
function now() { return Math.floor(Date.now() / 1000); }

function localHM(person, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: person.timezone || 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  const h = parts.find((p) => p.type === 'hour').value;
  const m = parts.find((p) => p.type === 'minute').value;
  return `${h === '24' ? '00' : h}:${m}`;
}
function inQuietHours(person) {
  if (!person.quiet_start || !person.quiet_end) return false;
  const cur = localHM(person);
  const s = person.quiet_start, e = person.quiet_end;
  return s <= e ? cur >= s && cur < e : cur >= s || cur < e;
}
async function calendarText(person) {
  return formatEvents(await upcomingEvents(person.id, 3), person.timezone);
}

// ---------- envio para a pessoa ----------
/** Manda uma mensagem do assistente para o WhatsApp da pessoa. */
export async function notifyPerson(person, text, kind = 'chat') {
  const body = `${MARK} ${text}`.trim();
  let instance;
  if (person.notify_mode === 'assistant' && config.evolution.assistantInstance) instance = config.evolution.assistantInstance;
  else instance = person.instance_name;
  if (!instance) throw new Error('Pessoa sem instância de WhatsApp');
  if (!person.phone) throw new Error('Número do WhatsApp da pessoa ainda não conhecido (conecte o WhatsApp primeiro)');
  const r = await evo.sendText(instance, person.phone, body);
  await db.insertAlert(person.id, kind, text, r.id);
  logger.info('Aviso enviado', { person: person.name, kind, chars: body.length });
  return r;
}

// ---------- ingestão WhatsApp ----------
export async function handleEvolutionEvent(instance, body) {
  const person = await db.getPersonByInstance(instance);
  if (!person) { logger.warn('Webhook de instância desconhecida', { instance }); return; }
  const event = String(body.event || '').toLowerCase().replace(/_/g, '.');
  const data = body.data || {};

  if (event === 'qrcode.updated') {
    const qr = data.qrcode?.base64 || data.base64 || null;
    if (qr) await db.setPersonFields(person.id, { wa_qr: qr, wa_qr_at: now(), wa_state: 'connecting' });
    return;
  }
  if (event === 'connection.update') {
    const state = String(data.state || data.status || '').toLowerCase();
    if (state) {
      const fields = { wa_state: state };
      if (state === 'open') fields.wa_qr = null;
      await db.setPersonFields(person.id, fields);
      // Descobre/atualiza o número da pessoa a partir da instância conectada
      if (state === 'open' && (!person.phone || person.phone.length < 8)) {
        const num = await evo.fetchProfileNumber(instance);
        if (num) await db.setPersonFields(person.id, { phone: num });
      }
    }
    return;
  }
  if (event === 'messages.upsert' || event === 'send.message') {
    const list = Array.isArray(data) ? data : [data];
    for (const m of list) await ingestWhatsAppMessage(person, m);
  }
}

async function ingestWhatsAppMessage(person, m) {
  const key = m.key || {};
  const jid = String(key.remoteJid || '');
  if (!jid || jid.endsWith('@broadcast')) return;
  const group = evo.isGroupJid(jid);
  if (group && person.ignore_groups) return;
  const { text } = evo.extractText(m.message);
  if (!text) return;
  const fromMe = Boolean(key.fromMe);
  const ownNumber = person.phone;
  const isSelfChat = !group && ownNumber && evo.jidToNumber(jid) === ownNumber;
  const ts = Number(m.messageTimestamp) || now();
  const externalId = key.id || `${jid}-${ts}`;

  // Chat "Você": onde o assistente e a pessoa conversam
  if (isSelfChat) {
    if (!fromMe) return;
    if (text.startsWith(MARK)) return; // mensagem do próprio assistente
    if (await db.alertExternalIdExists(person.id, externalId)) return;
    await db.insertAlert(person.id, 'user', text, externalId);
    handleUserCommand(person, text).catch((e) => logger.error('Erro no comando do usuário', { err: String(e.message) }));
    return;
  }

  const senderName = fromMe ? person.name : (m.pushName || (group ? evo.jidToNumber(key.participant) : evo.jidToNumber(jid)));
  const senderId = fromMe ? ownNumber : (group ? evo.jidToNumber(key.participant) : evo.jidToNumber(jid));
  const inserted = await db.insertMessage({
    person_id: person.id, channel: 'whatsapp', external_id: externalId, chat_id: jid,
    sender_name: senderName, sender_id: senderId, direction: fromMe ? 'out' : 'in', text, ts,
  });
  if (!inserted) return; // duplicado

  if (fromMe) {
    // A pessoa respondeu por conta própria: pendência daquela conversa resolvida
    await db.resolveItemsForChat(person.id, 'whatsapp', jid, 'replied');
    return;
  }
  scheduleTriage(person.id, 'whatsapp', jid, { group, contactLabel: group ? `grupo ${jid}` : `${senderName} (${senderId})` });
}

// ---------- ingestão e-mail ----------
export async function pollEmail(person) {
  if (!person.email_enabled || !person.imap_host || !person.imap_user) return;
  if (emailLocks.has(person.id)) return;
  emailLocks.add(person.id);
  try {
    const { emails, lastUid, uidValidity } = await email.fetchNew(person);
    await db.setPersonFields(person.id, { imap_last_uid: lastUid, imap_uidvalidity: uidValidity, email_status: `ok ${new Date().toISOString()}` });
    for (const e of emails) {
      const chatId = e.sender_id || e.sender_name || 'desconhecido';
      const inserted = await db.insertMessage({
        person_id: person.id, channel: 'email', external_id: e.external_id, chat_id: chatId,
        sender_name: e.sender_name, sender_id: e.sender_id, direction: 'in', subject: e.subject, text: e.text, ts: e.ts,
      });
      if (inserted) scheduleTriage(person.id, 'email', chatId, { contactLabel: `${e.sender_name} <${e.sender_id}>`, debounceMs: 5000 });
    }
    if (emails.length) logger.info('E-mails novos', { person: person.name, count: emails.length });
  } catch (e) {
    logger.error('Falha ao ler e-mail', { person: person.name, err: String(e.message) });
    await db.setPersonFields(person.id, { email_status: `erro: ${String(e.message).slice(0, 120)}` }).catch(() => {});
  } finally {
    emailLocks.delete(person.id);
  }
}

// ---------- triagem ----------
function scheduleTriage(personId, channel, chatId, opts = {}) {
  const key = `${personId}:${channel}:${chatId}`;
  if (debounces.has(key)) clearTimeout(debounces.get(key).t);
  const t = setTimeout(() => {
    debounces.delete(key);
    runTriage(personId, channel, chatId, opts).catch((e) => logger.error('Erro na triagem', { key, err: String(e.message) }));
  }, opts.debounceMs ?? config.agent.debounceMs);
  debounces.set(key, { t, opts });
}

async function runTriage(personId, channel, chatId, opts) {
  const person = await db.getPerson(personId);
  if (!person || !person.active) return;
  const fresh = await db.untriagedMessages(personId, chatId);
  if (!fresh.length) return;
  if (!ai.claudeConfigured()) { logger.warn('ANTHROPIC_API_KEY ausente — triagem pulada'); return; }
  const history = await db.recentChatMessages(personId, chatId, 30);
  const result = await ai.triage({
    person, channel, chatId, isGroup: Boolean(opts.group),
    contactLabel: opts.contactLabel || chatId,
    history, fresh, calendar: await calendarText(person),
  });
  await db.markTriaged(fresh.map((m) => m.id));
  logger.info('Triagem', { person: person.name, channel, contact: result.contact_name, urgency: result.urgency, notify: result.notify_now });

  const relevant = result.urgency_level >= 2 || result.needs_reply;
  if (!relevant) return;
  const itemId = await db.upsertItem({
    person_id: personId, channel, chat_id: chatId, contact_name: result.contact_name,
    urgency: result.urgency_level, category: result.category, summary: result.summary,
    needs_reply: result.needs_reply, suggested_reply: result.suggested_reply, deadline: result.deadline,
    last_message_ts: fresh[fresh.length - 1].ts,
  });

  const shouldNotify = result.notify_now && result.urgency_level >= Number(person.urgent_threshold || 3);
  if (shouldNotify && !inQuietHours(person)) {
    const lines = [
      `*${result.urgency_level >= 4 ? '🚨 Urgente' : '⚠️ Atenção'}* — ${result.contact_name} (${channel === 'email' ? 'e-mail' : 'WhatsApp'})`,
      result.summary,
      result.deadline ? `Prazo: ${result.deadline}` : null,
      result.calendar_conflict ? `Agenda: ${result.calendar_conflict}` : null,
      result.suggested_reply ? `\nSugestão de resposta (#${itemId}):\n"${result.suggested_reply}"\n\nResponda *enviar #${itemId}* para eu mandar, ou me diga o que ajustar.` : null,
    ].filter(Boolean).join('\n');
    try {
      await notifyPerson(person, lines, 'urgent');
      await db.setItemStatus(itemId, 'notified', { notified_at: now() });
    } catch (e) {
      logger.error('Falha ao avisar pessoa', { err: String(e.message) });
    }
  }
}

// ---------- resumo periódico ----------
export async function sendDigest(person, { label = 'nas últimas 24h' } = {}) {
  if (!ai.claudeConfigured()) throw new Error('ANTHROPIC_API_KEY ausente');
  const items = await db.openItems(person.id);
  const text = await ai.digest({ person, items, calendar: await calendarText(person), stats: await db.stats(person.id), sinceLabel: label });
  await notifyPerson(person, text, 'digest');
  for (const it of items) if (it.status === 'open') await db.setItemStatus(it.id, 'notified', { notified_at: now() });
  return text;
}

const digestSent = new Map(); // personId → "YYYY-MM-DD HH:MM" já enviado
async function checkDigests() {
  for (const person of await db.listPeople()) {
    if (!person.active || person.wa_state !== 'open') continue;
    const times = String(person.digest_times || '').split(',').map((s) => s.trim()).filter(Boolean);
    const cur = localHM(person);
    if (!times.includes(cur)) continue;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: person.timezone }).format(new Date());
    const stamp = `${day} ${cur}`;
    if (digestSent.get(person.id) === stamp) continue;
    digestSent.set(person.id, stamp);
    sendDigest(person).catch((e) => logger.error('Falha no resumo', { person: person.name, err: String(e.message) }));
  }
}

// ---------- comandos da pessoa (chat "Você") ----------
async function handleUserCommand(person, text) {
  const t = text.trim();
  const low = t.toLowerCase();

  // Atalhos determinísticos
  const sendMatch = low.match(/^(enviar|envia|manda|mandar|ok|sim|pode enviar|pode mandar)\s*#?(\d+)?\s*$/);
  if (sendMatch) {
    const id = sendMatch[2] ? Number(sendMatch[2]) : Number(await db.kvGet(`pending:${person.id}`) || 0);
    const item = id ? await db.getItem(id) : null;
    if (!item || item.person_id !== person.id) return notifyPerson(person, 'Não achei essa pendência. Diga o número (ex.: *enviar #12*).');
    const draft = (await db.kvGet(`draft:${person.id}:${item.id}`)) || item.suggested_reply;
    if (!draft) return notifyPerson(person, `O item #${item.id} não tem resposta sugerida. Me diga o que quer responder.`);
    return sendReplyToContact(person, item, draft);
  }
  if (/^(resumo|resumão|pendências|pendencias)$/.test(low)) {
    return sendDigest(person, { label: 'até agora' });
  }
  if (/^agenda$/.test(low)) {
    return notifyPerson(person, `*Agenda (próximos 3 dias)*\n${await calendarText(person)}`);
  }
  if (/^(ajuda|help|\?)$/.test(low)) {
    return notifyPerson(person, [
      'Comandos que eu entendo:',
      '- *resumo* — pendências e agenda agora',
      '- *agenda* — próximos compromissos',
      '- *enviar #12* — mando a resposta sugerida do item 12',
      '- *feito #12* — marca o item 12 como resolvido',
      'Ou fale comigo normalmente: "responde pro João que amanhã às 10h fica bom", "o que a Maria queria?", "prepara uma resposta educada pro cliente X".',
    ].join('\n'));
  }
  const doneMatch = low.match(/^(feito|resolvido|ignorar|ignora)\s*#?(\d+)\s*$/);
  if (doneMatch) {
    const item = await db.getItem(Number(doneMatch[2]));
    if (!item || item.person_id !== person.id) return notifyPerson(person, 'Não achei essa pendência.');
    await db.setItemStatus(item.id, 'done');
    return notifyPerson(person, `Ok, #${item.id} (${item.contact_name}) marcado como resolvido. ✅`);
  }

  // Conversa livre com a IA
  if (!ai.claudeConfigured()) return notifyPerson(person, 'A IA não está configurada no servidor (ANTHROPIC_API_KEY).');
  const history = (await db.recentAlerts(person.id, 20)).slice(0, -1); // sem a mensagem atual
  const items = await db.openItems(person.id);
  const out = await ai.chat({ person, history, items, calendar: await calendarText(person), userMessage: t });
  let reply = out.reply;
  for (const a of out.actions || []) {
    const item = a.item_id ? await db.getItem(a.item_id) : null;
    if (item && item.person_id !== person.id) continue;
    if (a.type === 'send_reply' && item && a.text) {
      await sendReplyToContact(person, item, a.text, { silent: true });
      reply += `\n\n✅ Enviado para ${item.contact_name}.`;
    } else if (a.type === 'propose_reply' && item && a.text) {
      await db.kvSet(`draft:${person.id}:${item.id}`, a.text);
      await db.kvSet(`pending:${person.id}`, String(item.id));
      if (!reply.includes(a.text)) reply += `\n\nRascunho para ${item.contact_name} (#${item.id}):\n"${a.text}"`;
      reply += `\n\nResponda *enviar #${item.id}* para eu mandar.`;
    } else if (a.type === 'mark_done' && item) {
      await db.setItemStatus(item.id, 'done');
    } else if (a.type === 'send_digest') {
      await sendDigest(person, { label: 'até agora' });
    }
  }
  return notifyPerson(person, reply);
}

async function sendReplyToContact(person, item, text, { silent = false } = {}) {
  if (item.channel !== 'whatsapp') {
    return notifyPerson(person, `O item #${item.id} é um e-mail — ainda não envio e-mails, mas aqui está o texto para você copiar:\n\n${text}`);
  }
  const r = await evo.sendText(person.instance_name, item.chat_id, text);
  await db.insertMessage({
    person_id: person.id, channel: 'whatsapp', external_id: r.id || `sent-${Date.now()}`, chat_id: item.chat_id,
    sender_name: person.name, sender_id: person.phone, direction: 'out', text, ts: now(),
  });
  await db.setItemStatus(item.id, 'replied');
  await db.kvSet(`draft:${person.id}:${item.id}`, '');
  if (!silent) await notifyPerson(person, `✅ Enviado para ${item.contact_name}:\n"${text}"`);
  return r;
}

// ---------- ciclo de vida ----------
async function refreshConnectionStates() {
  for (const person of await db.listPeople()) {
    if (!person.instance_name || !evo.configured()) continue;
    try {
      const state = await evo.connectionState(person.instance_name);
      if (state && state !== person.wa_state) await db.setPersonFields(person.id, { wa_state: state });
    } catch (e) {
      if (e.status === 404) await db.setPersonFields(person.id, { wa_state: 'missing' });
    }
  }
}

async function syncAllCalendars() {
  for (const p of await db.listPeople()) {
    if (!p.active || !p.calendar_ics_url) continue;
    try {
      const r = await syncCalendar(p);
      await db.setPersonFields(p.id, { calendar_status: `ok ${r.count} eventos ${new Date().toISOString()}` });
    } catch (e) {
      await db.setPersonFields(p.id, { calendar_status: `erro: ${String(e.message).slice(0, 120)}` }).catch(() => {});
    }
  }
}
async function pollAllEmails() {
  for (const p of await db.listPeople()) if (p.active) await pollEmail(p).catch(() => {});
}

export function startSchedulers() {
  const safe = (fn) => () => fn().catch((e) => logger.error('Erro em agendador', { err: String(e.message) }));
  setInterval(safe(pollAllEmails), config.agent.emailPollMs);
  setTimeout(safe(pollAllEmails), 8000);
  setInterval(safe(syncAllCalendars), config.agent.calendarPollMs);
  setTimeout(safe(syncAllCalendars), 5000);
  setInterval(safe(checkDigests), 30000);
  setInterval(safe(refreshConnectionStates), 120000);
  setTimeout(safe(refreshConnectionStates), 3000);
  logger.info('Agendadores iniciados');
}
