// Autenticação simples do portal: senha única (ADMIN_PASSWORD) + cookie assinado.
import crypto from 'node:crypto';
import { config } from './config.js';
import { sessionSecret } from './crypto.js';

const COOKIE = 'assist_session';
const CLIENT_COOKIE = 'assist_client';
const TTL = 7 * 24 * 3600;

function sign(payload) {
  const h = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${h}`;
}
/** Devolve o payload se a assinatura for válida e não expirou; senão null. */
function verifyToken(token) {
  if (!token) return null;
  const i = token.lastIndexOf('.');
  if (i < 0) return null;
  const payload = token.slice(0, i);
  const expected = sign(payload);
  if (expected.length !== token.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token))) return null;
  const parts = payload.split(':');
  const exp = Number(parts[parts.length - 1]);
  return exp > Date.now() / 1000 ? parts : null;
}
function verify(token) {
  const parts = verifyToken(token);
  return Boolean(parts && parts[0] === 'admin');
}
function setCookie(res, name, token, maxAge = TTL) {
  const secure = config.appUrl.startsWith('https://') ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}

// ---------- senhas de clientes (scrypt) ----------
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
export function checkPassword(password, stored) {
  if (!stored || !String(stored).startsWith('scrypt:')) return false;
  const [, salt, hash] = String(stored).split(':');
  const calc = crypto.scryptSync(String(password || ''), salt, 32);
  const ref = Buffer.from(hash, 'hex');
  return calc.length === ref.length && crypto.timingSafeEqual(calc, ref);
}

// ---------- sessão do cliente (área "Minha assistente") ----------
export function clientLogin(res, personId) {
  setCookie(res, CLIENT_COOKIE, sign(`client:${personId}:${Math.floor(Date.now() / 1000) + TTL}`));
}
export function clientLogout(res) {
  res.setHeader('Set-Cookie', `${CLIENT_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}
/** Id da pessoa logada na área do cliente, ou null. */
export function clientPersonId(req) {
  const parts = verifyToken(parseCookies(req)[CLIENT_COOKIE]);
  return parts && parts[0] === 'client' ? Number(parts[1]) : null;
}
export function requireClient(req, res, next) {
  const id = clientPersonId(req);
  if (!id) return res.status(401).json({ ok: false, error: 'não autenticado' });
  req.clientPersonId = id;
  next();
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
  setCookie(res, COOKIE, sign(`admin:${Math.floor(Date.now() / 1000) + TTL}`));
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
