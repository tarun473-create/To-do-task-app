/* Super Admin issues a temporary password for a team member (username = their work email).
   The person must choose their own password at first sign-in. The password is returned once,
   to the Super Admin's screen only, and is never stored by Task360. */
import { randomInt } from 'node:crypto';
import { getActor } from '@/lib/auth';
import { db } from '@/lib/db';
import { supabaseConfigured, storageConfigured } from '@/lib/env';
import { supabaseAdmin } from '@/lib/supabase';
import { json, fail, sameOrigin, errorResponse } from '@/lib/http';

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const tempPassword = () => {
  let p = '';
  for (let i = 0; i < 12; i++) p += ALPHA[randomInt(ALPHA.length)];
  return p.slice(0, 4) + '-' + p.slice(4, 8) + '-' + p.slice(8) + randomInt(10);
};

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail('Forbidden', 403);
  const actor = await getActor();
  if (!actor) return fail('Not signed in', 401);
  if (actor.role !== 'super_admin') return fail('Only the Super Admin can set passwords.', 403);
  // SUPABASE_SERVICE_ROLE_KEY is needed for the admin API (same key as file storage).
  if (!supabaseConfigured() || !storageConfigured()) return fail('Password sign-in needs Supabase to be configured on the server (NEXT_PUBLIC_SUPABASE_URL, anon key and SUPABASE_SERVICE_ROLE_KEY).', 501);
  const { userId } = await req.json().catch(() => ({}));
  if (typeof userId !== 'string') return fail('Choose a team member.');
  try {
    const sql = db();
    const [u] = await sql`select id, name, email, auth_id, active from task360.users where id = ${userId}`;
    if (!u || !u.active) return fail('Team member not found or inactive.', 404);
    if (!u.email) return fail(`${u.name} has no work email. Add it on the Team page first.`);
    const email = String(u.email).toLowerCase();
    const admin = supabaseAdmin().auth.admin;
    const password = tempPassword();
    let authId: string | null = u.auth_id || null;
    if (!authId) {
      for (let page = 1; page <= 20 && !authId; page++) {
        const { data, error } = await admin.listUsers({ page, perPage: 1000 });
        if (error) throw error;
        const hit = data.users.find(x => (x.email || '').toLowerCase() === email);
        if (hit) authId = hit.id;
        if (data.users.length < 1000) break;
      }
    }
    if (authId) {
      const { error } = await admin.updateUserById(authId, { password, email_confirm: true, user_metadata: { must_change_password: true } });
      if (error) throw error;
    } else {
      const { data, error } = await admin.createUser({ email, password, email_confirm: true, user_metadata: { must_change_password: true } });
      if (error || !data.user) throw error || new Error('createUser failed');
      authId = data.user.id;
    }
    await sql`update task360.users set auth_id = ${authId}, updated_at = now() where id = ${u.id} and (auth_id is null or auth_id = ${authId})`;
    await sql`insert into task360.audit_log (actor, action, detail) values (${actor.id}, 'password_issued', ${`Temporary password issued for ${u.name} by ${actor.name}`})`;
    return json({ email, password });
  } catch (e) { return errorResponse(e); }
}
