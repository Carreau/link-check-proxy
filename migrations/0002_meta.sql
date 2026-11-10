-- Small key/value store for cached stats and recent tick activity, so the
-- admin overview never has to scan the urls table.
CREATE TABLE meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,   -- JSON
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
