# Task360 on Cloudflare

Task360 runs entirely on Cloudflare:

| Cloudflare product | Used for |
|---|---|
| **Workers** | The app and its API (same screens and rules as every other Task360 edition) |
| **D1** | The database: people, departments, tasks with full history, close checklist, audit trail |
| **R2** | Evidence files and attachments (private; only people on a task can download) |
| **Cron Triggers** | The follow-up engine every 10 minutes: reminders, overdue notices, escalations, recurring tasks |

**Sign-in** is built in. There's no Supabase or other sign-in service:
- **Sign in with Microsoft**, directly with your Microsoft 365 / Entra ID tenant. Only your organisation's accounts are accepted.
- **Email + password.** Each person's username is their work email. Everyone starts with the company **starting password** (the `INITIAL_PASSWORD` secret) and must choose their own at first sign-in. The starting password stops working for a person once they set their own password or sign in with Microsoft.
- Passwords are stored as PBKDF2-SHA256 hashes. After 8 wrong passwords in 15 minutes, sign-in pauses. The Super Admin can reset anyone back to the starting password, which also signs them out everywhere.

> **Security note:** while a person still has the starting password, anyone who knows their email could sign in as them. Ask everyone to sign in on day one, watch **Team & Workload → Sign-in status**, and delete the `INITIAL_PASSWORD` secret once everyone has their own password or uses Microsoft. Never put the starting password in this repository; it is public.

## Set up (all in the browser)

1. **Merge the pull request** on GitHub so the `main` branch has the `cloudflare/` folder.
2. **Create a Cloudflare account** at dash.cloudflare.com.
3. **Create the database:** go to **Storage & Databases → D1 → Create** and name it `task360`. Copy its **Database ID**. On GitHub, open `cloudflare/wrangler.jsonc`, click the pencil icon, replace `PASTE-YOUR-D1-DATABASE-ID-HERE` with the ID, and commit.
4. **Create the file storage:** go to **R2 → Create bucket** and name it `task360-files`. Cloudflare may ask you to enable R2 first; the free allowance covers Task360's use.
5. **Create the Worker from GitHub:** go to **Workers & Pages → Create → Import a repository** and choose this repository. Then set:
   - Root directory: `cloudflare`
   - Build command: `npm run sync`
   - Deploy command: `npx wrangler deploy`

   Deploy. Your app address will look like `https://task360.<your-account>.workers.dev`.
6. **Add settings:** open the Worker's **Settings → Variables and Secrets** and add:

   | Name | Type | Value |
   |---|---|---|
   | `APP_URL` | Text | Your app address, without a trailing `/` |
   | `SESSION_SECRET` | Secret | A long random code (at least 32 characters) |
   | `INITIAL_PASSWORD` | Secret | The company starting password |
   | `SETUP_TOKEN` | Secret | Any code of at least 16 characters, used once in step 7 |

7. **Load your data:** in the current Task360 (Claude team page), go to **Admin Settings → Data → Download a copy (JSON)**. Then open `https://<your app>/setup`, enter the `SETUP_TOKEN`, and upload the file. The page creates the tables, loads everything, and then switches itself off.
8. **Turn on Microsoft sign-in:**
   1. In **entra.microsoft.com**, go to **App registrations → New registration**:
      - Name: Task360
      - Account type: **this organizational directory only**
      - Redirect URI (Web): `https://<your app>/auth/callback`
   2. Under **Certificates & secrets**, create a new client secret and copy its **Value**.
   3. Under **Token configuration**, add the optional claim `email` to the ID token.
   4. Add these to the Worker:

      | Name | Type | Value |
      |---|---|---|
      | `MICROSOFT_TENANT_ID` | Text | Directory (tenant) ID |
      | `MICROSOFT_CLIENT_ID` | Text | Application (client) ID |
      | `MICROSOFT_CLIENT_SECRET` | Secret | The secret Value |

9. **Sign in** at `https://<your app>/login`. Check `https://<your app>/api/health`; it should show `"database": true` and `"microsoft": true`. Then delete the `SETUP_TOKEN` secret.

Reminders start automatically through the Cron Trigger in `wrangler.jsonc`. No other scheduler is needed.

### Optional: Outlook email and Teams messages

| Name | Type | Value |
|---|---|---|
| `MS_MAIL_CLIENT_ID` | Text | An Entra app with the **application** permission `Mail.Send`, admin consent granted |
| `MS_MAIL_CLIENT_SECRET` | Secret | That app's client secret |
| `MS_SENDER_EMAIL` | Text | The mailbox to send from, for example `task360@yourcompany.com` |
| `TEAMS_WEBHOOK_URL` | Secret | Teams channel → Workflows → "Post to a channel when a webhook request is received" |

Until these are set, reminders appear in the app's 🔔 notification centre, and email and Teams copies are marked "skipped".

### Plans and limits
- **D1** (5 GB) and **R2** (10 GB) free allowances are far more than Task360 needs.
- The **Workers Free** plan allows 10 ms of CPU time per request. Task360 checks permissions over the whole workspace on each request, so it will outgrow that as tasks accumulate. Use **Workers Paid** (about USD 5 a month; check current pricing) for company use.
- **Custom address:** if your company domain's DNS is on Cloudflare, add one like `task360.yourcompany.com` under the Worker's **Settings → Domains & Routes**, then update `APP_URL` and the Microsoft redirect URI.

## Local development

```bash
npm ci
```

Create `.dev.vars`, which is ignored by Git, with `SESSION_SECRET`, `INITIAL_PASSWORD`, `SETUP_TOKEN` and, optionally, the `MICROSOFT_*` values. Then:

```bash
npm run dev
```

Open http://127.0.0.1:8787/setup. The local D1 and R2 live in `.wrangler/`. Run `npx wrangler dev --test-scheduled` and open `/cdn-cgi/handler/scheduled` to trigger the reminder job by hand.
