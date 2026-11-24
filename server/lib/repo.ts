/* Loading the dataset from PostgreSQL and persisting what an engine run changed. */
import { createHash, randomUUID } from 'node:crypto';
import { db } from './db';
import type { Dataset } from './engine';

type Sql = ReturnType<typeof db>;
export class ConflictError extends Error { constructor(m = 'Data changed concurrently') { super(m); } }

const ms = (v: any) => (v == null ? null : new Date(Number(v)));
const toUser = (r: any) => ({
  id: r.id, name: r.name, role: r.role, deptId: r.dept_id, depts: r.depts && r.depts.length ? r.depts : (r.dept_id ? [r.dept_id] : []), managerId: r.manager_id, teams: r.teams || [],
  email: r.email || '', active: r.active, onLeave: r.on_leave, backupId: r.backup_id
});

export type Loaded = { data: Dataset; versions: Map<string, number> };

/* Load everything the rules engine needs. Notifications/audit are not needed by the rules
   (duplicate prevention uses dedupe keys), so they are loaded separately for display. */
export async function loadAll(sql: Sql = db()): Promise<Loaded> {
  const [settings] = await sql`select doc, demo from task360.app_settings where id = 1`;
  if (!settings) throw new Error('Database not initialised. Run "npm run db:migrate" and "npm run db:seed".');
  const [departments, users, tasks, recurring, keys] = await Promise.all([
    sql`select id, name, color from task360.departments where active order by id`,
    sql`select * from task360.users order by id`,
    sql`select id, version, doc from task360.tasks`,
    sql`select doc from task360.recurring_templates order by id`,
    sql`select distinct dedupe_key from task360.notifications where dedupe_key is not null and created_at > now() - interval '400 days'`
  ]);
  const versions = new Map<string, number>();
  let maxSeq = 0;
  const taskDocs = tasks.map((t: any) => {
    versions.set(t.id, t.version);
    const n = parseInt(String(t.id).slice(5), 10); if (n > maxSeq) maxSeq = n;
    return t.doc;
  });
  const sentKeys: Record<string, number> = {};
  keys.forEach((k: any) => { sentKeys[k.dedupe_key] = 1; });
  return {
    versions,
    data: {
      demo: settings.demo, seq: maxSeq + 1, settings: settings.doc,
      departments: departments.map((d: any) => ({ id: d.id, name: d.name, color: d.color })),
      users: users.map(toUser), tasks: taskDocs, recurring: recurring.map((r: any) => r.doc),
      notifications: [], audit: [], sentKeys, leaves: []
    }
  };
}

const stable = (o: unknown) => JSON.stringify(o);

/* Write every difference between `before` and `after` in one transaction. Throws ConflictError
   (→ caller reloads and retries) if another request changed the same rows first. */
export async function persist(before: Loaded, after: Dataset, sql: Sql = db()): Promise<{ notificationsInserted: number }> {
  return sql.begin(async (tx: any) => {
    // settings
    if (stable(before.data.settings) !== stable(after.settings)) {
      await tx`update task360.app_settings set doc = ${tx.json(after.settings)}, updated_at = now() where id = 1`;
    }
    // departments
    const bDept = new Map(before.data.departments.map(d => [d.id, stable(d)]));
    for (const d of after.departments) {
      if (!bDept.has(d.id)) {
        const r = await tx`insert into task360.departments (id, name, color) values (${d.id}, ${d.name}, ${d.color || null}) on conflict do nothing returning id`;
        if (!r.length) throw new ConflictError();
      } else if (bDept.get(d.id) !== stable(d)) {
        await tx`update task360.departments set name = ${d.name}, color = ${d.color || null} where id = ${d.id}`;
      }
    }
    // users (insert first without self-references, then set references)
    const bUser = new Map(before.data.users.map(u => [u.id, stable(u)]));
    const changedUsers = after.users.filter(u => bUser.get(u.id) !== stable(u));
    for (const u of changedUsers.filter(u => !bUser.has(u.id))) {
      const r = await tx`insert into task360.users (id, email, name, role, dept_id, teams, active)
        values (${u.id}, ${u.email || null}, ${u.name}, ${u.role}, ${u.deptId || null}, ${u.teams || []}, ${u.active !== false})
        on conflict do nothing returning id`;
      if (!r.length) throw new ConflictError();
    }
    for (const u of changedUsers) {
      await tx`update task360.users set email = ${u.email || null}, name = ${u.name}, role = ${u.role}, dept_id = ${u.deptId || null},
        manager_id = ${u.managerId || null}, teams = ${u.teams || []}, depts = ${u.depts || []}, active = ${u.active !== false}, on_leave = ${!!u.onLeave},
        backup_id = ${u.backupId || null}, updated_at = now() where id = ${u.id}`;
    }
    // tasks
    const bTask = new Map(before.data.tasks.map(t => [t.id, stable(t)]));
    for (const t of after.tasks) {
      const prev = bTask.get(t.id);
      if (prev === stable(t)) continue;
      const cols = {
        dept_id: t.deptId, owner_id: t.ownerId, created_by: t.createdBy, status: t.status, priority: t.priority,
        due_at: ms(t.dueAt), original_due_at: ms(t.originalDueAt), kpi_due_at: ms(t.kpiDueAt), archived: !!t.archived
      };
      if (prev === undefined) {
        const r = await tx`insert into task360.tasks (id, dept_id, owner_id, created_by, status, priority, due_at, original_due_at, kpi_due_at, archived, demo, doc, created_at)
          values (${t.id}, ${cols.dept_id}, ${cols.owner_id}, ${cols.created_by}, ${cols.status}, ${cols.priority}, ${cols.due_at}, ${cols.original_due_at},
                  ${cols.kpi_due_at}, ${cols.archived}, ${!!after.demo}, ${tx.json(t)}, ${ms(t.createdAt)})
          on conflict (id) do nothing returning id`;
        if (!r.length) throw new ConflictError(`Task id ${t.id} already taken`);
      } else {
        const r = await tx`update task360.tasks set dept_id = ${cols.dept_id}, owner_id = ${cols.owner_id}, status = ${cols.status},
          priority = ${cols.priority}, due_at = ${cols.due_at}, kpi_due_at = ${cols.kpi_due_at}, archived = ${cols.archived},
          doc = ${tx.json(t)}, version = version + 1
          where id = ${t.id} and version = ${before.versions.get(t.id) ?? -1} returning id`;
        if (!r.length) throw new ConflictError(`Task ${t.id} was changed by someone else`);
      }
    }
    // recurring templates
    const bRec = new Map(before.data.recurring.map(r => [r.id, stable(r)]));
    for (const r of after.recurring) {
      if (bRec.get(r.id) === stable(r)) continue;
      await tx`insert into task360.recurring_templates (id, doc, active) values (${r.id}, ${tx.json(r)}, ${r.active !== false})
        on conflict (id) do update set doc = excluded.doc, active = excluded.active, updated_at = now()`;
    }
    // audit (append-only; the engine only ever appends)
    for (const a of after.audit) {
      await tx`insert into task360.audit_log (at, actor, action, task_id, detail) values (${ms(a.at)}, ${a.by}, ${a.action}, ${a.taskId || null}, ${a.detail || ''})`;
    }
    // notifications + delivery queue; the unique dedupe index makes duplicate reminders impossible
    let inserted = 0;
    for (const n of after.notifications) {
      const id = randomUUID();
      const r = n.key
        ? await tx`insert into task360.notifications (id, dedupe_key, type, task_id, recipient_id, message, created_at)
            values (${id}, ${n.key}, ${n.type}, ${n.taskId || null}, ${n.to}, ${n.message}, ${ms(n.at)})
            on conflict (dedupe_key, recipient_id) where dedupe_key is not null do nothing returning id`
        : await tx`insert into task360.notifications (id, dedupe_key, type, task_id, recipient_id, message, created_at)
            values (${id}, null, ${n.type}, ${n.taskId || null}, ${n.to}, ${n.message}, ${ms(n.at)}) returning id`;
      if (!r.length) continue;
      inserted++;
      for (const c of n.channels || []) {
        await tx`insert into task360.notification_deliveries (notification_id, channel, status, sent_at)
          values (${id}, ${c.channel}, ${c.channel === 'in-app' ? 'delivered' : 'queued'}, ${c.channel === 'in-app' ? new Date() : null})`;
      }
    }
    return { notificationsInserted: inserted };
  }) as any;
}

/* Load → run → persist, retrying on concurrent modification. */
export async function transact<R>(run: (loaded: Loaded) => { data?: Dataset; result: R; abort?: boolean }): Promise<R> {
  for (let attempt = 1; ; attempt++) {
    const loaded = await loadAll();
    const out = run(loaded);
    if (out.abort || !out.data) return out.result;
    try {
      await persist(loaded, out.data);
      return out.result;
    } catch (e) {
      if (e instanceof ConflictError && attempt < 4) continue;
      throw e;
    }
  }
}

/* Recent notifications (with delivery status) and audit entries, for display. */
export async function loadActivity(sql: Sql = db()) {
  const [notes, audit] = await Promise.all([
    sql`select n.id, n.type, n.task_id, n.recipient_id, n.message, n.created_at, n.read_at,
          coalesce(json_agg(json_build_object('channel', d.channel, 'status', d.status, 'error', d.last_error) order by d.channel)
                   filter (where d.id is not null), '[]') as channels
        from (select * from task360.notifications order by created_at desc limit 1500) n
        left join task360.notification_deliveries d on d.notification_id = n.id
        group by n.id, n.type, n.task_id, n.recipient_id, n.message, n.created_at, n.read_at
        order by n.created_at desc`,
    sql`select at, actor, action, task_id, detail from task360.audit_log order by at desc, id desc limit 3000`
  ]);
  return {
    notifications: notes.map((n: any) => ({
      id: n.id, type: n.type, taskId: n.task_id, to: n.recipient_id, message: n.message,
      at: new Date(n.created_at).getTime(), read: !!n.read_at, channels: n.channels
    })),
    audit: audit.map((a: any) => ({ at: new Date(a.at).getTime(), by: a.actor, action: a.action, taskId: a.task_id, detail: a.detail }))
  };
}

export const hashOf = (o: unknown) => createHash('sha1').update(JSON.stringify(o)).digest('hex');
