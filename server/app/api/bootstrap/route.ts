import { getActor } from '@/lib/auth';
import { loadAll } from '@/lib/repo';
import { buildBootstrap } from '@/lib/bootstrap';
import { json, fail, sameOrigin, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  if (!sameOrigin(req)) return fail('Forbidden', 403);
  const actor = await getActor();
  if (!actor) return fail('Not signed in', 401);
  try {
    const { data } = await loadAll();
    return json({ data: await buildBootstrap(data, actor.id) });
  } catch (e) { return errorResponse(e); }
}
