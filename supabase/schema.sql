-- Tabelas do assistente. Rode no SQL Editor do Supabase (o servidor também cria sozinho ao subir).

CREATE TABLE IF NOT EXISTS people (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  language TEXT NOT NULL DEFAULT 'pt-BR',
  instance_name TEXT UNIQUE,
  wa_state TEXT NOT NULL DEFAULT 'disconnected',
  wa_qr TEXT,
  wa_qr_at BIGINT,
  notify_mode TEXT NOT NULL DEFAULT 'self',
  ignore_groups INTEGER NOT NULL DEFAULT 1,
  email_enabled INTEGER NOT NULL DEFAULT 0,
  imap_host TEXT, imap_port INTEGER DEFAULT 993, imap_user TEXT, imap_pass TEXT,
  imap_folder TEXT DEFAULT 'INBOX',
  imap_last_uid BIGINT DEFAULT 0,
  imap_uidvalidity BIGINT DEFAULT 0,
  email_status TEXT DEFAULT '',
  calendar_ics_url TEXT,
  calendar_status TEXT DEFAULT '',
  digest_times TEXT NOT NULL DEFAULT '08:00,13:00,18:00',
  quiet_start TEXT DEFAULT '22:00',
  quiet_end TEXT DEFAULT '07:00',
  urgent_threshold INTEGER NOT NULL DEFAULT 3,
  context_notes TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  external_id TEXT,
  chat_id TEXT NOT NULL,
  sender_name TEXT, sender_id TEXT,
  direction TEXT NOT NULL,
  subject TEXT,
  text TEXT NOT NULL,
  ts BIGINT NOT NULL,
  triaged INTEGER NOT NULL DEFAULT 0,
  UNIQUE(person_id, channel, external_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_person_ts ON messages(person_id, ts);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(person_id, chat_id, ts);

CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  contact_name TEXT,
  urgency INTEGER NOT NULL,
  category TEXT,
  summary TEXT NOT NULL,
  needs_reply INTEGER NOT NULL DEFAULT 0,
  suggested_reply TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  notified_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  last_message_ts BIGINT
);
CREATE INDEX IF NOT EXISTS idx_items_person_status ON items(person_id, status);

CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  external_id TEXT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE TABLE IF NOT EXISTS calendar_events (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  uid TEXT, summary TEXT, location TEXT, description TEXT,
  start_ts BIGINT NOT NULL, end_ts BIGINT,
  all_day INTEGER DEFAULT 0,
  UNIQUE(person_id, uid, start_ts)
);

CREATE TABLE IF NOT EXISTS api_usage (
  id SERIAL PRIMARY KEY,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
CREATE INDEX IF NOT EXISTS idx_usage_person ON api_usage(person_id, created_at);

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY, v TEXT
);

ALTER TABLE people ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE kv ENABLE ROW LEVEL SECURITY;
