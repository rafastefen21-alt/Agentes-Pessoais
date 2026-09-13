// Autenticação simples do portal: senha única (ADMIN_PASSWORD) + cookie assinado.
import crypto from 'node:crypto';
import { config } from './config.js';
import { sessionSecret } from './crypto.js';

const COOKIE = 'assist_session';
const TTL = 7 * 24 * 3600;

function sign(payload) {
  const h = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${h}`;
}
function verify(token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const expected = sign(payload);
  if (expected.length !== token.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))) return false;
  const exp = Number(payload.split(':')[1]);
  return exp > Date.now() / 1000;
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) out[k] = decodeURIComponent(v.join('='));
  }
  return out;
}

export function login(req, res) {
  const { password } = req.body || {};
  if (!config.adminPassword) return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD não definida no servidor' });
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(config.adminPassword);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ ok: false, error: 'Senha incorreta' });
  const token = sign(`admin:${Math.floor(Date.now() / 1000) + TTL}`);
  const secure = config.appUrl.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL}${secure}`);
  res.json({ ok: true });
}
export function logout(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.json({ ok: true });
}
export function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  if (verify(cookies[COOKIE])) return next();
  return res.status(401).json({ ok: false, error: 'não autenticado' });
}
export function isAuthed(req) {
  return verify(parseCookies(req)[COOKIE]);
}
