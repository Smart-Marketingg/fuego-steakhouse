-- Fuego Steakhouse & Bar — CRM schema for Cloudflare D1 (SQLite).
-- Idempotent: safe to run again on an existing database.
-- A fresh database created from this file alone supports every feature.
-- Keep schema.oneline.sql in step (npm run schema:oneline) for the D1 console.

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL DEFAULT '',
  pass_hash   TEXT,                       -- base64 PBKDF2-SHA256, NULL until password is set
  salt        TEXT,                       -- base64 per-user salt
  role        TEXT NOT NULL DEFAULT 'staff',  -- admin | staff
  perms       TEXT NOT NULL DEFAULT '[]', -- JSON array of extra permissions (staff only)
  off         TEXT NOT NULL DEFAULT '[]', -- JSON array of hidden sidebar sections
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,           -- sha256 of the cookie token
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  remember    INTEGER NOT NULL DEFAULT 0,
  ip_hash     TEXT,
  ua          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS set_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'set',   -- set | invite | reset
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_set_tokens_user ON set_tokens(user_id);

CREATE TABLE IF NOT EXISTS leads (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  form        TEXT NOT NULL,              -- reservation | event | contact | newsletter
  pipeline    TEXT NOT NULL,              -- pipeline id (one per form)
  stage       TEXT NOT NULL DEFAULT 'new',-- new | contacted | scheduled | won | closed
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  topic       TEXT NOT NULL DEFAULT '',   -- interest / subject / occasion
  message     TEXT NOT NULL DEFAULT '',
  fields      TEXT NOT NULL DEFAULT '{}', -- JSON of every other field (date, time, party...)
  file_key    TEXT,                       -- PRIVATE bucket key of an attachment
  file_name   TEXT,
  page        TEXT NOT NULL DEFAULT '',   -- landing / submitting page
  utm         TEXT NOT NULL DEFAULT '{}', -- JSON {source, medium, campaign, term, content, ref}
  ip_hash     TEXT,
  spam_score  INTEGER NOT NULL DEFAULT 0,
  email_status TEXT NOT NULL DEFAULT 'pending', -- pending | sent | failed | skipped
  email_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_form_stage ON leads(form, stage);
CREATE INDEX IF NOT EXISTS idx_leads_pipeline_stage ON leads(pipeline, stage);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);

CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notes_lead ON notes(lead_id);

CREATE TABLE IF NOT EXISTS activity (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT,
  user_id     TEXT,                       -- NULL for system / website
  action      TEXT NOT NULL,              -- created | stage | note | email_sent | email_failed | exported | deleted
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_lead ON activity(lead_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  enc_value   TEXT NOT NULL,              -- AES-GCM (SETTINGS_KEY) base64 iv.ciphertext, or plain JSON prefixed "plain:"
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS auth_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,              -- login_email | login_ip | lead_ip | forgot_ip
  key_hash    TEXT NOT NULL,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ok          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_key ON auth_attempts(scope, key_hash, at);

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     TEXT,
  action      TEXT NOT NULL,
  target      TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  ip_hash     TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);

CREATE TABLE IF NOT EXISTS media (
  key         TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT '',
  size        INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS email_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id     TEXT,
  kind        TEXT NOT NULL,              -- notification | autoreply | invite | reset | weekly | test
  to_addr     TEXT NOT NULL DEFAULT '',
  ok          INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_at ON email_log(at);

CREATE TABLE IF NOT EXISTS cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
