/* Server configuration. Secrets are read from environment variables only — never sent to the browser. */
const bool = (v?: string) => v === 'true' || v === '1';

export const env = {
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || '',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  storageBucket: process.env.STORAGE_BUCKET || 'task-attachments',
  microsoftSso: bool(process.env.MICROSOFT_SSO_ENABLED),
  cronSecret: process.env.CRON_SECRET || '',
  // Microsoft Graph (Outlook mail) — app registration with Mail.Send application permission
  msTenantId: process.env.MS_TENANT_ID || '',
  msClientId: process.env.MS_CLIENT_ID || '',
  msClientSecret: process.env.MS_CLIENT_SECRET || '',
  msSender: process.env.MS_SENDER_EMAIL || '',
  msLoginBase: (process.env.MS_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/$/, ''),
  msGraphBase: (process.env.MS_GRAPH_BASE || 'https://graph.microsoft.com').replace(/\/$/, ''),
  emailSkipTypes: (process.env.EMAIL_SKIP_TYPES ?? 'comment').split(',').map(s => s.trim()).filter(Boolean),
  // Microsoft Teams — "Workflows" (Power Automate) webhook that posts to a channel
  teamsWebhookUrl: process.env.TEAMS_WEBHOOK_URL || '',
  teamsTypes: (process.env.TEAMS_NOTIFY_TYPES ?? 'overdue,escalation1,escalation2,digest,weekly_summary,monthly_kpi')
    .split(',').map(s => s.trim()).filter(Boolean),
  // Local development only: sign in as any user without Supabase. Ignored in production.
  devLogin: bool(process.env.DEV_LOGIN) && process.env.NODE_ENV !== 'production'
};

export const graphConfigured = () => Boolean(env.msTenantId && env.msClientId && env.msClientSecret && env.msSender);
export const storageConfigured = () => Boolean(env.supabaseUrl && env.supabaseServiceKey);
export const supabaseConfigured = () => Boolean(env.supabaseUrl && env.supabaseAnonKey);
