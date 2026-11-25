import { db } from '@/lib/db';
import { env } from '@/lib/env';

export const dynamic = 'force-dynamic';

const box: React.CSSProperties = { maxWidth: 560, margin: '8vh auto', padding: 28 };

async function people(): Promise<number | null> {
  try { const [{ n }] = await db()`select count(*)::int as n from task360.users`; return n; } catch { return null; }
}

export default async function Setup({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const n = await people();
  const done = sp.done || (n && n > 0 ? 'already' : '');
  return (
    <div className="card" style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <div className="brand-logo">360</div>
        <div><b style={{ fontSize: 17 }}>Task360 one-time setup</b><div className="small muted">Creates the database tables and loads your data</div></div>
      </div>
      {sp.error && <div className="alert danger">{sp.error}</div>}
      {done === 'import' && <div className="alert info">Done. Loaded {sp.people} people, {sp.depts} departments, {sp.tasks} tasks and {sp.close} month-end close activities. {sp.warn ? <><br /><b>Note:</b> {sp.warn}</> : null}</div>}
      {done === 'empty' && <div className="alert info">Done. An empty workspace was created with you as Super Admin.</div>}
      {done ? (
        <>
          {done === 'already' && <div className="alert info">Task360 is already set up. This page is switched off.</div>}
          <p>Next: open the <a href="/login">sign-in page</a> and sign in.</p>
          <p className="small muted">You can now remove SETUP_TOKEN from the server settings.</p>
        </>
      ) : env.setupToken.length < 16 ? (
        <div className="alert warn">Add a <b>SETUP_TOKEN</b> (any secret code of at least 16 characters) to the server settings and redeploy, then reload this page.</div>
      ) : (
        <>
          {n === null && <p className="small muted">The database tables will be created now.</p>}
          <form method="post" action="/api/setup" encType="multipart/form-data">
            <input type="hidden" name="mode" value="import" />
            <label className="field"><span>Setup code (the SETUP_TOKEN you chose)</span><input className="input" type="password" name="token" required autoComplete="off" /></label>
            <label className="field"><span>Task360 export file (.json) — from Admin Settings → Data → Download a copy</span><input className="input" type="file" name="file" accept=".json,application/json" required /></label>
            <button className="btn primary" type="submit" style={{ width: '100%', justifyContent: 'center' }}>Create tables and load my data</button>
          </form>
          <details style={{ marginTop: 16 }}><summary className="small muted" style={{ cursor: 'pointer' }}>Or start with an empty workspace</summary>
            <form method="post" action="/api/setup" encType="multipart/form-data" style={{ marginTop: 10 }}>
              <input type="hidden" name="mode" value="empty" />
              <label className="field"><span>Setup code</span><input className="input" type="password" name="token" required autoComplete="off" /></label>
              <label className="field"><span>Your name</span><input className="input" name="name" required /></label>
              <label className="field"><span>Your work email</span><input className="input" type="email" name="email" required /></label>
              <button className="btn" type="submit" style={{ width: '100%', justifyContent: 'center' }}>Create empty workspace</button>
            </form>
          </details>
        </>
      )}
    </div>
  );
}
