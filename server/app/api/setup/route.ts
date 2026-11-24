/* One-time setup from the browser: creates the database tables and loads the first data —
   either a Task360 export file or an empty workspace with one Super Admin.
   Protected by SETUP_TOKEN (set on the server) and refuses to run once people exist. */
import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { env } from '@/lib/env';
import { safeEqual } from '@/lib/http';
import { importWorkspace } from '@/lib/importer';
import { SCHEMA_SQL } from '@/lib/generated/client';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const back = (q: string) => NextResponse.redirect(`${env.appUrl}/setup?${q}`, 303);

export async function POST(req: Request) {
  if (env.setupToken.length < 16) return back('error=' + encodeURIComponent('SETUP_TOKEN is not set on the server (at least 16 characters).'));
  let form: FormData;
  try { form = await req.formData(); } catch { return back('error=' + encodeURIComponent('The upload could not be read. Try again.')); }
  if (!safeEqual(String(form.get('token') || ''), env.setupToken)) return back('error=' + encodeURIComponent('The setup code is not correct.'));
  const sql = db();
  try {
    await sql.unsafe(SCHEMA_SQL); // idempotent: creates or updates the tables
    const [{ n }] = await sql`select count(*)::int as n from task360.users`;
    if (n > 0) return back('done=already');
    const mode = String(form.get('mode') || 'import');
    if (mode === 'empty') {
      const name = String(form.get('name') || '').trim(), email = String(form.get('email') || '').trim().toLowerCase();
      if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back('error=' + encodeURIComponent('Enter your name and work email.'));
      const { SETTINGS_DEFAULT } = await import('@/lib/defaults');
      await sql.begin(async (tx: any) => {
        await tx`insert into task360.app_settings (id, doc, demo) values (1, ${tx.json(SETTINGS_DEFAULT)}, false) on conflict (id) do update set doc = excluded.doc`;
        await tx`insert into task360.users (id, email, name, role, active) values ('u1', ${email}, ${name}, 'super_admin', true)`;
        await tx`insert into task360.audit_log (actor, action, detail) values ('system', 'setup', ${`Empty workspace created; Super Admin ${email}`})`;
      });
      return back('done=empty');
    }
    const file = form.get('file');
    if (!file || typeof file === 'string') return back('error=' + encodeURIComponent('Choose the Task360 export file (JSON).'));
    if ((file as File).size > 4 * 1024 * 1024) return back('error=' + encodeURIComponent('The file is larger than 4 MB. Use the command-line import in server/README.md instead.'));
    let data: any;
    try { data = JSON.parse(await (file as File).text()); } catch { return back('error=' + encodeURIComponent('That file is not a JSON export.')); }
    const r = await importWorkspace(sql, data, (file as File).name || 'upload');
    return back(`done=import&people=${r.people}&tasks=${r.tasks}&close=${r.closeActivities}&depts=${r.departments}` + (r.warnings.length ? `&warn=${encodeURIComponent(r.warnings.join(' '))}` : ''));
  } catch (e: any) {
    console.error('setup failed', e);
    return back('error=' + encodeURIComponent(e?.message ? `Setup failed: ${e.message}` : 'Setup failed. Check DATABASE_URL.'));
  }
}
