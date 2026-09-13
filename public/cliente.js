/* Área do cliente: login próprio, gastos, resumo do mês da assistente e agenda. */
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $toast = document.getElementById('toast');
document.getElementById('brandMark').innerHTML = icon('sparkles');
document.getElementById('logoutBtn').innerHTML = icon('logout') + ' Sair';

async function api(path, opts = {}) {
  const res = await fetch('/api/client' + path, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({ ok: false, error: 'resposta inválida' }));
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('não autenticado'); }
  if (!res.ok || data.ok === false) throw new Error(data.error || `erro ${res.status}`);
  return data;
}
function toast(msg, err = false) {
  $toast.innerHTML = icon(err ? 'alertCircle' : 'check') + ' ' + esc(msg); $toast.hidden = false; $toast.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { $toast.hidden = true; }, err ? 6000 : 3000);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(usd, rate) {
  const v = Number(usd || 0);
  const us = 'US$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: v < 0.1 && v > 0 ? 4 : 2 });
  return rate ? `${us} (R$ ${(v * rate).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : us;
}
const URG = { 1: 'baixa', 2: 'média', 3: 'alta', 4: 'crítica' };
const STATUS = { open: ['warn', 'em aberto'], notified: ['warn', 'avisado'], replied: ['ok', 'respondido'], done: ['ok', 'resolvido'], dismissed: ['', 'ignorado'] };
function monthLabel(key) { const [y, m] = key.split('-'); return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' }); }
function fmtDay(ts) { return new Date(ts * 1000).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }); }
function fmtTime(ts) { return new Date(ts * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }

function showLogin() {
  $nav.hidden = true;
  $app.innerHTML = `
    <div class="card glass login">
      <h1>${icon('lock')} Entrar</h1>
      <p class="lead">Acesse o painel da sua assistente: gastos, resumo do mês e agenda.</p>
      <form id="loginForm">
        <div class="field"><label>E-mail</label><input type="email" name="email" autocomplete="username" autofocus></div>
        <div class="field"><label>Senha</label><input type="password" name="password" autocomplete="current-password"></div>
        <button class="primary" type="submit">${icon('login')} Entrar</button>
      </form>
    </div>`;
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/login', { method: 'POST', body: { email: e.target.email.value, password: e.target.password.value } }); load(); }
    catch (err) { toast(err.message, true); }
  };
}
document.getElementById('logoutBtn').onclick = async () => { await api('/logout', { method: 'POST' }); showLogin(); };

let currentMonth = '';
async function load(month) {
  $app.innerHTML = '<div class="loading">Carregando…</div>';
  let s;
  try { s = await api(`/summary${month ? `?month=${month}` : ''}`); } catch (e) { if (e.message !== 'não autenticado') $app.innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
  currentMonth = s.month;
  $nav.hidden = false;
  document.getElementById('who').textContent = s.person.name;
  const st = s.stats;
  const openCount = (st.items.open || 0) + (st.items.notified || 0);
  const r = s.report;
  const items = s.items.filter((i) => i.urgency >= 2).slice(0, 12);
  $app.innerHTML = `
    <h1>Olá, ${esc(s.person.name.split(' ')[0])}
      <select id="monthSel" style="width:auto;padding:7px 12px;border-radius:999px">${s.months.map((k) => `<option value="${k}" ${k === s.month ? 'selected' : ''}>${esc(monthLabel(k))}</option>`).join('')}</select>
    </h1>
    <div class="kpis" style="margin-bottom:16px">
      <div class="kpi"><div class="v">${(st.messages.whatsapp || 0) + (st.messages.email || 0)}</div><div class="l">${icon('inbox')} mensagens lidas (${st.messages.whatsapp || 0} WhatsApp, ${st.messages.email || 0} e-mail)</div></div>
      <div class="kpi"><div class="v">${st.itemsTotal}</div><div class="l">${icon('bookmark')} pendências identificadas</div></div>
      <div class="kpi"><div class="v">${st.urgent}</div><div class="l">${icon('alert')} urgentes</div></div>
      <div class="kpi"><div class="v">${(st.items.replied || 0) + (st.items.done || 0)}</div><div class="l">${icon('check')} resolvidas · ${openCount} em aberto</div></div>
      <div class="kpi"><div class="v">${money(s.usage.cost_usd, s.usdBrl)}</div><div class="l">${icon('coins')} gasto com IA no mês (${s.usage.calls} chamadas)</div></div>
    </div>
    <div class="two">
      <div>
        <div class="card">
          <h2>${icon('sparkles')} Resumo do mês <span class="grow"></span><button class="small" id="regenBtn">${icon('refresh')} Atualizar</button></h2>
          ${r ? `
            <p>${esc(r.resumo)}</p>
            ${r.destaques?.length ? `<h3>Principais pontos</h3><ul class="clean">${r.destaques.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
            ${r.recomendacoes?.length ? `<h3 style="margin-top:14px">Para o próximo mês</h3><ul class="clean">${r.recomendacoes.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
            <div class="hint" style="margin-top:12px">Escrito pela assistente em ${new Date(r.generated_at * 1000).toLocaleString('pt-BR')}.</div>`
          : `<div class="empty">${s.hasActivity ? 'O relatório ainda não foi gerado. Clique em Atualizar.' : 'Ainda não há atividade registrada neste mês.'}</div>`}
        </div>
        <div class="card">
          <h2>${icon('bookmark')} Pendências mais relevantes</h2>
          ${items.length ? `<div class="list">${items.map((it) => `
            <div class="item u${it.urgency}">
              <div class="top"><span class="who">${esc(it.contact_name)} <span class="badge">${it.channel === 'email' ? 'e-mail' : 'WhatsApp'}</span> <span class="badge ${it.urgency >= 3 ? 'warn' : ''}">${URG[it.urgency]}</span></span>
                <span class="badge ${(STATUS[it.status] || [''])[0]}">${(STATUS[it.status] || [it.status])[1]}</span></div>
              <div class="sum">${esc(it.summary)}${it.deadline ? ` <b>· prazo: ${esc(it.deadline)}</b>` : ''}</div>
            </div>`).join('')}</div>` : '<div class="empty">Nenhuma pendência relevante neste mês.</div>'}
        </div>
      </div>
      <div>
        <div class="card">
          <h2>${icon('calendar')} Agenda do mês</h2>
          ${s.events.length ? `<table>${s.events.map((e) => `<tr><td class="muted" style="white-space:nowrap">${fmtDay(e.start_ts)}${e.all_day ? '' : ' ' + fmtTime(e.start_ts)}</td><td>${esc(e.summary)}${e.location ? `<br><span class="muted small">${esc(e.location)}</span>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">Nenhum compromisso registrado neste mês.</div>'}
          ${r?.agenda?.length ? `<h3 style="margin-top:14px">Observações da assistente</h3><ul class="clean">${r.agenda.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}
        </div>
        <div class="card">
          <h2>${icon('coins')} Gasto com IA</h2>
          <table><tr><th>Chamadas</th><th>Tokens entrada</th><th>Tokens saída</th><th>Custo</th></tr>
            <tr><td>${s.usage.calls}</td><td>${Number(s.usage.input_tokens).toLocaleString('pt-BR')}</td><td>${Number(s.usage.output_tokens).toLocaleString('pt-BR')}</td><td><b>${money(s.usage.cost_usd, s.usdBrl)}</b></td></tr></table>
          ${s.usage.daily.length ? `<h3 style="margin-top:14px">Por dia</h3><table>${s.usage.daily.map((d) => `<tr><td class="muted">${esc(d.day)}</td><td>${d.calls} chamadas</td><td style="text-align:right">${money(d.cost_usd, s.usdBrl)}</td></tr>`).join('')}</table>` : ''}
          <div class="hint" style="margin-top:10px">Valor estimado pelos tokens de cada chamada e pela tabela de preços da Anthropic.</div>
        </div>
      </div>
    </div>`;
  document.getElementById('monthSel').onchange = (e) => load(e.target.value);
  document.getElementById('regenBtn').onclick = async (e) => {
    e.target.disabled = true; toast('Escrevendo o relatório do mês…');
    try { await api(`/summary/regenerate?month=${currentMonth}`, { method: 'POST' }); load(currentMonth); }
    catch (err) { toast(err.message, true); e.target.disabled = false; }
  };
}

(async () => {
  try { const me = await api('/me'); if (me.authed) load(); else showLogin(); } catch { showLogin(); }
})();
