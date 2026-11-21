import { NextResponse } from 'next/server';
import { env, supabaseConfigured } from '@/lib/env';
import { supabaseServer } from '@/lib/supabase';
import { DEV_COOKIE } from '@/lib/auth';

export async function POST() {
  if (supabaseConfigured()) { const s = await supabaseServer(); await s.auth.signOut(); }
  const res = NextResponse.redirect(`${env.appUrl}/login`, 303);
  res.cookies.delete(DEV_COOKIE);
  return res;
}
