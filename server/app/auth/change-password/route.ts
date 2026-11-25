import { NextResponse } from 'next/server';
import { env, supabaseConfigured } from '@/lib/env';
import { supabaseServer } from '@/lib/supabase';
import { getActor } from '@/lib/auth';

/* Signed-in person sets their own password (required after a temporary password). */
export async function POST(req: Request) {
  if (!supabaseConfigured()) return NextResponse.redirect(`${env.appUrl}/login`, 303);
  const actor = await getActor();
  if (!actor) return NextResponse.redirect(`${env.appUrl}/login?expired=1`, 303);
  const form = await req.formData();
  const pw = String(form.get('password') || ''), pw2 = String(form.get('confirm') || '');
  const bad = pw.length < 10 ? 'short' : pw !== pw2 ? 'mismatch' : !(/[A-Za-z]/.test(pw) && /\d/.test(pw)) ? 'weak' : '';
  if (bad) return NextResponse.redirect(`${env.appUrl}/account/password?error=${bad}`, 303);
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.updateUser({ password: pw, data: { must_change_password: false } });
  if (error) return NextResponse.redirect(`${env.appUrl}/account/password?error=save`, 303);
  return NextResponse.redirect(`${env.appUrl}/hub`, 303);
}
