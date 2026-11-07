PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS storage_usage (
  business_id TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  quota_bytes INTEGER NOT NULL DEFAULT 524288000 CHECK (quota_bytes = 524288000),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (length(record_type) BETWEEN 1 AND 60),
  payload TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_tenant_type_created ON records(business_id, record_type, created_at DESC);
CREATE INDEX IF NOT EXISTS records_expiry ON records(expires_at);

CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS objects_tenant_created ON objects(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS objects_expiry ON objects(expires_at);

CREATE TABLE IF NOT EXISTS cleanup_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  records_deleted INTEGER NOT NULL DEFAULT 0,
  objects_deleted INTEGER NOT NULL DEFAULT 0,
  bytes_released INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  target_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_tenant_created ON audit_events(business_id, created_at DESC);
