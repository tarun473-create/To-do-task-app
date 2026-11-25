-- Task360 on Cloudflare D1 (SQLite). Statements are separated by "-- ;;" so the one-time
-- /setup page can also apply this file. Safe to run again (IF NOT EXISTS everywhere).

CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  doc TEXT NOT NULL,
  demo INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);
-- ;;
CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
-- ;;
-- People. doc holds the profile the rules engine uses (departments, manager, teams, leave).
-- Sign-in data (password hash, Microsoft id) stays in its own columns and never reaches the browser.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'dept_head', 'manager', 'employee')),
  active INTEGER NOT NULL DEFAULT 1,
  doc TEXT NOT NULL,
  password_hash TEXT,
  must_change INTEGER NOT NULL DEFAULT 1,
  ms_oid TEXT UNIQUE,
  last_login INTEGER,
  updated_at INTEGER
);
-- ;;
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY CHECK (id GLOB 'T360-[0-9][0-9][0-9][0-9]*'),
  status TEXT NOT NULL CHECK (status IN ('assigned', 'acknowledged', 'in_progress', 'on_hold', 'in_approval', 'pending_review', 'completed', 'reopened', 'cancelled')),
  owner_id TEXT NOT NULL,
  dept_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  original_due_at INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  doc TEXT NOT NULL,
  updated_at INTEGER
);
-- ;;
CREATE INDEX IF NOT EXISTS tasks_owner_status ON tasks (owner_id, status);
-- ;;
CREATE TRIGGER IF NOT EXISTS tasks_protect BEFORE UPDATE ON tasks
BEGIN
  SELECT CASE
    WHEN NEW.original_due_at <> OLD.original_due_at THEN RAISE(ABORT, 'original_due_at is immutable')
    WHEN NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN RAISE(ABORT, 'task creation details are immutable')
    WHEN json_extract(OLD.doc, '$.firstSubmittedAt') IS NOT NULL
      AND json_extract(NEW.doc, '$.firstSubmittedAt') IS NOT json_extract(OLD.doc, '$.firstSubmittedAt') THEN RAISE(ABORT, 'first submission time is immutable')
    WHEN json_array_length(NEW.doc, '$.history') < json_array_length(OLD.doc, '$.history') THEN RAISE(ABORT, 'task history is append-only')
  END;
END;
-- ;;
CREATE TABLE IF NOT EXISTS recurring_templates (
  id TEXT PRIMARY KEY,
  doc TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
-- ;;
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  task_id TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
-- ;;
CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at);
-- ;;
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
-- ;;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
-- ;;
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT,
  type TEXT NOT NULL,
  task_id TEXT,
  recipient_id TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
-- ;;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe ON notifications (dedupe_key, recipient_id) WHERE dedupe_key IS NOT NULL;
-- ;;
CREATE INDEX IF NOT EXISTS notifications_created ON notifications (created_at);
-- ;;
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('in-app', 'email', 'teams')),
  status TEXT NOT NULL CHECK (status IN ('delivered', 'queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  claim TEXT,
  sent_at INTEGER,
  updated_at INTEGER,
  UNIQUE (notification_id, channel)
);
-- ;;
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- ;;
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
-- ;;
-- Optimistic-locking guard: a batch inserts changes() here; 0 changed rows fails the CHECK and
-- rolls the whole batch back, so a concurrent edit is retried instead of overwritten.
CREATE TABLE IF NOT EXISTS _guard (ok INTEGER NOT NULL CHECK (ok > 0));
