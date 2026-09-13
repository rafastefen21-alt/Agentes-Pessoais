// Leitura de e-mails via IMAP (imapflow + mailparser). Uma leitura por pessoa,
// guardando o último UID lido para pegar só o que é novo.
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { decrypt } from './crypto.js';
import { logger } from './logger.js';

function stripHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

function clientFor(person) {
  return new ImapFlow({
    host: person.imap_host,
    port: Number(person.imap_port) || 993,
    secure: Number(person.imap_port) !== 143,
    auth: { user: person.imap_user, pass: decrypt(person.imap_pass) },
    logger: false,
    socketTimeout: 60000,
  });
}

/** Testa a conexão e retorna { ok, messages } (total na caixa). */
export async function testConnection(person) {
  const client = clientFor(person);
  try {
    await client.connect();
    const box = await client.mailboxOpen(person.imap_folder || 'INBOX', { readOnly: true });
    return { ok: true, exists: box.exists, uidNext: box.uidNext, uidValidity: Number(box.uidValidity) };
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * Busca e-mails novos (UID > last_uid). Na primeira vez, só marca o ponto de
 * partida (não processa o histórico inteiro) — a não ser que `initialLookback`
 * seja informado (em quantidade de mensagens).
 */
export async function fetchNew(person, { initialLookback = 10, maxPerRun = 40 } = {}) {
  const client = clientFor(person);
  const out = [];
  let lastUid = Number(person.imap_last_uid) || 0;
  let uidValidity = Number(person.imap_uidvalidity) || 0;
  try {
    await client.connect();
    const box = await client.mailboxOpen(person.imap_folder || 'INBOX', { readOnly: true });
    const validity = Number(box.uidValidity);
    if (validity !== uidValidity) {
      // Caixa nova ou resetada: começa alguns e-mails para trás
      lastUid = Math.max(0, Number(box.uidNext) - 1 - initialLookback);
      uidValidity = validity;
    }
    const from = lastUid + 1;
    const to = Number(box.uidNext) - 1;
    if (to >= from) {
      const range = `${from}:${Math.min(to, from + maxPerRun - 1)}`;
      for await (const msg of client.fetch(range, { uid: true, envelope: true, source: true, internalDate: true }, { uid: true })) {
        try {
          const parsed = await simpleParser(msg.source);
          const fromAddr = parsed.from?.value?.[0] || {};
          const body = (parsed.text && parsed.text.trim()) || stripHtml(parsed.html) || '';
          out.push({
            uid: msg.uid,
            external_id: parsed.messageId || `uid-${validity}-${msg.uid}`,
            sender_name: fromAddr.name || fromAddr.address || '',
            sender_id: (fromAddr.address || '').toLowerCase(),
            subject: parsed.subject || '(sem assunto)',
            text: body.slice(0, 6000),
            ts: Math.floor((parsed.date || msg.internalDate || new Date()).getTime() / 1000),
            to: (parsed.to?.value || []).map((t) => t.address).join(', '),
          });
        } catch (e) {
          logger.warn('Falha ao parsear e-mail', { uid: msg.uid, err: String(e.message) });
        }
        lastUid = Math.max(lastUid, msg.uid);
      }
      // Se nada foi retornado no range (ex.: UIDs pulados), avança mesmo assim
      lastUid = Math.max(lastUid, Math.min(to, from + maxPerRun - 1));
    }
    return { emails: out, lastUid, uidValidity };
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Presets de servidores comuns para facilitar o cadastro no portal. */
export const IMAP_PRESETS = {
  gmail: { host: 'imap.gmail.com', port: 993, note: 'Use uma "Senha de app" (Conta Google → Segurança → Verificação em duas etapas → Senhas de app).' },
  outlook: { host: 'outlook.office365.com', port: 993, note: 'Contas Microsoft 365 podem exigir senha de app ou habilitação de IMAP pelo administrador.' },
  icloud: { host: 'imap.mail.me.com', port: 993, note: 'Gere uma senha específica de app em appleid.apple.com.' },
  yahoo: { host: 'imap.mail.yahoo.com', port: 993, note: 'Gere uma senha de app nas configurações de segurança do Yahoo.' },
  zoho: { host: 'imap.zoho.com', port: 993, note: 'Habilite o acesso IMAP nas configurações do Zoho Mail.' },
  hostinger: { host: 'imap.hostinger.com', port: 993, note: 'Senha normal da caixa de e-mail.' },
  titan: { host: 'imap.titan.email', port: 993, note: 'Senha normal da caixa de e-mail.' },
};
