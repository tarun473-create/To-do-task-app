/* Delivery worker: sends queued email / Teams notifications with retry and backoff.
 * Runs from the scheduled job (/api/cron). Rows are claimed with FOR UPDATE SKIP LOCKED,
 * so overlapping runs never send the same message twice. */
import { db } from '../db';
import { env, graphConfigured } from '../env';
import { sendMail } from './graph';
import { postToTeams } from './teams';

const MAX_ATTEMPTS = 5;
const LABEL: Record<string, string> = {
  assigned: 'New task assigned', ack_reminder: 'Please acknowledge', due_24h: 'Deadline reminder', due_2h: 'Urgent: due soon',
  overdue: 'Task overdue', escalation1: 'Escalation', escalation2: 'Second escalation', reassigned: 'Task reassigned',
  review: 'Review requested', approved: 'Task approved', reopened: 'Task reopened', daily_followup: 'Daily follow-up',
  comment: 'New comment', weekly_summary: 'Weekly performance summary', monthly_kpi: 'Monthly KPI report',
  digest: 'Morning digest', deadline_changed: 'Deadline changed', cancelled: 'Task cancelled', recurring: 'Recurring task',
  backup: 'Backup assignment', approval: 'Approval needed', approval_done: 'Approvals complete',
  approval_rejected: 'Approval rejected', approval_reminder: 'Approval reminder'
};
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const istFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

function emailHtml(r: any, link: string) {
  const t = r.task;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1d2433;max-width:560px">
  <div style="font-weight:700;font-size:16px;margin-bottom:8px">Task360 · ${esc(LABEL[r.type] || r.type)}</div>
  <p>Hello ${esc(r.name)},</p><p>${esc(r.message)}</p>
  ${t ? `<table style="border-collapse:collapse;font-size:13px;margin:8px 0">
    <tr><td style="color:#6b7385;padding:2px 12px 2px 0">Task</td><td><b>${esc(t.id)}</b> — ${esc(t.title)}</td></tr>
    <tr><td style="color:#6b7385;padding:2px 12px 2px 0">Due (IST)</td><td>${esc(istFmt.format(Number(t.dueAt)))}</td></tr>
    <tr><td style="color:#6b7385;padding:2px 12px 2px 0">Priority</td><td>${esc(t.priority)}</td></tr></table>` : ''}
  <p><a href="${esc(link)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open in Task360</a></p>
  <p style="color:#6b7385;font-size:12px">Automatic message from Task360 — Team Performance &amp; Accountability Hub.</p></div>`;
}

export async function processQueue(limit = 50) {
  const sql = db();
  // Recover rows left in 'sending' by a crashed run.
  await sql`update task360.notification_deliveries set status = 'queued', updated_at = now()
            where status = 'sending' and updated_at < now() - interval '15 minutes'`;
  const rows: any[] = await sql.begin(async (tx: any) => {
    const r = await tx`
      select d.id, d.channel, d.attempts, n.type, n.message, n.task_id, u.email, u.name, t.doc as task_doc
      from task360.notification_deliveries d
      join task360.notifications n on n.id = d.notification_id
      join task360.users u on u.id = n.recipient_id
      left join task360.tasks t on t.id = n.task_id
      where d.status = 'queued' and d.next_attempt_at <= now()
      order by d.id limit ${limit}
      for update of d skip locked`;
    if (r.length) await tx`update task360.notification_deliveries set status = 'sending', updated_at = now() where id in ${tx(r.map((x: any) => x.id))}`;
    return r;
  });

  const stats = { sent: 0, failed: 0, retry: 0, skipped: 0 };
  for (const r of rows) {
    const task = r.task_doc ? { id: r.task_doc.id, title: r.task_doc.title, dueAt: r.task_doc.dueAt, priority: r.task_doc.priority } : null;
    const link = `${env.appUrl}/hub#/${task ? `task/${encodeURIComponent(task.id)}` : 'dashboard'}`;
    let skip = '';
    try {
      if (r.channel === 'email') {
        if (!graphConfigured()) skip = 'Microsoft Graph not configured';
        else if (!r.email) skip = 'Recipient has no email';
        else if (env.emailSkipTypes.includes(r.type)) skip = 'Email disabled for this notification type';
        else await sendMail(r.email, `[Task360] ${LABEL[r.type] || r.type}${task ? `: ${task.title}` : ''}`, emailHtml({ ...r, task }, link));
      } else if (r.channel === 'teams') {
        if (!env.teamsWebhookUrl) skip = 'Teams webhook not configured';
        else if (!env.teamsTypes.includes(r.type)) skip = 'Teams disabled for this notification type';
        else await postToTeams({
          title: `Task360 · ${LABEL[r.type] || r.type}`, text: r.message,
          facts: [['For', r.name], ...(task ? [['Task', `${task.id} — ${task.title}`], ['Due (IST)', istFmt.format(Number(task.dueAt))]] as [string, string][] : [])],
          url: link
        });
      } else skip = 'Unsupported channel';
      if (skip) {
        await sql`update task360.notification_deliveries set status = 'skipped', last_error = ${skip}, updated_at = now() where id = ${r.id}`;
        stats.skipped++;
      } else {
        await sql`update task360.notification_deliveries set status = 'sent', attempts = attempts + 1, last_error = null, sent_at = now(), updated_at = now() where id = ${r.id}`;
        stats.sent++;
      }
    } catch (e: any) {
      const attempts = r.attempts + 1, final = attempts >= MAX_ATTEMPTS;
      const delayMin = Math.min(2 ** attempts, 120); // 2, 4, 8, 16 … minutes
      await sql`update task360.notification_deliveries set status = ${final ? 'failed' : 'queued'}, attempts = ${attempts},
        last_error = ${String(e?.message || e).slice(0, 500)}, next_attempt_at = now() + ${delayMin + ' minutes'}::interval, updated_at = now()
        where id = ${r.id}`;
      if (final) stats.failed++; else stats.retry++;
    }
  }
  return { processed: rows.length, ...stats };
}
