export const dynamic = 'force-dynamic';

const box: React.CSSProperties = { maxWidth: 420, margin: '10vh auto', padding: 28 };
const MSG: Record<string, string> = {
  short: 'Use at least 10 characters.',
  mismatch: 'The two passwords do not match.',
  weak: 'Use letters and at least one number.',
  save: 'The password could not be saved. Please try again.'
};

export default async function ChangePassword({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  return (
    <div className="card" style={box}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <div className="brand-logo">360</div>
        <div><b style={{ fontSize: 17 }}>Set your password</b><div className="small muted">Task360</div></div>
      </div>
      {sp.first && <div className="alert info">You signed in with a temporary password. Choose your own password to continue.</div>}
      {sp.error && <div className="alert danger">{MSG[sp.error] || 'Please try again.'}</div>}
      <form method="post" action="/auth/change-password">
        <label className="field"><span>New password (at least 10 characters, letters and a number)</span><input className="input" type="password" name="password" required minLength={10} autoComplete="new-password" /></label>
        <label className="field"><span>Repeat new password</span><input className="input" type="password" name="confirm" required minLength={10} autoComplete="new-password" /></label>
        <button className="btn primary" type="submit" style={{ width: '100%', justifyContent: 'center' }}>Save password</button>
      </form>
    </div>
  );
}
