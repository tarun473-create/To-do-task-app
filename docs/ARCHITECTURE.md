# Task360: Architecture, Plan and Acceptance Criteria

**Task360: Team Performance & Accountability Hub** is a multi-user task management system for department heads, managers and employees. It centralises task assignment, automates follow-up and escalation, and measures employee performance through transparent KPIs. The first rollout is a corporate Finance & Accounts department.

This repository contains two editions:

| Edition | What it is | Status |
|---|---|---|
| **Standalone (this repo: `index.html`, `css/`, `js/`)** | Every workflow works in plain HTML, CSS and JavaScript. Data is saved in the browser's `localStorage` and labelled **DEMO DATA**. The business rules are written as server-style APIs. | Done: Phases 1–5 run end to end in one browser |
| **Server (production)** | Next.js + PostgreSQL/Supabase, using the same rules, `db/schema.sql`, scheduled jobs and Microsoft Graph | Designed here; the standalone rules engine (`js/engine.js`) carries over directly |

---

## 1. Inputs → outputs

| Inputs | Outputs |
|---|---|
| Task name, description, department, category | Individual task lists (My Tasks, Assigned by Me) |
| Assignee, reviewer, collaborators | Department and management dashboards |
| Assignment date/time (server), due date and time (IST) | Task ageing, overdue report, priority dashboard |
| Priority, expected TAT, KPI weight | Actual TAT and deviation |
| Reminder mode | Automated follow-ups and escalations |
| Completion remarks and evidence | Completion report and approval queue |
| Reassignment, deadline change (with reasons) | Accountability history (ownership, audit trail) |
| KPI weightage and policy | Employee KPI scores with the basis shown |

## 2. User flow

```
Manager creates task ──► Assignment notification (in-app / Outlook / Teams)
        │
        ▼
Employee acknowledges ──► (not acknowledged in 4 h → reminder)
        │
        ▼
In Progress: progress %, checklist, comments, evidence
        │   ├─ 24 h before due → reminder; 2 h before → urgent reminder
        │   ├─ Deadline crossed → Overdue flag (status retained) + notice
        │   ├─ +1 working day → escalation to reporting manager
        │   └─ +2 working days → escalation to department head
        ▼
Employee submits completion ──► server stamps submitted_at; reviewer notified; reminders stop
        │
        ▼
Manager reviews ──► Approve (Completed) │ Reopen (reason) │ Reassign (reason)
        │
        ▼
KPI recalculated (on-time, completion, quality, TAT, responsiveness)
```

## 3. Roles and access

| Capability | Super Admin | Dept Head | Manager | Employee |
|---|:-:|:-:|:-:|:-:|
| View tasks | All | All in company | Own teams + direct reports | Own, created, collaborator |
| Create / assign | ✓ | ✓ | Within authorised teams | — |
| Reassign / change deadline / cancel | ✓ | ✓ | Within scope (reason required) | — |
| Acknowledge / progress / submit | — | — | — | Own tasks |
| Approve / reopen | ✓ | ✓ | Within scope (never own task) | — |
| KPI view | All | All | Team | Own (with basis) |
| Edit KPI weights / rules / calendar / users | ✓ | — | — | — |
| Audit trail | ✓ | ✓ | ✓ (scope) | Task history only |

In production, enforcement happens in three places: server API route guards, Postgres RLS (`db/schema.sql`), and database triggers that protect immutable columns.

## 4. Architecture (production)

```
 Browser (Next.js App Router, React, Tailwind, Recharts)
      │  HTTPS, session cookie (Supabase Auth / Microsoft Entra ID SSO)
      ▼
 Next.js server: route handlers /api/*  ← all mutations; validate role, scope, reasons;
      │            set timestamps with now(); write audit_log in the same transaction
      ▼
 PostgreSQL (Supabase) ── RLS for reads ── triggers (append-only audit, immutable original_due_at)
      ▲
      │ service role
 Scheduled jobs (Supabase pg_cron / Vercel Cron, every 5 min):
   • follow-up engine (reminders, overdue, escalations) with dedupe keys
   • recurring task generator (unique template + period key)
   • daily digest 09:00 IST, weekly summary Monday, monthly KPI at month end
   • KPI snapshot writer → kpi_records
      │
      ▼
 Notification worker → Microsoft Graph (Outlook mail, Teams chat / channel webhook)
   • retries with backoff; delivery status in notification_deliveries
   • reminders suppressed once a task is pending_review / completed / cancelled
 Private object storage (attachments) → short-lived signed URLs
 AI assistant → server route that queries ONLY rows the user can see (RLS), then
   passes the summarised facts to an LLM for natural-language answers
```

### Key design decisions
- **Overdue is a computed flag** (`status not in (pending_review, completed, cancelled) and now() > due_at`), so a task can be In Progress *and* Overdue.
- **Three deadlines:** `original_due_at` (never changes), `due_at` (current), and `kpi_due_at`. `kpi_due_at` moves only when a revision is attributed to the *manager* or an *external* cause. Extensions the employee asked for keep the original KPI deadline.
- **Fair ownership:** `task_ownership` records every handover. KPI measures each owner from their own `assigned_at`, so earlier owners are not scored on reassigned work.
- **Duplicate prevention:** every automatic notification has a deterministic `dedupe_key` (for example `T360-00042:esc1:<due_at>`), with a unique constraint on `(dedupe_key, recipient_id)`. If the due date changes, the key changes, so the reminder cycle restarts correctly.
- **Working-day maths** uses `company_settings.working_days` and `holidays` for escalations.

## 5. Database schema

See [`db/schema.sql`](../db/schema.sql). Tables: `companies`, `departments`, `users`, `manager_scopes`, `leaves`, `tasks`, `task_collaborators`, `task_ownership`, `task_deadline_changes`, `task_dependencies`, `task_checklist_items`, `task_comments`, `task_attachments`, `audit_log`, `recurring_templates`, `escalation_rules`, `notifications`, `notification_deliveries`, `holidays`, `company_settings`, `kpi_records`.

## 6. KPI formula

| Parameter | Default weight | Formula (per period, by KPI deadline) |
|---|---|---|
| On-time completion | 35% | first submission ≤ kpi_due_at ÷ tasks due (approved external dependencies excluded) |
| Overall completion | 25% | submitted (pending review or completed) ÷ tasks due |
| Quality / first-time acceptance | 20% | completed with reopen_count = 0 ÷ completed |
| TAT adherence | 10% | (first_submitted_at − assigned_at) ≤ expected TAT ÷ submitted (external excluded) |
| Responsiveness | 10% | acknowledged within the acknowledgement window (default 4 h) ÷ assigned |

Each task counts with its KPI weight (1–3). Score = Σ(metric × weight) ÷ Σ(weights of metrics that have data). Bands: ≥90 Excellent, ≥80 Very good, ≥70 Good, ≥60 Needs improvement, below 60 Critical. Cancelled tasks are excluded. Worked example: 90/95/85/80/90 gives **89.25 → 89.3% (Very good)**.

## 7. Pages

Management Dashboard · My Tasks · Assigned by Me · Pending Approvals · Overdue Tasks · All Tasks (list) · Kanban Board · Calendar · Team & Workload · KPI & Performance · Follow-up Centre · Recurring Tasks · Reports & Analytics · AI Assistant · Audit Trail · Admin Settings. Every page is implemented in the standalone edition.

## 8. Implementation phases

| Phase | Scope | Standalone | Server |
|---|---|---|---|
| 1 | Auth and roles, users, create/assign/reassign/complete, approval | ✓ (user switcher in place of login) | Supabase Auth + Entra ID SSO |
| 2 | Dashboard, search, filters, drill-down, history, reports, CSV/Excel | ✓ | Same UI as React components |
| 3 | Reminders, escalation matrix, recurring tasks, Outlook/Teams | ✓ (email/Teams logged as *simulated*) | pg_cron + Graph worker |
| 4 | KPI engine, workload balancing, leave/backup, analytics | ✓ | `kpi_records` snapshots |
| 5 | AI assistant, advanced integrations | ✓ (rules-based, data-grounded) | LLM over RLS-scoped data |

## 9. Acceptance criteria (with test status in the standalone build)

| # | Criterion | Status |
|---|---|---|
| 1 | Employees cannot create tasks or assign outside scope | ✅ tested |
| 2 | Managers can assign only within authorised teams | ✅ tested |
| 3 | Unique task ID generated automatically | ✅ tested |
| 4 | Acknowledge, submit and complete timestamps set by the system, never by user input | ✅ tested |
| 5 | Submission requires remarks; blocked while dependencies are open | ✅ tested |
| 6 | Only a manager or reviewer (not the owner) can approve; reopen requires a reason | ✅ tested |
| 7 | Reassignment and deadline changes require reasons; original deadline preserved | ✅ tested |
| 8 | Employee-requested extension does not move the KPI deadline; manager revision does | ✅ tested |
| 9 | Overdue works as a flag and the underlying status is kept | ✅ tested |
| 10 | Overdue notice → 1st escalation (manager) → 2nd escalation (dept head) on working days | ✅ tested |
| 11 | Rerunning the engine sends no duplicate reminders | ✅ tested |
| 12 | Reminders stop when a task is submitted, completed or cancelled | ✅ tested |
| 13 | Audit entries cannot be modified | ✅ tested (frozen objects; DB trigger in production) |
| 14 | Only the Super Admin can change KPI weights or rules; weights must total 100% | ✅ tested |
| 15 | Leave hands open tasks to a backup and keeps ownership history | ✅ tested |
| 16 | Every dashboard card and chart drills down to the matching task list | ✅ tested |
| 17 | All pages render for all four roles with no script errors | ✅ tested |
| 18 | Email/Teams delivery and failure retries | ⏳ needs server edition (Graph credentials) |
| 19 | Multi-user concurrent access and permanent storage | ⏳ needs server edition |
