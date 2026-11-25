import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { DEV_COOKIE } from '@/lib/auth';

/* Local development only (DEV_LOGIN=true and not a production build). */
export async function GET(req: Request) {
  if (!env.devLogin) return new NextResponse('Not found', { status: 404 });
  const user = new URL(req.url).searchParams.get('user') || '';
  const res = NextResponse.redirect(`${env.appUrl}/hub`);
  res.cookies.set(DEV_COOKIE, user, { httpOnly: true, sameSite: 'lax', path: '/' });
  return res;
}
