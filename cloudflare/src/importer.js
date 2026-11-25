/* Loads a Task360 JSON export (Claude team page / standalone / other edition) into an empty D1 database. */
import { SCHEMA } from './gen/client.js';

export async function applySchema(db) {
  await db.batch(SCHEMA.map(s => db.prepare(s)));
}

export function checkExport(data) {
  if (!data || !Array.isArray(data.users) || !Array.isArray(data.tasks) || !data.settings || !Array.isArray(data.departments))
    throw new Error('This is not a Task360 export file. In Task360 use Admin Settings → Data → Download a copy (JSON).');
  const warnings = [];
  const users = data.users.map(u => ({ ...u, email: String(u.email || '').trim().toLowerCase() || null }));
  const noEmail = users.filter(u => u.active !== false && !u.email).map(u => u.name);
  if (noEmail.length) warnings.push(`No work email for ${noEmail.join(', ')} — they cannot sign in until an email is added.`);
  const emails = users.map(u => u.email).filter(Boolean);
  const dupes = emails.filter((e, i) => emails.indexOf(e) !== i);
  if (dupes.length) throw new Error(`Two people share the same email: ${[...new Set(dupes)].join(', ')}.`);
  if (!users.some(u => u.role === 'super_admin' && u.active !== false && u.email)) throw new Error('The file has no active Super Admin with a work email.');
  const depIds = new Set(data.departments.map(d => d.id)), userIds = new Set(users.map(u => u.id));
  const tasks = data.tasks.filter(t => depIds.has(t.deptId) && userIds.has(t.ownerId) && userIds.has(t.createdBy));
  if (tasks.length !== data.tasks.length) warnings.push(`${data.tasks.length - tasks.length} task(s) point to a missing department or person and were skipped.`);
  return { users, tasks, warnings };
}

const userDoc = u => { const { id, email, name, role, active, linked, claudeId, ...rest } = u; return JSON.stringify(rest); };

export async function importWorkspace(db, data, source) {
  const { users, tasks, warnings } = checkExport(data);
  const now = Date.now(), st = [];
  st.push(db.prepare('INSERT INTO app_settings (id, doc, demo, updated_at) VALUES (1, ?, ?, ?)').bind(JSON.stringify(data.settings), data.demo ? 1 : 0, now));
  for (const d of data.departments) st.push(db.prepare('INSERT INTO departments (id, name, color) VALUES (?, ?, ?)').bind(d.id, d.name, d.color || null));
  for (const u of users) st.push(db.prepare('INSERT INTO users (id, email, name, role, active, doc, must_change, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
    .bind(u.id, u.email, u.name, u.role, u.active === false ? 0 : 1, userDoc(u), now));
  for (const t of tasks) st.push(db.prepare(`INSERT INTO tasks (id, status, owner_id, dept_id, created_by, created_at, due_at, original_due_at, archived, doc, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(t.id, t.status, t.ownerId, t.deptId, t.createdBy, t.createdAt, t.dueAt, t.originalDueAt, t.archived ? 1 : 0, JSON.stringify(t), now));
  for (const r of data.recurring || []) st.push(db.prepare('INSERT INTO recurring_templates (id, doc, active) VALUES (?, ?, ?)').bind(r.id, JSON.stringify(r), r.active === false ? 0 : 1));
  for (const a of data.audit || []) st.push(db.prepare('INSERT INTO audit_log (at, actor, action, task_id, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(Number(a.at) || now, a.by || 'system', a.action || 'note', a.taskId || null, String(a.detail || '')));
  st.push(db.prepare("INSERT INTO audit_log (at, actor, action, detail) VALUES (?, 'system', 'import', ?)").bind(now, `Workspace imported from ${source}: ${users.length} people, ${tasks.length} tasks`));
  await db.batch(st); // one transaction: all or nothing
  return { departments: data.departments.length, people: users.length, tasks: tasks.length, close: (data.settings.closeItems || []).length, warnings };
}
