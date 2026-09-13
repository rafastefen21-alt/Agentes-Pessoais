/* Página de conexão por link (sem login): mostra os QR codes das duas conexões. */
const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
document.getElementById('brandMark').innerHTML = icon('sparkles');
const token = new URLSearchParams(location.search).get('t') || '';

async function api(path, opts = {}) {
  const res = await fetch(`/api/connect/${encodeURIComponent(token)}${path}`, { method: opts.method || 'GET', headers: { 'Content-Type': 'application/json' } });
  const data = await res.json().catch(() => ({ ok: false, error: 'resposta inválida' }));
  if (!res.ok || data.ok === false) throw new Error(data.error || `erro ${res.status}`);
  return data;
}
function toast(msg, err = false) {
  $toast.innerHTML = icon(err ? 'alertCircle' : 'check') + ' ' + esc(msg); $toast.hidden = false; $toast.className = 'toast' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => { $toast.hidden = true; }, err ? 6000 : 3000);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function stateBadge(s) {
  const map = { open: ['ok', 'wifi', 'Conectado'], connecting: ['warn', 'qr', 'Aguardando leitura do QR'], close: ['bad', 'wifiOff', 'Desconectado'], disconnected: ['bad', 'wifiOff', 'Não conectado'], missing: ['bad', 'alertCircle', 'Precisa conectar'] };
  const [cls, ic, label] = map[s] || ['', 'help', s || '—'];
  return `<span class="badge ${cls}">${icon(ic)}${esc(label)}</span>`;
}
const STEPS = {
  person: { n: 1, title: 'Seu WhatsApp', ic: 'phone', hint: 'No SEU celular: abra o WhatsApp, toque nos três pontos (ou em Configurações), "Aparelhos conectados", "Conectar aparelho" e aponte a câmera para este QR.' },
  assistant: { n: 2, title: 'Número da assistente', ic: 'bot', hint: 'No aparelho que tem o chip da assistente: WhatsApp, "Aparelhos conectados", "Conectar aparelho" e aponte para este QR.' },
};
const polls = {};
function block(role, c) {
  const S = STEPS[role];
  const done = c.state === 'open';
  return `
    <div class="card" data-role="${role}">
      <h2>${icon(S.ic)} Passo ${S.n}: ${S.title} <span class="grow"></span><span class="st">${stateBadge(c.state)}</span></h2>
      <div class="qrBox center" style="margin:12px 0">${done ? `<p class="row small">${icon('check')} Já está conectado.</p>` : ''}</div>
      <div class="row"><button class="${done ? '' : 'primary'}" data-act="connect">${icon('qr')} ${done ? 'Gerar novo QR' : 'Gerar QR code'}</button></div>
      <div class="hint" style="margin-top:10px">${S.hint} O QR expira em cerca de 40 s e é renovado sozinho aqui.</div>
    </div>`;
}
function wire(role) {
  const el = document.querySelector(`[data-role="${role}"]`);
  const qrBox = el.querySelector('.qrBox');
  const render = (s) => {
    el.querySelector('.st').innerHTML = stateBadge(s.state);
    if (s.state === 'open') { qrBox.innerHTML = `<p class="row small" style="justify-content:center">${icon('check')} Conectado. Pode fechar esta parte.</p>`; clearInterval(polls[role]); delete polls[role]; checkAllDone(); return; }
    if (s.qr) qrBox.innerHTML = `<div class="qr"><img src="${s.qr.startsWith('data:') ? s.qr : 'data:image/png;base64,' + s.qr}" alt="QR"></div>`;
    else if (s.state === 'connecting') qrBox.innerHTML = '<p class="muted small">Gerando QR code…</p>';
  };
  const poll = async () => { try { render(await api(`/status?role=${role}`)); } catch { /* ignora */ } };
  el.querySelector('[data-act="connect"]').onclick = async (e) => {
    e.target.disabled = true;
    try { qrBox.innerHTML = '<p class="muted small">Preparando…</p>'; render(await api(`/connect?role=${role}`, { method: 'POST' })); clearInterval(polls[role]); polls[role] = setInterval(poll, 4000); }
    catch (err) { toast(err.message, true); qrBox.innerHTML = ''; }
    e.target.disabled = false;
  };
}
let info = null;
function checkAllDone() {
  const states = document.querySelectorAll('.st');
  const all = [...states].every((s) => s.textContent.includes('Conectado'));
  const done = document.getElementById('done');
  if (done) done.hidden = !all;
}

(async () => {
  try { info = await api('/info'); } catch (e) {
    $app.innerHTML = `<div class="card glass login"><h1>${icon('lock')} Link inválido</h1><p class="lead">${esc(e.message)}</p></div>`; return;
  }
  document.getElementById('who').textContent = info.name;
  $app.innerHTML = `
    <h1>Olá, ${esc(info.name.split(' ')[0])}</h1>
    <p class="muted" style="margin-bottom:18px">Vamos ligar a sua assistente ao WhatsApp. ${info.assistant ? 'São dois passos, cada um com um QR code.' : 'É um passo só.'} Leva menos de um minuto.</p>
    ${block('person', info.person)}
    ${info.assistant ? block('assistant', info.assistant) : ''}
    <div class="card" id="done" hidden><h2>${icon('check')} Tudo conectado</h2><p>Sua assistente já está lendo as mensagens e vai te avisar do que for importante. Você pode fechar esta página.</p></div>
    <p class="hint center">Este link vale por alguns dias e só serve para conectar. Se precisar de novo, peça outro.</p>`;
  wire('person'); if (info.assistant) wire('assistant');
  checkAllDone();
})();
