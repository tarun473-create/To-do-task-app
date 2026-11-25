// Moves a Task360 workspace into the company database.
//   1. In the current Task360 (e.g. the Claude team page): Admin Settings → Data → Download a copy (JSON)
//   2. DATABASE_URL=... npm run db:migrate
//   3. DATABASE_URL=... npm run db:import -- --file task360-backup.json
// Copies settings (incl. the month-end close checklist), departments, people, tasks with their full
// history, recurring templates and the audit trail. Refuses to run if the database already has people.
import postgres from 'postgres';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const file = arg('file');
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL.'); process.exit(1); }
if (!file) { console.error('Pass --file <the JSON you downloaded from Admin Settings → Data>.'); process.exit(1); }

let data;
try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { console.error('Could not read the file:', e.message); process.exit(1); }
if (!data || !Array.isArray(data.users) || !Array.isArray(data.tasks) || !data.settings) { console.error('This is not a Task360 backup file.'); process.exit(1); }
if (data.demo) console.warn('Note: this file is marked as demonstration data.');

const users = data.users.map(u => ({ ...u, email: (u.email || '').trim().toLowerCase() || null }));
const noEmail = users.filter(u => u.active !== false && !u.email).map(u => u.name);
if (noEmail.length) console.warn(`Warning: no work email for ${noEmail.join(', ')} — they cannot sign in until an email is added.`);
const dupes = users.map(u => u.email).filter((e, i, a) => e && a.indexOf(e) !== i);
if (dupes.length) { console.error('Two people share the same email:', [...new Set(dupes)].join(', ')); process.exit(1); }
if (!users.some(u => u.role === 'super_admin' && u.active !== false && u.email)) { console.error('The file has no active Super Admin with an email; nobody could manage the workspace.'); process.exit(1); }
const depIds = new Set((data.departments || []).map(d => d.id));
const userIds = new Set(users.map(u => u.id));
const tasks = data.tasks.filter(t => depIds.has(t.deptId) && userIds.has(t.ownerId) && userIds.has(t.createdBy));
if (tasks.length !== data.tasks.length) console.warn(`Skipping ${data.tasks.length - tasks.length} task(s) that point to a missing department or person.`);

const sql = postgres(process.env.DATABASE_URL, { prepare: false, onnotice: () => {} });
const d = ms => (ms == null ? null : new Date(Number(ms)));
try {
  const [{ n }] = await sql`select count(*)::int as n from task360.users`;
  if (n > 0) { console.error('The database already has people — not importing. (To start over: drop schema task360 cascade; then migrate and import.)'); process.exit(1); }
  await sql.begin(async tx => {
    const settings = { ...data.settings };
    await tx`insert into task360.app_settings (id, doc, demo) values (1, ${tx.json(settings)}, ${!!data.demo}) on conflict (id) do update set doc = excluded.doc, demo = excluded.demo`;
    for (const x of data.departments || []) await tx`insert into task360.departments (id, name, color) values (${x.id}, ${x.name}, ${x.color || null})`;
    for (const u of users) {
      const depts = Array.isArray(u.depts) && u.depts.length ? u.depts : (u.deptId ? [u.deptId] : []);
      await tx`insert into task360.users (id, email, name, role, dept_id, depts, teams, active, on_leave)
        values (${u.id}, ${u.email}, ${u.name}, ${u.role}, ${u.deptId || null}, ${depts}, ${u.teams || []}, ${u.active !== false}, ${!!u.onLeave})`;
    }
    for (const u of users) {
      if (u.managerId && userIds.has(u.managerId)) await tx`update task360.users set manager_id = ${u.managerId} where id = ${u.id}`;
      if (u.backupId && userIds.has(u.backupId)) await tx`update task360.users set backup_id = ${u.backupId} where id = ${u.id}`;
    }
    for (const t of tasks) {
      await tx`insert into task360.tasks (id, dept_id, owner_id, created_by, status, priority, due_at, original_due_at, kpi_due_at, archived, demo, doc, created_at)
        values (${t.id}, ${t.deptId}, ${t.ownerId}, ${t.createdBy}, ${t.status}, ${t.priority}, ${d(t.dueAt)}, ${d(t.originalDueAt)}, ${d(t.kpiDueAt)},
                ${!!t.archived}, ${!!data.demo}, ${tx.json(t)}, ${d(t.createdAt)})`;
    }
    for (const r of data.recurring || []) await tx`insert into task360.recurring_templates (id, doc, active) values (${r.id}, ${tx.json(r)}, ${r.active !== false})`;
    for (const a of data.audit || []) {
      await tx`insert into task360.audit_log (at, actor, action, task_id, detail) values (${d(a.at) || new Date()}, ${a.by || 'system'}, ${a.action || 'note'}, ${a.taskId || null}, ${a.detail || ''})`;
    }
    await tx`insert into task360.audit_log (actor, action, detail) values ('system', 'import', ${`Workspace imported from ${file.split(/[\\/]/).pop()}: ${users.length} people, ${tasks.length} tasks`})`;
  });
  const close = (data.settings.closeItems || []).length;
  console.log(`Imported: ${(data.departments || []).length} departments, ${users.length} people, ${tasks.length} tasks, ${close} month-end close activities, ${(data.audit || []).length} audit entries.`);
  console.log('Next: sign in as a Super Admin and use Team & Workload → Sign-in status → "Set temporary password" for each person.');
} catch (e) {
  console.error('Import failed (nothing was saved):', e.message); process.exitCode = 1;
} finally { await sql.end(); }
