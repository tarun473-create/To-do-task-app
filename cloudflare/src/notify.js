/* Sends queued Outlook (Microsoft Graph) and Teams notifications with retry and backoff.
   Runs from the Cron Trigger. Rows are claimed with one atomic UPDATE so overlapping runs never
   send the same message twice. Channels that are not configured are marked "skipped". */
const LABEL = {
  assigned: 'New task assigned', ack_reminder: 'Please acknowledge', due_24h: 'Deadline reminder', due_2h: 'Urgent: due soon', overdue: 'Task overdue',
  escalation1: 'Escalation', escalation2: 'Second escalation', reassigned: 'Task reassigned', review: 'Review requested', approved: 'Task approved',
  reopened: 'Task reopened', daily_followup: 'Daily follow-up', comment: 'New comment', weekly_summary: 'Weekly performance summary',
  monthly_kpi: 'Monthly KPI report', digest: 'Morning digest', deadline_changed: 'Deadline changed', cancelled: 'Task cancelled',
  recurring: 'Recurring task', backup: 'Backup assignment', approval: 'Approval needed', approval_done: 'Approvals complete',
  approval_rejected: 'Approval rejected', approval_reminder: 'Approval reminder'
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ist = ms => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(ms);
const list = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);
const graphOn = env => !!(env.MS_MAIL_TENANT_ID || env.MICROSOFT_TENANT_ID) && !!env.MS_MAIL_CLIENT_ID && !!env.MS_MAIL_CLIENT_SECRET && !!env.MS_SENDER_EMAIL;

let token = null;
async function graphToken(env) {
  if (token && token.exp > Date.now() + 60e3) return token.value;
  const tenant = env.MS_MAIL_TENANT_ID || env.MICROSOFT_TENANT_ID, base = (env.MS_AUTHORITY || 'https://login.microsoftonline.com').replace(/\/$/, '');
  const res = await fetch(`${base}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.MS_MAIL_CLIENT_ID, client_secret: env.MS_MAIL_CLIENT_SECRET, scope: `${env.MS_GRAPH_BASE || 'https://graph.microsoft.com'}/.default`, grant_type: 'client_credentials' }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Graph token error ${res.status}: ${j.error || ''}`.slice(0, 300));
  token = { value: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
  return token.value;
}
async function sendMail(env, to, subject, html) {
  const res = await fetch(`${env.MS_GRAPH_BASE || 'https://graph.microsoft.com'}/v1.0/users/${encodeURIComponent(env.MS_SENDER_EMAIL)}/sendMail`, {
    method: 'POST', headers: { authorization: `Bearer ${await graphToken(env)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] }, saveToSentItems: false }) });
  if (res.status === 401) token = null;
  if (!res.ok && res.status !== 202) throw new Error(`Graph sendMail ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
}
async function postTeams(env, card) {
  const content = { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
    body: [{ type: 'TextBlock', text: card.title, weight: 'Bolder', size: 'Medium', wrap: true }, { type: 'TextBlock', text: card.text, wrap: true },
      { type: 'FactSet', facts: card.facts.map(([title, value]) => ({ title, value })) }],
    actions: [{ type: 'Action.OpenUrl', title: 'Open in Task360', url: card.url }] };
  const res = await fetch(env.TEAMS_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }] }) });
  if (!res.ok) throw new Error(`Teams webhook ${res.status}`);
}

export async function processQueue(env, appUrl, limit = 50) {
  const db = env.DB, now = Date.now(), claim = crypto.randomUUID();
  await db.prepare("UPDATE deliveries SET status = 'queued', updated_at = ? WHERE status = 'sending' AND updated_at < ?").bind(now, now - 15 * 60e3).run();
  await db.prepare(`UPDATE deliveries SET status = 'sending', claim = ?, updated_at = ? WHERE id IN
    (SELECT id FROM deliveries WHERE status = 'queued' AND next_attempt_at <= ? ORDER BY id LIMIT ?)`).bind(claim, now, now, limit).run();
  const { results } = await db.prepare(`SELECT d.id, d.channel, d.attempts, n.type, n.message, n.task_id, u.email, u.name, t.doc AS task_doc
    FROM deliveries d JOIN notifications n ON n.id = d.notification_id JOIN users u ON u.id = n.recipient_id LEFT JOIN tasks t ON t.id = n.task_id
    WHERE d.claim = ? AND d.status = 'sending'`).bind(claim).all();
  const stats = { sent: 0, failed: 0, retry: 0, skipped: 0 };
  const skipEmail = list(env.EMAIL_SKIP_TYPES ?? 'comment'), teamsTypes = list(env.TEAMS_NOTIFY_TYPES ?? 'overdue,escalation1,escalation2,digest,weekly_summary,monthly_kpi');
  for (const r of results) {
    const t = r.task_doc ? JSON.parse(r.task_doc) : null;
    const link = `${appUrl}/hub#/${t ? 'task/' + encodeURIComponent(t.id) : 'dashboard'}`;
    let skip = '';
    try {
      if (r.channel === 'email') {
        if (!graphOn(env)) skip = 'Outlook sending not configured';
        else if (!r.email) skip = 'Recipient has no email';
        else if (skipEmail.includes(r.type)) skip = 'Email disabled for this notification type';
        else await sendMail(env, r.email, `[Task360] ${LABEL[r.type] || r.type}${t ? ': ' + t.title : ''}`,
          `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#1d2433;max-width:560px"><div style="font-weight:700;font-size:16px;margin-bottom:8px">Task360 · ${esc(LABEL[r.type] || r.type)}</div>
          <p>Hello ${esc(r.name)},</p><p>${esc(r.message)}</p>${t ? `<p style="font-size:13px"><b>${esc(t.id)}</b> — ${esc(t.title)}<br>Due (IST): ${esc(ist(Number(t.dueAt)))}</p>` : ''}
          <p><a href="${esc(link)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none">Open in Task360</a></p>
          <p style="color:#6b7385;font-size:12px">Automatic message from Task360.</p></div>`);
      } else if (r.channel === 'teams') {
        if (!env.TEAMS_WEBHOOK_URL) skip = 'Teams not configured';
        else if (!teamsTypes.includes(r.type)) skip = 'Teams disabled for this notification type';
        else await postTeams(env, { title: `Task360 · ${LABEL[r.type] || r.type}`, text: r.message, url: link,
          facts: [['For', r.name], ...(t ? [['Task', `${t.id} — ${t.title}`], ['Due (IST)', ist(Number(t.dueAt))]] : [])] });
      } else skip = 'Unsupported channel';
      if (skip) { await db.prepare("UPDATE deliveries SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ?").bind(skip, Date.now(), r.id).run(); stats.skipped++; }
      else { await db.prepare("UPDATE deliveries SET status = 'sent', attempts = attempts + 1, last_error = NULL, sent_at = ?, updated_at = ? WHERE id = ?").bind(Date.now(), Date.now(), r.id).run(); stats.sent++; }
    } catch (e) {
      const attempts = r.attempts + 1, final = attempts >= 5;
      await db.prepare('UPDATE deliveries SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?')
        .bind(final ? 'failed' : 'queued', attempts, String(e && e.message || e).slice(0, 500), Date.now() + Math.min(2 ** attempts, 120) * 60e3, Date.now(), r.id).run();
      if (final) stats.failed++; else stats.retry++;
    }
  }
  return { processed: results.length, ...stats };
}
