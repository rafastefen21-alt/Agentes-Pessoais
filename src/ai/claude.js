// Camada de IA (Claude). Três funções:
//   triage()  – classifica novas mensagens de uma conversa (urgência, resumo, sugestão de resposta)
//   digest()  – escreve o resumo periódico para mandar no WhatsApp da pessoa
//   chat()    – responde quando a pessoa conversa com o assistente no chat "Você"
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config.js';
import { logger } from '../logger.js';

let client = null;
export function claudeConfigured() {
  return Boolean(config.claude.apiKey);
}
function getClient() {
  if (!client) client = new Anthropic({ apiKey: config.claude.apiKey });
  return client;
}

// ---------- prompts (estáveis → cacheáveis) ----------
const SYSTEM_BASE = `Você é a assistente pessoal executiva de uma pessoa ocupada. Você lê o WhatsApp e os e-mails dela e a ajuda a não perder nada importante, sem incomodar com o que não importa.

Princípios:
- Seja objetiva e concreta. Nomes, valores, datas e prazos sempre explícitos.
- Escreva em português do Brasil, no tom natural de uma assistente de confiança (sem formalidade excessiva, sem gírias).
- Nunca invente fatos: se a informação não está nas mensagens, diga que não está.
- Urgência é sobre consequência e prazo, não sobre volume ou tom da mensagem. Cobranças com prazo, clientes esperando resposta, pedidos de decisão, problemas em andamento, compromissos hoje/amanhã e pessoas próximas com necessidade real são urgentes. Propaganda, newsletters, notificações automáticas, grupos de conversa fiada e "bom dia" não são.
- Ao sugerir respostas, escreva como a própria pessoa escreveria para aquele contato (curta, direta, cordial), pronta para copiar e enviar. Nunca prometa nada que a pessoa não confirmou.
- Formato para WhatsApp: use *negrito* para destacar e listas com "-". Nada de markdown com # ou tabelas. Emojis com moderação (no máximo um por bloco).`;

const TriageSchema = z.object({
  contact_name: z.string().describe('Nome do contato/remetente como aparece ou como se deduz da conversa'),
  urgency: z.enum(['baixa', 'media', 'alta', 'critica']).describe('baixa: pode esperar dias / ignorar; media: responder hoje ou amanhã; alta: responder nas próximas horas; critica: agora'),
  category: z.enum(['pessoal', 'trabalho', 'cliente', 'financeiro', 'agenda', 'suporte', 'divulgacao', 'automatico', 'outro']),
  summary: z.string().describe('Resumo em 1-2 frases do que a pessoa precisa saber. Concreto.'),
  needs_reply: z.boolean().describe('true se o contato está esperando uma resposta da pessoa'),
  suggested_reply: z.string().nullable().describe('Resposta pronta para enviar ao contato, na voz da pessoa. null se não precisa responder.'),
  deadline: z.string().nullable().describe('Prazo ou data/hora relevante mencionada, em texto curto (ex.: "hoje 18h", "sexta 15/03"). null se não há.'),
  calendar_conflict: z.string().nullable().describe('Se a mensagem propõe/menciona compromisso que conflita com a agenda informada, descreva. Senão null.'),
  notify_now: z.boolean().describe('true se vale interromper a pessoa agora com um aviso (em vez de esperar o resumo periódico)'),
});
export const URGENCY_LEVEL = { baixa: 1, media: 2, alta: 3, critica: 4 };
export const URGENCY_LABEL = { 1: 'baixa', 2: 'média', 3: 'alta', 4: 'crítica' };

const ChatSchema = z.object({
  reply: z.string().describe('Mensagem para enviar no WhatsApp da pessoa (formato WhatsApp).'),
  actions: z.array(z.object({
    type: z.enum(['send_reply', 'propose_reply', 'mark_done', 'send_digest', 'none']).describe(
      'send_reply: a pessoa pediu EXPLICITAMENTE para enviar agora ("manda", "envia", "pode mandar", "responde pra ele que..."). ' +
      'propose_reply: você redigiu um rascunho e quer confirmação antes de enviar. ' +
      'mark_done: a pessoa disse que já resolveu/ignorar o item. send_digest: a pessoa pediu o resumo geral.'),
    item_id: z.number().nullable().describe('ID do item (da lista de pendências) a que a ação se refere. null se não se aplica.'),
    text: z.string().nullable().describe('Texto da resposta a enviar ao contato (para send_reply / propose_reply).'),
  })),
});

// ---------- chamada base ----------
async function callClaude({ system, messages, format, effort, maxTokens = 4000 }) {
  const c = getClient();
  const base = {
    model: config.claude.model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: { effort, ...(format ? { format } : {}) },
  };
  let response;
  if (config.claude.fallbacks) {
    try {
      response = await c.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError) {
        logger.warn('Fallback server-side rejeitado; repetindo sem fallbacks', { err: e.message.slice(0, 200) });
        config.claude.fallbacks = false;
        response = await c.messages.create(base);
      } else throw e;
    }
  } else {
    response = await c.messages.create(base);
  }
  if (response.stop_reason === 'refusal') {
    const why = response.stop_details?.explanation || response.stop_details?.category || 'sem detalhe';
    throw new Error(`Claude recusou a solicitação (${why})`);
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  logger.debug('Claude usage', { in: response.usage?.input_tokens, out: response.usage?.output_tokens, cached: response.usage?.cache_read_input_tokens, stop: response.stop_reason });
  return { text, response };
}

const norm = (v) => String(v || '').normalize('NFD').replace(/[0300-036f]/g, '').toLowerCase().trim();
function parseJson(text, schema) {
  let raw = text;
  const m = text.match(/\{[\s\S]*\}/);
  if (m) raw = m[0];
  const obj = JSON.parse(raw);
  // Tolerância a acentos/maiúsculas nos enums (ex.: "Média" → "media")
  if (typeof obj.urgency === 'string') obj.urgency = norm(obj.urgency);
  if (typeof obj.category === 'string') obj.category = norm(obj.category);
  if (Array.isArray(obj.actions)) for (const a of obj.actions) if (a && typeof a.type === 'string') a.type = norm(a.type).replace(/[^a-z_]/g, '_');
  const parsed = schema.safeParse(obj);
  if (!parsed.success) throw new Error('Resposta da IA fora do formato: ' + parsed.error.message.slice(0, 200));
  return parsed.data;
}

function personBlock(person, extras = {}) {
  const now = new Intl.DateTimeFormat('pt-BR', { timeZone: person.timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  return [
    `## Sobre a pessoa que você assiste`,
    `Nome: ${person.name}`,
    `Agora: ${now} (${person.timezone})`,
    person.context_notes ? `Contexto e prioridades (escrito por ela):\n${person.context_notes}` : 'Contexto: (não informado)',
    extras.calendar ? `\n## Agenda (próximos dias)\n${extras.calendar}` : '',
  ].filter(Boolean).join('\n');
}

// ---------- triagem ----------
/**
 * @param {object} p  { person, channel, chatId, history: [{direction, sender_name, text, ts, subject}], fresh: [...], calendar: string }
 */
export async function triage(p) {
  const fmtTs = (ts) => new Intl.DateTimeFormat('pt-BR', { timeZone: p.person.timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));
  const line = (m) => {
    const who = m.direction === 'out' ? p.person.name + ' (ela mesma)' : (m.sender_name || m.sender_id || 'contato');
    const subj = m.subject ? ` [assunto: ${m.subject}]` : '';
    return `[${fmtTs(m.ts)}] ${who}${subj}: ${m.text}`;
  };
  const freshIds = new Set(p.fresh.map((m) => m.id));
  const older = p.history.filter((m) => !freshIds.has(m.id));
  const user = [
    personBlock(p.person, { calendar: p.calendar }),
    `\n## Canal: ${p.channel === 'email' ? 'E-mail' : 'WhatsApp'}${p.isGroup ? ' (grupo)' : ''}`,
    `Conversa com: ${p.contactLabel}`,
    older.length ? `\n## Histórico anterior da conversa (já visto)\n${older.map(line).join('\n')}` : '',
    `\n## Mensagens NOVAS (ainda não vistas pela pessoa)\n${p.fresh.map(line).join('\n')}`,
    `\nClassifique as mensagens novas, considerando o histórico e a agenda. Responda no formato JSON pedido.`,
  ].filter(Boolean).join('\n');

  const { text } = await callClaude({
    system: SYSTEM_BASE + '\n\nSua tarefa agora é TRIAR mensagens novas de uma conversa e devolver um JSON.',
    messages: [{ role: 'user', content: user }],
    format: zodOutputFormat(TriageSchema),
    effort: config.claude.triageEffort,
    maxTokens: 2000,
  });
  const data = parseJson(text, TriageSchema);
  return { ...data, urgency_level: URGENCY_LEVEL[data.urgency] };
}

// ---------- resumo periódico ----------
export async function digest({ person, items, calendar, stats, sinceLabel }) {
  const list = items.length
    ? items.map((it) => `- #${it.id} [${URGENCY_LABEL[it.urgency]}] (${it.channel}) ${it.contact_name}: ${it.summary}${it.needs_reply ? ' — aguarda resposta' : ''}${it.deadline ? ` — prazo: ${it.deadline}` : ''}${it.suggested_reply ? `\n    sugestão: "${it.suggested_reply}"` : ''}`).join('\n')
    : '(nenhuma pendência)';
  const user = [
    personBlock(person, { calendar }),
    `\n## Volume ${sinceLabel}: WhatsApp ${stats.last24h?.whatsapp || 0} mensagens, e-mail ${stats.last24h?.email || 0}`,
    `\n## Pendências abertas (já triadas)\n${list}`,
    `\nEscreva o RESUMO para enviar no WhatsApp de ${person.name.split(' ')[0]}. Estrutura: (1) o que é urgente/precisa de resposta, com a sugestão de resposta quando houver, citando o número do item como "#id" para ela poder responder "enviar #id"; (2) agenda de hoje e amanhã e conflitos; (3) o resto em uma linha cada, se houver. Máximo ~1500 caracteres. Se não houver nada relevante, diga isso em uma frase simpática e curta.`,
  ].join('\n');
  const { text } = await callClaude({
    system: SYSTEM_BASE + '\n\nSua tarefa agora é escrever o resumo periódico (texto puro para WhatsApp, sem JSON).',
    messages: [{ role: 'user', content: user }],
    effort: config.claude.digestEffort,
    maxTokens: 3000,
  });
  return text;
}

// ---------- conversa com o assistente ----------
export async function chat({ person, history, items, calendar, userMessage }) {
  const list = items.length
    ? items.map((it) => `- item_id ${it.id} [${URGENCY_LABEL[it.urgency]}] (${it.channel}, chat ${it.chat_id}) ${it.contact_name}: ${it.summary}${it.needs_reply ? ' — aguarda resposta' : ''}${it.suggested_reply ? `\n    sugestão atual: "${it.suggested_reply}"` : ''}`).join('\n')
    : '(nenhuma pendência aberta)';
  const system = SYSTEM_BASE + `\n\nAgora você está CONVERSANDO com a pessoa pelo WhatsApp. Ela pode pedir resumos, detalhes de uma conversa, redigir/ajustar respostas, mandar respostas para contatos, marcar coisas como resolvidas ou perguntar sobre a agenda.
Regras de ação:
- Só use "send_reply" quando ela pediu explicitamente para enviar agora. Se ela pediu para "preparar", "escrever", "sugerir" ou se houver dúvida, use "propose_reply" e peça confirmação na reply (ela responde "enviar").
- Toda ação de envio precisa de item_id válido da lista de pendências e do texto completo.
- Se ela mencionar algo que não está nas pendências nem no histórico, diga que não tem essa informação.`;
  const messages = [];
  for (const h of history) {
    messages.push({ role: h.kind === 'user' ? 'user' : 'assistant', content: h.text });
  }
  // Garante alternância válida e começo com user
  const normalized = [];
  for (const m of messages) {
    const last = normalized[normalized.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else normalized.push({ ...m });
  }
  while (normalized.length && normalized[0].role !== 'user') normalized.shift();
  const context = `${personBlock(person, { calendar })}\n\n## Pendências abertas\n${list}\n\n## Mensagem da pessoa agora\n${userMessage}`;
  normalized.push({ role: 'user', content: context });

  const { text } = await callClaude({
    system,
    messages: normalized,
    format: zodOutputFormat(ChatSchema),
    effort: config.claude.triageEffort,
    maxTokens: 3000,
  });
  return parseJson(text, ChatSchema);
}
