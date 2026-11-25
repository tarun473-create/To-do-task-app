import { getActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { json, fail, sameOrigin, errorResponse } from '@/lib/http';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail('Forbidden', 403);
  const actor = await getActor();
  if (!actor) return fail('Not signed in', 401);
  const { ids } = await req.json().catch(() => ({}));
  if (ids != null && (!Array.isArray(ids) || ids.length > 500 || !ids.every((x: unknown) => typeof x === 'string'))) return fail('Invalid ids');
  try {
    const sql = db();
    if (ids) await sql`update task360.notifications set read_at = now() where recipient_id = ${actor.id} and read_at is null and id in ${sql(ids.length ? ids : [''])}`;
    else await sql`update task360.notifications set read_at = now() where recipient_id = ${actor.id} and read_at is null`;
    return json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
