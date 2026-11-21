import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { env } from './env';

/* Supabase client bound to the request cookies (auth session). Server-side only. */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseAnonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: list => { try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* read-only context */ } }
    }
  });
}

/* Service-role client for private file storage. Never exposed to the browser. */
export function supabaseAdmin() {
  return createClient(env.supabaseUrl, env.supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
