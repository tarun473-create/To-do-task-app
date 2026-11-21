# Task360: server edition (Next.js + Supabase)

This is the multi-user version of Task360. It gives everyone one shared database, real sign-in (an email link, or Microsoft single sign-on), private file attachments, and real Outlook and Teams notifications.

It uses **the same screens and the same rules code** as the standalone demo (`../index.html`, `../css`, `../js`). The browser shows the app, but every change is checked again on the server and saved to PostgreSQL. The browser cannot choose who it is acting as, set a timestamp, or skip a permission check.

```
Browser (Task360 UI)  ──HTTPS──►  Next.js server (Vercel)  ──►  Supabase PostgreSQL (schema task360)
                                     │  rules engine (js/engine.js) runs here, sandboxed per request
                                     │  Supabase Auth: email link / Microsoft Entra ID
                                     ├─► Supabase Storage (private bucket, 5-minute signed links)
                                     └─► Microsoft Graph (Outlook mail) · Teams Workflows webhook
GitHub Actions, every 10 min ──► /api/cron  (reminders, escalations, digests, recurring tasks, sending)
```

## What you need

| Service | Used for | Cost |
|---|---|---|
| [Supabase](https://supabase.com) | Database, sign-in, file storage | Free tier is enough to start |
| [Vercel](https://vercel.com) (or any Node 20+ host) | Runs the app | Free tier for evaluation; a paid plan for business use |
| Microsoft 365 admin (your IT team) | Microsoft sign-in, Outlook sending, Teams channel | Uses your existing licences |
| This GitHub repo | Runs the 10-minute scheduled job | Free for public repos |

You'll also need [Node.js 20+](https://nodejs.org) on your computer, once, to create the database tables.

---

## Step 1: Create the Supabase project

1. Go to Supabase → **New project**. Pick the **Mumbai (ap-south-1)** region and save the database password.
2. Under **Project settings → Database → Connection string → URI**, copy the **Transaction pooler** string (port 6543). This is `DATABASE_URL`.
3. Under **Project settings → API**, copy the **Project URL** (`NEXT_PUBLIC_SUPABASE_URL`), the **anon public** key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) and the **service_role** key (`SUPABASE_SERVICE_ROLE_KEY`). Keep the service_role key secret.
4. Under **Storage → New bucket**, name it `task-attachments` and leave **Public** switched **off**.

## Step 2: Create the tables and your admin account (run once, from your computer)

```bash
git clone https://github.com/tarun473-create/To-do-task-app.git
```

```bash
cd To-do-task-app/server && npm ci
```

```bash
DATABASE_URL="<your transaction pooler string>" npm run db:migrate
```

Then choose **one** of these:

```bash
DATABASE_URL="<…>" npm run db:seed -- --empty --admin-email you@yourcompany.com --admin-name "Your Name"
```
This is a real start: settings, the 5 Finance & Accounts departments, and you as Super Admin. Add your team in **Admin Settings → Users**.

```bash
DATABASE_URL="<…>" npm run db:seed -- --admin-email you@yourcompany.com --admin-name "Your Name"
```
This loads the demonstration data (labelled **DEMO DATA**), with you as the Super Admin. The demo employees have `@example.com` addresses and cannot sign in.

To start over later, run `drop schema task360 cascade;` in the Supabase SQL editor, then run migrate and seed again.

## Step 3: Set up sign-in

**Email link (always available)**
1. Go to Supabase → **Authentication → URL Configuration**. Set **Site URL** to your app address (for example `https://task360.yourcompany.com`) and add `https://task360.yourcompany.com/auth/callback` under **Redirect URLs**.
2. For real use, set up **Authentication → Emails → SMTP settings** with your company mail server. Supabase's built-in mailer only sends a few emails per hour.

Only people an administrator has added (by work email) can sign in. Anyone else is turned away.

**Microsoft single sign-on (optional, recommended)**
1. Your IT team goes to **Entra ID → App registrations → New registration** and creates "Task360 sign-in" (single tenant). The redirect URI (Web) is `https://<your-project>.supabase.co/auth/v1/callback`.
2. Under **Certificates & secrets**, create a client secret.
3. In Supabase, go to **Authentication → Providers → Azure** and enable it. Enter the Application (client) ID and the secret, and set **Azure Tenant URL** to `https://login.microsoftonline.com/<tenant-id>`.
4. On the server, set `MICROSOFT_SSO_ENABLED=true`. A **Sign in with Microsoft** button then appears on the login page.

## Step 4: Deploy the app on Vercel

1. In Vercel, choose **Add New → Project** and import this GitHub repo.
2. Set **Root Directory** to `server`. Keep **"Include files outside the root directory in the Build Step"** switched on, because the build copies `../index.html`, `../css` and `../js`.
3. Add the environment variables from [`.env.example`](.env.example). At minimum: `APP_URL`, `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET`. Generate the last one with `openssl rand -hex 32`.
4. Deploy, then open `https://<your-app>/api/health`. `"database": true` means the app is connected.

## Step 5: Turn on Outlook email (Microsoft Graph)

1. In **Entra ID → App registrations**, create "Task360 mailer". This can also be the sign-in app.
2. Under **API permissions → Add → Microsoft Graph → Application permissions**, add **Mail.Send**, then click **Grant admin consent**.
3. Create a client secret.
4. Create or choose the mailbox the app sends from, for example `task360@yourcompany.com`.
5. **Recommended:** limit the app to that one mailbox with an Exchange application access policy, using Exchange Online PowerShell. Without it, Mail.Send can send as any mailbox.
   ```powershell
   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId task360@yourcompany.com -AccessRight RestrictAccess -Description "Task360 mailer"
   ```
6. Set `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` and `MS_SENDER_EMAIL` on the server.

Every notification is emailed to its recipient, except comments (`EMAIL_SKIP_TYPES`). Each email has an **Open in Task360** button that opens the task.

## Step 6: Turn on Teams messages

1. In the Teams channel your team uses, open **⋯ → Workflows** and choose **"Post to a channel when a webhook request is received"**. Copy the URL.
2. Set `TEAMS_WEBHOOK_URL` to that URL.

By default only overdue notices, escalations, digests and weekly/monthly reports are posted, so the channel doesn't get flooded. You can change this with `TEAMS_NOTIFY_TYPES`. Each card names the employee concerned and links to the task.

## Step 7: Start the scheduled job

The follow-up engine runs every 10 minutes from GitHub Actions (`.github/workflows/followup-cron.yml`). In the repo, go to **Settings → Secrets and variables → Actions → New repository secret** and add:
- `TASK360_URL`: your app address, for example `https://task360.yourcompany.com`
- `TASK360_CRON_SECRET`: the same value as `CRON_SECRET`

Each run creates any reminders and escalations that are due, generates recurring tasks, and sends queued emails and Teams messages. Failed sends retry with growing delays (2, 4, 8, 16 minutes) and are marked **failed** after 5 attempts. You can see the status of every message in the **Follow-up Centre**.

*Alternative:* if you prefer Supabase to trigger the job, enable the `pg_cron` and `pg_net` extensions and run:
```sql
select cron.schedule('task360-followups', '*/10 * * * *',
  $$ select net.http_post(url := 'https://task360.yourcompany.com/api/cron',
       headers := jsonb_build_object('Authorization', 'Bearer <CRON_SECRET>')) $$);
```

---

## Security design

- Every change goes through `POST /api/actions`. The server takes the user from the sign-in session, runs the rules engine in an isolated sandbox, and only then writes to the database. The browser's copy of the rules exists only for quick feedback.
- Each user's browser receives only the data they are allowed to see. Employees get their own tasks only, and other people's email addresses are hidden from everyone except the Super Admin.
- The tables live in a private schema (`task360`) that Supabase's public API can't reach. Row-level security is also switched on with no access rules, as a second barrier.
- Database triggers block any edit or deletion of the audit log, changes to a task's original deadline, creation details or first-submission time, and removal of task history entries. This holds even for someone with direct database access through the app's account.
- Every reminder has a unique key in the database, so the same reminder can never be sent twice, even if two job runs overlap.
- Each task has a version number. If two people change the same task at the same moment, the second save is retried on fresh data rather than silently overwriting the first.
- API calls must carry a custom header, which blocks cross-site request forgery. Secrets exist only as server environment variables. Attachments are private, with 5-minute signed download links and a 25 MB limit.

## Local development

```bash
cp .env.example .env.local
```

Edit `.env.local`: set `DATABASE_URL` to a local PostgreSQL 15+ database and `DEV_LOGIN=true`. Then:

```bash
npm ci
```

```bash
npm run db:migrate
```

```bash
npm run db:seed -- --admin-email admin@example.com
```

```bash
npm run dev
```

Open http://localhost:3000. With `DEV_LOGIN=true`, the login page lists users you can sign in as without Supabase. This is switched off automatically in production builds. If you change files in `../js` or `../css`, re-run `npm run sync` (it also runs automatically before `dev` and `build`).

## Limits to know

- Each request loads the whole task set, which is fine for a department (thousands of tasks). Archive old tasks, or move to per-query loading, before scaling to many large departments.
- GitHub may delay scheduled jobs by a few minutes, and it pauses scheduled workflows in a repo with no commits for 60 days. For tighter timing, use the `pg_cron` option above.
