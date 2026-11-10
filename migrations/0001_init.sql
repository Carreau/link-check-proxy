-- One row per normalized URL (fragment stripped).
CREATE TABLE urls (
  url                  TEXT PRIMARY KEY,
  host                 TEXT NOT NULL,
  status               INTEGER,          -- last HTTP status, NULL if none
  error                TEXT,             -- error kind, NULL if none
  final_url            TEXT,             -- after redirects
  checked_at           INTEGER,          -- epoch seconds, NULL = never checked
  expires_at           INTEGER,          -- result is "fresh" until then
  next_check_at        INTEGER NOT NULL, -- scheduler key
  first_seen_at        INTEGER NOT NULL,
  last_requested_at    INTEGER NOT NULL, -- coarse, see PROJECT.md §6.5
  request_count        INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  idle_level           INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

CREATE INDEX urls_next_check ON urls(next_check_at);
-- Small partial index so never-checked URLs can be picked first cheaply.
CREATE INDEX urls_unknown ON urls(next_check_at) WHERE checked_at IS NULL;

CREATE TABLE hosts (
  host          TEXT PRIMARY KEY,
  backoff_until INTEGER NOT NULL DEFAULT 0   -- from 429 / Retry-After
) WITHOUT ROWID;

CREATE TABLE api_keys (
  id                    TEXT PRIMARY KEY,
  key_hash              TEXT NOT NULL UNIQUE,  -- SHA-256 hex of the key
  name                  TEXT NOT NULL,
  owner                 TEXT,
  is_admin              INTEGER NOT NULL DEFAULT 0,
  new_url_quota_per_day INTEGER NOT NULL DEFAULT 5000,
  created_at            INTEGER NOT NULL,
  revoked_at            INTEGER
);

CREATE TABLE api_key_usage (
  key_id   TEXT NOT NULL,
  day      TEXT NOT NULL,                    -- YYYY-MM-DD (UTC)
  new_urls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
) WITHOUT ROWID;
