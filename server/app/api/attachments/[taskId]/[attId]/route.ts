/* Download: only people who can view the task get a 5-minute signed link. */
import { NextResponse } from 'next/server';
import { getActor } from '@/lib/auth';
import { loadAll } from '@/lib/repo';
import { taskAccess } from '@/lib/engine';
import { storageConfigured, env } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase';
import { fail, errorResponse } from '@/lib/http';

export async function GET(_req: Request, ctx: { params: Promise<{ taskId: string; attId: string }> }) {
  const { taskId, attId } = await ctx.params;
  const actor = await getActor();
  if (!actor) return fail('Not signed in', 401);
  if (!storageConfigured()) return fail('File storage is not configured.', 501);
  try {
    const { data } = await loadAll();
    const access = taskAccess(data, actor.id, taskId);
    if (!access.canView) return fail('Not found', 404);
    const att = access.attachments.find((a: any) => a.id === attId);
    if (!att || !att.path) return fail('Not found', 404);
    const { data: signed, error } = await supabaseAdmin().storage.from(env.storageBucket).createSignedUrl(att.path, 300, { download: att.name });
    if (error || !signed) return fail('Could not create download link', 502);
    return NextResponse.redirect(signed.signedUrl);
  } catch (e) { return errorResponse(e); }
}
