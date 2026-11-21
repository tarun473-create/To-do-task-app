-- =====================================================================
-- Task360 — Team Performance & Accountability Hub
-- PostgreSQL / Supabase schema for the server edition (server/).
--
-- • All tables live in a private schema `task360` that is NOT exposed through
--   Supabase's public REST API; only the Next.js server (direct Postgres
--   connection) reads and writes it. RLS is also enabled with no policies as a
--   second barrier.
-- • Each task row stores the full task document (doc jsonb: checklist, comments,
--   attachments metadata, ownership history, deadline revisions, task history)
--   plus indexed columns used for querying and integrity rules.
-- • Timestamps are UTC (timestamptz); the app displays Asia/Kolkata.
-- • Idempotent: safe to run again (npm run db:migrate).
-- =====================================================================

create extension if not exists citext;

create schema if not exists task360;

-- ---------- configuration ----------
create table if not exists task360.app_settings (
  id          smallint primary key default 1 check (id = 1),
  doc         jsonb not null,                 -- working days, holidays, KPI weights/policy, reminder rules, channels
  demo        boolean not null default false, -- true when the database holds demonstration data
  updated_at  timestamptz not null default now()
);

-- ---------- organisation ----------
create table if not exists task360.departments (
  id          text primary key,
  name        text not null unique,
  color       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists task360.users (
  id          text primary key,
  auth_id     uuid unique,                    -- Supabase auth.users.id, linked on first sign-in
  email       citext unique,
  name        text not null,
  role        text not null check (role in ('super_admin', 'dept_head', 'manager', 'employee')),
  dept_id     text references task360.departments(id),
  manager_id  text references task360.users(id),
  teams       text[] not null default '{}',   -- departments a manager is authorised for
  active      boolean not null default true,
  on_leave    boolean not null default false,
  backup_id   text references task360.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ---------- tasks ----------
create table if not exists task360.tasks (
  id               text primary key check (id ~ '^T360-[0-9]{4,}$'),
  dept_id          text not null references task360.departments(id),
  owner_id         text not null references task360.users(id),
  created_by       text not null references task360.users(id),
  status           text not null check (status in ('assigned', 'acknowledged', 'in_progress', 'on_hold', 'pending_review', 'completed', 'reopened', 'cancelled')),
  priority         text not null check (priority in ('low', 'medium', 'high', 'critical')),
  due_at           timestamptz not null,
  original_due_at  timestamptz not null,        -- immutable (trigger below)
  kpi_due_at       timestamptz not null,
  archived         boolean not null default false,
  demo             boolean not null default false,
  version          integer not null default 1,  -- optimistic concurrency
  doc              jsonb not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (doc->>'id' = id)
);
create index if not exists tasks_owner_status_idx on task360.tasks (owner_id, status);
create index if not exists tasks_dept_due_idx     on task360.tasks (dept_id, due_at);
create index if not exists tasks_open_due_idx     on task360.tasks (due_at) where status not in ('completed', 'cancelled');

create table if not exists task360.recurring_templates (
  id          text primary key,
  doc         jsonb not null,
  active      boolean not null default true,
  updated_at  timestamptz not null default now()
);

-- ---------- immutable audit trail ----------
create table if not exists task360.audit_log (
  id       bigserial primary key,
  at       timestamptz not null default now(),
  actor    text not null,                    -- user id or 'system'
  action   text not null,
  task_id  text,
  detail   text not null default ''
);
create index if not exists audit_task_idx on task360.audit_log (task_id, at);
create index if not exists audit_at_idx   on task360.audit_log (at desc);

-- ---------- notifications ----------
create table if not exists task360.notifications (
  id            text primary key,
  dedupe_key    text,                        -- e.g. 'T360-0042:esc1:<due ms>' — prevents duplicate reminders
  type          text not null,
  task_id       text,
  recipient_id  text not null references task360.users(id),
  message       text not null,
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);
create unique index if not exists notifications_dedupe_uq on task360.notifications (dedupe_key, recipient_id) where dedupe_key is not null;
create index if not exists notifications_recipient_idx on task360.notifications (recipient_id, created_at desc);
create index if not exists notifications_created_idx on task360.notifications (created_at desc);

create table if not exists task360.notification_deliveries (
  id               bigserial primary key,
  notification_id  text not null references task360.notifications(id) on delete cascade,
  channel          text not null check (channel in ('in-app', 'email', 'teams')),
  status           text not null check (status in ('delivered', 'queued', 'sending', 'sent', 'failed', 'skipped')),
  attempts         integer not null default 0,
  last_error       text,
  next_attempt_at  timestamptz not null default now(),
  sent_at          timestamptz,
  updated_at       timestamptz not null default now(),
  unique (notification_id, channel)
);
create index if not exists deliveries_queue_idx on task360.notification_deliveries (next_attempt_at) where status in ('queued', 'sending');

-- ---------- integrity triggers ----------
create or replace function task360.forbid_audit_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only';
end $$;
drop trigger if exists audit_no_update on task360.audit_log;
create trigger audit_no_update before update or delete on task360.audit_log
  for each row execute function task360.forbid_audit_mutation();
drop trigger if exists audit_no_truncate on task360.audit_log;
create trigger audit_no_truncate before truncate on task360.audit_log
  for each statement execute function task360.forbid_audit_mutation();

create or replace function task360.protect_task() returns trigger language plpgsql as $$
begin
  if new.original_due_at <> old.original_due_at then
    raise exception 'original_due_at is immutable';
  end if;
  if new.created_at <> old.created_at or new.created_by <> old.created_by then
    raise exception 'task creation details are immutable';
  end if;
  if (old.doc->>'firstSubmittedAt') is not null and (new.doc->>'firstSubmittedAt') is distinct from (old.doc->>'firstSubmittedAt') then
    raise exception 'first submission timestamp is immutable once set';
  end if;
  if jsonb_array_length(coalesce(new.doc->'history', '[]')) < jsonb_array_length(coalesce(old.doc->'history', '[]')) then
    raise exception 'task history is append-only';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists tasks_protect on task360.tasks;
create trigger tasks_protect before update on task360.tasks
  for each row execute function task360.protect_task();

-- ---------- lock down ----------
alter table task360.app_settings            enable row level security;
alter table task360.departments             enable row level security;
alter table task360.users                   enable row level security;
alter table task360.tasks                   enable row level security;
alter table task360.recurring_templates     enable row level security;
alter table task360.audit_log               enable row level security;
alter table task360.notifications           enable row level security;
alter table task360.notification_deliveries enable row level security;

do $$
begin
  -- Supabase API roles must never touch this schema directly.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema task360 from anon';
    execute 'revoke all on all tables in schema task360 from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema task360 from authenticated';
    execute 'revoke all on all tables in schema task360 from authenticated';
  end if;
end $$;
