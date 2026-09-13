// Camada de IA (Claude). Três funções:
//   triage()  – classifica novas mensagens de uma conversa (urgência, resumo, sugestão de resposta)
//   digest()  – escreve o resumo periódico para mandar no WhatsApp da pessoa
//   chat()    – responde quando a pessoa conversa com o assistente no chat "Você"
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { insertUsage } from '../db.js';

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
- Formato para WhatsApp: use *negrito* para destacar e listas com "-". Nada de markdown com # ou tabelas. Não use emojis.`;

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
    type: z.enum(['send_reply', 'propose_reply', 'mark_done', 'send_digest', 'summarize_chat', 'none']).describe(
      'send_reply: a pessoa pediu EXPLICITAMENTE para enviar agora ("manda", "envia", "pode mandar", "responde pra ele que..."). ' +
      'propose_reply: você redigiu um rascunho e quer confirmação antes de enviar. ' +
      'mark_done: a pessoa disse que já resolveu/ignorar o item. send_digest: a pessoa pediu o resumo geral. ' +
      'summarize_chat: a pessoa pediu para resumir/relembrar a conversa com um contato (use chat_id da lista de conversas; o resumo será gerado e enviado em seguida, então na reply diga apenas que vai buscar).'),
    item_id: z.number().nullable().describe('ID do item (da lista de pendências) a que a ação se refere. null se não se aplica.'),
    chat_id: z.string().nullable().describe('Para summarize_chat: o chat_id exato da lista de conversas. null se não se aplica ou se ficou ambíguo (nesse caso pergunte na reply qual contato).'),
    text: z.string().nullable().describe('Texto da resposta a enviar ao contato (para send_reply / propose_reply).'),
  })),
});

// ---------- preços (US$ por 1 milhão de tokens) ----------
// [padrão do id do modelo, entrada, saída, leitura de cache]. Escrita de cache = 1,25x a entrada.
// Atualize aqui se a Anthropic mudar a tabela: https://www.anthropic.com/pricing
const PRICES = [
  [/fable-5|mythos-5/, 10, 50, 0.25],
  [/opus-5|opus-4-[678]/, 5, 25, 0.5],
  [/sonnet-5/, 2, 10, 0.2],
  [/sonnet-4-6/, 3, 15, 0.3],
  [/haiku-4-5/, 1, 5, 0.1],
];
export function estimateCost(model, usage = {}) {
  const row = PRICES.find(([re]) => re.test(String(model || ''))) || PRICES[1];
  const [, pin, pout, pcache] = row;
  const M = 1_000_000;
  return (usage.input_tokens || 0) * pin / M + (usage.output_tokens || 0) * pout / M
    + (usage.cache_read_input_tokens || 0) * pcache / M + (usage.cache_creation_input_tokens || 0) * pin * 1.25 / M;
}
async function recordUsage(meta, response) {
  if (!meta) return;
  const u = response.usage || {};
  const model = response.model || config.claude.model;
  try {
    await insertUsage({
      person_id: meta.personId, kind: meta.kind, model,
      input_tokens: u.input_tokens, output_tokens: u.output_tokens,
      cache_read_tokens: u.cache_read_input_tokens, cache_write_tokens: u.cache_creation_input_tokens,
      cost_usd: estimateCost(model, u),
    });
  } catch (e) {
    logger.warn('Não foi possível registrar uso da API', { err: String(e.message) });
  }
}

// ---------- chamada base ----------
async function callClaude({ system, messages, format, effort, maxTokens = 4000, meta }) {
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
  await recordUsage(meta, response);
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

function profileBlock(person) {
  if (!person.style_profile) return '';
  let p; try { p = JSON.parse(person.style_profile); } catch { return ''; }
  const lines = ['\n## Perfil aprendido com o histórico do WhatsApp'];
  if (p.contexto) lines.push(`Contexto: ${p.contexto}`);
  if (p.estilo) lines.push(`Como ela escreve: ${p.estilo}`);
  if (p.expressoes?.length) lines.push(`Expressões e marcas típicas: ${p.expressoes.join(' | ')}`);
  if (p.exemplos?.length) lines.push(`Exemplos reais de mensagens dela:\n${p.exemplos.map((e) => `- "${e}"`).join('\n')}`);
  if (p.contatos?.length) lines.push(`Contatos importantes: ${p.contatos.map((c) => `${c.nome} (${c.relacao})`).join('; ')}`);
  if (p.prioridades?.length) lines.push(`O que costuma ser prioridade: ${p.prioridades.join('; ')}`);
  lines.push('Ao sugerir respostas, imite esse estilo (tamanho, tom, saudações, pontuação, vocabulário) — deve parecer que foi ela quem escreveu.');
  return lines.join('\n');
}

function personBlock(person, extras = {}) {
  const now = new Intl.DateTimeFormat('pt-BR', { timeZone: person.timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  return [
    `## Sobre a pessoa que você assiste`,
    `Nome: ${person.name}`,
    `Agora: ${now} (${person.timezone})`,
    person.context_notes ? `Contexto e prioridades (escrito por ela):\n${person.context_notes}` : 'Contexto: (não informado)',
    profileBlock(person),
    extras.calendar ? `\n## Agenda (próximos dias)\n${extras.calendar}` : '',
  ].filter(Boolean).join('\n');
}

// ---------- perfil de estilo e contexto (aprendido do histórico) ----------
const ProfileSchema = z.object({
  contexto: z.string().describe('2 a 4 frases: o que a pessoa faz, com quem lida, que tipo de assunto domina as conversas.'),
  estilo: z.string().describe('Como ela escreve: formalidade, tamanho das mensagens, saudações e despedidas, pontuação, abreviações, uso de áudio/emoji, tom com clientes vs. amigos.'),
  expressoes: z.array(z.string()).describe('5 a 12 expressões, aberturas ou fechos que ela usa de verdade (copiados das mensagens).'),
  exemplos: z.array(z.string()).describe('4 a 8 mensagens reais dela, curtas, que representam bem o jeito de escrever (sem dados sensíveis).'),
  contatos: z.array(z.object({ nome: z.string(), relacao: z.string().describe('cliente, fornecedor, sócio, família, amigo, equipe…'), observacao: z.string().nullable() })).describe('Até 12 contatos mais relevantes e o que se percebe da relação.'),
  prioridades: z.array(z.string()).describe('O que parece ter prioridade para ela (tipos de pedido, pessoas, prazos).'),
});
export async function styleProfile({ person, outgoing, incoming, contacts }) {
  const fmt = (m) => `[${m.chat_id.split('@')[0]}] ${m.text.slice(0, 300)}`;
  const user = [
    `## Pessoa: ${person.name}`,
    person.context_notes ? `Contexto informado por ela: ${person.context_notes}` : '',
    `\n## Contatos com mais conversa (número, nome, recebidas/enviadas)\n${contacts.map((c) => `- ${c.chat_id.split('@')[0]} ${c.name || ''}: ${c.received}/${c.sent}`).join('\n')}`,
    `\n## Mensagens ESCRITAS PELA PESSOA (mais recentes primeiro)\n${outgoing.map(fmt).join('\n')}`,
    `\n## Amostra de mensagens RECEBIDAS\n${incoming.map((m) => `[${m.chat_id.split('@')[0]} ${m.sender_name || ''}] ${m.text.slice(0, 200)}`).join('\n')}`,
    `\nEstude o material e descreva o contexto e o estilo de escrita da pessoa. Seja específico e fiel ao que está nas mensagens; não invente. Responda no formato JSON pedido.`,
  ].filter(Boolean).join('\n');
  const { text } = await callClaude({
    system: 'Você analisa históricos de WhatsApp para que uma assistente pessoal consiga escrever exatamente como o dono da conta. Responda em português do Brasil, sem emojis.',
    messages: [{ role: 'user', content: user }],
    format: zodOutputFormat(ProfileSchema),
    effort: config.claude.digestEffort,
    maxTokens: 4000,
    meta: { personId: person.id, kind: 'perfil' },
  });
  return parseJson(text, ProfileSchema);
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
    meta: { personId: p.person.id, kind: 'triagem' },
  });
  const data = parseJson(text, TriageSchema);
  return { ...data, urgency_level: URGENCY_LEVEL[data.urgency] };
}

// ---------- resumo periódico ----------
export async function digest({ person, items, calendar, stats, sinceLabel }) {
  const mine = items.filter((it) => it.owner === 'me');
  const theirs = items.filter((it) => it.owner !== 'me');
  const fmtItem = (it) => `- #${it.id} [${URGENCY_LABEL[it.urgency]}] (${it.channel}) ${it.contact_name}: ${it.summary}${it.needs_reply ? ' — aguarda resposta' : ''}${it.deadline ? ` — prazo: ${it.deadline}` : ''}${it.suggested_reply ? `\n    sugestão: "${it.suggested_reply}"` : ''}`;
  const list = theirs.length ? theirs.map(fmtItem).join('\n') : '(nenhuma pendência)';
  const promises = mine.length ? mine.map(fmtItem).join('\n') : '(nenhum compromisso registrado)';
  const user = [
    personBlock(person, { calendar }),
    `\n## Volume ${sinceLabel}: WhatsApp ${stats.last24h?.whatsapp || 0} mensagens, e-mail ${stats.last24h?.email || 0}`,
    `\n## Pendências abertas (o que os outros esperam dela)\n${list}`,
    `\n## Compromissos que ELA assumiu nas conversas (o que ela ficou de fazer)\n${promises}`,
    `\nEscreva o RESUMO para enviar no WhatsApp de ${person.name.split(' ')[0]}. Estrutura: (1) o que ela ficou de fazer e está vencendo (hoje/amanhã), com "#id"; (2) o que é urgente/precisa de resposta, com a sugestão de resposta quando houver, citando "#id" para ela responder "enviar #id"; (3) agenda de hoje e amanhã e conflitos; (4) o resto em uma linha cada, se houver. Máximo ~1500 caracteres. Se não houver nada relevante, diga isso em uma frase simpática e curta.`,
  ].join('\n');
  const { text } = await callClaude({
    system: SYSTEM_BASE + '\n\nSua tarefa agora é escrever o resumo periódico (texto puro para WhatsApp, sem JSON).',
    messages: [{ role: 'user', content: user }],
    effort: config.claude.digestEffort,
    maxTokens: 3000,
    meta: { personId: person.id, kind: 'resumo' },
  });
  return text;
}

// ---------- compromissos assumidos pela pessoa ----------
const CommitSchema = z.object({
  compromissos: z.array(z.object({
    descricao: z.string().describe('O que a pessoa ficou de fazer, curto e concreto (ex.: "enviar o relatório de manutenção do elevador 2").'),
    para_quem: z.string().describe('Nome do contato/empresa a quem prometeu.'),
    quando_texto: z.string().nullable().describe('Quando, como foi dito (ex.: "amanhã cedo", "até sexta", "semana que vem"). null se não há prazo.'),
    due_at: z.string().nullable().describe('Data/hora limite em ISO 8601 com fuso (ex.: 2026-09-15T09:00:00-03:00), inferida a partir de "agora" e do texto. "amanhã" sem hora = 09:00; "até sexta" = sexta 18:00; "semana que vem" = segunda 09:00. null se não dá para inferir.'),
    ja_cumprido: z.boolean().describe('true se, pela própria conversa, a pessoa já fez o que prometeu.'),
  })),
});
/** Lê mensagens ESCRITAS pela pessoa numa conversa e extrai o que ela ficou de fazer. */
export async function extractCommitments({ person, contactLabel, history, fresh }) {
  const fmtTs = (ts) => new Intl.DateTimeFormat('pt-BR', { timeZone: person.timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));
  const line = (m) => `[${fmtTs(m.ts)}] ${m.direction === 'out' ? person.name + ' (ela)' : (m.sender_name || 'contato')}: ${m.text}`;
  const freshIds = new Set(fresh.map((m) => m.id));
  const user = [
    personBlock(person),
    `\n## Conversa com: ${contactLabel}`,
    `\n## Histórico recente\n${history.filter((m) => !freshIds.has(m.id)).map(line).join('\n') || '(vazio)'}`,
    `\n## Mensagens NOVAS escritas pela pessoa\n${fresh.map(line).join('\n')}`,
    `\nListe apenas compromissos REAIS que a pessoa assumiu nessas mensagens novas (promessas de enviar, ligar, ir, pagar, resolver, agendar). Nada de intenções vagas. Se não houver, devolva lista vazia.`,
  ].join('\n');
  const { text } = await callClaude({
    system: SYSTEM_BASE + '\n\nSua tarefa agora é extrair COMPROMISSOS que a própria pessoa assumiu e devolver um JSON.',
    messages: [{ role: 'user', content: user }],
    format: zodOutputFormat(CommitSchema),
    effort: config.claude.triageEffort,
    maxTokens: 1500,
    meta: { personId: person.id, kind: 'compromissos' },
  });
  return parseJson(text, CommitSchema).compromissos;
}

/** Resumo de uma conversa específica, a pedido da pessoa ("resume a última conversa com X"). */
export async function summarizeConversation({ person, contactLabel, messages, request }) {
  const fmtTs = (ts) => new Intl.DateTimeFormat('pt-BR', { timeZone: person.timezone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts * 1000));
  const lines = messages.map((m) => `[${fmtTs(m.ts)}] ${m.direction === 'out' ? person.name.split(' ')[0] : (m.sender_name || 'contato')}: ${m.text}`).join('\n');
  const user = [
    personBlock(person),
    `\n## Conversa com: ${contactLabel}`,
    `\n## Mensagens (mais antigas primeiro)\n${lines}`,
    `\n## O que a pessoa pediu\n${request}`,
    `\nEscreva o resumo para o WhatsApp dela: (1) assunto e situação atual em 2-3 frases; (2) o que ficou combinado, com quem faz o quê e quando; (3) o que ainda está em aberto ou esperando alguém; (4) datas e valores citados. Use *negrito* nos pontos-chave e listas com "-". Máximo ~1200 caracteres. Se a conversa for antiga, diga a data da última mensagem.`,
  ].join('\n');
  const { text } = await callClaude({
    system: SYSTEM_BASE + '\n\nSua tarefa agora é RESUMIR uma conversa específica (texto puro para WhatsApp, sem JSON).',
    messages: [{ role: 'user', content: user }],
    effort: config.claude.triageEffort,
    maxTokens: 2000,
    meta: { personId: person.id, kind: 'resumo_conversa' },
  });
  return text;
}

// ---------- relatório mensal (área do cliente) ----------
const MonthlySchema = z.object({
  resumo: z.string().describe('2 a 4 frases sobre como foi o mês: volume, o que dominou a atenção, o que ficou resolvido.'),
  destaques: z.array(z.string()).describe('Os 3 a 8 pontos mais importantes do mês, um por item, concretos (nomes, valores, prazos).'),
  agenda: z.array(z.string()).describe('Compromissos e prazos relevantes do mês e os que vêm a seguir, um por item.'),
  recomendacoes: z.array(z.string()).describe('Até 4 sugestões práticas para o próximo mês (o que responder, o que cobrar, o que agendar).'),
});
export async function monthlyReport({ person, monthLabel, stats, items, events, usage }) {
  const list = items.length
    ? items.map((it) => `- [${URGENCY_LABEL[it.urgency]}] (${it.channel}) ${it.contact_name}: ${it.summary}${it.deadline ? ` — prazo: ${it.deadline}` : ''} — status: ${it.status}`).join('\n')
    : '(nenhuma pendência registrada)';
  const user = [
    personBlock(person),
    `\n## Mês: ${monthLabel}`,
    `Mensagens lidas: WhatsApp ${stats.messages?.whatsapp || 0}, e-mail ${stats.messages?.email || 0}, de ${stats.contacts} contatos.`,
    `Pendências identificadas: ${stats.itemsTotal} (urgentes: ${stats.urgent}; respondidas: ${stats.items?.replied || 0}; resolvidas: ${stats.items?.done || 0}; ainda abertas: ${(stats.items?.open || 0) + (stats.items?.notified || 0)}).`,
    `Avisos enviados pela assistente: urgentes ${stats.alerts?.urgent || 0}, resumos ${stats.alerts?.digest || 0}, conversas ${stats.alerts?.chat || 0}.`,
    `\n## Pendências do mês\n${list}`,
    `\n## Agenda do mês\n${events || '(nenhum evento)'}`,
    `\nEscreva o relatório do mês para ${person.name.split(' ')[0]} ler no portal. Texto simples, sem emojis, sem markdown. Responda no formato JSON pedido.`,
  ].join('\n');
  const { text } = await callClaude({
    system: SYSTEM_BASE + '\n\nSua tarefa agora é escrever o RELATÓRIO MENSAL da pessoa e devolver um JSON.',
    messages: [{ role: 'user', content: user }],
    format: zodOutputFormat(MonthlySchema),
    effort: config.claude.digestEffort,
    maxTokens: 3000,
    meta: { personId: person.id, kind: 'relatorio_mensal' },
  });
  return parseJson(text, MonthlySchema);
}

// ---------- conversa com o assistente ----------
export async function chat({ person, history, items, calendar, userMessage, chats = [] }) {
  const chatList = chats.length
    ? chats.map((c) => `- chat_id ${c.chat_id} | ${c.name || '(sem nome)'} | última: ${new Date(c.last_ts * 1000).toLocaleDateString('pt-BR')} | "${c.last_text}"`).join('\n')
    : '(nenhuma conversa registrada ainda)';
  const list = items.length
    ? items.map((it) => `- item_id ${it.id} [${URGENCY_LABEL[it.urgency]}] (${it.channel}, chat ${it.chat_id}) ${it.contact_name}: ${it.summary}${it.needs_reply ? ' — aguarda resposta' : ''}${it.suggested_reply ? `\n    sugestão atual: "${it.suggested_reply}"` : ''}`).join('\n')
    : '(nenhuma pendência aberta)';
  const system = SYSTEM_BASE + `\n\nAgora você está CONVERSANDO com a pessoa pelo WhatsApp. Ela pode pedir resumos, detalhes de uma conversa, redigir/ajustar respostas, mandar respostas para contatos, marcar coisas como resolvidas ou perguntar sobre a agenda.
Regras de ação:
- Só use "send_reply" quando ela pediu explicitamente para enviar agora. Se ela pediu para "preparar", "escrever", "sugerir" ou se houver dúvida, use "propose_reply" e peça confirmação na reply (ela responde "enviar").
- Toda ação de envio precisa de item_id válido da lista de pendências e do texto completo.
- Se ela pedir para resumir/relembrar a conversa com alguém ("resume a última conversa com o síndico do prédio X", "o que combinei com o fornecedor Y?"), escolha o chat_id certo na lista de conversas (pelo nome, pelo número ou pela última mensagem, ajudado pelo perfil de contatos) e use "summarize_chat". Se houver mais de um candidato, pergunte qual em vez de chutar.
- Se ela mencionar algo que não está nas pendências, nas conversas nem no histórico, diga que não tem essa informação.`;
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
  const context = `${personBlock(person, { calendar })}\n\n## Pendências abertas\n${list}\n\n## Conversas recentes (para pedidos de resumo)\n${chatList}\n\n## Mensagem da pessoa agora\n${userMessage}`;
  normalized.push({ role: 'user', content: context });

  const { text } = await callClaude({
    system,
    messages: normalized,
    format: zodOutputFormat(ChatSchema),
    effort: config.claude.triageEffort,
    maxTokens: 3000,
    meta: { personId: person.id, kind: 'conversa' },
  });
  return parseJson(text, ChatSchema);
}
