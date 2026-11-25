import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { env, supabaseConfigured } from '@/lib/env';
import { supabaseServer } from '@/lib/supabase';

/* Email magic link. Links are only sent to active users an administrator has added; the
   response is identical either way so the form cannot be used to discover who is registered. */
export async function POST(req: Request) {
  const form = await req.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();
  const done = NextResponse.redirect(`${env.appUrl}/login?sent=1`, 303);
  if (!email || email.length > 254 || !supabaseConfigured()) return done;
  const [u] = await db()`select id from task360.users where lower(email) = ${email} and active`;
  if (u) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${env.appUrl}/auth/callback`, shouldCreateUser: true } });
    if (error) console.error('signInWithOtp failed:', error.message);
  }
  return done;
}
