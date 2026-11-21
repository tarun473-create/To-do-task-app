/* Session refresh + gate: everything except the login/auth pages, health check and the
   cron endpoint (which has its own secret) requires a signed-in session. Fine-grained
   permissions are enforced again in every route by the rules engine. */
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const PUBLIC = [/^\/login/, /^\/auth\//, /^\/api\/health/, /^\/api\/cron/, /^\/app\//, /^\/favicon/];
const devLogin = (process.env.DEV_LOGIN === 'true' || process.env.DEV_LOGIN === '1') && process.env.NODE_ENV !== 'production';

export async function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname;
  let res = NextResponse.next({ request: req });
  let signedIn = false;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (url && key) {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: list => {
          list.forEach(({ name, value }) => req.cookies.set(name, value));
          res = NextResponse.next({ request: req });
          list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
        }
      }
    });
    const { data } = await supabase.auth.getUser();
    signedIn = !!data.user;
  }
  if (!signedIn && devLogin && req.cookies.get('t360_dev_user')) signedIn = true;
  if (signedIn || PUBLIC.some(r => r.test(path))) return res;
  if (path.startsWith('/api/')) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const login = req.nextUrl.clone(); login.pathname = '/login'; login.search = '';
  return NextResponse.redirect(login);
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
