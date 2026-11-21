/* Resolves the signed-in Task360 user for a request.
 * Production: Supabase Auth session (magic link or Microsoft Entra ID) → task360.users row,
 * matched by auth id, or linked by email on first sign-in. Only users an administrator has
 * added (and who are active) can get in.
 * Local development (DEV_LOGIN=true, never in production): a cookie picks the user. */
import { cookies } from 'next/headers';
import { db } from './db';
import { env, supabaseConfigured } from './env';
import { supabaseServer } from './supabase';

export type Actor = { id: string; name: string; role: string; email: string };
export const DEV_COOKIE = 't360_dev_user';

export async function getActor(): Promise<Actor | null> {
  const sql = db();
  if (env.devLogin) {
    const id = (await cookies()).get(DEV_COOKIE)?.value;
    if (id) {
      const [u] = await sql`select id, name, role, email from task360.users where id = ${id} and active`;
      if (u) return { id: u.id, name: u.name, role: u.role, email: u.email || '' };
    }
  }
  if (!supabaseConfigured()) return null;
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const authId = data.user.id, email = (data.user.email || '').toLowerCase();
  let [u] = await sql`select id, name, role, email, active from task360.users where auth_id = ${authId}`;
  if (!u && email) {
    [u] = await sql`update task360.users set auth_id = ${authId}, updated_at = now()
      where lower(email) = ${email} and auth_id is null returning id, name, role, email, active`;
  }
  if (!u || !u.active) return null;
  return { id: u.id, name: u.name, role: u.role, email: u.email || '' };
}
