// Loads initial data.  Usage:
//   npm run db:seed -- --admin-email you@company.com [--admin-name "Your Name"]          demo data (labelled DEMO DATA)
//   npm run db:seed -- --empty --admin-email you@company.com --admin-name "Your Name"    real start: settings, 5 F&A departments, you as Super Admin
// Refuses to run if the database already has users.
import postgres from 'postgres';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const arg = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const empty = argv.includes('--empty');
const adminEmail = (arg('admin-email') || '').trim().toLowerCase();
const adminName = arg('admin-name');
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL.'); process.exit(1); }
if (!adminEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) { console.error('Pass --admin-email you@company.com (this person becomes Super Admin and can sign in).'); process.exit(1); }

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ctx = vm.createContext({ window: { T360_CONFIG: { mode: 'server' } }, console });
vm.runInContext(readFileSync(join(root, 'js/store.js'), 'utf8') + '\n;\n' + readFileSync(join(root, 'js/engine.js'), 'utf8'), ctx);
const demo = JSON.parse(vm.runInContext('window.T360.store.save = function () {}; window.T360.store.reset(); JSON.stringify(window.T360.store.data)', ctx));

let data;
if (empty) {
  data = {
    demo: false, settings: demo.settings, departments: demo.departments, tasks: [], recurring: [], audit: [],
    users: [{ id: 'u1', name: adminName || 'Administrator', role: 'super_admin', deptId: null, managerId: null, teams: [], email: adminEmail, active: true, onLeave: false, backupId: null }]
  };
} else {
  data = demo;
  const admin = data.users.find(u => u.role === 'super_admin');
  admin.email = adminEmail; if (adminName) admin.name = adminName;
}

const sql = postgres(process.env.DATABASE_URL, { prepare: false, onnotice: () => {} });
const d = ms => (ms == null ? null : new Date(Number(ms)));
try {
  const [{ n }] = await sql`select count(*)::int as n from task360.users`;
  if (n > 0) { console.error('The database already has users — not seeding again. (To start over: drop schema task360 cascade; then migrate and seed.)'); process.exit(1); }
  await sql.begin(async tx => {
    await tx`insert into task360.app_settings (id, doc, demo) values (1, ${tx.json(data.settings)}, ${data.demo}) on conflict (id) do update set doc = excluded.doc, demo = excluded.demo`;
    for (const x of data.departments) await tx`insert into task360.departments (id, name, color) values (${x.id}, ${x.name}, ${x.color})`;
    for (const u of data.users) await tx`insert into task360.users (id, email, name, role, dept_id, depts, teams, active) values (${u.id}, ${u.email || null}, ${u.name}, ${u.role}, ${u.deptId}, ${u.depts || (u.deptId ? [u.deptId] : [])}, ${u.teams || []}, true)`;
    for (const u of data.users) if (u.managerId) await tx`update task360.users set manager_id = ${u.managerId} where id = ${u.id}`;
    for (const t of data.tasks) {
      await tx`insert into task360.tasks (id, dept_id, owner_id, created_by, status, priority, due_at, original_due_at, kpi_due_at, archived, demo, doc, created_at)
        values (${t.id}, ${t.deptId}, ${t.ownerId}, ${t.createdBy}, ${t.status}, ${t.priority}, ${d(t.dueAt)}, ${d(t.originalDueAt)}, ${d(t.kpiDueAt)}, ${!!t.archived}, ${data.demo}, ${tx.json(t)}, ${d(t.createdAt)})`;
    }
    for (const r of data.recurring) await tx`insert into task360.recurring_templates (id, doc, active) values (${r.id}, ${tx.json(r)}, ${r.active !== false})`;
    await tx`insert into task360.audit_log (actor, action, detail) values ('system', 'seed', ${empty ? `Initial setup; Super Admin ${adminEmail}` : `Demonstration data loaded; Super Admin ${adminEmail}`})`;
  });
  console.log(`Seeded ${empty ? 'an empty workspace' : 'demonstration data'}: ${data.users.length} users, ${data.tasks.length} tasks. Super Admin: ${adminEmail}`);
} catch (e) {
  console.error('Seeding failed:', e.message); process.exitCode = 1;
} finally { await sql.end(); }
