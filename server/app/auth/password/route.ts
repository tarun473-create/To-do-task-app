import { NextResponse } from 'next/server';
import { env, supabaseConfigured } from '@/lib/env';
import { supabaseServer } from '@/lib/supabase';
import { getActor } from '@/lib/auth';

/* Email + password sign-in. The username is the person's work email; the Super Admin issues a
   temporary password from the Team page and the person sets their own at first sign-in. */
export async function POST(req: Request) {
  const form = await req.formData();
  const email = String(form.get('email') || '').trim().toLowerCase();
  const password = String(form.get('password') || '');
  if (!supabaseConfigured() || !email || !password) return NextResponse.redirect(`${env.appUrl}/login?error=password`, 303);
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) return NextResponse.redirect(`${env.appUrl}/login?error=password`, 303);
  if (!(await getActor())) { await supabase.auth.signOut(); return NextResponse.redirect(`${env.appUrl}/login?denied=1`, 303); }
  const mustChange = !!(data.user.user_metadata && data.user.user_metadata.must_change_password);
  return NextResponse.redirect(`${env.appUrl}${mustChange ? '/account/password?first=1' : '/hub'}`, 303);
}
