import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { supabaseServer } from '@/lib/supabase';

/* Microsoft Entra ID (Azure AD) single sign-on through Supabase Auth's "azure" provider. */
export async function GET() {
  if (!env.microsoftSso) return NextResponse.redirect(`${env.appUrl}/login`);
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'azure', options: { redirectTo: `${env.appUrl}/auth/callback`, scopes: 'openid email profile' }
  });
  if (error || !data.url) return NextResponse.redirect(`${env.appUrl}/login?error=1`);
  return NextResponse.redirect(data.url);
}
