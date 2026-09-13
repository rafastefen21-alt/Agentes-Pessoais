// Agenda: lê um calendário no formato ICS (URL secreta do Google Agenda,
// calendário publicado do Outlook, etc.). Só leitura — sem OAuth.
import ical from 'node-ical';
import { replaceCalendarEvents, calendarEventsBetween } from './db.js';
import { logger } from './logger.js';

export async function syncCalendar(person) {
  if (!person.calendar_ics_url) return { ok: false, reason: 'sem URL' };
  const url = person.calendar_ics_url.replace(/^webcal:\/\//i, 'https://');
  const res = await fetch(url, { headers: { 'User-Agent': 'assistente-ia/1.0' } });
  if (!res.ok) throw new Error(`ICS HTTP ${res.status}`);
  const text = await res.text();
  const data = ical.sync.parseICS(text);
  const now = Date.now();
  const from = now - 2 * 86400000;
  const to = now + 30 * 86400000;
  const events = [];
  for (const k of Object.keys(data)) {
    const ev = data[k];
    if (!ev || ev.type !== 'VEVENT') continue;
    const push = (start, end) => {
      const s = start.getTime();
      if (s < from || s > to) return;
      events.push({
        uid: ev.uid || k,
        summary: ev.summary || '(sem título)',
        location: ev.location || '',
        description: String(ev.description || '').slice(0, 500),
        start_ts: Math.floor(s / 1000),
        end_ts: end ? Math.floor(end.getTime() / 1000) : null,
        all_day: ev.datetype === 'date',
      });
    };
    if (ev.rrule) {
      try {
        const dates = ev.rrule.between(new Date(from), new Date(to), true);
        const dur = ev.end && ev.start ? ev.end.getTime() - ev.start.getTime() : 0;
        const exdates = new Set(Object.values(ev.exdate || {}).map((d) => new Date(d).toISOString().slice(0, 10)));
        for (const d of dates) {
          if (exdates.has(d.toISOString().slice(0, 10))) continue;
          push(d, dur ? new Date(d.getTime() + dur) : null);
        }
      } catch (e) {
        logger.warn('Falha ao expandir recorrência', { uid: ev.uid, err: String(e.message) });
      }
    } else if (ev.start) {
      push(new Date(ev.start), ev.end ? new Date(ev.end) : null);
    }
  }
  await replaceCalendarEvents(person.id, events);
  return { ok: true, count: events.length };
}

export async function upcomingEvents(personId, days = 3) {
  const now = Math.floor(Date.now() / 1000);
  return calendarEventsBetween(personId, now - 3600, now + days * 86400);
}

export function formatEvents(events, timezone) {
  if (!events.length) return '(nenhum evento)';
  const tz = timezone || 'America/Sao_Paulo';
  const fmtFull = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fmtDay = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: '2-digit' });
  const fmtHour = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  return events.map((e) => {
    const startDate = new Date(e.start_ts * 1000);
    const start = e.all_day ? `${fmtDay.format(startDate)} (dia todo)` : fmtFull.format(startDate);
    const end = e.end_ts && !e.all_day ? '-' + fmtHour.format(new Date(e.end_ts * 1000)) : '';
    return `- ${start}${end}: ${e.summary}${e.location ? ` @ ${e.location}` : ''}`;
  }).join('\n');
}
