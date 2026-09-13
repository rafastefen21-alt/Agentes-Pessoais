// Carrega e valida as variáveis de ambiente em um único lugar.
import 'dotenv/config';

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function bool(v, def = false) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export const config = {
  port: num(process.env.PORT, 3000),
  // URL pública deste servidor (a Evolution precisa dela para chamar o webhook)
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  adminPassword: process.env.ADMIN_PASSWORD || '',
  appSecret: process.env.APP_SECRET || '',
  logLevel: process.env.LOG_LEVEL || 'info',
  dataDir: process.env.DATA_DIR || 'data',
  // Postgres (Supabase). Vazio = SQLite local em DATA_DIR.
  databaseUrl: (process.env.DATABASE_URL || '').trim(),

  evolution: {
    url: (process.env.EVOLUTION_URL || '').replace(/\/+$/, ''),
    apikey: process.env.EVOLUTION_APIKEY || '',
    // Segredo que vai na URL do webhook para validar a origem
    webhookToken: process.env.EVOLUTION_WEBHOOK_TOKEN || process.env.APP_SECRET || '',
    // Instância opcional de um número "assistente" dedicado (modo notify=assistant)
    assistantInstance: process.env.ASSISTANT_INSTANCE || '',
    // Prefixo usado para nomear instâncias criadas pelo portal
    instancePrefix: process.env.INSTANCE_PREFIX || 'assist',
  },

  claude: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.CLAUDE_MODEL || 'claude-opus-5',
    triageEffort: process.env.CLAUDE_TRIAGE_EFFORT || 'medium',
    digestEffort: process.env.CLAUDE_DIGEST_EFFORT || 'high',
    fallbacks: bool(process.env.CLAUDE_FALLBACKS, true),
  },

  agent: {
    // Espera (ms) para juntar mensagens picadas do mesmo chat antes de triar
    debounceMs: num(process.env.TRIAGE_DEBOUNCE_MS, 60000),
    // Intervalo (ms) de leitura dos e-mails
    emailPollMs: num(process.env.EMAIL_POLL_MS, 180000),
    // Intervalo (ms) de atualização da agenda (ICS)
    calendarPollMs: num(process.env.CALENDAR_POLL_MS, 900000),
    // Marca que identifica mensagens escritas pelo assistente no chat "Você"
    marker: process.env.ASSISTANT_MARKER || '🤖',
    // Ignorar grupos de WhatsApp por padrão (configurável por pessoa)
    ignoreGroupsDefault: bool(process.env.IGNORE_GROUPS_DEFAULT, true),
  },
};

export function validateConfig() {
  const problems = [];
  if (!config.adminPassword) problems.push('ADMIN_PASSWORD ausente (o portal fica sem senha!)');
  if (!config.appUrl) problems.push('APP_URL ausente (a Evolution não conseguirá enviar webhooks)');
  if (!config.evolution.url) problems.push('EVOLUTION_URL ausente');
  if (!config.evolution.apikey) problems.push('EVOLUTION_APIKEY ausente');
  if (!config.claude.apiKey) problems.push('ANTHROPIC_API_KEY ausente (a IA não vai funcionar)');
  if (!config.databaseUrl) problems.push('DATABASE_URL ausente (usando SQLite local; em produção use o Postgres do Supabase)');
  return problems;
}

export default config;
