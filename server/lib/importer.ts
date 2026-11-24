/* Loads a Task360 JSON export (Claude team page / standalone) into an empty database.
   Used by the one-time /setup page; scripts/import.mjs does the same from the command line. */
import type { Sql } from 'postgres';

export type ImportSummary = { departments: number; people: number; tasks: number; closeActivities: number; auditEntries: number; warnings: string[] };

export function checkExport(data: any): { users: any[]; tasks: any[]; warnings: string[] } {
  if (!data || !Array.isArray(data.users) || !Array.isArray(data.tasks) || !data.settings || !Array.isArray(data.departments))
    throw new Error('This is not a Task360 export file. In Task360 use Admin Settings → Data → Download a copy (JSON).');
  const warnings: string[] = [];
  const users = data.users.map((u: any) => ({ ...u, email: String(u.email || '').trim().toLowerCase() || null }));
  const noEmail = users.filter((u: any) => u.active !== false && !u.email).map((u: any) => u.name);
  if (noEmail.length) warnings.push(`No work email for ${noEmail.join(', ')} — they cannot sign in until an email is added on the Team page.`);
  const emails = users.map((u: any) => u.email).filter(Boolean);
  const dupes = emails.filter((e: string, i: number) => emails.indexOf(e) !== i);
  if (dupes.length) throw new Error(`Two people share the same email: ${[...new Set(dupes)].join(', ')}.`);
  if (!users.some((u: any) => u.role === 'super_admin' && u.active !== false && u.email)) throw new Error('The file has no active Super Admin with a work email.');
  const depIds = new Set(data.departments.map((d: any) => d.id));
  const userIds = new Set(users.map((u: any) => u.id));
  const tasks = data.tasks.filter((t: any) => depIds.has(t.deptId) && userIds.has(t.ownerId) && userIds.has(t.createdBy));
  if (tasks.length !== data.tasks.length) warnings.push(`${data.tasks.length - tasks.length} task(s) point to a missing department or person and were skipped.`);
  return { users, tasks, warnings };
}

export async function importWorkspace(sql: Sql, data: any, source: string): Promise<ImportSummary> {
  const { users, tasks, warnings } = checkExport(data);
  const userIds = new Set(users.map((u: any) => u.id));
  const d = (ms: any) => (ms == null ? null : new Date(Number(ms)));
  await sql.begin(async (tx: any) => {
    const [{ n }] = await tx`select count(*)::int as n from task360.users`;
    if (n > 0) throw new Error('Task360 already has people in its database — the import runs only once.');
    await tx`insert into task360.app_settings (id, doc, demo) values (1, ${tx.json(data.settings)}, ${!!data.demo})
      on conflict (id) do update set doc = excluded.doc, demo = excluded.demo`;
    for (const x of data.departments) await tx`insert into task360.departments (id, name, color) values (${x.id}, ${x.name}, ${x.color || null})`;
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
      await tx`insert into task360.audit_log (at, actor, action, task_id, detail) values (${d(a.at) || new Date()}, ${a.by || 'system'}, ${a.action || 'note'}, ${a.taskId || null}, ${String(a.detail || '')})`;
    }
    await tx`insert into task360.audit_log (actor, action, detail) values ('system', 'import', ${`Workspace imported from ${source}: ${users.length} people, ${tasks.length} tasks`})`;
  });
  return {
    departments: data.departments.length, people: users.length, tasks: tasks.length,
    closeActivities: (data.settings.closeItems || []).length, auditEntries: (data.audit || []).length, warnings
  };
}
