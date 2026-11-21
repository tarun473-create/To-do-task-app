import { db } from '@/lib/db';
import { json } from '@/lib/http';
import { graphConfigured, storageConfigured, supabaseConfigured, env } from '@/lib/env';

export const dynamic = 'force-dynamic';

export async function GET() {
  let database = false;
  try { await db()`select 1 from task360.app_settings limit 1`; database = true; } catch { /* reported below */ }
  return json({
    ok: database, database, auth: supabaseConfigured(), microsoftSso: env.microsoftSso, fileStorage: storageConfigured(),
    outlook: graphConfigured(), teams: Boolean(env.teamsWebhookUrl), cron: env.cronSecret.length >= 16
  }, database ? 200 : 503);
}
