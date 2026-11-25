/* Sign-in for Task360 on Cloudflare: sessions, email + password, and Microsoft (Entra ID) directly.
   No third-party sign-in service: password hashes and sessions live in D1. */

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => new Uint8Array(h.match(/.{2}/g).map(x => parseInt(x, 16)));
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
export const SESSION_COOKIE = 't360_session';
const SESSION_DAYS = 7;
const ITER = 100000; // the most PBKDF2 iterations Workers allow

export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  let r = 0; for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

/* ---------------- passwords ---------------- */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${hex(salt)}$${hex(bits)}`;
}
export async function verifyPassword(password, stored) {
  const [alg, iter, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'pbkdf2' || !saltHex || !hashHex) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: Number(iter) }, key, 256);
  return timingSafeEqual(hex(bits), hashHex);
}
export function passwordProblem(pw, initial) {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use letters and at least one number.';
  if (initial && pw === initial) return 'Choose a password different from the starting password.';
  return '';
}

/* Brute-force protection: at most 8 wrong passwords per email in 15 minutes. */
export async function tooManyAttempts(db, key) {
  const row = await db.prepare('SELECT count, window_start FROM login_attempts WHERE key = ?').bind(key).first();
  return !!row && Date.now() - row.window_start < 15 * 60e3 && row.count >= 8;
}
export async function recordFailure(db, key) {
  const now = Date.now();
  await db.prepare(`INSERT INTO login_attempts (key, count, window_start) VALUES (?, 1, ?)
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN ? - window_start > 900000 THEN 1 ELSE count + 1 END,
      window_start = CASE WHEN ? - window_start > 900000 THEN ? ELSE window_start END`).bind(key, now, now, now, now).run();
}
export const clearFailures = (db, key) => db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(key).run();

/* ---------------- sessions ---------------- */
export async function createSession(db, userId) {
  const id = randomHex(32), now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(id, userId, now, now + SESSION_DAYS * 864e5),
    db.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(now, userId),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now)
  ]);
  return id;
}
export const sessionCookie = (id, secure) => `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
export const clearCookie = (name, secure) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
export function readCookie(req, name) {
  const m = (req.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
/* The signed-in, active Task360 user for this request, or null. */
export async function getActor(db, req) {
  const sid = readCookie(req, SESSION_COOKIE);
  if (!/^[0-9a-f]{64}$/.test(sid)) return null;
  const u = await db.prepare(`SELECT u.id, u.name, u.role, u.email, u.must_change, u.password_hash FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`).bind(sid, Date.now()).first();
  return u ? { id: u.id, name: u.name, role: u.role, email: u.email || '', mustChange: !!u.must_change, sessionId: sid } : null;
}
export const endSession = (db, sid) => db.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();

/* ---------------- Microsoft Entra ID (OpenID Connect, authorization code + PKCE) ---------------- */
const authority = env => (env.MS_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/$/, '');
export const microsoftEnabled = env => !!(env.MICROSOFT_TENANT_ID && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET);

async function sign(env, value) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(value)));
}
export async function microsoftStart(env, appUrl) {
  const state = randomHex(16), nonce = randomHex(16), verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  const q = new URLSearchParams({
    client_id: env.MICROSOFT_CLIENT_ID, response_type: 'code', response_mode: 'query', scope: 'openid email profile',
    redirect_uri: `${appUrl}/auth/callback`, state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account'
  });
  const payload = `${state}.${nonce}.${verifier}`;
  const cookie = `t360_oidc=${payload}.${await sign(env, payload)}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${appUrl.startsWith('https') ? '; Secure' : ''}`;
  return { url: `${authority(env)}/${encodeURIComponent(env.MICROSOFT_TENANT_ID)}/oauth2/v2.0/authorize?${q}`, cookie };
}
/* Returns { email, oid } of the Sunsure account that signed in, or throws. */
export async function microsoftFinish(env, appUrl, req) {
  const u = new URL(req.url);
  if (u.searchParams.get('error')) throw new Error(u.searchParams.get('error_description') || 'Microsoft sign-in was cancelled.');
  const [state, nonce, verifier, sig] = readCookie(req, 't360_oidc').split('.');
  if (!state || sig !== await sign(env, `${state}.${nonce}.${verifier}`)) throw new Error('Sign-in session expired. Please try again.');
  if (u.searchParams.get('state') !== state) throw new Error('Sign-in state did not match. Please try again.');
  const res = await fetch(`${authority(env)}/${encodeURIComponent(env.MICROSOFT_TENANT_ID)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.MICROSOFT_CLIENT_ID, client_secret: env.MICROSOFT_CLIENT_SECRET, grant_type: 'authorization_code',
      code: u.searchParams.get('code') || '', redirect_uri: `${appUrl}/auth/callback`, code_verifier: verifier })
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) throw new Error(`Microsoft did not complete the sign-in (${tok.error || res.status}).`);
  // The ID token comes straight from Microsoft's token endpoint over TLS (no browser in between),
  // so we check its claims: audience, tenant, issuer, nonce and expiry.
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(tok.id_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))));
  const tenant = String(env.MICROSOFT_TENANT_ID).toLowerCase();
  if (claims.aud !== env.MICROSOFT_CLIENT_ID) throw new Error('This sign-in was not issued for Task360.');
  if (String(claims.tid || '').toLowerCase() !== tenant) throw new Error('Only Sunsure work accounts can sign in.');
  if (claims.iss !== `${authority(env) === 'https://login.microsoftonline.com' ? 'https://login.microsoftonline.com' : authority(env)}/${claims.tid}/v2.0`) throw new Error('Unexpected sign-in issuer.');
  if (claims.nonce !== nonce) throw new Error('Sign-in check failed. Please try again.');
  if (!(claims.exp * 1000 > Date.now() - 60e3)) throw new Error('Sign-in expired. Please try again.');
  const email = String(claims.email || claims.preferred_username || claims.upn || '').trim().toLowerCase();
  if (!email) throw new Error('Microsoft did not share your email address.');
  return { email, oid: String(claims.oid || '') };
}
