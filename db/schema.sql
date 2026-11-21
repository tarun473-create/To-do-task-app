-- =====================================================================
-- Task360 — Team Performance & Accountability Hub
-- PostgreSQL / Supabase schema (production edition)
-- Timestamps are stored in UTC (timestamptz); display timezone is Asia/Kolkata.
-- =====================================================================

create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- ---------- enums ----------
create type user_role       as enum ('super_admin', 'dept_head', 'manager', 'employee');
create type task_status     as enum ('assigned', 'acknowledged', 'in_progress', 'on_hold', 'pending_review', 'completed', 'reopened', 'cancelled');
create type task_priority   as enum ('low', 'medium', 'high', 'critical');
create type reminder_mode   as enum ('standard', 'daily', 'none');
create type delay_attrib    as enum ('employee', 'manager', 'external');
create type recur_freq      as enum ('daily', 'weekly', 'monthly', 'quarterly', 'annual');
create type notif_channel   as enum ('in_app', 'email', 'teams');
create type notif_status    as enum ('queued', 'sent', 'delivered', 'failed', 'suppressed');

-- ---------- organisation ----------
create table companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  timezone    text not null default 'Asia/Kolkata',
  created_at  timestamptz not null default now()
);

create table departments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references companies(id),
  name        text not null,
  head_id     uuid,                                   -- FK added after users
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (company_id, name)
);

create table users (
  id            uuid primary key default gen_random_uuid(),  -- = auth.users.id in Supabase
  company_id    uuid not null references companies(id),
  full_name     text not null,
  email         citext unique not null,
  role          user_role not null default 'employee',
  department_id uuid references departments(id),
  manager_id    uuid references users(id),
  is_active     boolean not null default true,
  aad_object_id text unique,                                -- Microsoft Entra ID (SSO)
  created_at    timestamptz not null default now()
);
alter table departments add constraint departments_head_fk foreign key (head_id) references users(id);

-- Teams (departments) a manager is authorised for
create table manager_scopes (
  manager_id    uuid not null references users(id) on delete cascade,
  department_id uuid not null references departments(id) on delete cascade,
  primary key (manager_id, department_id)
);

create table leaves (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id),
  backup_id   uuid not null references users(id),
  starts_on   date not null,
  ends_on     date not null,
  created_by  uuid not null references users(id),
  created_at  timestamptz not null default now(),
  check (ends_on >= starts_on)
);

-- ---------- tasks ----------
create sequence task_number_seq start 1;

create table recurring_templates (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  description     text,
  department_id   uuid not null references departments(id),
  category        text not null,
  priority        task_priority not null default 'medium',
  owner_id        uuid not null references users(id),
  created_by      uuid not null references users(id),
  frequency       recur_freq not null,
  weekday         smallint check (weekday between 0 and 6),
  day_of_month    smallint check (day_of_month between 1 and 28),
  month_of_year   smallint check (month_of_year between 1 and 12),
  due_time        time not null default '18:00',
  expected_tat_hours int not null default 48,
  is_active       boolean not null default true,
  last_period_key text,
  created_at      timestamptz not null default now()
);

create table tasks (
  id                 uuid primary key default gen_random_uuid(),
  task_no            text unique not null default ('T360-' || lpad(nextval('task_number_seq')::text, 5, '0')),
  company_id         uuid not null references companies(id),
  department_id      uuid not null references departments(id),
  category           text not null default 'Ad hoc',
  title              text not null check (length(title) >= 3),
  description        text,
  priority           task_priority not null default 'medium',
  status             task_status not null default 'assigned',
  progress           smallint not null default 0 check (progress between 0 and 100),
  owner_id           uuid not null references users(id),
  created_by         uuid not null references users(id),
  reviewer_id        uuid references users(id),
  start_date         date,
  due_at             timestamptz not null,
  original_due_at    timestamptz not null,           -- never updated after insert (trigger)
  kpi_due_at         timestamptz not null,           -- moves only on manager/external revisions
  expected_tat_hours int not null default 48,
  reminder_mode      reminder_mode not null default 'standard',
  include_in_kpi     boolean not null default true,
  kpi_weight         smallint not null default 1 check (kpi_weight between 1 and 3),
  external_dependency_reason text,
  external_dependency_approved_by uuid references users(id),
  external_dependency_approved_at timestamptz,
  recurring_template_id uuid references recurring_templates(id),
  recurring_period_key  text,
  assigned_at        timestamptz not null default now(),
  acknowledged_at    timestamptz,
  started_at         timestamptz,
  first_submitted_at timestamptz,
  submitted_at       timestamptz,
  completed_at       timestamptz,
  reopen_count       int not null default 0,
  is_archived        boolean not null default false,
  is_demo            boolean not null default false,  -- clearly distinguishes demo data
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (recurring_template_id, recurring_period_key)  -- prevents duplicate recurring instances
);
create index tasks_owner_status_idx on tasks (owner_id, status);
create index tasks_dept_due_idx     on tasks (department_id, due_at);
create index tasks_open_due_idx     on tasks (due_at) where status not in ('completed', 'cancelled');

create table task_collaborators (
  task_id uuid references tasks(id) on delete cascade,
  user_id uuid references users(id),
  primary key (task_id, user_id)
);

create table task_ownership (                  -- full ownership history for fair KPI
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id) on delete cascade,
  user_id     uuid not null references users(id),
  from_at     timestamptz not null default now(),
  to_at       timestamptz,
  reason      text not null,
  end_reason  text,
  cause       text check (cause in ('workload', 'skill', 'leave', 'performance', 'scope')),
  backup_for  uuid references users(id)
);

create table task_deadline_changes (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id) on delete cascade,
  changed_by  uuid not null references users(id),
  from_due_at timestamptz not null,
  to_due_at   timestamptz not null,
  reason      text not null check (length(reason) >= 5),
  attribution delay_attrib not null,
  changed_at  timestamptz not null default now()
);

create table task_dependencies (
  task_id       uuid references tasks(id) on delete cascade,
  depends_on_id uuid references tasks(id) on delete cascade,
  primary key (task_id, depends_on_id),
  check (task_id <> depends_on_id)
);

create table task_checklist_items (
  id        uuid primary key default gen_random_uuid(),
  task_id   uuid not null references tasks(id) on delete cascade,
  text      text not null,
  is_done   boolean not null default false,
  position  int not null default 0
);

create table task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references tasks(id) on delete cascade,
  author_id   uuid not null references users(id),
  body        text not null,
  created_at  timestamptz not null default now()
);

create table task_attachments (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references tasks(id) on delete cascade,
  uploaded_by   uuid not null references users(id),
  file_name     text not null,
  storage_path  text not null,          -- private bucket; served via short-lived signed URLs
  size_bytes    bigint not null check (size_bytes <= 26214400),
  mime_type     text,
  is_evidence   boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------- immutable audit trail ----------
create table audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid references users(id),        -- null = system job
  action      text not null,
  task_id     uuid references tasks(id),
  detail      text,
  before      jsonb,
  after       jsonb,
  ip_address  inet
);
create index audit_task_idx on audit_log (task_id, at);

create or replace function forbid_audit_mutation() returns trigger language plpgsql as $$
begin raise exception 'audit_log is append-only'; end $$;
create trigger audit_no_update before update or delete on audit_log
  for each row execute function forbid_audit_mutation();

-- original_due_at may never change; status/timestamps are set by the server
create or replace function protect_task_columns() returns trigger language plpgsql as $$
begin
  if new.original_due_at <> old.original_due_at then raise exception 'original_due_at is immutable'; end if;
  if new.first_submitted_at is distinct from old.first_submitted_at and old.first_submitted_at is not null then
    raise exception 'first_submitted_at is immutable once set';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger tasks_protect before update on tasks for each row execute function protect_task_columns();

-- ---------- notifications & automation ----------
create table escalation_rules (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references companies(id),
  trigger_code    text not null,  -- ack_reminder | due_24h | due_2h | overdue | escalation1 | escalation2 | daily_followup | digest | weekly_summary | monthly_kpi
  offset_hours    numeric,        -- e.g. 4 for ack reminder, -24 for due reminder
  offset_working_days int,        -- e.g. 1 / 2 for escalations
  recipient       text not null,  -- employee | reporting_manager | department_head | creator
  channels        notif_channel[] not null default '{in_app,email,teams}',
  is_active       boolean not null default true
);

create table notifications (
  id            uuid primary key default gen_random_uuid(),
  dedupe_key    text not null,               -- e.g. '<task>:esc1:<due_at>' — prevents duplicates
  type          text not null,
  task_id       uuid references tasks(id),
  recipient_id  uuid not null references users(id),
  message       text not null,
  created_at    timestamptz not null default now(),
  read_at       timestamptz,
  unique (dedupe_key, recipient_id)
);

create table notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references notifications(id) on delete cascade,
  channel         notif_channel not null,
  status          notif_status not null default 'queued',
  attempts        int not null default 0,
  last_error      text,
  provider_msg_id text,
  updated_at      timestamptz not null default now()
);

-- ---------- configuration ----------
create table holidays (
  company_id  uuid not null references companies(id),
  holiday_on  date not null,
  name        text not null,
  primary key (company_id, holiday_on)
);

create table company_settings (
  company_id      uuid primary key references companies(id),
  working_days    smallint[] not null default '{1,2,3,4,5,6}',
  business_start  time not null default '09:30',
  business_end    time not null default '18:30',
  kpi_weights     jsonb not null default '{"onTime":35,"completion":25,"quality":20,"tat":10,"responsiveness":10}',
  kpi_exclude_external  boolean not null default true,
  kpi_exclude_cancelled boolean not null default true,
  check ((kpi_weights->>'onTime')::int + (kpi_weights->>'completion')::int + (kpi_weights->>'quality')::int
       + (kpi_weights->>'tat')::int + (kpi_weights->>'responsiveness')::int = 100)
);

-- ---------- KPI snapshots (written only by the server job) ----------
create table kpi_records (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id),
  period_start     date not null,
  period_end       date not null,
  on_time_pct      numeric(5,2),
  completion_pct   numeric(5,2),
  quality_pct      numeric(5,2),
  tat_pct          numeric(5,2),
  responsiveness_pct numeric(5,2),
  score            numeric(5,2),
  weights          jsonb not null,
  basis            jsonb not null,          -- task ids + numerators/denominators for transparency
  computed_at      timestamptz not null default now(),
  unique (user_id, period_start, period_end)
);

-- =====================================================================
-- Row-level security (Supabase). The service role (server jobs) bypasses RLS.
-- =====================================================================
alter table tasks          enable row level security;
alter table task_comments  enable row level security;
alter table task_attachments enable row level security;
alter table audit_log      enable row level security;
alter table kpi_records    enable row level security;
alter table notifications  enable row level security;

create or replace function current_app_user() returns users language sql stable as $$
  select * from users where id = auth.uid()
$$;

create or replace function can_view_task(t tasks) returns boolean language sql stable as $$
  select case
    when (current_app_user()).role in ('super_admin', 'dept_head') then true
    when t.owner_id = auth.uid() or t.created_by = auth.uid() or t.reviewer_id = auth.uid() then true
    when exists (select 1 from task_collaborators c where c.task_id = t.id and c.user_id = auth.uid()) then true
    when (current_app_user()).role = 'manager' and (
         exists (select 1 from manager_scopes s where s.manager_id = auth.uid() and s.department_id = t.department_id)
      or exists (select 1 from users u where u.id = t.owner_id and u.manager_id = auth.uid())) then true
    else false end
$$;

create policy tasks_select on tasks for select using (can_view_task(tasks));
-- All writes go through server API routes using the service role, which enforce workflow rules.
create policy tasks_no_direct_write on tasks for all using (false) with check (false);

create policy kpi_select on kpi_records for select using (
  user_id = auth.uid() or (current_app_user()).role in ('super_admin', 'dept_head')
  or exists (select 1 from users u where u.id = kpi_records.user_id and u.manager_id = auth.uid())
);
-- No insert/update policy for kpi_records: employees (and everyone else) cannot modify KPI scores.

create policy notif_select on notifications for select using (recipient_id = auth.uid());
create policy notif_mark_read on notifications for update using (recipient_id = auth.uid()) with check (recipient_id = auth.uid());

create policy audit_select on audit_log for select using (
  (current_app_user()).role in ('super_admin', 'dept_head', 'manager')
);
