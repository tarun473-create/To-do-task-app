import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { supabaseServer } from '@/lib/supabase';
import { getActor } from '@/lib/auth';

/* Completes magic-link and Microsoft sign-in, then checks the person is a Task360 user. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = u.searchParams.get('code'), tokenHash = u.searchParams.get('token_hash'), type = u.searchParams.get('type') as EmailOtpType | null;
  const supabase = await supabaseServer();
  const { error } = code ? await supabase.auth.exchangeCodeForSession(code)
    : tokenHash && type ? await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    : { error: new Error('missing code') };
  if (error) return NextResponse.redirect(`${env.appUrl}/login?error=1`);
  if (!(await getActor())) { await supabase.auth.signOut(); return NextResponse.redirect(`${env.appUrl}/login?denied=1`); }
  return NextResponse.redirect(`${env.appUrl}/hub`);
}
