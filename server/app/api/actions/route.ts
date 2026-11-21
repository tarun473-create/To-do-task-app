/* Every workflow change goes through here. The rules engine runs on the server with the
   signed-in user as the actor; the browser cannot choose the actor or any timestamp. */
import { getActor } from '@/lib/auth';
import { execute, type ActionResult } from '@/lib/engine';
import { transact, loadAll } from '@/lib/repo';
import { buildBootstrap } from '@/lib/bootstrap';
import { json, fail, sameOrigin, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// markRead has its own endpoint; attachments must go through the upload endpoints.
const BLOCKED = new Set(['markRead', 'addAttachment']);

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail('Forbidden', 403);
  const actor = await getActor();
  if (!actor) return fail('Not signed in', 401);
  const raw = await req.text();
  if (raw.length > 200_000) return fail('Request too large', 413);
  let body: any;
  try { body = JSON.parse(raw); } catch { return fail('Invalid request'); }
  const { action, args } = body || {};
  if (typeof action !== 'string' || !/^[a-zA-Z]{2,40}$/.test(action) || BLOCKED.has(action)) return fail('Unknown action');
  if (!Array.isArray(args) || args.length > 6) return fail('Invalid arguments');
  if (action === 'createTask' && args[0] && typeof args[0] === 'object') {
    delete args[0].allowPastDue; delete args[0].recurringId; // engine-internal options
  }
  try {
    let failure: Extract<ActionResult, { ok: false }> | null = null;
    const result = await transact(loaded => {
      const r = execute(loaded.data, actor.id, action, args);
      if (!r.ok) { failure = r; return { result: null, abort: true }; }
      return { data: r.data, result: r.result };
    });
    if (failure) {
      const f = failure as Extract<ActionResult, { ok: false }>;
      return fail(f.error, f.code === 403 ? 403 : 400);
    }
    const { data } = await loadAll();
    return json({ result, data: await buildBootstrap(data, actor.id) });
  } catch (e) { return errorResponse(e); }
}
