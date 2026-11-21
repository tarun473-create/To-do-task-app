import { getActor } from '@/lib/auth';
import { loadAll } from '@/lib/repo';
import { buildBootstrap } from '@/lib/bootstrap';
import { runFollowUpPass } from '@/lib/followups';
import { json, fail, sameOrigin, errorResponse } from '@/lib/http';

/* "Run follow-up engine now" button (managers and above). Safe to repeat: duplicates are
   impossible because every reminder has a unique delivery key. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail('Forbidden', 403);
  const actor = await getActor();
  if (!actor) return fail('Not signed in', 401);
  if (actor.role === 'employee') return fail('Only managers can run the follow-up engine.', 403);
  try {
    const sent = await runFollowUpPass();
    const { data } = await loadAll();
    return json({ sent, data: await buildBootstrap(data, actor.id) });
  } catch (e) { return errorResponse(e); }
}
