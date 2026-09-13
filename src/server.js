// Servidor: portal (arquivos estáticos), API do portal e webhook da Evolution.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, validateConfig } from './config.js';
import { logger } from './logger.js';
import { login, logout, requireAuth, isAuthed } from './auth.js';
import { api } from './routes/api.js';
import { webhooks } from './routes/webhooks.js';
import { startSchedulers } from './agent.js';
import { init as initDb } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '5mb' }));

// Webhook (público, validado por token)
app.use('/webhooks', webhooks);

// Autenticação
app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', (req, res) => res.json({ ok: true, authed: isAuthed(req) }));
app.use('/api', requireAuth, api);

// Portal
app.use(express.static(path.join(here, '..', 'public')));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use((err, req, res, next) => {
  logger.error('Erro não tratado', { err: String(err?.message || err) });
  res.status(500).json({ ok: false, error: 'erro interno' });
});

const problems = validateConfig();
for (const p of problems) logger.warn('[config] ' + p);

await initDb();

app.listen(config.port, () => {
  logger.info(`Portal em http://localhost:${config.port}  (APP_URL=${config.appUrl || 'não definida'})`);
  startSchedulers();
});

process.on('unhandledRejection', (e) => logger.error('unhandledRejection', { err: String(e?.message || e) }));
