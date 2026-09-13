// Resumo mensal de uma pessoa (usado na área do cliente e no portal do admin):
// números do mês, pendências, agenda, gasto com IA e o relatório escrito pela IA (cacheado).
import * as db from './db.js';
import { formatEvents } from './calendar.js';
import * as ai from './ai/claude.js';
import { logger } from './logger.js';

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** Epoch (s) da meia-noite local de (y, m, d) no fuso informado. */
function zonedEpoch(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const localAsUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'));
  return Math.floor((guess - (localAsUtc - guess)) / 1000);
}

export function currentMonthKey(tz = 'America/Sao_Paulo', date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(date).slice(0, 7);
}
export function normalizeMonthKey(key, tz) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(key || '')) ? key : currentMonthKey(tz);
}
export function monthRange(key, tz = 'America/Sao_Paulo') {
  const [y, m] = key.split('-').map(Number);
  const fromTs = zonedEpoch(y, m, 1, tz);
  const toTs = m === 12 ? zonedEpoch(y + 1, 1, 1, tz) : zonedEpoch(y, m + 1, 1, tz);
  return { fromTs, toTs, label: `${MONTHS[m - 1]} de ${y}` };
}
/** Últimos N meses (chaves YYYY-MM), do mais recente para o mais antigo. */
export function recentMonthKeys(tz, n = 6) {
  const out = [];
  let [y, m] = currentMonthKey(tz).split('-').map(Number);
  for (let i = 0; i < n; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m -= 1; if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

const cacheKey = (personId, key) => `monthly:${personId}:${key}`;

async function usageForMonth(personId, fromTs, key) {
  const daily = await db.usageDaily(personId, fromTs);
  const rows = daily.filter((r) => String(r.day).startsWith(key));
  const sum = (f) => rows.reduce((a, r) => a + Number(r[f] || 0), 0);
  return { calls: sum('calls'), input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens'), cache_read_tokens: sum('cache_read_tokens'), cost_usd: sum('cost_usd'), daily: rows };
}

/**
 * Monta o resumo do mês. Com autoGenerate, escreve o relatório da IA na primeira vez
 * que o mês é consultado (e guarda em cache).
 */
export async function monthlySummary(person, monthKey, { autoGenerate = false } = {}) {
  const tz = person.timezone || 'America/Sao_Paulo';
  const key = normalizeMonthKey(monthKey, tz);
  const { fromTs, toTs, label } = monthRange(key, tz);
  const stats = await db.periodStats(person.id, fromTs, toTs);
  const items = await db.itemsBetween(person.id, fromTs, toTs, 200);
  const events = await db.calendarEventsBetween(person.id, fromTs, toTs);
  const usage = await usageForMonth(person.id, fromTs, key);
  let report = null;
  const cached = await db.kvGet(cacheKey(person.id, key));
  if (cached) { try { report = JSON.parse(cached); } catch { report = null; } }
  const hasActivity = stats.itemsTotal > 0 || Object.keys(stats.messages).length > 0;
  if (!report && autoGenerate && hasActivity && ai.claudeConfigured()) {
    try { report = await generate(person, { key, label, stats, items, events, usage, tz }); }
    catch (e) { logger.error('Falha ao gerar relatório mensal', { person: person.name, err: String(e.message) }); }
  }
  return {
    month: key, label, fromTs, toTs, months: recentMonthKeys(tz, 6),
    stats, items: items.slice(0, 40), events, usage, report, hasActivity,
  };
}

async function generate(person, { key, label, stats, items, events, usage, tz }) {
  const data = await ai.monthlyReport({ person, monthLabel: label, stats, items, events: formatEvents(events, tz), usage });
  const report = { ...data, generated_at: Math.floor(Date.now() / 1000) };
  await db.kvSet(cacheKey(person.id, key), JSON.stringify(report));
  return report;
}

/** Regera o relatório (custa uma chamada à IA). minAgeSec limita a frequência. */
export async function regenerateMonthly(person, monthKey, { minAgeSec = 0 } = {}) {
  if (!ai.claudeConfigured()) throw new Error('ANTHROPIC_API_KEY ausente');
  const tz = person.timezone || 'America/Sao_Paulo';
  const key = normalizeMonthKey(monthKey, tz);
  if (minAgeSec > 0) {
    const cached = await db.kvGet(cacheKey(person.id, key));
    if (cached) {
      const prev = JSON.parse(cached);
      const age = Math.floor(Date.now() / 1000) - Number(prev.generated_at || 0);
      if (age < minAgeSec) { const err = new Error(`O relatório foi atualizado há pouco. Tente de novo em ${Math.ceil((minAgeSec - age) / 60)} min.`); err.status = 429; throw err; }
    }
  }
  const s = await monthlySummary(person, key);
  return generate(person, { key, label: s.label, stats: s.stats, items: s.items, events: s.events, usage: s.usage, tz });
}
