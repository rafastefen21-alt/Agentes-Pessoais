// Criptografia simétrica (AES-256-GCM) para guardar senhas de e-mail no banco.
// A chave vem de APP_SECRET; se não existir, é gerada e salva em data/secret.key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let keyCache = null;

function loadKey() {
  if (keyCache) return keyCache;
  let secret = config.appSecret;
  if (!secret) {
    const file = path.join(config.dataDir, 'secret.key');
    fs.mkdirSync(config.dataDir, { recursive: true });
    if (fs.existsSync(file)) secret = fs.readFileSync(file, 'utf8').trim();
    else {
      secret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  keyCache = crypto.createHash('sha256').update(secret).digest();
  return keyCache;
}

export function encrypt(text) {
  if (!text) return '';
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(payload) {
  if (!payload) return '';
  if (!String(payload).startsWith('enc:')) return String(payload);
  const [, ivB64, tagB64, dataB64] = String(payload).split(':');
  const key = loadKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

export function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sessionSecret() {
  return loadKey().toString('hex');
}
