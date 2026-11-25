# Task360: Team Performance & Accountability Hub

A team task management, accountability and KPI tracking system for department heads, managers and employees. It is set up first for a Finance & Accounts department (Treasury, AP, AR, Compliance, MIS & Closing).

## Two editions, one codebase

| | Standalone demo | Server edition ([`server/`](server/README.md)) |
|---|---|---|
| What it is | Plain HTML, CSS and JavaScript; open `index.html` | Next.js + Supabase (PostgreSQL), deployable to Vercel |
| Data | Your browser only, labelled **DEMO DATA** | One shared database for the whole team |
| Sign-in | User switcher (demo) | Email sign-in link or Microsoft SSO; only users the admin added |
| Notifications | In-app; email/Teams *simulated* | In-app + **real Outlook email** (Microsoft Graph) + **Teams channel** posts, with retries |
| Reminders & escalations | Run while the page is open | Scheduled job every 10 minutes (GitHub Actions or Supabase pg_cron) |
| Attachments | File names only | Private storage, signed download links |
| Live link | GitHub Pages: `https://tarun473-create.github.io/To-do-task-app/` (after Pages is switched on) | Your own address, for example on Vercel |

**Cloudflare edition ([`cloudflare/`](cloudflare/README.md)):** the same app on Cloudflare Workers, D1 (database), R2 (files) and Cron Triggers (reminders), with sign-in built in: Microsoft 365 directly, or email + password with a company starting password that must be changed at first sign-in. No other services needed.

All editions use the same screens and the same rules engine (`js/engine.js`). The server runs that engine itself, so every permission, reason requirement and timestamp is enforced on the server. **To deploy the server edition, follow [`server/README.md`](server/README.md).**

## Shared team page on claude.ai (no hosting needed)

The same app can run as a shared page on claude.ai (`js/shared.js` adapter). People sign in with their Claude account. Every change is saved permanently in the page's shared database and appears live for everyone.

- **First open by the owner:** a setup screen creates an empty workspace. There is no demo data, and the owner becomes Super Admin.
- **Adding people:** the Super Admin adds team members by work email, or by searching the organization, under **Team & Workload → Add team member**. When that person opens the page, they are recognised automatically.
- **Someone not on the team yet:** they can press **Ask for access**. The request appears on the Super Admin's Team page.
- **Access:** share the page with team members as **Contributor** in the Share menu. Viewers can only look.
- **Limits compared with the server edition:**
  - Notifications are in-app only.
  - Reminders and escalations run while someone on the team has the page open.
  - Attachments record the file name only.
  - Roles are enforced in the page itself, so share it only with your team.

## Approval before submission

Any task, or recurring task, can require one or more approvals before the assignee may submit it (maker–checker). The flow is:

1. The assignee sends the task for approval, with an optional note.
2. Each approver, in order, approves or rejects. A rejection needs a reason and sends the task back to the assignee.
3. Once every step is approved, the assignee submits the task for final review.

The task panel shows a workflow tracker: every stage, who it is waiting on, since when, and the full approval history. The **Workflow Tracker** page lists every open task by stage, longest waiting first. **Approvals for Me** lists the decisions waiting on you.

Time spent waiting on approvers is not counted against the employee's turnaround time (TAT) or on-time KPI.

## Run the standalone demo

```bash
# any static server works; or just double-click index.html
python3 -m http.server 8080
# open http://localhost:8080
```

Use the **user switcher** in the top bar to sign in as a different role:
- **Tarun Rajput**: Super Admin and head of the department (default). Sees everything, receives second escalations and month-end reports, adds team members and departments (**Team & Workload** page), and changes settings
- **Priya Nair / Vikram Singh**: Reporting Managers (create, assign, review)
- **Ananya, Rohit, Sneha, …**: Employees (acknowledge, update progress, submit)

## Files

```
index.html          App shell (sidebar, top bar, search, notifications) — shared by both editions
css/styles.css      Design system: light/dark themes, responsive layout
js/store.js         Data model, demo seed data, localStorage persistence
js/engine.js        Business rules: permissions, workflow API, audit trail,
                    notifications, escalation engine, recurring tasks, KPI formula
js/ui.js            Shared components: task table, task drawer, create-task form, exports
js/views.js         Pages: dashboard, lists, Kanban, calendar, KPI, workload,
                    follow-up centre, recurring, reports, audit, admin, AI assistant
js/app.js           Router, navigation, global search, notification centre, theme
js/remote.js        Server edition only: sends actions to the server instead of browser storage
db/schema.sql       PostgreSQL schema (server edition) with immutability triggers
server/             Next.js server edition: API, sign-in, scheduled job, Outlook/Teams delivery
.github/workflows/  GitHub Pages deploy, 10-minute follow-up job, CI build check
docs/ARCHITECTURE.md  Architecture, user flow, KPI formula, phases, acceptance criteria
```

## Features

- **Tasks:** create, edit, assign, reassign (reason required), duplicate, archive, cancel. IDs are generated automatically (`T360-0001`). Tasks support a checklist, comments, attachments as evidence, dependencies, progress from 0 to 100%, and a KPI weight.
- **Statuses:** Assigned → Acknowledged → In Progress / On Hold → Pending Review → Completed / Reopened. **Overdue is a flag**, so a task keeps its status while overdue.
- **Follow-up and escalation:** acknowledgement reminder after 4 h, reminders 24 h and 2 h before the deadline, an overdue notice, 1st escalation to the manager after 1 working day and 2nd to the department head after 2. Optional daily follow-ups, a morning digest, a Monday summary and a month-end KPI report. Duplicates are suppressed. Timings, working days and holidays are configurable.
- **Dashboard:** 12 KPI cards, a status donut, department performance, employee workload, ageing and a priority breakdown. Every figure is clickable and opens the matching tasks.
- **Views:** List (sort, filter, search), Kanban (drag and drop, checked against workflow rules), Calendar (with holidays), My Tasks, Assigned by Me, Overdue, Pending Approvals, Team Workload, Recurring.
- **KPI:** 35/25/20/10/10 weights you can change. Each employee can see how their score is calculated, with a 6-month trend, the weakest area and delay attribution, plus an interactive calculator.
- **Fairness safeguards:** the original deadline is always kept. Extensions the employee asked for don't move the KPI deadline. Approved external dependencies are excluded. Each owner is scored only from their own assignment time.
- **Leave and backup:** open tasks are handed to a backup and the ownership history is kept. New tasks for someone on leave go to their backup automatically.
- **Audit trail:** an append-only log of every action, with user, IST date and time, and detail.
- **Reports:** weekly and monthly summaries, TAT deviations, an overdue report, and CSV/Excel/print exports.
- **AI assistant:** answers questions such as "Which tasks require my attention today?", "Who has the highest pendency?" and "Which department is consistently missing deadlines?" It uses only the data you are allowed to see.
- **Design:** collapsible sidebar, global search (press `/`), notification centre, light and dark modes, and a mobile-responsive layout. All times are shown in Asia/Kolkata (IST).

## Publish the demo on GitHub Pages

The workflow `.github/workflows/pages.yml` publishes `index.html`, `css/` and `js/` whenever they change on `main`. It is a one-time switch: **repository Settings → Pages → Build and deployment → Source: GitHub Actions**. Then run the workflow once from the **Actions** tab, or push a change. The link is `https://tarun473-create.github.io/To-do-task-app/`. Anyone with the link can open the demo. Each visitor's data stays in their own browser.

## Limits of the standalone demo

- Data is stored per browser. Use **Admin → Data** to back up, restore or reset it.
- Email and Teams notifications are recorded as *simulated*, and attachments store file names only.
- The user switcher stands in for login.

All of these are handled by the [server edition](server/README.md).
