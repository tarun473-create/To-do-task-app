# Task360: Architecture, Plan and Acceptance Criteria

**Task360: Team Performance & Accountability Hub** is a multi-user task management system for department heads, managers and employees. It centralises task assignment, automates follow-up and escalation, and measures employee performance through transparent KPIs. The first rollout is a corporate Finance & Accounts department.

This repository contains two editions:

| Edition | What it is | Status |
|---|---|---|
| **Standalone (`index.html`, `css/`, `js/`)** | Every workflow in plain HTML, CSS and JavaScript. Data is saved in the browser's `localStorage` and labelled **DEMO DATA**. Can be published on GitHub Pages. | Done |
| **Server (`server/`)** | Next.js 15 + Supabase (PostgreSQL, Auth, Storage), Microsoft Graph for Outlook, a Teams Workflows webhook, and a scheduled job. Same UI and the same rules engine, executed on the server. | Built and tested against PostgreSQL 16 with fake Microsoft endpoints; deployment steps in `server/README.md` |

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

In the server edition, enforcement happens in three layers: the rules engine run by the server for every change (the browser cannot pick the actor or timestamps); a private database schema that Supabase's public API cannot reach, with row-level security on and no policies; and database triggers that protect history and immutable columns.

## 4. Architecture (server edition, as built)

```
 Browser: Task360 UI (same index.html / css / js as the standalone demo, plus js/remote.js)
      │  HTTPS, Supabase Auth session cookie (email link or Microsoft Entra ID)
      ▼
 Next.js 15 server (server/)
   middleware.ts          session refresh; every page and API needs a signed-in user
   /hub                   app shell with the user's scoped data embedded
   /api/actions           ALL changes: actor from session → rules engine in a V8 sandbox
                          (js/store.js + js/engine.js) → diff → one transaction
   /api/bootstrap         fresh scoped data (browser polls every 30 s and on navigation)
   /api/attachments/*     signed upload → verify → record; 5-minute signed downloads
   /api/cron              (Bearer CRON_SECRET) follow-up engine + delivery worker
      ▼
 PostgreSQL (Supabase), private schema task360
   tasks (indexed columns + full task document), users, departments, app_settings,
   recurring_templates, audit_log (append-only), notifications (unique dedupe key),
   notification_deliveries (queue with attempts / next_attempt_at / last_error)
      ▲
 GitHub Actions every 10 min (or Supabase pg_cron) ──► /api/cron
      ▼
 Delivery worker → Microsoft Graph sendMail (Outlook) · Teams Workflows webhook (Adaptive Card)
   claims rows with FOR UPDATE SKIP LOCKED; retries at 2/4/8/16 min; failed after 5 attempts
```

**Why the server runs the same engine as the browser:** one set of rules, so client and server can never disagree. The browser copy only gives quick feedback. The server copy is the one that counts: it picks the actor, stamps all times, and re-checks every permission and every required reason.

**Concurrency:** each task row has a `version`. If another request changed a task first, the save is rolled back and the action is re-run on fresh data (up to 4 attempts). New task IDs are unique-constrained the same way.

### Key design decisions
- **Overdue is a computed flag** (`status not in (pending_review, completed, cancelled) and now() > due_at`), so a task can be In Progress *and* Overdue.
- **Three deadlines:** `original_due_at` (never changes), `due_at` (current), and `kpi_due_at`. `kpi_due_at` moves only when a revision is attributed to the *manager* or an *external* cause. Extensions the employee asked for keep the original KPI deadline.
- **Fair ownership:** `task_ownership` records every handover. KPI measures each owner from their own `assigned_at`, so earlier owners are not scored on reassigned work.
- **Duplicate prevention:** every automatic notification has a deterministic `dedupe_key` (for example `T360-0042:esc1:<due ms>`), with a unique index on `(dedupe_key, recipient_id)`. If the due date changes, the key changes, so the reminder cycle restarts correctly.
- **Working-day maths** uses `company_settings.working_days` and `holidays` for escalations.

## 5. Database schema

See [`db/schema.sql`](../db/schema.sql), schema `task360`:

| Table | Purpose |
|---|---|
| `app_settings` | Working days, business hours, holidays, KPI weights and policy, reminder/escalation rules, channels, demo flag |
| `departments`, `users` | Organisation; managers' authorised teams; leave and backup; `auth_id` linked on first sign-in |
| `tasks` | Indexed columns (owner, department, status, priority, due / original / KPI due, version) plus the full task document: checklist, comments, attachment metadata, ownership history, deadline revisions, task history |
| `recurring_templates` | Daily, weekly, monthly, quarterly and annual templates |
| `audit_log` | Append-only (UPDATE, DELETE and TRUNCATE blocked by triggers) |
| `notifications`, `notification_deliveries` | In-app inbox and the email/Teams delivery queue with status, attempts and last error |

Triggers also make `original_due_at`, creation details and the first-submission time immutable, and keep task history append-only.

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
| 1 | Auth and roles, users, create/assign/reassign/complete, approval | ✓ (user switcher in place of login) | ✓ Supabase Auth: email link + Entra ID SSO |
| 2 | Dashboard, search, filters, drill-down, history, reports, CSV/Excel | ✓ | ✓ same UI |
| 3 | Reminders, escalation matrix, recurring tasks, Outlook/Teams | ✓ (email/Teams logged as *simulated*) | ✓ scheduled job + Graph/Teams delivery worker |
| 4 | KPI engine, workload balancing, leave/backup, analytics | ✓ | ✓ (KPIs calculated live from the shared data) |
| 5 | AI assistant, advanced integrations | ✓ (rules-based, data-grounded) | ✓ same assistant over the user's scoped data; an LLM can be added later |

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
| 18 | Email/Teams delivery with retries; failures recorded and visible | ✅ tested with fake Graph/Teams endpoints: 503 → retried → sent; outage → failed after 5 attempts |
| 19 | Multi-user access with permanent shared storage | ✅ tested: manager and employee sessions on PostgreSQL 16 |
| 20 | Server enforces permissions even when the browser is bypassed (direct API calls) | ✅ tested (employee approve/create/settings, cross-team assignment, back-dating, spoofed recurring creator, attachment-path injection, missing CSRF header) |
| 21 | Simultaneous edits to the same task are both kept | ✅ tested |
| 22 | Database blocks edits to audit log, original deadline and task history | ✅ tested directly in SQL |
| 23 | Employees receive only their own tasks; colleagues' emails hidden | ✅ tested |
| 24 | Supabase Auth (email link, Microsoft SSO) and Supabase Storage uploads | ⚠ written to Supabase's documented APIs; needs a real Supabase project to verify |
