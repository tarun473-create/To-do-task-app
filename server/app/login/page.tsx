import { env } from '@/lib/env';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

const box: React.CSSProperties = { maxWidth: 400, margin: '10vh auto', padding: 28 };

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  let devUsers: { id: string; name: string; role: string }[] = [];
  if (env.devLogin) {
    try { devUsers = (await db()`select id, name, role from task360.users where active order by id`) as any; } catch { /* db not ready */ }
  }
  const msg = sp.sent ? { cls: 'info', text: 'If this email belongs to a Task360 user, a sign-in link is on its way. Check your inbox.' }
    : sp.denied ? { cls: 'danger', text: 'Your account is not set up in Task360 or is inactive. Ask your administrator to add your work email.' }
    : sp.expired ? { cls: 'warn', text: 'Your session has expired. Please sign in again.' }
    : sp.error === 'password' ? { cls: 'danger', text: 'Email or password is not correct. Ask your Task360 administrator for a new temporary password if needed.' }
    : sp.error ? { cls: 'danger', text: 'Sign-in failed. Please try again.' } : null;
  return (
    <div className="card" style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <div className="brand-logo">360</div>
        <div><b style={{ fontSize: 17 }}>Task360</b><div className="small muted">Team Performance &amp; Accountability Hub</div></div>
      </div>
      {msg && <div className={`alert ${msg.cls}`}>{msg.text}</div>}
      <form method="post" action="/auth/password">
        <label className="field"><span>Work email</span><input className="input" type="email" name="email" required autoComplete="username" placeholder="name@company.com" /></label>
        <label className="field"><span>Password</span><input className="input" type="password" name="password" required autoComplete="current-password" /></label>
        <button className="btn primary" type="submit" style={{ width: '100%', justifyContent: 'center' }}>Sign in</button>
      </form>
      {env.microsoftSso && (
        <a className="btn" href="/auth/microsoft" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}>Sign in with Microsoft</a>
      )}
      <details style={{ marginTop: 12 }}><summary className="small muted" style={{ cursor: 'pointer' }}>No password yet? Get a sign-in link by email</summary>
        <form method="post" action="/auth/otp" style={{ marginTop: 8 }}>
          <label className="field"><span>Work email</span><input className="input" type="email" name="email" required autoComplete="email" placeholder="name@company.com" /></label>
          <button className="btn" type="submit" style={{ width: '100%', justifyContent: 'center' }}>Email me a sign-in link</button>
        </form>
      </details>
      <p className="small muted" style={{ marginTop: 14 }}>Only people added by your Task360 administrator can sign in.</p>
      {env.devLogin && (
        <div style={{ marginTop: 16 }}>
          <div className="alert warn">Development login is enabled (DEV_LOGIN=true). This is disabled automatically in production.</div>
          {devUsers.map(u => <div key={u.id}><a href={`/auth/dev?user=${encodeURIComponent(u.id)}`}>{u.name}</a> <span className="small muted">· {u.role}</span></div>)}
        </div>
      )}
    </div>
  );
}
