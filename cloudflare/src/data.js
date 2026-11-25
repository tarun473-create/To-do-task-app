/* Loading the workspace from D1, running the rules engine, and saving what changed. */
import { createT360 } from './gen/client.js';

export class ConflictError extends Error {}
const clone = o => JSON.parse(JSON.stringify(o));
const stable = o => JSON.stringify(o, (k, v) => (k === 'linked' ? undefined : v));
const uuid = () => crypto.randomUUID();

/* ---------------- load ---------------- */
export async function loadAll(db) {
  const [settings, depts, users, tasks, rec, keys] = await db.batch([
    db.prepare('SELECT doc, demo FROM app_settings WHERE id = 1'),
    db.prepare('SELECT id, name, color FROM departments WHERE active = 1 ORDER BY rowid'),
    db.prepare('SELECT id, email, name, role, active, doc, last_login FROM users ORDER BY rowid'),
    db.prepare('SELECT id, version, doc FROM tasks'),
    db.prepare('SELECT doc FROM recurring_templates ORDER BY rowid'),
    db.prepare('SELECT DISTINCT dedupe_key FROM notifications WHERE dedupe_key IS NOT NULL AND created_at > ?').bind(Date.now() - 400 * 864e5)
  ]);
  const s = settings.results[0];
  if (!s) throw new Error('Task360 is not set up yet. Open /setup first.');
  const versions = new Map(); let maxSeq = 0;
  const taskDocs = tasks.results.map(t => { versions.set(t.id, t.version); const n = parseInt(t.id.slice(5), 10); if (n > maxSeq) maxSeq = n; return JSON.parse(t.doc); });
  const sentKeys = {}; keys.results.forEach(k => { sentKeys[k.dedupe_key] = 1; });
  return {
    versions,
    data: {
      demo: !!s.demo, seq: maxSeq + 1, settings: JSON.parse(s.doc),
      departments: depts.results.map(d => ({ id: d.id, name: d.name, color: d.color })),
      users: users.results.map(u => Object.assign({}, JSON.parse(u.doc), { id: u.id, email: u.email || '', name: u.name, role: u.role, active: !!u.active, linked: !!u.last_login })),
      tasks: taskDocs, recurring: rec.results.map(r => JSON.parse(r.doc)),
      notifications: [], audit: [], sentKeys, leaves: []
    }
  };
}

/* ---------------- engine helpers ---------------- */
function engineWith(data) { const T = createT360({ mode: 'server' }); T.store.data = clone(data); return T; }

export function execute(data, actorId, action, args) {
  const T = engineWith(data);
  const actor = T.user(actorId);
  if (!actor || !actor.active) return { ok: false, error: 'Your account is not active.', code: 403 };
  const fn = T.api[action];
  if (typeof fn !== 'function') return { ok: false, error: 'Unknown action.', code: 400 };
  try {
    const r = fn.apply(null, [actor].concat(clone(args)));
    return { ok: true, result: r === undefined ? null : clone(r), data: T.store.data };
  } catch (e) { return { ok: false, error: String((e && e.message) || e), code: (e && e.code) || 500 }; }
}

export function runFollowUps(data) { const T = engineWith(data); const sent = T.engine.run(); return { sent, data: T.store.data }; }

export function taskAccess(data, actorId, taskId) {
  const T = engineWith(data), me = T.user(actorId), t = T.task(taskId);
  if (!me || !t) return { canView: false, canEdit: false, attachments: [] };
  return { canView: T.canView(me, t), canEdit: T.isOwner(me, t) || T.canManage(me, t), attachments: t.attachments || [] };
}

/* What one person's browser receives: only what they may see. */
export async function buildBootstrap(db, data, actorId) {
  const T = engineWith(data), me = T.user(actorId), d = T.store.data;
  const tasks = d.tasks.filter(t => T.canView(me, t));
  const ids = new Set(tasks.map(t => t.id));
  const admin = me.role === 'super_admin';
  const users = d.users.map(u => ({ id: u.id, name: u.name, role: u.role, deptId: u.deptId, depts: u.depts || [], managerId: u.managerId, teams: u.teams || [],
    active: u.active, onLeave: u.onLeave, backupId: u.backupId, linked: admin ? !!u.linked : undefined, email: (admin || u.id === me.id) ? (u.email || '') : '' }));
  const sentKeys = {};
  Object.keys(d.sentKeys || {}).forEach(k => { const m = /^(T360-\d+):/.exec(k); if (m && ids.has(m[1])) sentKeys[k] = d.sentKeys[k]; });
  const recurring = d.recurring.filter(r => T.canSeeAll(me) || (me.role === 'manager' && T.managerTeams(me).includes(r.deptId)) || r.ownerId === me.id);
  const visible = new Set(T.visibleUsers(me).map(u => u.id));
  const [notes, audit] = await db.batch([
    db.prepare(`SELECT n.id, n.type, n.task_id, n.recipient_id, n.message, n.created_at, n.read_at,
      (SELECT json_group_array(json_object('channel', d.channel, 'status', d.status, 'error', d.last_error)) FROM deliveries d WHERE d.notification_id = n.id) AS channels
      FROM notifications n ORDER BY n.created_at DESC LIMIT 1500`),
    db.prepare('SELECT at, actor, action, task_id, detail FROM audit_log ORDER BY at DESC, id DESC LIMIT 3000')
  ]);
  const canSeeAll = T.canSeeAll(me);
  const notifications = notes.results
    .filter(n => n.recipient_id === me.id || canSeeAll || (me.role === 'manager' && visible.has(n.recipient_id)))
    .map(n => ({ id: n.id, type: n.type, taskId: n.task_id, to: n.recipient_id, message: n.message, at: n.created_at, read: !!n.read_at, channels: JSON.parse(n.channels || '[]') }));
  const auditOut = me.role === 'employee' ? [] : audit.results
    .filter(a => canSeeAll || !a.task_id || ids.has(a.task_id))
    .map(a => ({ at: a.at, by: a.actor, action: a.action, taskId: a.task_id, detail: a.detail }));
  const payload = { demo: d.demo, seq: d.seq, settings: d.settings, departments: d.departments, users, tasks, recurring, sentKeys, leaves: [], notifications, audit: auditOut };
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(JSON.stringify(payload)));
  payload.version = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return payload;
}

/* ---------------- persist ---------------- */
const userDoc = u => { const { id, email, name, role, active, linked, ...rest } = u; return JSON.stringify(rest); };

export async function persist(db, before, after) {
  const st = [], now = Date.now();
  const guard = () => db.prepare('INSERT INTO _guard (ok) VALUES (changes())');
  if (stable(before.data.settings) !== stable(after.settings)) st.push(db.prepare('UPDATE app_settings SET doc = ?, updated_at = ? WHERE id = 1').bind(JSON.stringify(after.settings), now));
  const bDept = new Map(before.data.departments.map(d => [d.id, stable(d)]));
  for (const d of after.departments) {
    if (!bDept.has(d.id)) st.push(db.prepare('INSERT INTO departments (id, name, color) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(d.id, d.name, d.color || null), guard());
    else if (bDept.get(d.id) !== stable(d)) st.push(db.prepare('UPDATE departments SET name = ?, color = ? WHERE id = ?').bind(d.name, d.color || null, d.id));
  }
  const bUser = new Map(before.data.users.map(u => [u.id, stable(u)]));
  for (const u of after.users) {
    const prev = bUser.get(u.id);
    if (prev === stable(u)) continue;
    if (prev === undefined) st.push(db.prepare('INSERT INTO users (id, email, name, role, active, doc, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING')
      .bind(u.id, u.email || null, u.name, u.role, u.active === false ? 0 : 1, userDoc(u), now), guard());
    else st.push(db.prepare('UPDATE users SET email = ?, name = ?, role = ?, active = ?, doc = ?, updated_at = ? WHERE id = ?')
      .bind(u.email || null, u.name, u.role, u.active === false ? 0 : 1, userDoc(u), now, u.id));
  }
  const bTask = new Map(before.data.tasks.map(t => [t.id, stable(t)]));
  for (const t of after.tasks) {
    const prev = bTask.get(t.id);
    if (prev === stable(t)) continue;
    if (prev === undefined) st.push(db.prepare(`INSERT INTO tasks (id, status, owner_id, dept_id, created_by, created_at, due_at, original_due_at, archived, doc, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`)
      .bind(t.id, t.status, t.ownerId, t.deptId || null, t.createdBy, t.createdAt, t.dueAt, t.originalDueAt, t.archived ? 1 : 0, JSON.stringify(t), now), guard());
    else st.push(db.prepare('UPDATE tasks SET status = ?, owner_id = ?, dept_id = ?, due_at = ?, archived = ?, doc = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?')
      .bind(t.status, t.ownerId, t.deptId || null, t.dueAt, t.archived ? 1 : 0, JSON.stringify(t), now, t.id, before.versions.get(t.id) ?? -1), guard());
  }
  const bRec = new Map(before.data.recurring.map(r => [r.id, stable(r)]));
  for (const r of after.recurring) {
    if (bRec.get(r.id) === stable(r)) continue;
    st.push(db.prepare('INSERT INTO recurring_templates (id, doc, active) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc, active = excluded.active')
      .bind(r.id, JSON.stringify(r), r.active === false ? 0 : 1));
  }
  for (const a of after.audit) st.push(db.prepare('INSERT INTO audit_log (at, actor, action, task_id, detail) VALUES (?, ?, ?, ?, ?)').bind(a.at, a.by, a.action, a.taskId || null, a.detail || ''));
  for (const n of after.notifications) {
    const id = uuid();
    st.push(db.prepare('INSERT INTO notifications (id, dedupe_key, type, task_id, recipient_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .bind(id, n.key || null, n.type, n.taskId || null, n.to, n.message, n.at));
    for (const c of n.channels || []) {
      const inApp = c.channel === 'in-app';
      st.push(db.prepare('INSERT INTO deliveries (notification_id, channel, status, sent_at, updated_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM notifications WHERE id = ?)')
        .bind(id, c.channel, inApp ? 'delivered' : 'queued', inApp ? now : null, now, id));
    }
  }
  if (!st.length) return;
  st.push(db.prepare('DELETE FROM _guard'));
  try { await db.batch(st); }
  catch (e) { if (/CHECK constraint failed/i.test(String(e && (e.message || e)))) throw new ConflictError('changed by someone else'); throw e; }
}

/* Load → run → save, retrying when someone else saved the same rows first. */
export async function transact(db, run) {
  for (let attempt = 1; ; attempt++) {
    const loaded = await loadAll(db);
    const out = run(loaded);
    if (out.abort || !out.data) return out.result;
    try { await persist(db, loaded, out.data); return out.result; }
    catch (e) { if (e instanceof ConflictError && attempt < 4) continue; throw e; }
  }
}
