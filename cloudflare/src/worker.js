/* Task360 on Cloudflare Workers.
   Bindings (wrangler.jsonc): DB (D1), FILES (R2), ASSETS (static client files under /app/).
   Secrets: SESSION_SECRET, INITIAL_PASSWORD, SETUP_TOKEN (one-time), MICROSOFT_CLIENT_SECRET,
   optional MS_MAIL_CLIENT_SECRET / TEAMS_WEBHOOK_URL. Variables: APP_URL, MICROSOFT_TENANT_ID,
   MICROSOFT_CLIENT_ID, optional MS_MAIL_CLIENT_ID, MS_SENDER_EMAIL. */
import { SHELL_HTML } from './gen/client.js';
import { loadAll, execute, runFollowUps, taskAccess, buildBootstrap, transact } from './data.js';
import { getActor, createSession, sessionCookie, clearCookie, SESSION_COOKIE, endSession, hashPassword, verifyPassword, passwordProblem,
  tooManyAttempts, recordFailure, clearFailures, microsoftEnabled, microsoftStart, microsoftFinish, timingSafeEqual } from './auth.js';
import { loginPage, passwordPage, setupPage } from './pages.js';
import { processQueue } from './notify.js';
import { applySchema, importWorkspace } from './importer.js';

const SECURITY = { 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' };
const appUrlOf = (env, req) => String(env.APP_URL || (req ? new URL(req.url).origin : '')).replace(/\/$/, '');
const secure = url => url.startsWith('https://');
const headers = (extra, url) => Object.assign({ 'Cache-Control': 'no-store' }, SECURITY, url && secure(url) ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}, extra || {});
const html = (body, url, status = 200, extra) => new Response(body, { status, headers: headers(Object.assign({ 'content-type': 'text/html; charset=utf-8' }, extra), url) });
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: headers({ 'content-type': 'application/json' }) });
const fail = (error, status = 400) => json({ error }, status);
const redirect = (to, cookies = []) => { const h = new Headers(headers({ Location: to })); cookies.forEach(c => h.append('Set-Cookie', c)); return new Response(null, { status: 303, headers: h }); };
const sameOrigin = req => req.headers.get('x-task360') === '1';
const safeJson = o => JSON.stringify(o).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const BLOCKED = new Set(['markRead', 'addAttachment']);
const MAX_FILE = 25 * 1024 * 1024;

async function readJson(req, max = 200000) {
  const text = await req.text();
  if (text.length > max) throw Object.assign(new Error('Request too large'), { status: 413 });
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('Invalid request'), { status: 400 }); }
}

async function hub(env, req, actor) {
  const url = appUrlOf(env, req);
  const { data } = await loadAll(env.DB);
  const boot = await buildBootstrap(env.DB, data, actor.id);
  const config = { mode: 'server', meId: actor.id, uploadMode: 'direct', initialPassword: !!env.INITIAL_PASSWORD };
  return html(SHELL_HTML.replace('<!--T360_BOOT-->', `<script>window.T360_CONFIG=${safeJson(config)};window.T360_BOOT=${safeJson(boot)};</script>`), url);
}

async function actionRoute(env, req, actor) {
  const body = await readJson(req);
  const { action, args } = body || {};
  if (typeof action !== 'string' || !/^[a-zA-Z]{2,40}$/.test(action) || BLOCKED.has(action)) return fail('Unknown action');
  if (!Array.isArray(args) || args.length > 6) return fail('Invalid arguments');
  if (action === 'createTask' && args[0] && typeof args[0] === 'object') { delete args[0].allowPastDue; delete args[0].recurringId; }
  let failure = null;
  const result = await transact(env.DB, loaded => {
    const r = execute(loaded.data, actor.id, action, args);
    if (!r.ok) { failure = r; return { result: null, abort: true }; }
    return { data: r.data, result: r.result };
  });
  if (failure) return fail(failure.error, failure.code === 403 ? 403 : 400);
  const { data } = await loadAll(env.DB);
  return json({ result, data: await buildBootstrap(env.DB, data, actor.id) });
}

async function followUpPass(env) {
  return transact(env.DB, loaded => { const out = runFollowUps(loaded.data); return { data: out.data, result: out.sent }; });
}

async function setupRoute(env, req) {
  const url = appUrlOf(env, req);
  const back = (state, message, summary) => html(setupPage({ state, message, summary, tokenSet: (env.SETUP_TOKEN || '').length >= 16 }), url, state === 'form' ? 400 : 200);
  if ((env.SETUP_TOKEN || '').length < 16) return back('form', 'Add a SETUP_TOKEN secret first.');
  const form = await req.formData();
  if (!timingSafeEqual(String(form.get('token') || ''), env.SETUP_TOKEN)) return back('form', 'The setup code is not correct.');
  await applySchema(env.DB);
  const n = await env.DB.prepare('SELECT count(*) AS n FROM users').first('n');
  if (n > 0) return back('already');
  if (String(form.get('mode')) === 'empty') {
    const name = String(form.get('name') || '').trim(), email = String(form.get('email') || '').trim().toLowerCase();
    if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return back('form', 'Enter your name and work email.');
    const { createT360 } = await import('./gen/client.js');
    const settings = createT360({ mode: 'server' }).defaultSettings();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare('INSERT INTO app_settings (id, doc, demo, updated_at) VALUES (1, ?, 0, ?)').bind(JSON.stringify(settings), now),
      env.DB.prepare("INSERT INTO users (id, email, name, role, active, doc, must_change, updated_at) VALUES ('u1', ?, ?, 'super_admin', 1, ?, 1, ?)").bind(email, name, JSON.stringify({ depts: [], teams: [] }), now),
      env.DB.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, 'system', 'setup', ?)").bind(now, `Empty workspace created; Super Admin ${email}`)
    ]);
    return back('done', '', `Done. An empty workspace was created with ${name} as Super Admin.`);
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') return back('form', 'Choose the Task360 export file (JSON).');
  let data; try { data = JSON.parse(await file.text()); } catch { return back('form', 'That file is not a JSON export.'); }
  try {
    const r = await importWorkspace(env.DB, data, file.name || 'upload');
    return back('done', '', `Done. Loaded ${r.people} people, ${r.departments} departments, ${r.tasks} tasks and ${r.close} month-end close activities.${r.warnings.length ? ' Note: ' + r.warnings.join(' ') : ''}`);
  } catch (e) { return back('form', e.message || 'Import failed.'); }
}

async function handle(req, env) {
  const url = new URL(req.url), path = url.pathname, method = req.method, app = appUrlOf(env, req);
  const db = env.DB;

  if (path === '/' ) return redirect('/hub');
  if (path === '/api/health') {
    let database = false; try { await db.prepare('SELECT 1 FROM app_settings LIMIT 1').first(); database = true; } catch { /* not set up */ }
    return json({ ok: database, database, microsoft: microsoftEnabled(env), files: !!env.FILES, initialPassword: !!env.INITIAL_PASSWORD,
      outlook: !!(env.MS_MAIL_CLIENT_ID && env.MS_MAIL_CLIENT_SECRET && env.MS_SENDER_EMAIL), teams: !!env.TEAMS_WEBHOOK_URL, sessionSecret: (env.SESSION_SECRET || '').length >= 32 }, database ? 200 : 503);
  }
  if (path === '/setup' && method === 'GET') {
    let n = null; try { n = await db.prepare('SELECT count(*) AS n FROM users').first('n'); } catch { /* tables not created yet */ }
    return html(setupPage({ state: n > 0 ? 'already' : 'form', tokenSet: (env.SETUP_TOKEN || '').length >= 16 }), app);
  }
  if (path === '/api/setup' && method === 'POST') return setupRoute(env, req);

  // ---------- sign-in ----------
  if (path === '/login' && method === 'GET') {
    if (await getActor(db, req).catch(() => null)) return redirect('/hub');
    const e = url.searchParams.get('error'), M = {
      password: 'Email or password is not correct.', locked: 'Too many wrong attempts. Wait 15 minutes, or ask your administrator to reset your password.',
      notmember: 'Your account is not set up in Task360. Ask your administrator to add your work email.', microsoft: url.searchParams.get('detail') || 'Microsoft sign-in did not complete. Please try again.',
      expired: 'Your session has expired. Please sign in again.' };
    return html(loginPage({ microsoft: microsoftEnabled(env), message: M[e] || '', messageClass: e === 'expired' ? 'warn' : 'danger', email: url.searchParams.get('email') }), app);
  }
  if (path === '/auth/password' && method === 'POST') {
    const form = await req.formData();
    const email = String(form.get('email') || '').trim().toLowerCase(), pw = String(form.get('password') || '');
    const key = 'pw:' + email, back = e => redirect(`/login?error=${e}&email=${encodeURIComponent(email)}`);
    if (!email || !pw) return back('password');
    if (await tooManyAttempts(db, key)) return back('locked');
    const u = await db.prepare('SELECT id, password_hash, must_change FROM users WHERE email = ? AND active = 1').bind(email).first();
    let ok = false;
    if (u && u.password_hash) ok = await verifyPassword(pw, u.password_hash);
    else if (u && u.must_change && env.INITIAL_PASSWORD) ok = timingSafeEqual(pw, env.INITIAL_PASSWORD);
    if (!ok) { await recordFailure(db, key); return back('password'); }
    await clearFailures(db, key);
    const sid = await createSession(db, u.id);
    return redirect(u.must_change ? '/account/password?first=1' : '/hub', [sessionCookie(sid, secure(app))]);
  }
  if (path === '/auth/microsoft' && method === 'GET') {
    if (!microsoftEnabled(env)) return redirect('/login');
    const { url: to, cookie } = await microsoftStart(env, app);
    return redirect(to, [cookie]);
  }
  if (path === '/auth/callback' && method === 'GET') {
    try {
      const { email, oid } = await microsoftFinish(env, app, req);
      let u = oid ? await db.prepare('SELECT id, password_hash FROM users WHERE ms_oid = ? AND active = 1').bind(oid).first() : null;
      if (!u) u = await db.prepare('SELECT id, password_hash FROM users WHERE email = ? AND active = 1').bind(email).first();
      if (!u) return redirect('/login?error=notmember', [clearCookie('t360_oidc', secure(app))]);
      // Someone who signs in with Microsoft no longer needs the starting password: switch it off for them.
      await db.prepare('UPDATE users SET ms_oid = COALESCE(ms_oid, ?), must_change = CASE WHEN password_hash IS NULL THEN 0 ELSE must_change END WHERE id = ?').bind(oid || null, u.id).run();
      const sid = await createSession(db, u.id);
      return redirect('/hub', [sessionCookie(sid, secure(app)), clearCookie('t360_oidc', secure(app))]);
    } catch (e) { return redirect(`/login?error=microsoft&detail=${encodeURIComponent(e.message || 'Sign-in failed')}`); }
  }
  if (path === '/auth/signout' && method === 'POST') {
    const a = await getActor(db, req).catch(() => null); if (a) await endSession(db, a.sessionId);
    return redirect('/login', [clearCookie(SESSION_COOKIE, secure(app))]);
  }

  const actor = await getActor(db, req).catch(() => null);
  if (path === '/account/password') {
    if (!actor) return redirect('/login?error=expired');
    if (method === 'GET') return html(passwordPage({ first: url.searchParams.get('first') === '1', message: url.searchParams.get('msg') || '' }), app);
  }
  if (path === '/auth/change-password' && method === 'POST') {
    if (!actor) return redirect('/login?error=expired');
    const form = await req.formData(), pw = String(form.get('password') || ''), pw2 = String(form.get('confirm') || '');
    const problem = pw !== pw2 ? 'The two passwords do not match.' : passwordProblem(pw, env.INITIAL_PASSWORD);
    if (problem) return redirect(`/account/password?${actor.mustChange ? 'first=1&' : ''}msg=${encodeURIComponent(problem)}`);
    await db.batch([
      db.prepare('UPDATE users SET password_hash = ?, must_change = 0, updated_at = ? WHERE id = ?').bind(await hashPassword(pw), Date.now(), actor.id),
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').bind(actor.id, actor.sessionId),
      db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, 'password_changed', ?)").bind(Date.now(), actor.id, `${actor.name} set their own password`)
    ]);
    return redirect('/hub');
  }

  if (path === '/hub' || path === '/hub/') {
    if (!actor) return redirect('/login');
    if (actor.mustChange) return redirect('/account/password?first=1');
    return hub(env, req, actor);
  }

  // ---------- API ----------
  if (path.startsWith('/api/')) {
    if (!actor) return fail('Not signed in', 401);
    if (actor.mustChange) return fail('Set your own password first.', 403);
    const dl = /^\/api\/attachments\/(T360-\d+)\/([\w-]+)$/.exec(path);
    if (dl && method === 'GET') {
      if (!env.FILES) return fail('File storage is not configured.', 501);
      const { data } = await loadAll(db);
      const acc = taskAccess(data, actor.id, dl[1]);
      const att = acc.canView && acc.attachments.find(a => a.id === dl[2]);
      if (!att || !att.path) return fail('Not found', 404);
      const obj = await env.FILES.get(att.path);
      if (!obj) return fail('File not found', 404);
      return new Response(obj.body, { headers: headers({ 'content-type': att.mime || 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(att.name)}` }) });
    }
    if (!sameOrigin(req)) return fail('Forbidden', 403);
    try {
      if (path === '/api/bootstrap' && method === 'GET') { const { data } = await loadAll(db); return json({ data: await buildBootstrap(db, data, actor.id) }); }
      if (path === '/api/actions' && method === 'POST') return await actionRoute(env, req, actor);
      if (path === '/api/notifications/read' && method === 'POST') {
        const { ids } = await readJson(req);
        if (ids != null && (!Array.isArray(ids) || ids.length > 500 || !ids.every(x => typeof x === 'string'))) return fail('Invalid ids');
        if (ids && ids.length) await db.batch(ids.map(id => db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND recipient_id = ? AND read_at IS NULL').bind(Date.now(), id, actor.id)));
        else if (!ids) await db.prepare('UPDATE notifications SET read_at = ? WHERE recipient_id = ? AND read_at IS NULL').bind(Date.now(), actor.id).run();
        return json({ ok: true });
      }
      if (path === '/api/engine/run' && method === 'POST') {
        if (actor.role === 'employee') return fail('Only managers can run the follow-up engine.', 403);
        const sent = await followUpPass(env); const { data } = await loadAll(db);
        return json({ sent, data: await buildBootstrap(db, data, actor.id) });
      }
      if (path === '/api/admin/set-password' && method === 'POST') {
        if (actor.role !== 'super_admin') return fail('Only the Super Admin can reset passwords.', 403);
        const { userId } = await readJson(req);
        const u = await db.prepare('SELECT id, name, email FROM users WHERE id = ? AND active = 1').bind(String(userId || '')).first();
        if (!u) return fail('Team member not found or inactive.', 404);
        if (!u.email) return fail(`${u.name} has no work email. Add it on the Team page first.`);
        let password = null, hash = null;
        if (!env.INITIAL_PASSWORD) { password = [...crypto.getRandomValues(new Uint8Array(9))].map(b => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[b % 56]).join('') + '7'; hash = await hashPassword(password); }
        await db.batch([
          db.prepare('UPDATE users SET password_hash = ?, must_change = 1, updated_at = ? WHERE id = ?').bind(hash, Date.now(), u.id),
          db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
          db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, 'password_reset', ?)").bind(Date.now(), actor.id, `Password reset for ${u.name} by ${actor.name}`)
        ]);
        return json(password ? { email: u.email, password } : { email: u.email, initial: true });
      }
      if (path === '/api/attachments' && method === 'POST') {
        if (!env.FILES) return fail('File storage is not configured.', 501);
        const form = await req.formData(), taskId = String(form.get('taskId') || ''), file = form.get('file');
        if (!/^T360-\d+$/.test(taskId) || !file || typeof file === 'string') return fail('Invalid upload');
        if (file.size > MAX_FILE) return fail('Files must be 25 MB or smaller.');
        const { data } = await loadAll(db);
        if (!taskAccess(data, actor.id, taskId).canEdit) return fail('You cannot add files to this task.', 403);
        const safe = String(file.name || 'file').normalize('NFKD').replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_').slice(-120);
        const key = `${taskId}/${actor.id}/${crypto.randomUUID()}-${safe}`;
        await env.FILES.put(key, file.stream(), { httpMetadata: { contentType: file.type || 'application/octet-stream' } });
        let failure = null;
        const result = await transact(db, loaded => {
          const r = execute(loaded.data, actor.id, 'addAttachment', [taskId, { name: String(file.name).slice(0, 200), size: file.size, path: key, mime: String(file.type || '').slice(0, 100) }]);
          if (!r.ok) { failure = r; return { result: null, abort: true }; }
          return { data: r.data, result: r.result };
        });
        if (failure) { await env.FILES.delete(key); return fail(failure.error, failure.code === 403 ? 403 : 400); }
        const fresh = await loadAll(db);
        return json({ result, data: await buildBootstrap(db, fresh.data, actor.id) });
      }
      return fail('Not found', 404);
    } catch (e) {
      if (e && e.status) return fail(e.message, e.status);
      console.error(e);
      return fail('Something went wrong on the server. Please try again.', 500);
    }
  }
  return new Response('Not found', { status: 404, headers: headers() });
}

export default {
  async fetch(req, env, ctx) {
    try { return await handle(req, env, ctx); }
    catch (e) { console.error(e); return new Response('Task360 hit an error. If this is a new installation, open /setup first.', { status: 500, headers: headers() }); }
  },
  /* Cron Trigger (every 10 minutes): reminders, escalations, digests, recurring tasks, then sending. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const created = await followUpPass(env);
        const delivery = await processQueue(env, appUrlOf(env));
        console.log('Task360 follow-ups', JSON.stringify({ created, delivery }));
      } catch (e) { console.error('Task360 scheduled run failed', e); }
    })());
  }
};
