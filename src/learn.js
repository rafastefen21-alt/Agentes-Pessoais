// Aprendizado com o histórico: ao conectar o WhatsApp, lê as conversas recentes
// (as que a Evolution sincronizou) e as mensagens já guardadas, e pede à IA um
// perfil de como a pessoa escreve e do contexto dela. O perfil entra em todos os
// prompts (triagem, resumos, conversa) e é renovado periodicamente.
import * as db from './db.js';
import * as evo from './evolution.js';
import * as ai from './ai/claude.js';
import { logger } from './logger.js';

const running = new Set();
const now = () => Math.floor(Date.now() / 1000);

/** Importa o histórico recente da Evolution para a tabela messages (já marcado como triado). */
export async function importHistory(person, { maxChats = 40, perChat = 40 } = {}) {
  if (!evo.configured() || !person.instance_name) return { imported: 0 };
  let chats = [];
  try { chats = await evo.findChats(person.instance_name); } catch (e) { logger.warn('findChats falhou', { err: String(e.message) }); }
  const jids = chats
    .map((c) => c.remoteJid || c.id || c.jid || '')
    .filter((j) => j && !evo.isGroupJid(j) && !j.endsWith('@broadcast') && evo.jidToNumber(j) !== person.phone && evo.jidToNumber(j) !== person.assistant_phone)
    .slice(0, maxChats);
  let imported = 0;
  const seenJids = new Set();
  const process = async (records) => {
    for (const m of records) {
      const key = m.key || {};
      const jid = String(key.remoteJid || '');
      if (!jid || evo.isGroupJid(jid)) continue;
      if (evo.jidToNumber(jid) === person.phone || (person.assistant_phone && evo.jidToNumber(jid) === person.assistant_phone)) continue;
      const { text } = evo.extractText(m.message);
      if (!text) continue;
      const fromMe = Boolean(key.fromMe);
      const ts = Number(m.messageTimestamp) || now();
      const id = await db.insertMessage({
        person_id: person.id, channel: 'whatsapp', external_id: key.id || `${jid}-${ts}`, chat_id: jid,
        sender_name: fromMe ? person.name : (m.pushName || evo.jidToNumber(jid)),
        sender_id: fromMe ? person.phone : evo.jidToNumber(jid),
        direction: fromMe ? 'out' : 'in', text, ts,
      });
      if (id) { imported += 1; await db.markTriaged([id]); }
      seenJids.add(jid);
    }
  };
  if (jids.length) {
    for (const jid of jids) {
      try { await process(await evo.findMessages(person.instance_name, jid, { pageSize: perChat })); }
      catch (e) { logger.debug('findMessages falhou', { jid, err: String(e.message) }); }
    }
  } else {
    // Sem lista de chats: tenta as mensagens mais recentes sem filtro
    try { await process(await evo.findRecentMessages(person.instance_name, { pageSize: 500 })); }
    catch (e) { logger.warn('findRecentMessages falhou', { err: String(e.message) }); }
  }
  logger.info('Histórico importado', { person: person.name, imported, chats: seenJids.size });
  return { imported, chats: seenJids.size };
}

/** Amostra de mensagens guardadas para a IA estudar. */
async function sample(person) {
  const outgoing = await db.sampleMessages(person.id, 'out', 250);
  const incoming = await db.sampleMessages(person.id, 'in', 120);
  const contacts = await db.topContacts(person.id, 25);
  return { outgoing, incoming, contacts };
}

/**
 * Gera (ou renova) o perfil. Retorna o perfil ou null se não houver material.
 * force = refaz mesmo que já exista.
 */
export async function learnProfile(person, { force = false, importFirst = true } = {}) {
  if (running.has(person.id)) return null;
  running.add(person.id);
  try {
    if (importFirst) await importHistory(person);
    const fresh = await db.getPerson(person.id);
    if (!force && fresh.style_profile) return JSON.parse(fresh.style_profile);
    const s = await sample(fresh);
    if (s.outgoing.length < 5) {
      logger.info('Poucas mensagens da pessoa para aprender o estilo ainda', { person: fresh.name, outgoing: s.outgoing.length });
      await db.setPersonFields(fresh.id, { profile_status: `aguardando: só ${s.outgoing.length} mensagens escritas pela pessoa até agora (mínimo 5)` });
      return null;
    }
    if (!ai.claudeConfigured()) {
      logger.warn('Perfil não gerado: ANTHROPIC_API_KEY ausente');
      await db.setPersonFields(fresh.id, { profile_status: 'IA não configurada no servidor (ANTHROPIC_API_KEY)' });
      return null;
    }
    const profile = await ai.styleProfile({ person: fresh, ...s });
    profile.generated_at = now();
    profile.based_on = { outgoing: s.outgoing.length, incoming: s.incoming.length, contacts: s.contacts.length };
    await db.setPersonFields(fresh.id, { style_profile: JSON.stringify(profile), profile_updated_at: now(), profile_status: `ok ${new Date().toISOString()}` });
    logger.info('Perfil aprendido', { person: fresh.name, outgoing: s.outgoing.length });
    return profile;
  } catch (e) {
    logger.error('Falha ao aprender perfil', { person: person.name, err: String(e.message) });
    await db.setPersonFields(person.id, { profile_status: `erro: ${String(e.message).slice(0, 120)}` }).catch(() => {});
    return null;
  } finally {
    running.delete(person.id);
  }
}

/** Agenda o aprendizado logo após a conexão (dá tempo de a Evolution sincronizar o histórico). */
export function scheduleLearnAfterConnect(personId, delayMs = 90000) {
  setTimeout(async () => {
    const p = await db.getPerson(personId);
    if (p && p.active) learnProfile(p).catch(() => {});
  }, delayMs);
}

/** Renova perfis com mais de 7 dias (chamado pelo agendador). */
export async function refreshStaleProfiles(maxAgeSec = 7 * 86400) {
  for (const p of await db.listPeople()) {
    if (!p.active || p.wa_state !== 'open') continue;
    const age = now() - Number(p.profile_updated_at || 0);
    if (!p.style_profile || age > maxAgeSec) await learnProfile(p, { force: Boolean(p.style_profile) }).catch(() => {});
  }
}
