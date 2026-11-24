/* Runs the shared Task360 rules engine (../js/store.js + ../js/engine.js — the same code the
 * browser runs) inside an isolated V8 sandbox per request. The server, not the browser, is the
 * authority: it chooses the actor from the signed-in session, stamps all timestamps itself and
 * enforces every permission and validation rule before anything is written.
 */
import vm from 'node:vm';
import { STORE_SRC, ENGINE_SRC } from './generated/client';

export type Dataset = {
  version?: string;
  demo: boolean;
  seq: number;
  settings: any;
  departments: any[];
  users: any[];
  tasks: any[];
  recurring: any[];
  notifications: any[];
  audit: any[];
  sentKeys: Record<string, number>;
  leaves: any[];
  [k: string]: any;
};

const program = new vm.Script(`${STORE_SRC}\n;\n${ENGINE_SRC}`, { filename: 'task360-engine.js' });

function sandbox(data: Dataset) {
  const ctx = vm.createContext({ window: { T360_CONFIG: { mode: 'server' } }, console });
  program.runInContext(ctx, { timeout: 5000 });
  ctx.__data = JSON.stringify(data);
  vm.runInContext('window.T360.store.data = JSON.parse(__data); window.T360.store.save = function () {}; delete globalThis.__data;', ctx);
  return ctx;
}

/* Evaluate `body` (a function body receiving T and INPUT) inside a fresh sandbox; returns its JSON result. */
function evaluate<R>(data: Dataset, body: string, input: unknown): R {
  const ctx = sandbox(data);
  ctx.__input = JSON.stringify(input ?? null);
  const out = vm.runInContext(`(function (T, INPUT) { ${body} })(window.T360, JSON.parse(__input))`, ctx, { timeout: 10000 });
  return JSON.parse(out);
}

export type ActionResult = { ok: true; result: any; data: Dataset } | { ok: false; error: string; code: number };

/* Execute one workflow action (T.api[action]) as `actorId`. */
export function execute(data: Dataset, actorId: string, action: string, args: unknown[]): ActionResult {
  return evaluate<ActionResult>(data, `
    var actor = T.user(INPUT.actorId);
    if (!actor || !actor.active) return JSON.stringify({ ok: false, error: 'Your account is not active.', code: 403 });
    var fn = T.api[INPUT.action];
    if (typeof fn !== 'function') return JSON.stringify({ ok: false, error: 'Unknown action.', code: 400 });
    try {
      var r = fn.apply(null, [actor].concat(INPUT.args));
      return JSON.stringify({ ok: true, result: r === undefined ? null : r, data: T.store.data });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String(e && e.message || e), code: (e && e.code) || 500 });
    }`, { actorId, action, args });
}

/* Run the follow-up engine (reminders, escalations, digests, recurring task generation). */
export function runFollowUps(data: Dataset): { sent: number; data: Dataset } {
  return evaluate(data, `var sent = T.engine.run(); return JSON.stringify({ sent: sent, data: T.store.data });`, null);
}

export type Scope = {
  canSeeAll: boolean;
  role: string;
  visibleUserIds: string[];
  data: Dataset;
};

/* The slice of data a user is allowed to see (sent to their browser). */
export function scopeFor(data: Dataset, actorId: string): Scope {
  return evaluate<Scope>(data, `
    var me = T.user(INPUT.actorId), d = T.store.data;
    var tasks = d.tasks.filter(function (t) { return T.canView(me, t); });
    var ids = {}; tasks.forEach(function (t) { ids[t.id] = 1; });
    var admin = me.role === 'super_admin';
    var users = d.users.map(function (u) {
      return { id: u.id, name: u.name, role: u.role, deptId: u.deptId, depts: u.depts || [], managerId: u.managerId, teams: u.teams || [],
        active: u.active, onLeave: u.onLeave, backupId: u.backupId, email: (admin || u.id === me.id) ? (u.email || '') : '' };
    });
    var sentKeys = {};
    Object.keys(d.sentKeys || {}).forEach(function (k) { var m = k.match(/^(T360-\\d+):/); if (m && ids[m[1]]) sentKeys[k] = d.sentKeys[k]; });
    var recurring = d.recurring.filter(function (r) {
      return T.canSeeAll(me) || (me.role === 'manager' && T.managerTeams(me).indexOf(r.deptId) >= 0) || r.ownerId === me.id;
    });
    return JSON.stringify({
      canSeeAll: T.canSeeAll(me), role: me.role,
      visibleUserIds: T.visibleUsers(me).map(function (u) { return u.id; }),
      data: { demo: d.demo, seq: d.seq, settings: d.settings, departments: d.departments, users: users, tasks: tasks,
        recurring: recurring, sentKeys: sentKeys, leaves: [], notifications: [], audit: [] }
    });`, { actorId });
}

/* Permission + lookup helpers used by the attachment endpoints. */
export function taskAccess(data: Dataset, actorId: string, taskId: string): { canView: boolean; canEdit: boolean; open: boolean; attachments: any[] } {
  return evaluate(data, `
    var me = T.user(INPUT.actorId), t = T.task(INPUT.taskId);
    if (!me || !t) return JSON.stringify({ canView: false, canEdit: false, open: false, attachments: [] });
    return JSON.stringify({ canView: T.canView(me, t), canEdit: T.isOwner(me, t) || T.canManage(me, t), open: T.isOpen(t), attachments: t.attachments || [] });`,
    { actorId, taskId });
}

/* Generate demonstration data with the same seed the standalone build uses. */
export function demoDataset(): Dataset {
  const ctx = vm.createContext({ window: { T360_CONFIG: { mode: 'server' } }, console });
  program.runInContext(ctx);
  return JSON.parse(vm.runInContext('window.T360.store.save = function () {}; window.T360.store.reset(); JSON.stringify(window.T360.store.data)', ctx));
}
