/* Step 1 of an upload: permission check, then a short-lived signed upload URL for the private
   bucket. The browser uploads the file directly to storage (no size limit from the app host). */
import { randomUUID } from 'node:crypto';
import { getActor } from '@/lib/auth';
import { loadAll } from '@/lib/repo';
import { taskAccess } from '@/lib/engine';
import { storageConfigured, env } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase';
import { MAX_BYTES, safeName } from '@/lib/attachments';
import { json, fail, sameOrigin, errorResponse } from '@/lib/http';

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail('Forbidden', 403);
  const actor = await getActor();
  if (!actor) return fail('Not signed in', 401);
  if (!storageConfigured()) return fail('File storage is not configured on this server (SUPABASE_SERVICE_ROLE_KEY).', 501);
  const { taskId, name, size } = await req.json().catch(() => ({}));
  if (typeof taskId !== 'string' || typeof name !== 'string' || !name) return fail('Invalid upload request');
  if (!(Number(size) > 0) || Number(size) > MAX_BYTES) return fail('Files must be 25 MB or smaller.');
  try {
    const { data } = await loadAll();
    const access = taskAccess(data, actor.id, taskId);
    if (!access.canEdit) return fail('You cannot add files to this task.', 403);
    const path = `${taskId}/${actor.id}/${randomUUID()}-${safeName(name)}`;
    const { data: signed, error } = await supabaseAdmin().storage.from(env.storageBucket).createSignedUploadUrl(path);
    if (error || !signed) return fail(`Could not prepare upload: ${error?.message || 'unknown error'}`, 502);
    return json({ path, signedUrl: signed.signedUrl });
  } catch (e) { return errorResponse(e); }
}
