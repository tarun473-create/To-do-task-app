/* Scheduled job endpoint (call every 5–15 minutes). Protected by CRON_SECRET:
     Authorization: Bearer <CRON_SECRET>
   1) runs the follow-up engine, 2) sends queued Outlook / Teams notifications. */
import { env } from '@/lib/env';
import { runFollowUpPass } from '@/lib/followups';
import { processQueue } from '@/lib/notify/worker';
import { json, fail, safeEqual, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function handle(req: Request) {
  if (!env.cronSecret || env.cronSecret.length < 16) return fail('CRON_SECRET is not configured (min 16 characters).', 503);
  const auth = req.headers.get('authorization') || '';
  if (!safeEqual(auth, `Bearer ${env.cronSecret}`)) return fail('Unauthorized', 401);
  try {
    const created = await runFollowUpPass();
    const delivery = await processQueue(100);
    return json({ ok: true, notificationsCreated: created, delivery, at: new Date().toISOString() });
  } catch (e) { return errorResponse(e); }
}
export const GET = handle;
export const POST = handle;
