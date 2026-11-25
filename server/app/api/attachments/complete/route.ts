/* Step 2 of an upload: verify the object exists in this user's upload folder for this task,
   then record it on the task (audited) through the rules engine. */
import { getActor } from '@/lib/auth';
import { execute, type ActionResult } from '@/lib/engine';
import { transact, loadAll } from '@/lib/repo';
import { buildBootstrap } from '@/lib/bootstrap';
import { storageConfigured, env } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase';
import { MAX_BYTES } from '@/lib/attachments';
import { json, fail, sameOrigin, errorResponse } from '@/lib/http';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail('Forbidden', 403);
  const actor = await getActor();
  if (!actor) return fail('Not signed in', 401);
  if (!storageConfigured()) return fail('File storage is not configured.', 501);
  const { taskId, path, name, mime } = await req.json().catch(() => ({}));
  if (typeof taskId !== 'string' || typeof path !== 'string' || typeof name !== 'string') return fail('Invalid request');
  const folder = `${taskId}/${actor.id}`;
  if (!path.startsWith(folder + '/') || path.includes('..')) return fail('Invalid upload path', 403);
  try {
    const file = path.slice(folder.length + 1);
    const storage = supabaseAdmin().storage.from(env.storageBucket);
    const { data: list, error } = await storage.list(folder, { search: file, limit: 10 });
    const obj = list?.find(o => o.name === file);
    if (error || !obj) return fail('Upload not found — please try again.', 400);
    const size = Number((obj.metadata as any)?.size) || 0;
    if (size > MAX_BYTES) { await storage.remove([path]); return fail('Files must be 25 MB or smaller.'); }
    let failure: Extract<ActionResult, { ok: false }> | null = null;
    const result = await transact(loaded => {
      const r = execute(loaded.data, actor.id, 'addAttachment', [taskId, { name: name.slice(0, 200), size, path, mime: String(mime || '').slice(0, 100) }]);
      if (!r.ok) { failure = r; return { result: null, abort: true }; }
      return { data: r.data, result: r.result };
    });
    if (failure) { await storage.remove([path]); const f = failure as any; return fail(f.error, f.code === 403 ? 403 : 400); }
    const { data } = await loadAll();
    return json({ result, data: await buildBootstrap(data, actor.id) });
  } catch (e) { return errorResponse(e); }
}
