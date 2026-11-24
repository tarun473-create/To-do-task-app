/* Task360 — business rules: permissions, workflow API, audit, notifications,
 * escalation engine, recurring tasks and KPI calculation.
 * Every mutating function here is written as a "server API": it validates the
 * acting user, enforces permissions, stamps timestamps itself (callers cannot
 * pass them) and appends to the immutable audit trail.
 */
(function (T) {
  'use strict';
  const { HOUR, DAY } = T;
  const D = () => T.store.data;
  const now = () => Date.now();
  /* mode 'standalone' (browser-only demo) or 'server' (rules executed authoritatively on the server) */
  T.config = Object.assign({ mode: 'standalone' }, (typeof window !== 'undefined' && window.T360_CONFIG) || {});
  T.isServer = () => T.config.mode === 'server';
  /* 'shared': the published team page — data in the page's shared database, sign-in via Claude accounts. */
  T.isShared = () => T.config.mode === 'shared';

  /* ---------------- lookups ---------------- */
  T.user = id => D().users.find(u => u.id === id);
  T.dept = id => D().departments.find(d => d.id === id);
  T.task = id => D().tasks.find(t => t.id === id);
  T.userName = id => id === 'system' ? 'System' : (T.user(id) || { name: 'Unknown' }).name;
  T.deptName = id => (T.dept(id) || { name: '—' }).name;
  T.statusLabel = s => (T.STATUSES.find(x => x.id === s) || { label: s }).label;
  T.priorityLabel = p => (T.PRIORITIES.find(x => x.id === p) || { label: p }).label;

  /* ---------------- time / calendar ---------------- */
  T.isHoliday = ms => D().settings.holidays.some(h => h.date === T.istDateStr(ms));
  T.isWorkingDay = ms => D().settings.workingDays.includes(T.epochToIstParts(ms).dow) && !T.isHoliday(ms);
  /* Whole working days elapsed after `from` up to `to` (counts calendar days after the due date that are working days). */
  T.workingDaysBetween = function (from, to) {
    if (to <= from) return 0;
    let n = 0;
    let cursor = T.istToEpoch(T.istDateStr(from), '12:00') + DAY;
    const end = T.istToEpoch(T.istDateStr(to), '12:00');
    while (cursor <= end) { if (T.isWorkingDay(cursor)) n++; cursor += DAY; }
    // only count today if the full day boundary has passed relative to due time
    return n;
  };

  /* ---------------- status helpers ---------------- */
  T.CLOSED = ['completed', 'cancelled'];
  T.isOpen = t => !T.CLOSED.includes(t.status);
  T.isSubmitted = t => t.status === 'pending_review' || t.status === 'completed';
  /* Overdue is a FLAG, not a status: the task keeps In Progress / On Hold etc. */
  T.isOverdue = (t, at = now()) => !T.CLOSED.includes(t.status) && t.status !== 'pending_review' && at > t.dueAt;
  T.overdueDays = (t, at = now()) => T.isOverdue(t, at) ? T.workingDaysBetween(t.dueAt, at) : 0;
  T.dueToday = t => T.isOpen(t) && T.istDateStr(t.dueAt) === T.istDateStr(now());
  T.ageDays = t => Math.floor(((t.completedAt || now()) - t.createdAt) / DAY);
  /* Approval-before-submission workflow helpers */
  T.hasApprovals = t => (t.approvals || []).length > 0;
  T.approvalsDone = t => T.hasApprovals(t) && t.approvals.every(a => a.status === 'approved');
  T.currentApproval = t => t.status === 'in_approval' ? (t.approvals || []).find(a => a.status === 'pending') || null : null;
  /* Time the task spent waiting on approvers before first submission. KPI fairness: this time is
     not counted against the employee's turnaround or on-time delivery. */
  T.approvalWaitMs = t => (t.approvalLog || []).reduce((sum, e) => {
    if (!e.requestedAt) return sum;
    const end = Math.min(e.decidedAt || now(), t.firstSubmittedAt || Infinity);
    return sum + Math.max(0, end - e.requestedAt);
  }, 0);
  T.actualTatHrs = t => t.firstSubmittedAt ? Math.max(0, t.firstSubmittedAt - t.assignedAt - T.approvalWaitMs(t)) / HOUR : null;
  T.submittedOnTime = t => !!t.firstSubmittedAt && t.firstSubmittedAt - T.approvalWaitMs(t) <= t.kpiDueAt;
  /* A decision this person must take: an approval step assigned to them, or a final review they can do. */
  T.waitingOnMe = (t, me) => {
    const a = T.currentApproval(t);
    if (a) return a.approverId === me.id;
    return t.status === 'pending_review' && t.ownerId !== me.id && T.canManage(me, t);
  };
  /* Where a task is in its workflow right now, and who it is waiting on. */
  T.stageOf = t => {
    const lastHold = [...(t.history || [])].reverse().find(h => h.action === 'on_hold');
    switch (t.status) {
      case 'assigned': return { stage: 'Awaiting acknowledgement', waitingOn: t.ownerId, since: t.assignedAt };
      case 'acknowledged': case 'in_progress': case 'reopened':
        if (T.hasApprovals(t) && !T.approvalsDone(t)) return { stage: t.status === 'reopened' ? 'Rework, then send for approval' : 'Working, then send for approval', waitingOn: t.ownerId, since: t.startedAt || t.ackAt || t.assignedAt };
        if (T.approvalsDone(t)) return { stage: 'Approved, ready to submit', waitingOn: t.ownerId, since: Math.max(...t.approvals.map(a => a.decidedAt || 0)) };
        return { stage: t.status === 'reopened' ? 'Rework after review' : t.status === 'acknowledged' ? 'Acknowledged, not started' : 'In progress', waitingOn: t.ownerId, since: t.startedAt || t.ackAt || t.assignedAt };
      case 'on_hold': return { stage: 'On hold', waitingOn: t.ownerId, since: lastHold ? lastHold.at : t.assignedAt };
      case 'in_approval': { const a = T.currentApproval(t); return { stage: `Approval: ${a ? a.label : ''}`, waitingOn: a ? a.approverId : null, since: a ? a.requestedAt : null }; }
      case 'pending_review': return { stage: 'Final review', waitingOn: t.reviewerId || t.createdBy, since: t.submittedAt };
      case 'completed': return { stage: 'Completed', waitingOn: null, since: t.completedAt };
      default: return { stage: 'Cancelled', waitingOn: null, since: null };
    }
  };
  T.blockedBy = t => (t.dependsOn || []).map(T.task).filter(x => x && T.isOpen(x));

  /* ---------------- permissions (enforced in every API call) ---------------- */
  T.managerTeams = u => u.role === 'manager' ? (u.teams || [u.deptId]) : [];
  T.canSeeAll = u => u.role === 'super_admin' || u.role === 'dept_head';
  T.reportsTo = (emp, mgr) => emp && emp.managerId === mgr.id;
  T.canView = (u, t) => {
    if (!u || !t) return false;
    if (T.canSeeAll(u)) return true;
    if (t.ownerId === u.id || t.createdBy === u.id || t.reviewerId === u.id || (t.collaborators || []).includes(u.id)) return true;
    if ((t.approvals || []).some(a => a.approverId === u.id)) return true;
    if (u.role === 'manager') return T.managerTeams(u).includes(t.deptId) || T.reportsTo(T.user(t.ownerId), u);
    return false;
  };
  T.canManage = (u, t) => {
    if (!u || !t) return false;
    if (T.canSeeAll(u)) return true;
    if (u.role === 'manager') return t.createdBy === u.id || T.managerTeams(u).includes(t.deptId) || T.reportsTo(T.user(t.ownerId), u);
    return false;
  };
  T.canCreate = u => u && u.role !== 'employee';
  /* Validate approval steps: up to 5, each with an active approver who is not the assignee. */
  T.cleanApprovals = (steps, ownerId) => {
    if (!Array.isArray(steps)) return [];
    const out = steps.filter(s => s && s.approverId).slice(0, 5).map((s, i) => {
      const u = T.user(s.approverId);
      if (!u || !u.active) { const e = new Error('Select an active approver for every approval step.'); e.code = 400; throw e; }
      if (u.id === ownerId) { const e = new Error(`${u.name} is the assignee and cannot also approve the task.`); e.code = 400; throw e; }
      return { id: 's' + (i + 1), label: String(s.label || '').trim().slice(0, 60) || `Approval ${i + 1}`, approverId: u.id, status: 'waiting', requestedAt: null, decidedAt: null, note: '', by: null };
    });
    return out;
  };
  T.isOwner = (u, t) => u && t && t.ownerId === u.id;
  T.visibleTasks = u => D().tasks.filter(t => T.canView(u, t));
  T.visibleUsers = u => {
    if (T.canSeeAll(u)) return D().users.filter(x => x.active);
    if (u.role === 'manager') return D().users.filter(x => x.active && (x.id === u.id || x.managerId === u.id || (x.role === 'employee' && T.managerTeams(u).includes(x.deptId))));
    return [u];
  };
  T.assignableUsers = u => T.visibleUsers(u).filter(x => x.role === 'employee' || (T.canSeeAll(u) && x.role === 'manager'));
  T.visibleDepts = u => {
    if (T.canSeeAll(u)) return D().departments;
    if (u.role === 'manager') return D().departments.filter(d => T.managerTeams(u).includes(d.id));
    return D().departments.filter(d => d.id === u.deptId);
  };

  function deny(msg) { const e = new Error(msg || 'You are not authorised to perform this action.'); e.code = 403; throw e; }
  function need(cond, msg) { if (!cond) { const e = new Error(msg); e.code = 400; throw e; } }

  /* ---------------- audit (append-only) ---------------- */
  function audit(by, action, task, detail) {
    const at = now();
    const entry = Object.freeze({ at, by, action, taskId: task ? task.id : null, detail: detail || '' });
    D().audit.push(entry);
    if (task) task.history.push({ at, by, action, detail: detail || '' });
  }

  /* ---------------- notifications ---------------- */
  let notifySeq = 0;
  const TYPE_LABEL = {
    assigned: 'Assignment', ack_reminder: 'Acknowledgement reminder', due_24h: 'Deadline reminder', due_2h: 'Urgent reminder',
    overdue: 'Overdue notice', escalation1: 'First escalation', escalation2: 'Second escalation', reassigned: 'Reassignment',
    review: 'Review request', approved: 'Approved', reopened: 'Reopened', daily_followup: 'Daily follow-up', comment: 'Comment',
    weekly_summary: 'Weekly performance summary', monthly_kpi: 'Monthly KPI report', digest: 'Daily management digest',
    deadline_changed: 'Deadline changed', cancelled: 'Cancelled', recurring: 'Recurring task created', backup: 'Backup assignment',
    approval: 'Approval request', approval_done: 'Approvals complete', approval_rejected: 'Approval rejected', approval_reminder: 'Approval reminder'
  };
  T.notifTypeLabel = t => TYPE_LABEL[t] || t;

  /* Returns false when the dedupe key has already been sent (prevents duplicate reminders). */
  function notify(type, task, toIds, message, dedupeKey) {
    const d = D();
    if (dedupeKey && d.sentKeys[dedupeKey]) return false;
    const recipients = [...new Set(toIds.filter(Boolean))];
    if (!recipients.length) return false;
    const ch = d.settings.channels;
    const channels = [];
    if (ch.inApp) channels.push({ channel: 'in-app', status: 'delivered' });
    // Email / Teams: queued for the server delivery worker (Microsoft Graph); simulated in the standalone build.
    const ext = T.isServer() ? 'queued' : 'simulated';
    if (!T.isShared()) { // the shared team page has in-app notifications only
      if (ch.email) channels.push({ channel: 'email', status: ext });
      if (ch.teams) channels.push({ channel: 'teams', status: ext });
    }
    recipients.forEach(uid => {
      d.notifications.push({
        id: 'n' + now().toString(36) + (notifySeq++), type, taskId: task ? task.id : null, to: uid,
        at: now(), message, channels, read: false, key: dedupeKey || null
      });
    });
    if (dedupeKey) d.sentKeys[dedupeKey] = now();
    if (d.notifications.length > 3000) d.notifications.splice(0, d.notifications.length - 3000);
    return true;
  }
  T.notify = notify;
  T.mgrOf = uid => { const u = T.user(uid); return u ? u.managerId : null; };
  /* Second-level escalations and month-end reports go to department heads; when there is no
     department head (e.g. the Super Admin heads the department), they go to the Super Admin(s). */
  T.deptHeads = () => {
    const heads = D().users.filter(u => u.role === 'dept_head' && u.active).map(u => u.id);
    return heads.length ? heads : D().users.filter(u => u.role === 'super_admin' && u.active).map(u => u.id);
  };
  T.myNotifications = uid => D().notifications.filter(n => n.to === uid).sort((a, b) => b.at - a.at);

  /* ---------------- task API ---------------- */
  const commit = () => T.store.save();

  T.api = {
    createTask(actor, input) {
      if (!T.canCreate(actor)) deny('Only managers, department heads and administrators can create tasks.');
      need(input.title && input.title.trim().length >= 3, 'Task title is required (min 3 characters).');
      const owner = T.user(input.ownerId);
      need(owner && owner.active, 'Select a valid assignee.');
      need(T.assignableUsers(actor).some(u => u.id === owner.id), 'You can only assign tasks to members of your authorised teams.');
      need(Number.isFinite(input.dueAt), 'Due date and time are required.');
      const at = now();
      need(input.dueAt > at - 60e3 || input.allowPastDue, 'Due date/time must be in the future.');
      const d = D();
      const pr = T.PRIORITIES.find(p => p.id === input.priority) || T.PRIORITIES[1];
      // If owner is on leave, route to backup while preserving ownership history
      let finalOwner = owner, backupNote = '';
      if (owner.onLeave && owner.backupId) { finalOwner = T.user(owner.backupId); backupNote = ` (backup for ${owner.name}, on leave)`; }
      const approvals = T.cleanApprovals(input.approvals, finalOwner.id);
      const t = {
        id: 'T360-' + String(d.seq++).padStart(4, '0'),
        title: input.title.trim(), description: (input.description || '').trim(),
        deptId: input.deptId || finalOwner.deptId, category: input.category || 'Ad hoc', priority: pr.id,
        ownerId: finalOwner.id, createdBy: actor.id, reviewerId: input.reviewerId || actor.id,
        collaborators: input.collaborators || [],
        createdAt: at, assignedAt: at, startDate: input.startDate || T.istDateStr(at),
        dueAt: input.dueAt, originalDueAt: input.dueAt, kpiDueAt: input.dueAt,
        expectedTatHrs: Number(input.expectedTatHrs) || pr.tat,
        status: 'assigned', progress: 0, reminder: input.reminder || 'standard',
        kpi: input.kpi !== false, kpiWeight: Number(input.kpiWeight) || 1,
        externalDependency: null, dependsOn: (input.dependsOn || []).filter(id => T.task(id)),
        ackAt: null, startedAt: null, firstSubmittedAt: null, submittedAt: null, completedAt: null,
        reopenCount: 0, recurringId: input.recurringId || null, archived: false,
        comments: [], attachments: [],
        checklist: (input.checklist || []).filter(Boolean).map((text, i) => ({ id: 'c' + (i + 1), text, done: false })),
        ownership: [{ userId: finalOwner.id, from: at, to: null, reason: 'Initial assignment' + backupNote }],
        deadlineChanges: [], history: [],
        approvals, approvalLog: [], approvalRound: 0
      };
      d.tasks.push(t);
      audit(actor.id, 'created', t, `Task created and assigned to ${finalOwner.name}${backupNote}; due ${T.fmt(t.dueAt)}` +
        (approvals.length ? `; approval before submission: ${approvals.map(a => `${a.label} (${T.userName(a.approverId)})`).join(' → ')}` : ''));
      notify('assigned', t, [finalOwner.id, ...t.collaborators], `New task assigned: ${t.title} — due ${T.fmt(t.dueAt)}`, `${t.id}:assigned`);
      commit();
      return t;
    },

    updateDetails(actor, id, patch) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny();
      const changes = [];
      ['title', 'description', 'category', 'priority', 'reminder', 'expectedTatHrs', 'kpi', 'kpiWeight'].forEach(k => {
        if (patch[k] !== undefined && patch[k] !== t[k]) { changes.push(`${k}: “${t[k]}” → “${patch[k]}”`); t[k] = patch[k]; }
      });
      if (changes.length) { audit(actor.id, 'edited', t, changes.join('; ')); commit(); }
      return t;
    },

    acknowledge(actor, id) {
      const t = T.task(id); if (!T.isOwner(actor, t)) deny('Only the assignee can acknowledge.');
      need(t.status === 'assigned', 'Task is not awaiting acknowledgement.');
      t.ackAt = now(); t.status = 'acknowledged';
      audit(actor.id, 'acknowledged', t, 'Task acknowledged'); commit();
    },

    setStatus(actor, id, status, reason) {
      const t = T.task(id); if (!(T.isOwner(actor, t) || T.canManage(actor, t))) deny();
      const allowed = { in_progress: ['assigned', 'acknowledged', 'on_hold', 'reopened'], on_hold: ['acknowledged', 'in_progress', 'reopened', 'assigned'] };
      need(allowed[status] && allowed[status].includes(t.status), `Cannot move from ${T.statusLabel(t.status)} to ${T.statusLabel(status)}.`);
      if (status === 'on_hold') need(reason && reason.trim(), 'A reason is required to put a task on hold.');
      if (!t.ackAt && T.isOwner(actor, t)) t.ackAt = now();
      if (status === 'in_progress' && !t.startedAt) t.startedAt = now();
      const from = t.status; t.status = status;
      audit(actor.id, status === 'on_hold' ? 'on_hold' : 'status', t, `${T.statusLabel(from)} → ${T.statusLabel(status)}${reason ? ': ' + reason : ''}`);
      commit();
    },

    setProgress(actor, id, pct) {
      const t = T.task(id); if (!(T.isOwner(actor, t) || T.canManage(actor, t))) deny();
      need(T.isOpen(t) && t.status !== 'pending_review', 'Progress can only be updated on active tasks.');
      pct = Math.max(0, Math.min(100, Math.round(pct / 5) * 5));
      if (pct === t.progress) return;
      t.progress = pct;
      if (t.status === 'assigned' || t.status === 'acknowledged') { if (!t.ackAt) t.ackAt = now(); t.startedAt = t.startedAt || now(); t.status = 'in_progress'; }
      audit(actor.id, 'progress', t, `Progress updated to ${pct}%`); commit();
    },

    submit(actor, id, remarks) {
      const t = T.task(id); if (!T.isOwner(actor, t)) deny('Only the assignee can submit completion.');
      need(['acknowledged', 'in_progress', 'reopened', 'assigned', 'on_hold'].includes(t.status), 'Task cannot be submitted in its current state.');
      need(remarks && remarks.trim().length >= 5, 'Completion remarks are required.');
      if (T.hasApprovals(t) && !T.approvalsDone(t)) {
        const next = t.approvals.find(a => a.status !== 'approved');
        need(false, `This task needs approval before submission. Send it for approval first (next: ${next.label}, ${T.userName(next.approverId)}).`);
      }
      const blockers = T.blockedBy(t);
      need(!blockers.length, `Blocked by open dependency: ${blockers.map(b => b.id).join(', ')}`);
      const at = now(); // server-generated
      if (!t.ackAt) t.ackAt = at;
      if (!t.firstSubmittedAt) t.firstSubmittedAt = at;
      t.submittedAt = at; t.status = 'pending_review'; t.progress = 100;
      audit(actor.id, 'submitted', t, `Completion submitted: ${remarks.trim()}`);
      notify('review', t, [t.reviewerId || t.createdBy], `${actor.name} submitted “${t.title}” for review`, `${t.id}:review:${at}`);
      commit();
    },

    approve(actor, id, note) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny('Only the reviewer or manager can approve.');
      need(t.ownerId !== actor.id, 'You cannot approve your own task.');
      need(t.status === 'pending_review', 'Task is not pending review.');
      t.status = 'completed'; t.completedAt = now();
      audit(actor.id, 'approved', t, 'Approved and closed' + (note ? `: ${note}` : ''));
      notify('approved', t, [t.ownerId], `“${t.title}” was approved by ${actor.name}`, `${t.id}:approved:${t.completedAt}`);
      commit();
    },

    reopen(actor, id, reason) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny();
      need(['pending_review', 'completed'].includes(t.status), 'Only submitted or completed tasks can be reopened.');
      need(reason && reason.trim().length >= 5, 'A reason is required to reopen.');
      t.status = 'reopened'; t.reopenCount++; t.submittedAt = null; t.completedAt = null; t.progress = Math.min(t.progress, 80);
      const reapprove = T.hasApprovals(t);
      if (reapprove) t.approvals.forEach(a => { a.status = 'waiting'; a.requestedAt = null; a.decidedAt = null; a.note = ''; a.by = null; });
      audit(actor.id, 'reopened', t, `Reopened: ${reason.trim()}${reapprove ? ' (approvals must be obtained again before resubmission)' : ''}`);
      notify('reopened', t, [t.ownerId], `“${t.title}” was reopened: ${reason.trim()}`, `${t.id}:reopened:${t.reopenCount}`);
      commit();
    },

    /* Set or change the approval steps a task needs before it can be submitted. */
    setApprovals(actor, id, steps) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny('Only managers can change approval steps.');
      need(T.isOpen(t) && t.status !== 'pending_review', 'Approval steps can only be changed on active tasks.');
      need(t.status !== 'in_approval', 'Wait for the current approval to finish, or ask the assignee to withdraw it, before changing the steps.');
      const before = (t.approvals || []).map(a => `${a.label} (${T.userName(a.approverId)})`).join(' → ') || 'none';
      t.approvals = T.cleanApprovals(steps, t.ownerId);
      const after = t.approvals.map(a => `${a.label} (${T.userName(a.approverId)})`).join(' → ') || 'none';
      audit(actor.id, 'approval_steps', t, `Approval steps changed: ${before} ⇒ ${after}`); commit();
    },

    requestApproval(actor, id, note) {
      const t = T.task(id); if (!T.isOwner(actor, t)) deny('Only the assignee can send a task for approval.');
      need(T.hasApprovals(t), 'This task has no approval steps.');
      need(['assigned', 'acknowledged', 'in_progress', 'reopened', 'on_hold'].includes(t.status), 'This task cannot be sent for approval in its current state.');
      need(!T.approvalsDone(t), 'All approvals are already received — you can submit the task.');
      const at = now();
      t.approvalRound = (t.approvalRound || 0) + 1;
      t.approvals.forEach(a => { if (a.status !== 'approved') { a.status = 'waiting'; a.requestedAt = null; a.decidedAt = null; a.note = ''; a.by = null; } });
      const step = t.approvals.find(a => a.status !== 'approved');
      step.status = 'pending'; step.requestedAt = at;
      t.approvalLog = t.approvalLog || [];
      t.approvalLog.push({ round: t.approvalRound, stepId: step.id, label: step.label, approverId: step.approverId, requestedAt: at, requestedBy: actor.id, note: (note || '').trim(), decision: null, decidedAt: null });
      if (!t.ackAt) t.ackAt = at;
      if (!t.startedAt) t.startedAt = at;
      t.status = 'in_approval';
      audit(actor.id, 'approval_requested', t, `Sent for approval: ${step.label} — ${T.userName(step.approverId)}${note && note.trim() ? `. Note: ${note.trim()}` : ''}`);
      notify('approval', t, [step.approverId], `${actor.name} needs your approval on “${t.title}” (${step.label})`, `${t.id}:appr:${t.approvalRound}:${step.id}`);
      commit();
    },

    decideApproval(actor, id, decision, note) {
      const t = T.task(id); need(t, 'Task not found.');
      const step = T.currentApproval(t);
      need(step, 'This task is not waiting for an approval.');
      const onBehalf = actor.id !== step.approverId;
      if (onBehalf && actor.role !== 'super_admin') deny(`Only ${T.userName(step.approverId)} can decide this approval.`);
      need(['approve', 'reject'].includes(decision), 'Choose approve or reject.');
      if (decision === 'reject') need(note && note.trim().length >= 5, 'Give a reason when rejecting, so the assignee knows what to fix.');
      const at = now();
      step.status = decision === 'approve' ? 'approved' : 'rejected';
      step.decidedAt = at; step.by = actor.id; step.note = (note || '').trim();
      const log = [...(t.approvalLog || [])].reverse().find(e => e.stepId === step.id && !e.decidedAt);
      if (log) { log.decision = step.status; log.decidedAt = at; log.decidedBy = actor.id; log.decisionNote = step.note; }
      const who = onBehalf ? `${actor.name} on behalf of ${T.userName(step.approverId)}` : actor.name;
      if (decision === 'reject') {
        t.approvals.forEach(a => { if (a.status === 'waiting' || a.status === 'pending') a.status = 'waiting'; });
        t.status = 'in_progress';
        audit(actor.id, 'approval_rejected', t, `${step.label} rejected by ${who}: ${step.note}`);
        notify('approval_rejected', t, [t.ownerId], `${step.label} for “${t.title}” was rejected by ${actor.name}: ${step.note}`, `${t.id}:apprno:${t.approvalRound}:${step.id}`);
      } else {
        const next = t.approvals.find(a => a.status === 'waiting');
        audit(actor.id, 'approval_given', t, `${step.label} approved by ${who}${step.note ? `: ${step.note}` : ''}`);
        if (next) {
          next.status = 'pending'; next.requestedAt = at;
          t.approvalLog.push({ round: t.approvalRound, stepId: next.id, label: next.label, approverId: next.approverId, requestedAt: at, requestedBy: actor.id, note: '', decision: null, decidedAt: null });
          notify('approval', t, [next.approverId], `“${t.title}” needs your approval (${next.label}) — ${step.label} done by ${actor.name}`, `${t.id}:appr:${t.approvalRound}:${next.id}`);
        } else {
          t.status = 'in_progress';
          notify('approval_done', t, [t.ownerId], `All approvals received for “${t.title}”. You can now submit it.`, `${t.id}:approk:${t.approvalRound}`);
        }
      }
      commit();
    },

    withdrawApproval(actor, id) {
      const t = T.task(id); if (!T.isOwner(actor, t)) deny('Only the assignee can withdraw an approval request.');
      const step = T.currentApproval(t); need(step, 'This task is not waiting for an approval.');
      step.status = 'waiting'; step.requestedAt = null;
      const log = [...(t.approvalLog || [])].reverse().find(e => e.stepId === step.id && !e.decidedAt);
      if (log) { log.decision = 'withdrawn'; log.decidedAt = now(); log.decidedBy = actor.id; }
      t.status = 'in_progress';
      audit(actor.id, 'approval_withdrawn', t, `Approval request withdrawn (${step.label})`); commit();
    },

    reassign(actor, id, newOwnerId, reason, cause) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny();
      need(T.isOpen(t), 'Closed tasks cannot be reassigned.');
      const nu = T.user(newOwnerId); need(nu && nu.active, 'Select a valid new assignee.');
      need(nu.id !== t.ownerId, 'Task is already assigned to this person.');
      need(T.assignableUsers(actor).some(u => u.id === nu.id), 'New assignee is outside your authorised teams.');
      need(reason && reason.trim().length >= 5, 'A reason is required for reassignment.');
      const at = now(), old = t.ownerId;
      const cur = t.ownership[t.ownership.length - 1]; if (cur) { cur.to = at; cur.endReason = reason.trim(); cur.cause = cause || 'workload'; }
      t.ownership.push({ userId: nu.id, from: at, to: null, reason: reason.trim() });
      t.ownerId = nu.id; t.assignedAt = at; t.ackAt = null; t.startedAt = null; t.status = 'assigned';
      audit(actor.id, 'reassigned', t, `Reassigned from ${T.userName(old)} to ${nu.name} (${cause || 'workload'}): ${reason.trim()}`);
      notify('reassigned', t, [old, nu.id], `“${t.title}” reassigned from ${T.userName(old)} to ${nu.name}`, `${t.id}:reassigned:${at}`);
      commit();
    },

    changeDeadline(actor, id, newDue, reason, attribution) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny('Only managers can change deadlines.');
      need(T.isOpen(t), 'Closed tasks cannot be re-dated.');
      need(Number.isFinite(newDue) && newDue > now(), 'New deadline must be in the future.');
      need(reason && reason.trim().length >= 5, 'A reason is required for a deadline change.');
      need(['employee', 'manager', 'external'].includes(attribution), 'Select who the revision is attributable to.');
      const from = t.dueAt;
      t.deadlineChanges.push({ at: now(), by: actor.id, from, to: newDue, reason: reason.trim(), attribution });
      t.dueAt = newDue;
      // KPI fairness: only manager/external-caused revisions move the KPI deadline; employee-requested extensions keep the original.
      if (attribution !== 'employee') t.kpiDueAt = newDue;
      audit(actor.id, 'deadline_changed', t, `Deadline ${T.fmt(from)} → ${T.fmt(newDue)} (${attribution}-attributed): ${reason.trim()}`);
      notify('deadline_changed', t, [t.ownerId], `Deadline for “${t.title}” changed to ${T.fmt(newDue)}`, `${t.id}:dl:${newDue}`);
      commit();
    },

    setExternalDependency(actor, id, reason) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny('Only managers can approve external dependencies.');
      if (reason) { t.externalDependency = { reason: reason.trim(), approvedBy: actor.id, approvedAt: now() }; audit(actor.id, 'external_dependency', t, `External dependency approved: ${reason.trim()}`); }
      else { t.externalDependency = null; audit(actor.id, 'external_dependency', t, 'External dependency exclusion removed'); }
      commit();
    },

    cancel(actor, id, reason) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny();
      need(T.isOpen(t), 'Task already closed.');
      need(reason && reason.trim().length >= 5, 'A reason is required to cancel.');
      t.status = 'cancelled';
      audit(actor.id, 'cancelled', t, `Cancelled: ${reason.trim()}`);
      notify('cancelled', t, [t.ownerId], `“${t.title}” was cancelled`, `${t.id}:cancelled`);
      commit();
    },

    archive(actor, id, flag) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny();
      t.archived = !!flag; audit(actor.id, flag ? 'archived' : 'unarchived', t, flag ? 'Archived' : 'Restored from archive'); commit();
    },

    duplicate(actor, id) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny();
      const span = Math.max(t.dueAt - t.createdAt, DAY);
      return T.api.createTask(actor, {
        title: t.title + ' (copy)', description: t.description, deptId: t.deptId, category: t.category, priority: t.priority,
        ownerId: t.ownerId, dueAt: now() + span, expectedTatHrs: t.expectedTatHrs, reminder: t.reminder, kpi: t.kpi,
        kpiWeight: t.kpiWeight, checklist: t.checklist.map(c => c.text)
      });
    },

    comment(actor, id, text) {
      const t = T.task(id); if (!T.canView(actor, t)) deny();
      need(text && text.trim(), 'Comment cannot be empty.');
      const c = { id: 'm' + now().toString(36), by: actor.id, at: now(), text: text.trim() };
      t.comments.push(c);
      audit(actor.id, 'comment', t, text.trim().slice(0, 140));
      const others = [t.ownerId, t.createdBy, t.reviewerId].filter(x => x !== actor.id);
      notify('comment', t, others, `${actor.name} commented on “${t.title}”`, null);
      commit();
    },

    toggleChecklist(actor, id, itemId) {
      const t = T.task(id); if (!(T.isOwner(actor, t) || T.canManage(actor, t))) deny();
      const c = t.checklist.find(x => x.id === itemId); if (!c) return;
      c.done = !c.done; audit(actor.id, 'checklist', t, `${c.done ? 'Completed' : 'Unchecked'}: ${c.text}`); commit();
    },
    addChecklist(actor, id, text) {
      const t = T.task(id); if (!(T.isOwner(actor, t) || T.canManage(actor, t))) deny();
      need(text && text.trim(), 'Checklist item cannot be empty.');
      t.checklist.push({ id: 'c' + now().toString(36), text: text.trim(), done: false });
      audit(actor.id, 'checklist', t, `Added: ${text.trim()}`); commit();
    },
    addAttachment(actor, id, file) {
      const t = T.task(id); if (!(T.isOwner(actor, t) || T.canManage(actor, t))) deny();
      need(file && file.name, 'No file selected.');
      need(file.size <= 25 * 1024 * 1024, 'Files must be 25 MB or smaller.');
      // Demo build stores metadata only; production uploads to private object storage with signed URLs.
      t.attachments.push({ id: 'a' + now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(file.name).slice(0, 200), size: +file.size || 0, by: actor.id, at: now(), ...(file.path ? { path: file.path, mime: file.mime || '' } : {}) });
      audit(actor.id, 'attachment', t, `Attached ${file.name}`); commit();
    },
    addDependency(actor, id, depId) {
      const t = T.task(id); if (!T.canManage(actor, t)) deny();
      const dep = T.task(depId); need(dep, 'Dependency task not found.');
      need(dep.id !== t.id, 'A task cannot depend on itself.');
      need(!(dep.dependsOn || []).includes(t.id), 'Circular dependency.');
      if (!t.dependsOn.includes(dep.id)) { t.dependsOn.push(dep.id); audit(actor.id, 'dependency', t, `Now depends on ${dep.id} (${T.userName(dep.ownerId)})`); commit(); }
    },

    /* --- admin --- */
    updateSettings(actor, patch, label) {
      if (actor.role !== 'super_admin') deny('Only the Super Admin can change system settings.');
      const ALLOWED = ['companyName', 'workingDays', 'businessHours', 'holidays', 'kpiWeights', 'kpiPolicy', 'rules', 'channels'];
      const bad = Object.keys(patch || {}).filter(k => !ALLOWED.includes(k));
      need(!bad.length, `Unknown setting(s): ${bad.join(', ')}`);
      if (patch.kpiWeights) {
        const keys = ['onTime', 'completion', 'quality', 'tat', 'responsiveness'];
        need(keys.every(k => Number.isFinite(patch.kpiWeights[k]) && patch.kpiWeights[k] >= 0), 'Every KPI weight must be a non-negative number.');
        need(keys.reduce((a, k) => a + patch.kpiWeights[k], 0) === 100, 'KPI weights must total exactly 100%.');
        patch.kpiWeights = Object.fromEntries(keys.map(k => [k, patch.kpiWeights[k]]));
      }
      if (patch.workingDays) need(Array.isArray(patch.workingDays) && patch.workingDays.length && patch.workingDays.every(d => Number.isInteger(d) && d >= 0 && d <= 6), 'Invalid working days.');
      if (patch.rules) need(patch.rules.escalation2Days > patch.rules.escalation1Days, 'Second escalation must be later than the first.');
      Object.assign(D().settings, patch);
      audit(actor.id, 'settings', null, label || 'Settings updated'); commit();
    },
    saveUser(actor, u) {
      if (actor.role !== 'super_admin') deny('Only the Super Admin can manage users.');
      need(u.name && u.name.trim(), 'Name is required.');
      need(T.ROLES[u.role], 'Invalid role.');
      if (T.isServer() || T.isShared()) need(u.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(u.email), 'A valid work email is required — it is used to sign in.');
      const claudeId = typeof u.claudeId === 'string' && u.claudeId.length < 120 ? u.claudeId : null;
      const d = D();
      if (u.email) need(!d.users.some(x => x.id !== u.id && x.email && x.email.toLowerCase() === u.email.toLowerCase()), 'Another user already has this email.');
      if (u.id) need(T.user(u.id), 'User not found.');
      u = { id: u.id, name: u.name.trim(), email: (u.email || '').trim(), role: u.role, deptId: u.deptId || null, managerId: u.managerId || null, teams: Array.isArray(u.teams) ? u.teams : [], ...(u.id ? { active: u.active !== false } : {}), ...(claudeId ? { claudeId } : {}) };
      if (u.id) { const ex = T.user(u.id); Object.assign(ex, u); audit(actor.id, 'user', null, `User updated: ${u.name}`); }
      else { u.id = 'u' + (Math.max(...d.users.map(x => +x.id.slice(1))) + 1); u.active = true; u.onLeave = false; d.users.push(u); audit(actor.id, 'user', null, `User created: ${u.name} (${T.ROLES[u.role]})`); }
      commit(); return u;
    },
    saveDept(actor, name, managerId) {
      if (actor.role !== 'super_admin') deny('Only the Super Admin can manage departments.');
      name = String(name || '').trim();
      need(name.length >= 2, 'Department name is required.');
      const d = D();
      need(!d.departments.some(x => x.name.toLowerCase() === name.toLowerCase()), `A department called “${name}” already exists.`);
      const mgr = managerId ? T.user(managerId) : null;
      if (managerId) need(mgr && mgr.active && mgr.role === 'manager', 'Select a reporting manager to run this department.');
      const id = 'd' + (Math.max(0, ...d.departments.map(x => +x.id.slice(1) || 0)) + 1);
      const palette = ['#7c3aed', '#0d9488', '#ea580c', '#2563eb', '#be123c', '#65a30d'];
      const dept = { id, name: name.slice(0, 80), color: palette[d.departments.length % palette.length] };
      d.departments.push(dept);
      if (mgr) mgr.teams = [...new Set([...(mgr.teams || []), id])];
      audit(actor.id, 'department', null, `Department created: ${dept.name}${mgr ? ` (managed by ${mgr.name})` : ''}`); commit();
      return dept;
    },
    renameDept(actor, id, name) {
      if (actor.role !== 'super_admin') deny('Only the Super Admin can manage departments.');
      const dept = T.dept(id); need(dept, 'Department not found.');
      name = String(name || '').trim();
      need(name.length >= 2, 'Department name is required.');
      need(!D().departments.some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase()), `A department called “${name}” already exists.`);
      const old = dept.name; dept.name = name.slice(0, 80);
      audit(actor.id, 'department', null, `Department renamed: ${old} → ${dept.name}`); commit();
      return dept;
    },
    setLeave(actor, userId, onLeave, backupId) {
      const u = T.user(userId);
      if (!(actor.role === 'super_admin' || actor.role === 'dept_head' || (actor.role === 'manager' && u.managerId === actor.id))) deny();
      u.onLeave = !!onLeave; u.backupId = onLeave ? backupId || null : null;
      audit(actor.id, 'leave', null, onLeave ? `${u.name} on leave; backup: ${T.userName(backupId)}` : `${u.name} back from leave`);
      if (onLeave && backupId) {
        // temporary hand-over of open tasks; ownership history retained
        D().tasks.filter(t => t.ownerId === u.id && T.isOpen(t) && t.status !== 'pending_review').forEach(t => {
          const at = now(); const cur = t.ownership[t.ownership.length - 1]; cur.to = at; cur.endReason = 'Leave'; cur.cause = 'leave';
          t.ownership.push({ userId: backupId, from: at, to: null, reason: `Backup for ${u.name} (leave)`, backupFor: u.id });
          t.ownerId = backupId; t.assignedAt = at; t.status = t.status === 'assigned' ? 'assigned' : t.status;
          audit(actor.id, 'reassigned', t, `Temporarily handed to ${T.userName(backupId)} — ${u.name} on leave`);
          notify('backup', t, [backupId], `You are covering “${t.title}” while ${u.name} is on leave`, `${t.id}:backup:${at}`);
        });
      }
      commit();
    },
    saveRecurring(actor, input) {
      if (!T.canCreate(actor)) deny();
      need(input && input.title && String(input.title).trim(), 'Title is required.');
      const owner = T.user(input.ownerId);
      need(owner && owner.active, 'Select an assignee.');
      need(T.assignableUsers(actor).some(u => u.id === owner.id), 'You can only set up recurring tasks for your authorised teams.');
      need(['daily', 'weekly', 'monthly', 'quarterly', 'annual'].includes(input.frequency), 'Invalid frequency.');
      need(/^\d{2}:\d{2}$/.test(input.dueTime || ''), 'Invalid due time.');
      const pr = T.PRIORITIES.find(p => p.id === input.priority) || T.PRIORITIES[1];
      // Only these fields can be set by a user; creator, schedule state and IDs are controlled here.
      const r = {
        title: String(input.title).trim().slice(0, 160), description: String(input.description || '').slice(0, 2000),
        frequency: input.frequency, dayOfMonth: Math.min(Math.max(parseInt(input.dayOfMonth, 10) || 1, 1), 28),
        weekday: Math.min(Math.max(parseInt(input.weekday, 10) || 0, 0), 6), month: Math.min(Math.max(parseInt(input.month, 10) || 3, 1), 12),
        dueTime: input.dueTime, ownerId: owner.id, deptId: owner.deptId, priority: pr.id,
        tatHrs: Math.max(parseInt(input.tatHrs, 10) || pr.tat, 1), category: T.CATEGORIES.includes(input.category) ? input.category : 'Ad hoc',
        approvals: T.cleanApprovals(input.approvals, owner.id).map(a => ({ label: a.label, approverId: a.approverId }))
      };
      const d = D();
      if (input.id) {
        const ex = d.recurring.find(x => x.id === input.id); need(ex, 'Recurring template not found.');
        need(T.canSeeAll(actor) || ex.createdBy === actor.id || T.managerTeams(actor).includes(ex.deptId), 'You cannot edit this recurring template.');
        Object.assign(ex, r);
      } else { r.id = 'r' + (d.recurring.length + 1) + now().toString(36).slice(-3); r.createdBy = actor.id; r.active = true; r.lastKey = null; d.recurring.push(r); }
      audit(actor.id, 'recurring', null, `Recurring template saved: ${r.title} (${r.frequency})`); commit();
      T.engine.run();
    },
    toggleRecurring(actor, id) {
      if (!T.canCreate(actor)) deny();
      const r = D().recurring.find(x => x.id === id); need(r, 'Recurring template not found.');
      need(T.canSeeAll(actor) || r.createdBy === actor.id || T.managerTeams(actor).includes(r.deptId), 'You cannot change this recurring template.');
      r.active = !r.active;
      audit(actor.id, 'recurring', null, `${r.title} ${r.active ? 'activated' : 'paused'}`); commit();
    },
    markRead(actor, ids) {
      D().notifications.forEach(n => { if (n.to === actor.id && (!ids || ids.includes(n.id))) n.read = true; });
      commit();
    }
  };

  /* ---------------- recurring generation ---------------- */
  function periodFor(r, at) {
    const p = T.epochToIstParts(at);
    const ds = T.istDateStr(at);
    const mm = String(p.m).padStart(2, '0');
    switch (r.frequency) {
      case 'daily': return T.isWorkingDay(at) ? { key: ds, due: T.istToEpoch(ds, r.dueTime) } : null;
      case 'weekly': {
        const diff = ((r.weekday ?? 5) - p.dow + 7) % 7;
        const dueDay = at + diff * DAY; const dd = T.istDateStr(dueDay);
        return { key: 'W' + dd, due: T.istToEpoch(dd, r.dueTime) };
      }
      case 'monthly': case 'quarterly': case 'annual': {
        if (r.frequency === 'quarterly' && ![3, 6, 9, 12].includes(p.m)) return null;
        if (r.frequency === 'annual' && p.m !== (r.month || 3)) return null;
        const dom = Math.min(r.dayOfMonth || 1, 28);
        const dd = `${p.y}-${mm}-${String(dom).padStart(2, '0')}`;
        return { key: `${r.frequency}:${p.y}-${mm}`, due: T.istToEpoch(dd, r.dueTime) };
      }
    }
    return null;
  }

  /* ---------------- KPI ---------------- */
  T.kpiBand = s => s == null ? { label: 'No data', cls: '' } : s >= 90 ? { label: 'Excellent', cls: 'band-excellent' } : s >= 80 ? { label: 'Very good', cls: 'band-very-good' } : s >= 70 ? { label: 'Good', cls: 'band-good' } : s >= 60 ? { label: 'Needs improvement', cls: 'band-needs-improvement' } : { label: 'Critical', cls: 'band-critical' };
  T.KPI_PARAMS = [
    { key: 'onTime', label: 'On-time completion', basis: 'Tasks submitted on or before the KPI deadline ÷ tasks due in the period. Employee-requested extensions keep the original deadline.' },
    { key: 'completion', label: 'Overall completion rate', basis: 'Tasks submitted (pending review or completed) ÷ tasks due in the period.' },
    { key: 'quality', label: 'Quality / first-time acceptance', basis: 'Completed tasks never reopened ÷ completed tasks.' },
    { key: 'tat', label: 'TAT adherence', basis: 'Tasks whose actual TAT (assignment → first submission) ≤ expected TAT ÷ submitted tasks.' },
    { key: 'responsiveness', label: 'Responsiveness', basis: 'Tasks acknowledged within the acknowledgement window ÷ tasks assigned.' }
  ];

  /* Compute KPI for one employee over [from, to]. Only tasks currently owned by the employee are scored, with
   * TAT/acknowledgement measured from THEIR assignment time — previous owners are not penalised for reassigned work. */
  T.computeKpi = function (userId, from, to, weightsOverride) {
    const s = D().settings, at = now();
    const W = weightsOverride || s.kpiWeights;
    const ackWin = s.rules.ackReminderHrs * HOUR;
    const all = D().tasks.filter(t => t.ownerId === userId && t.kpi && !(s.kpiPolicy.excludeCancelled && t.status === 'cancelled'));
    const base = all.filter(t => t.kpiDueAt >= from && t.kpiDueAt <= to);
    const due = base.filter(t => t.kpiDueAt <= at || t.firstSubmittedAt);
    const extOk = t => !(s.kpiPolicy.excludeExternal && t.externalDependency);
    const wsum = (arr) => arr.reduce((a, t) => a + (t.kpiWeight || 1), 0);
    const ratio = (num, den) => den.length ? { value: 100 * wsum(num) / wsum(den), num: num.length, den: den.length } : { value: null, num: 0, den: 0 };

    const dueTimely = due.filter(extOk);
    const onTime = ratio(dueTimely.filter(T.submittedOnTime), dueTimely);
    const completion = ratio(due.filter(T.isSubmitted), due);
    const completed = base.filter(t => t.status === 'completed');
    const quality = ratio(completed.filter(t => t.reopenCount === 0), completed);
    const subm = base.filter(t => t.firstSubmittedAt && t.expectedTatHrs && extOk(t));
    const tat = ratio(subm.filter(t => T.actualTatHrs(t) <= t.expectedTatHrs), subm);
    const ackBase = base.filter(t => t.ackAt || at - t.assignedAt > ackWin);
    const responsiveness = ratio(ackBase.filter(t => t.ackAt && t.ackAt - t.assignedAt <= ackWin), ackBase);

    const metrics = { onTime, completion, quality, tat, responsiveness };
    let num = 0, wTot = 0;
    Object.keys(metrics).forEach(k => { if (metrics[k].value != null && W[k] > 0) { num += metrics[k].value * W[k]; wTot += W[k]; } });
    const score = wTot ? num / wTot : null; // weights re-normalised when a parameter has no data
    const late = due.filter(t => !t.firstSubmittedAt ? t.kpiDueAt < at : !T.submittedOnTime(t));
    const delays = { employee: 0, manager: 0, external: 0 };
    late.forEach(t => { if (t.externalDependency) delays.external++; else delays.employee++; });
    base.forEach(t => t.deadlineChanges.forEach(c => { if (c.attribution === 'manager') delays.manager++; }));
    return {
      userId, metrics, score, band: T.kpiBand(score),
      counts: { total: base.length, due: due.length, completed: completed.length, open: base.filter(T.isOpen).length, overdue: base.filter(t => T.isOverdue(t)).length, reopened: base.filter(t => t.reopenCount > 0).length, external: base.filter(t => t.externalDependency).length },
      delays, tasks: base
    };
  };
  T.monthRange = (offset = 0) => {
    const p = T.epochToIstParts(now());
    let y = p.y, m = p.m + offset; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; }
    const from = T.istToEpoch(`${y}-${String(m).padStart(2, '0')}-01`, '00:00');
    let ny = y, nm = m + 1; if (nm > 12) { nm = 1; ny++; }
    const to = T.istToEpoch(`${ny}-${String(nm).padStart(2, '0')}-01`, '00:00') - 1;
    return { from, to, label: new Date(from + 6 * HOUR).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) };
  };

  /* ---------------- automation engine (server cron in production) ---------------- */
  T.engine = {
    lastRun: null,
    run() {
      const d = D(), s = d.settings, R = s.rules, at = now();
      let sent = 0;
      const send = (...a) => { if (notify(...a)) sent++; };
      const todayStr = T.istDateStr(at), hm = T.istTimeStr(at), workday = T.isWorkingDay(at);

      // 1. recurring task generation
      d.recurring.filter(r => r.active).forEach(r => {
        const per = periodFor(r, at);
        if (!per || r.lastKey === per.key) return;
        const owner = T.user(r.ownerId), creator = T.user(r.createdBy) || d.users.find(u => u.role === 'super_admin');
        if (!owner) return;
        r.lastKey = per.key;
        try {
          const t = T.api.createTask(creator, { title: `${r.title} — ${per.key.replace(/^(W|monthly:|quarterly:|annual:)/, '')}`, description: r.description || `Recurring ${r.frequency} activity.`, deptId: r.deptId, category: r.category, priority: r.priority, ownerId: r.ownerId, dueAt: per.due, expectedTatHrs: r.tatHrs, recurringId: r.id, allowPastDue: true, reminder: 'standard', approvals: r.approvals || [] });
          d.audit.push(Object.freeze({ at, by: 'system', action: 'recurring', taskId: t.id, detail: `Generated from recurring template ${r.id}` }));
        } catch (e) { console.warn('Recurring generation failed', r.id, e.message); }
      });

      // 2. per-task reminders and escalations — stop automatically once completed / cancelled / submitted
      d.tasks.forEach(t => {
        if (!T.isOpen(t) || t.status === 'pending_review' || t.archived) return;
        const left = t.dueAt - at;
        const pend = T.currentApproval(t);
        if (pend && pend.requestedAt && at - pend.requestedAt > R.ackReminderHrs * HOUR)
          send('approval_reminder', t, [pend.approverId], `Reminder: “${t.title}” is waiting for your approval (${pend.label}) since ${T.fmt(pend.requestedAt)}`, `${t.id}:apprrem:${t.approvalRound}:${pend.id}`);
        if (t.status === 'assigned' && at - t.assignedAt > R.ackReminderHrs * HOUR)
          send('ack_reminder', t, [t.ownerId], `Please acknowledge “${t.title}” (assigned ${T.fmt(t.assignedAt)})`, `${t.id}:ack:${t.assignedAt}`);
        if (left > 0 && left <= R.urgentReminderHrs * HOUR)
          send('due_2h', t, [t.ownerId], `URGENT: “${t.title}” is due at ${T.fmtTime(t.dueAt)}`, `${t.id}:2h:${t.dueAt}`);
        else if (left > 0 && left <= R.dueReminderHrs * HOUR)
          send('due_24h', t, [t.ownerId], `Reminder: “${t.title}” is due ${T.fmt(t.dueAt)}`, `${t.id}:24h:${t.dueAt}`);
        if (left <= 0) {
          send('overdue', t, [t.ownerId], `OVERDUE: “${t.title}” was due ${T.fmt(t.dueAt)}`, `${t.id}:overdue:${t.dueAt}`);
          const od = T.workingDaysBetween(t.dueAt, at);
          if (od >= R.escalation1Days) send('escalation1', t, [T.mgrOf(t.ownerId) || t.createdBy], `Escalation: “${t.title}” (${T.userName(t.ownerId)}) is overdue by ${od} working day(s)`, `${t.id}:esc1:${t.dueAt}`);
          if (od >= R.escalation2Days) send('escalation2', t, T.deptHeads(), `Second escalation: “${t.title}” (${T.userName(t.ownerId)}, ${T.deptName(t.deptId)}) overdue by ${od} working days`, `${t.id}:esc2:${t.dueAt}`);
        }
        if (t.reminder === 'daily' && workday && hm >= R.dailyFollowUpTime)
          send('daily_followup', t, [t.ownerId], `Daily follow-up: “${t.title}” — ${t.progress}% done, due ${T.fmt(t.dueAt)}`, `${t.id}:daily:${todayStr}`);
      });

      // 3. digests and periodic reports
      const managers = d.users.filter(u => u.active && (u.role === 'manager' || u.role === 'dept_head' || u.role === 'super_admin'));
      if (workday && hm >= R.digestTime) managers.forEach(m => {
        const vis = T.visibleTasks(m).filter(t => !t.archived);
        const od = vis.filter(t => T.isOverdue(t)).length, today = vis.filter(T.dueToday).length, crit = vis.filter(t => T.isOpen(t) && t.priority === 'critical').length, rev = vis.filter(t => t.status === 'pending_review').length;
        send('digest', null, [m.id], `Morning digest — ${od} overdue, ${today} due today, ${crit} critical open, ${rev} awaiting your approval`, `digest:${m.id}:${todayStr}`);
      });
      if (T.epochToIstParts(at).dow === 1 && hm >= R.digestTime) managers.forEach(m => {
        send('weekly_summary', null, [m.id], 'Weekly performance summary is ready — open Reports & Analytics', `weekly:${m.id}:${todayStr}`);
      });
      const tomorrow = at + DAY;
      if (T.epochToIstParts(tomorrow).m !== T.epochToIstParts(at).m && hm >= '17:00') {
        send('monthly_kpi', null, T.deptHeads(), `Monthly KPI report for ${T.monthRange(0).label} is ready`, `monthly:${todayStr.slice(0, 7)}`);
      }

      this.lastRun = at;
      T.store.save();
      return sent;
    }
  };

  /* ---------------- formatting (IST) ---------------- */
  const fmtDT = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  const fmtD = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const fmtT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
  T.fmt = ms => ms ? fmtDT.format(ms) : '—';
  T.fmtDate = ms => ms ? fmtD.format(ms) : '—';
  T.fmtTime = ms => ms ? fmtT.format(ms) : '—';
  T.fmtHrs = h => h == null ? '—' : h < 24 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
  T.rel = ms => {
    const diff = ms - now(), a = Math.abs(diff);
    const v = a < HOUR ? `${Math.round(a / 60e3)} min` : a < DAY ? `${Math.round(a / HOUR)} h` : `${Math.round(a / DAY)} d`;
    return diff >= 0 ? `in ${v}` : `${v} ago`;
  };
})(window.T360);
