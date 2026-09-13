/* Portal — SPA simples em JS puro. Rotas: #/ (pessoas), #/p/:id (pessoa), #/status */
const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $toast = document.getElementById('toast');
let pollTimer = null;

// ---------- utilidades ----------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'resposta inválida' }));
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('não autenticado'); }
  if (!res.ok || data.ok === false) throw new Error(data.error || `erro ${res.status}`);
  return data;
}
function toast(msg, err = false) {
  $toast.textContent = msg; $toast.hidden = false; $toast.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { $toast.hidden = true; }, err ? 6000 : 3000);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtTs(ts) { return ts ? new Date(ts * 1000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; }
function stateBadge(s) {
  const map = { open: ['ok', 'Conectado'], connecting: ['warn', 'Aguardando QR'], close: ['bad', 'Desconectado'], disconnected: ['bad', 'Não conectado'], missing: ['bad', 'Instância ausente'] };
  const [cls, label] = map[s] || ['', s || '—'];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}
const URG = { 1: 'baixa', 2: 'média', 3: 'alta', 4: 'crítica' };
function money(usd, rate) {
  const v = Number(usd || 0);
  const us = 'US$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: v < 0.1 && v > 0 ? 4 : 2 });
  return rate ? `${us} (R$ ${(v * rate).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : us;
}
function tokens(n) { return Number(n || 0).toLocaleString('pt-BR'); }
function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } if (typeof stopWaPolls === 'function') stopWaPolls(); }

// ---------- login ----------
function showLogin() {
  stopPolling();
  $nav.hidden = true;
  $app.innerHTML = `
    <div class="card login">
      <h1>Entrar</h1>
      <form id="loginForm">
        <div class="field"><label>Senha do portal</label><input type="password" name="password" autofocus></div>
        <button class="primary" type="submit">Entrar</button>
      </form>
    </div>`;
  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: { password: e.target.password.value } });
      $nav.hidden = false; route();
    } catch (err) { toast(err.message, true); }
  };
}
document.getElementById('logoutBtn').onclick = async () => { await api('/logout', { method: 'POST' }); showLogin(); };

// ---------- lista de pessoas ----------
async function viewPeople() {
  stopPolling();
  const { people, usdBrl } = await api('/people');
  const cards = people.map((p) => `
    <div class="card person-card" onclick="location.hash='#/p/${p.id}'">
      <div class="row"><span class="name grow">${esc(p.name)}</span>${p.active ? '' : '<span class="badge bad">pausado</span>'}</div>
      <div class="meta">📱 Pessoa: ${stateBadge(p.wa_state)} ${esc(p.phone || '')}${p.notify_mode === 'assistant' ? `<br>🤖 Assistente: ${stateBadge(p.assistant_state)} ${esc(p.assistant_phone || '')}` : '<br>🤖 Avisos pela conversa "Você"'}</div>
      <div class="meta">${p.email_enabled ? '✉️ ' + esc(p.imap_user) : '✉️ e-mail não configurado'}${p.calendar_ics_url ? ' · 📅 agenda' : ''}</div>
      <div class="stats">
        <span>24h: <b>${p.stats.last24h.whatsapp || 0}</b> WhatsApp · <b>${p.stats.last24h.email || 0}</b> e-mails</span>
        <span>Pendências: <b>${p.stats.openItems}</b> (<b>${p.stats.urgentItems}</b> urgentes)</span>
        <span>IA no mês: <b>${money(p.usage_month?.cost_usd, usdBrl)}</b></span>
      </div>
    </div>`).join('');
  $app.innerHTML = `
    <div class="row" style="margin-bottom:16px"><h1 class="grow" style="margin:0">Pessoas com assistente</h1><button class="primary" id="newBtn">+ Nova pessoa</button></div>
    ${people.length ? `<div class="grid">${cards}</div>` : '<div class="card empty">Nenhuma pessoa ainda. Clique em "Nova pessoa" para criar o primeiro assistente.</div>'}
    <div class="card" id="newForm" hidden>
      <h2>Nova pessoa</h2>
      <form id="createForm">
        <div class="two">
          <div class="field"><label>Nome</label><input name="name" required placeholder="Ex.: Rafael Marques"></div>
          <div class="field"><label>Número do WhatsApp (com DDI, só dígitos)</label><input name="phone" placeholder="5511999998888"><div class="hint">Pode deixar em branco: é detectado ao conectar o WhatsApp.</div></div>
        </div>
        <div class="field"><label>Contexto para a assistente (quem é a pessoa, prioridades, clientes VIP, tom de resposta)</label>
          <textarea name="context_notes" placeholder="Ex.: Sou dono de uma agência de marketing. Clientes têm prioridade máxima. Fornecedores podem esperar. Respondo de forma curta e cordial. Minha esposa é a Ana; família sempre importante."></textarea></div>
        <div class="two">
          <div class="field"><label>Fuso horário</label><input name="timezone" value="America/Sao_Paulo"></div>
          <div class="field"><label>Ler grupos de WhatsApp?</label><select name="ignore_groups"><option value="1">Não (ignorar grupos)</option><option value="0">Sim (ler grupos também)</option></select></div>
        </div>
        <div class="row"><button class="primary" type="submit">Criar assistente</button><button type="button" id="cancelNew">Cancelar</button></div>
      </form>
    </div>`;
  document.getElementById('newBtn').onclick = () => { document.getElementById('newForm').hidden = false; };
  document.getElementById('cancelNew').onclick = () => { document.getElementById('newForm').hidden = true; };
  document.getElementById('createForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const { person } = await api('/people', { method: 'POST', body: { name: f.get('name'), phone: f.get('phone'), context_notes: f.get('context_notes'), timezone: f.get('timezone'), ignore_groups: f.get('ignore_groups') === '1' } });
      toast('Pessoa criada. Agora conecte o WhatsApp.');
      location.hash = `#/p/${person.id}`;
    } catch (err) { toast(err.message, true); }
  };
}

// ---------- pessoa ----------
let currentTab = 'whatsapp';
async function viewPerson(id) {
  stopPolling();
  let data;
  try { data = await api(`/people/${id}`); } catch (e) { $app.innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
  const { person: p } = data;
  const tabs = [['whatsapp', '📱 WhatsApp'], ['email', '✉️ E-mail'], ['calendar', '📅 Agenda'], ['prefs', '⚙️ Preferências'], ['items', '📌 Pendências'], ['chat', '💬 Conversa com a assistente'], ['messages', '📥 Mensagens lidas'], ['usage', '💰 Custos']];
  $app.innerHTML = `
    <div class="row" style="margin-bottom:12px">
      <a href="#/">← Pessoas</a>
      <h1 class="grow" style="margin:0">${esc(p.name)} <span class="small muted">pessoa</span> ${stateBadge(p.wa_state)}${p.notify_mode === 'assistant' ? ` <span class="small muted">assistente</span> ${stateBadge(p.assistant_state)}` : ''}</h1>
      <button id="digestBtn">Enviar resumo agora</button>
      <button id="testBtn">Mensagem de teste</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${k === currentTab ? 'active' : ''}">${l}</button>`).join('')}</div>
    <div id="tabBody"></div>`;
  document.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { currentTab = b.dataset.tab; viewPerson(id); }; });
  document.getElementById('digestBtn').onclick = async () => { try { toast('Gerando resumo…'); await api(`/people/${id}/digest`, { method: 'POST' }); toast('Resumo enviado no WhatsApp.'); } catch (e) { toast(e.message, true); } };
  document.getElementById('testBtn').onclick = async () => { try { await api(`/people/${id}/notify`, { method: 'POST', body: {} }); toast('Mensagem de teste enviada.'); } catch (e) { toast(e.message, true); } };
  const body = document.getElementById('tabBody');
  ({ whatsapp: tabWhatsApp, email: tabEmail, calendar: tabCalendar, prefs: tabPrefs, items: tabItems, chat: tabChat, messages: tabMessages, usage: tabUsage })[currentTab](body, data);
}

async function tabUsage(body, { person: p }) {
  body.innerHTML = '<div class="loading">Carregando custos…</div>';
  const u = await api(`/people/${p.id}/usage`);
  const row = (label, s) => `<tr><td>${label}</td><td>${s.calls}</td><td>${tokens(s.input_tokens)}</td><td>${tokens(s.output_tokens)}</td><td>${tokens(s.cache_read_tokens)}</td><td><b>${money(s.cost_usd, u.usdBrl)}</b></td></tr>`;
  const head = '<tr><th>Período</th><th>Chamadas</th><th>Tokens entrada</th><th>Tokens saída</th><th>Lidos do cache</th><th>Custo</th></tr>';
  body.innerHTML = `
    <div class="card"><h2>Gasto com IA — ${esc(p.name)}</h2>
      <table>${head}${row('Hoje', u.today)}${row('Últimos 7 dias', u.last7d)}${row('Este mês', u.month)}${row('Últimos 30 dias', u.last30d)}${row('Desde o início', u.total)}</table>
      <div class="hint" style="margin-top:8px">Valores estimados a partir dos tokens de cada chamada e da tabela de preços da Anthropic (tokens lidos do cache custam ~10% da entrada). A fatura oficial é a do console da Anthropic.</div>
    </div>
    <div class="card"><h2>Por tipo de uso (30 dias)</h2>
      ${u.byKind30d.length ? `<table><tr><th>Tipo</th><th>Chamadas</th><th>Tokens entrada</th><th>Tokens saída</th><th>Lidos do cache</th><th>Custo</th></tr>${u.byKind30d.map((k) => row(esc(k.kind), k)).join('')}</table>` : '<div class="empty">Nenhuma chamada ainda.</div>'}
    </div>
    <div class="card"><h2>Por dia (30 dias)</h2>
      ${u.daily.length ? `<table><tr><th>Dia</th><th>Chamadas</th><th>Tokens entrada</th><th>Tokens saída</th><th>Lidos do cache</th><th>Custo</th></tr>${u.daily.map((d) => row(esc(d.day), d)).join('')}</table>` : '<div class="empty">Nenhuma chamada ainda.</div>'}
    </div>`;
}

// Duas conexões por pessoa: o WhatsApp dela (leitura) e o número da assistente (conversa com ela).
const WA_ROLES = {
  person: { title: '1. WhatsApp da pessoa (leitura)', inst: 'instance_name', state: 'wa_state', phone: 'phone',
    hint: 'É o WhatsApp que a assistente vai ler. Escaneie com o celular da própria pessoa: WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho.',
    done: '✅ Conectado. A assistente já está lendo as mensagens desta pessoa.' },
  assistant: { title: '2. Número da assistente (conversa com a pessoa)', inst: 'assistant_instance_name', state: 'assistant_state', phone: 'assistant_phone',
    hint: 'Um chip/número exclusivo desta pessoa, de onde a assistente escreve e recebe os comandos. Escaneie com o aparelho que tem esse chip. Se cair, os avisos passam a ir pela conversa "Você" do próprio WhatsApp da pessoa até reconectar.',
    done: '✅ Conectado. A assistente fala com a pessoa por este número. Peça para ela salvar o contato.' },
};
const pollTimers = {};
function stopWaPolls() { for (const k of Object.keys(pollTimers)) { clearInterval(pollTimers[k]); delete pollTimers[k]; } }

function waBlock(p, role) {
  const R = WA_ROLES[role];
  return `
    <div class="card" data-role="${role}">
      <h2>${R.title}</h2>
      <p class="small muted">Instância: <span class="mono">${esc(p[R.inst] || '—')}</span> · Número: <b class="phone">${esc(p[R.phone] || 'não detectado')}</b></p>
      <div class="waStatus">${stateBadge(p[R.state])}</div>
      <div class="qrBox" style="margin:14px 0"></div>
      <div class="row">
        <button class="primary" data-act="connect">Conectar / gerar QR</button>
        <button data-act="logout">Desconectar</button>
        <button class="danger" data-act="reset">Recriar instância</button>
        <button data-act="webhook">Verificar webhook</button>
      </div>
      <div class="hint" style="margin-top:10px">${R.hint} O QR expira em ~40 s e é renovado automaticamente aqui.</div>
      <pre class="pre mono webhookInfo" hidden></pre>
    </div>`;
}

function wireWaBlock(p, role) {
  const R = WA_ROLES[role];
  const el = document.querySelector(`[data-role="${role}"]`);
  const qrBox = el.querySelector('.qrBox');
  const q = `?role=${role}`;
  const render = (state, qr, phone) => {
    el.querySelector('.waStatus').innerHTML = stateBadge(state);
    if (phone) el.querySelector('.phone').textContent = phone;
    if (state === 'open') { qrBox.innerHTML = `<p>${R.done}</p>`; clearInterval(pollTimers[role]); delete pollTimers[role]; return; }
    if (qr) qrBox.innerHTML = `<div class="qr"><img src="${qr.startsWith('data:') ? qr : 'data:image/png;base64,' + qr}" alt="QR"></div>`;
    else if (state === 'connecting') qrBox.innerHTML = '<p class="muted">Aguardando QR code…</p>';
  };
  const poll = async () => {
    try { const s = await api(`/people/${p.id}/whatsapp/status${q}`); render(s.state, s.qr, s.phone); } catch (e) { /* ignora */ }
  };
  const startPoll = (ms) => { clearInterval(pollTimers[role]); pollTimers[role] = setInterval(poll, ms); };
  el.querySelector('[data-act="connect"]').onclick = async () => {
    try {
      qrBox.innerHTML = '<p class="muted">Criando instância e gerando QR…</p>';
      const r = await api(`/people/${p.id}/whatsapp/connect${q}`, { method: 'POST' });
      render(r.state, r.qr);
      startPoll(4000);
    } catch (e) { toast(e.message, true); qrBox.innerHTML = ''; }
  };
  el.querySelector('[data-act="logout"]').onclick = async () => { try { await api(`/people/${p.id}/whatsapp/logout${q}`, { method: 'POST' }); toast('Desconectado'); render('close'); } catch (e) { toast(e.message, true); } };
  el.querySelector('[data-act="reset"]').onclick = async () => { if (!confirm('Apagar esta instância na Evolution e recriar? Será preciso escanear o QR de novo.')) return; try { await api(`/people/${p.id}/whatsapp/reset${q}`, { method: 'POST' }); toast('Instância apagada. Clique em Conectar.'); render('disconnected'); } catch (e) { toast(e.message, true); } };
  el.querySelector('[data-act="webhook"]').onclick = async () => {
    const pre = el.querySelector('.webhookInfo'); pre.hidden = false; pre.textContent = 'Consultando…';
    try { const r = await api(`/people/${p.id}/whatsapp/webhook${q}`); pre.textContent = `Esperado: ${r.expected}\n\nNa Evolution:\n${JSON.stringify(r.info, null, 2)}`; }
    catch (e) { pre.textContent = 'Erro: ' + e.message + '\n\nClique de novo em "Conectar / gerar QR" para reconfigurar o webhook.'; }
  };
  if (p[R.state] !== 'open' && p[R.state] !== 'disconnected') { poll(); startPoll(5000); }
}

function tabWhatsApp(body, { person: p }) {
  stopWaPolls();
  body.innerHTML = `
    ${waBlock(p, 'person')}
    ${p.notify_mode === 'assistant' ? waBlock(p, 'assistant') : '<div class="card"><h2>2. Número da assistente</h2><p class="small muted">Esta pessoa está configurada para receber os avisos na conversa "Você" do próprio WhatsApp. Para usar um número dedicado da assistente, mude "Avisar por" em Preferências.</p></div>'}
    <div class="card">
      <h2>Como funciona</h2>
      <ul class="small muted">
        <li>A assistente lê as mensagens que chegam no WhatsApp da pessoa (1) e classifica a urgência com IA.</li>
        <li>Quando algo é urgente, ela avisa pelo número da assistente (2), com resumo e sugestão de resposta.</li>
        <li>A pessoa responde nessa conversa: <i>enviar #12</i>, <i>resumo</i>, <i>agenda</i>, <i>feito #12</i> ou fala livremente ("responde pro João que amanhã às 10h"). As respostas aos contatos saem do WhatsApp da própria pessoa (1).</li>
        <li>Resumos periódicos nos horários configurados em Preferências.</li>
      </ul>
    </div>`;
  wireWaBlock(p, 'person');
  if (p.notify_mode === 'assistant') wireWaBlock(p, 'assistant');
}

async function tabEmail(body, { person: p }) {
  const { presets } = await api('/email-presets');
  body.innerHTML = `
    <div class="card">
      <h2>Leitura de e-mail (IMAP)</h2>
      <form id="emailForm">
        <div class="field"><label><input type="checkbox" name="email_enabled" ${p.email_enabled ? 'checked' : ''} style="width:auto;margin-right:8px">Ativar leitura de e-mail</label></div>
        <div class="field"><label>Provedor (preenche host/porta)</label>
          <select id="preset"><option value="">— escolher —</option>${Object.entries(presets).map(([k, v]) => `<option value="${k}">${k} (${v.host})</option>`).join('')}</select>
          <div class="hint" id="presetNote"></div></div>
        <div class="three">
          <div class="field"><label>Servidor IMAP</label><input name="imap_host" value="${esc(p.imap_host || '')}" placeholder="imap.gmail.com"></div>
          <div class="field"><label>Porta</label><input name="imap_port" value="${esc(p.imap_port || 993)}"></div>
          <div class="field"><label>Pasta</label><input name="imap_folder" value="${esc(p.imap_folder || 'INBOX')}"></div>
        </div>
        <div class="two">
          <div class="field"><label>Usuário (e-mail)</label><input name="imap_user" value="${esc(p.imap_user || '')}" placeholder="pessoa@empresa.com"></div>
          <div class="field"><label>Senha ${p.has_imap_pass ? '(salva — deixe em branco para manter)' : ''}</label><input type="password" name="imap_pass" placeholder="${p.has_imap_pass ? '••••••••' : 'senha ou senha de app'}"></div>
        </div>
        <div class="row"><button class="primary" type="submit">Salvar</button><button type="button" id="testEmail">Testar conexão</button><button type="button" id="pollEmail">Ler agora</button>
          <span class="small muted">Status: ${esc(p.email_status || '—')}</span></div>
      </form>
      <div class="hint" style="margin-top:10px">Gmail e Outlook exigem <b>senha de app</b> (não a senha normal). A senha fica criptografada no banco. Só os e-mails novos a partir da ativação são lidos.</div>
    </div>`;
  const form = document.getElementById('emailForm');
  document.getElementById('preset').onchange = (e) => {
    const pr = presets[e.target.value]; if (!pr) return;
    form.imap_host.value = pr.host; form.imap_port.value = pr.port; document.getElementById('presetNote').textContent = pr.note;
  };
  const save = async () => {
    const b = { email_enabled: form.email_enabled.checked, imap_host: form.imap_host.value, imap_port: form.imap_port.value, imap_folder: form.imap_folder.value, imap_user: form.imap_user.value };
    if (form.imap_pass.value) b.imap_pass = form.imap_pass.value;
    await api(`/people/${p.id}`, { method: 'PUT', body: b });
  };
  form.onsubmit = async (e) => { e.preventDefault(); try { await save(); toast('Salvo'); viewPerson(p.id); } catch (err) { toast(err.message, true); } };
  document.getElementById('testEmail').onclick = async () => { try { await save(); const r = await api(`/people/${p.id}/email/test`, { method: 'POST' }); toast(`Conectou! ${r.exists} mensagens na pasta.`); } catch (err) { toast('Falha: ' + err.message, true); } };
  document.getElementById('pollEmail').onclick = async () => { try { await save(); const r = await api(`/people/${p.id}/email/poll`, { method: 'POST' }); toast('Leitura feita: ' + r.status); } catch (err) { toast(err.message, true); } };
}

function tabCalendar(body, { person: p, calendar }) {
  body.innerHTML = `
    <div class="card">
      <h2>Agenda (link ICS)</h2>
      <form id="calForm">
        <div class="field"><label>URL do calendário (ICS / iCal)</label><input name="calendar_ics_url" value="${esc(p.calendar_ics_url || '')}" placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"></div>
        <div class="row"><button class="primary" type="submit">Salvar e sincronizar</button><span class="small muted">Status: ${esc(p.calendar_status || '—')}</span></div>
      </form>
      <div class="hint" style="margin-top:10px"><b>Google Agenda:</b> Configurações → sua agenda → "Endereço secreto no formato iCal". <b>Outlook:</b> Configurações → Calendário → Calendários compartilhados → Publicar → link ICS. A assistente usa a agenda para detectar conflitos e montar o resumo do dia.</div>
    </div>
    <div class="card"><h2>Próximos 7 dias</h2>
      ${calendar.length ? `<table><tr><th>Quando</th><th>Evento</th><th>Local</th></tr>${calendar.map((e) => `<tr><td>${e.all_day ? new Date(e.start_ts * 1000).toLocaleDateString('pt-BR') + ' (dia todo)' : fmtTs(e.start_ts)}</td><td>${esc(e.summary)}</td><td>${esc(e.location || '')}</td></tr>`).join('')}</table>` : '<div class="empty">Nenhum evento carregado.</div>'}
    </div>`;
  document.getElementById('calForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api(`/people/${p.id}`, { method: 'PUT', body: { calendar_ics_url: e.target.calendar_ics_url.value } }); const r = await api(`/people/${p.id}/calendar/sync`, { method: 'POST' }); toast(`Sincronizado: ${r.count} eventos`); viewPerson(p.id); }
    catch (err) { toast(err.message, true); }
  };
}

function tabPrefs(body, { person: p }) {
  body.innerHTML = `
    <div class="card">
      <h2>Preferências</h2>
      <form id="prefForm">
        <div class="two">
          <div class="field"><label>Nome</label><input name="name" value="${esc(p.name)}"></div>
          <div class="field"><label>Número do WhatsApp (só dígitos, com DDI)</label><input name="phone" value="${esc(p.phone || '')}"></div>
        </div>
        <div class="field"><label>Contexto para a assistente</label><textarea name="context_notes">${esc(p.context_notes || '')}</textarea>
          <div class="hint">Quanto mais contexto (quem são os clientes, o que é prioridade, como a pessoa gosta de responder), melhor a triagem e as sugestões.</div></div>
        <div class="three">
          <div class="field"><label>Horários dos resumos (HH:MM, separados por vírgula)</label><input name="digest_times" value="${esc(p.digest_times)}"></div>
          <div class="field"><label>Silêncio de</label><input name="quiet_start" value="${esc(p.quiet_start || '')}" placeholder="22:00"></div>
          <div class="field"><label>até</label><input name="quiet_end" value="${esc(p.quiet_end || '')}" placeholder="07:00"></div>
        </div>
        <div class="three">
          <div class="field"><label>Avisar na hora a partir de urgência</label><select name="urgent_threshold">${[2, 3, 4].map((n) => `<option value="${n}" ${Number(p.urgent_threshold) === n ? 'selected' : ''}>${URG[n]}</option>`).join('')}</select></div>
          <div class="field"><label>Fuso horário</label><input name="timezone" value="${esc(p.timezone)}"></div>
          <div class="field"><label>Avisar por</label><select name="notify_mode"><option value="assistant" ${p.notify_mode === 'assistant' ? 'selected' : ''}>Número próprio da assistente (recomendado)</option><option value="self" ${p.notify_mode === 'self' ? 'selected' : ''}>Conversa "Você" (próprio número da pessoa)</option></select></div>
        </div>
        <div class="two">
          <div class="field"><label><input type="checkbox" name="ignore_groups" ${p.ignore_groups ? 'checked' : ''} style="width:auto;margin-right:8px">Ignorar grupos de WhatsApp</label></div>
          <div class="field"><label><input type="checkbox" name="active" ${p.active ? 'checked' : ''} style="width:auto;margin-right:8px">Assistente ativa</label></div>
        </div>
        <div class="row"><button class="primary" type="submit">Salvar</button><span class="grow"></span><button type="button" class="danger" id="delBtn">Excluir pessoa</button></div>
      </form>
    </div>`;
  const f = document.getElementById('prefForm');
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api(`/people/${p.id}`, { method: 'PUT', body: { name: f.name.value, phone: f.phone.value, context_notes: f.context_notes.value, digest_times: f.digest_times.value, quiet_start: f.quiet_start.value, quiet_end: f.quiet_end.value, urgent_threshold: f.urgent_threshold.value, timezone: f.timezone.value, notify_mode: f.notify_mode.value, ignore_groups: f.ignore_groups.checked, active: f.active.checked } });
      toast('Salvo'); viewPerson(p.id);
    } catch (err) { toast(err.message, true); }
  };
  document.getElementById('delBtn').onclick = async () => {
    if (!confirm(`Excluir ${p.name} e a instância do WhatsApp? Isso apaga todo o histórico.`)) return;
    try { await api(`/people/${p.id}`, { method: 'DELETE' }); toast('Excluído'); location.hash = '#/'; } catch (err) { toast(err.message, true); }
  };
}

function tabItems(body, { person: p, items }) {
  const open = items.filter((i) => ['open', 'notified'].includes(i.status));
  const closed = items.filter((i) => !['open', 'notified'].includes(i.status));
  const card = (it) => `
    <div class="item u${it.urgency}">
      <div class="top"><span class="who">#${it.id} ${esc(it.contact_name)} <span class="badge">${it.channel}</span> <span class="badge ${it.urgency >= 3 ? 'warn' : ''}">${URG[it.urgency]}</span> <span class="badge">${esc(it.category || '')}</span></span><span class="small muted">${fmtTs(it.last_message_ts)} · ${esc(it.status)}</span></div>
      <div class="sum">${esc(it.summary)}${it.deadline ? ` <b>· prazo: ${esc(it.deadline)}</b>` : ''}</div>
      ${it.suggested_reply ? `<div class="sug">Sugestão: ${esc(it.suggested_reply)}</div>` : ''}
      ${['open', 'notified'].includes(it.status) ? `<div class="actions">
        ${it.suggested_reply && it.channel === 'whatsapp' ? `<button data-send="${it.id}">Enviar sugestão</button>` : ''}
        <button data-done="${it.id}">Marcar resolvido</button><button data-dismiss="${it.id}">Ignorar</button></div>` : ''}
    </div>`;
  body.innerHTML = `
    <div class="card"><h2>Pendências abertas (${open.length})</h2><div class="list">${open.length ? open.map(card).join('') : '<div class="empty">Nada pendente.</div>'}</div></div>
    <div class="card"><h2>Histórico recente</h2><div class="list">${closed.length ? closed.slice(0, 30).map(card).join('') : '<div class="empty">—</div>'}</div></div>`;
  body.querySelectorAll('[data-send]').forEach((b) => { b.onclick = async () => { if (!confirm('Enviar a resposta sugerida para o contato?')) return; try { await api(`/people/${p.id}/items/${b.dataset.send}/send`, { method: 'POST', body: {} }); toast('Enviado'); viewPerson(p.id); } catch (e) { toast(e.message, true); } }; });
  body.querySelectorAll('[data-done]').forEach((b) => { b.onclick = async () => { await api(`/people/${p.id}/items/${b.dataset.done}/status`, { method: 'POST', body: { status: 'done' } }); viewPerson(p.id); }; });
  body.querySelectorAll('[data-dismiss]').forEach((b) => { b.onclick = async () => { await api(`/people/${p.id}/items/${b.dataset.dismiss}/status`, { method: 'POST', body: { status: 'dismissed' } }); viewPerson(p.id); }; });
}

function tabChat(body, { person: p, alerts }) {
  body.innerHTML = `
    <div class="card"><h2>Conversa entre ${esc(p.name.split(' ')[0])} e a assistente (chat "Você" no WhatsApp)</h2>
      <div class="chat">${alerts.length ? alerts.map((a) => `<div class="bubble ${a.kind === 'user' ? 'user' : 'assistant'}"><span class="k">${a.kind === 'user' ? esc(p.name) : 'assistente · ' + esc(a.kind)} · ${fmtTs(a.created_at)}</span>${esc(a.text)}</div>`).join('') : '<div class="empty">Nenhuma mensagem ainda. Use "Mensagem de teste" ou "Enviar resumo agora".</div>'}</div>
    </div>`;
  const c = body.querySelector('.chat'); if (c) c.scrollTop = c.scrollHeight;
}

function tabMessages(body, { messages }) {
  body.innerHTML = `
    <div class="card"><h2>Últimas mensagens lidas</h2>
      ${messages.length ? `<table><tr><th>Quando</th><th>Canal</th><th>De / para</th><th>Texto</th></tr>${messages.map((m) => `<tr><td>${fmtTs(m.ts)}</td><td>${m.channel} ${m.direction === 'out' ? '↗' : '↙'}</td><td>${esc(m.sender_name || m.sender_id || '')}<br><span class="muted mono">${esc(m.chat_id)}</span></td><td>${m.subject ? `<b>${esc(m.subject)}</b><br>` : ''}${esc(String(m.text).slice(0, 300))}${m.triaged ? '' : ' <span class="badge info">na fila</span>'}</td></tr>`).join('')}</table>` : '<div class="empty">Nenhuma mensagem recebida ainda.</div>'}
    </div>`;
}

// ---------- status ----------
async function viewStatus() {
  stopPolling();
  const [s, u] = await Promise.all([api('/status'), api('/usage')]);
  const totalMonth = u.month.reduce((a, r) => a + Number(r.cost_usd || 0), 0);
  $app.innerHTML = `
    <h1>Status do sistema</h1>
    ${s.problems.map((p) => `<div class="problem">⚠️ ${esc(p)}</div>`).join('')}
    <div class="card"><h2>Gasto com IA por pessoa — este mês (total ${money(totalMonth, u.usdBrl)})</h2>
      ${u.month.length ? `<table><tr><th>Pessoa</th><th>Chamadas</th><th>Tokens entrada</th><th>Tokens saída</th><th>Lidos do cache</th><th>Custo</th></tr>${u.month.map((r) => `<tr><td>${r.person_id ? `<a href="#/p/${r.person_id}">${esc(r.name)}</a>` : esc(r.name)}</td><td>${r.calls}</td><td>${tokens(r.input_tokens)}</td><td>${tokens(r.output_tokens)}</td><td>${tokens(r.cache_read_tokens)}</td><td><b>${money(r.cost_usd, u.usdBrl)}</b></td></tr>`).join('')}</table>` : '<div class="empty">Nenhuma chamada à IA registrada neste mês.</div>'}
      <div class="small muted" style="margin-top:8px">Hoje: ${money(u.totals.today.cost_usd, u.usdBrl)} · 7 dias: ${money(u.totals.last7d.cost_usd, u.usdBrl)} · 30 dias: ${money(u.totals.last30d.cost_usd, u.usdBrl)} · desde o início: ${money(u.totals.total.cost_usd, u.usdBrl)}</div>
    </div>
    <div class="card"><h2>Configuração</h2>
      <table>
        <tr><th>URL pública (APP_URL)</th><td class="mono">${esc(s.appUrl || '— não definida —')}</td></tr>
        <tr><th>Evolution API</th><td>${s.evolution.configured ? `<span class="mono">${esc(s.evolution.url)}</span> ${s.evolution.ok ? `<span class="badge ok">online · v${esc(s.evolution.version || '?')}</span>` : `<span class="badge bad">falhou (${esc(s.evolution.error || s.evolution.status)})</span>`}` : '<span class="badge bad">não configurada</span>'}</td></tr>
        <tr><th>Claude (IA)</th><td>${s.claude.configured ? `<span class="badge ok">configurado</span> modelo <span class="mono">${esc(s.claude.model)}</span>` : '<span class="badge bad">ANTHROPIC_API_KEY ausente</span>'}</td></tr>
      </table>
    </div>
    <div class="card"><h2>Últimos webhooks recebidos da Evolution</h2>
      ${s.lastEvents.length ? `<table><tr><th>Quando</th><th>Instância</th><th>Evento</th><th>Detalhe</th></tr>${s.lastEvents.map((e) => `<tr><td class="mono">${esc(e.at.slice(11, 19))}</td><td>${esc(e.instance)}</td><td>${esc(e.event)}</td><td class="mono">${esc([e.state, e.hasQr ? 'QR' : '', e.remoteJid, e.fromMe ? 'fromMe' : ''].filter(Boolean).join(' · '))}</td></tr>`).join('')}</table>` : '<div class="empty">Nenhum webhook recebido ainda. Se o WhatsApp está conectado e nada chega aqui, verifique APP_URL e o webhook da instância.</div>'}
    </div>`;
}

// ---------- roteador ----------
async function route() {
  try {
    const me = await api('/me');
    if (!me.authed) return showLogin();
  } catch { return showLogin(); }
  $nav.hidden = false;
  const h = location.hash || '#/';
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === h));
  try {
    const m = h.match(/^#\/p\/(\d+)/);
    if (m) return await viewPerson(Number(m[1]));
    if (h === '#/status') return await viewStatus();
    return await viewPeople();
  } catch (e) {
    if (e.message !== 'não autenticado') $app.innerHTML = `<div class="card">Erro: ${esc(e.message)}</div>`;
  }
}
window.addEventListener('hashchange', route);
route();
