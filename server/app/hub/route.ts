/* Serves the Task360 app shell (same HTML/CSS/JS as the standalone build) with the signed-in
   user's data embedded, so the first screen renders without an extra round trip. */
import { NextResponse } from 'next/server';
import { getActor } from '@/lib/auth';
import { loadAll } from '@/lib/repo';
import { buildBootstrap } from '@/lib/bootstrap';
import { SHELL_HTML } from '@/lib/generated/client';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

const safeJson = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export async function GET() {
  const actor = await getActor();
  if (!actor) return NextResponse.redirect(`${env.appUrl}/login?denied=1`);
  const { data } = await loadAll();
  const boot = await buildBootstrap(data, actor.id);
  const config = { mode: 'server', meId: actor.id };
  const html = SHELL_HTML.replace('<!--T360_BOOT-->',
    `<script>window.T360_CONFIG=${safeJson(config)};window.T360_BOOT=${safeJson(boot)};</script>`);
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
