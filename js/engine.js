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
  T.actualTatHrs = t => t.firstSubmittedAt ? (t.firstSubmittedAt - t.assignedAt) / HOUR : null;
  T.blockedBy = t => (t.dependsOn || []).map(T.task).filter(x => x && T.isOpen(x));

  /* ---------------- permissions (enforced in every API call) ---------------- */
  T.managerTeams = u => u.role === 'manager' ? (u.teams || [u.deptId]) : [];
  T.canSeeAll = u => u.role === 'super_admin' || u.role === 'dept_head';
  T.reportsTo = (emp, mgr) => emp && emp.managerId === mgr.id;
  T.canView = (u, t) => {
    if (!u || !t) return false;
    if (T.canSeeAll(u)) return true;
    if (t.ownerId === u.id || t.createdBy === u.id || t.reviewerId === u.id || (t.collaborators || []).includes(u.id)) return true;
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
    deadline_changed: 'Deadline changed', cancelled: 'Cancelled', recurring: 'Recurring task created', backup: 'Backup assignment'
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
    // Email / Teams require the server connector (Microsoft Graph); in this standalone build they are logged as simulated.
    if (ch.email) channels.push({ channel: 'email', status: 'simulated' });
    if (ch.teams) channels.push({ channel: 'teams', status: 'simulated' });
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
  T.deptHeads = () => D().users.filter(u => u.role === 'dept_head' && u.active).map(u => u.id);
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
        deadlineChanges: [], history: []
      };
      d.tasks.push(t);
      audit(actor.id, 'created', t, `Task created and assigned to ${finalOwner.name}${backupNote}; due ${T.fmt(t.dueAt)}`);
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
      audit(actor.id, 'reopened', t, `Reopened: ${reason.trim()}`);
      notify('reopened', t, [t.ownerId], `“${t.title}” was reopened: ${reason.trim()}`, `${t.id}:reopened:${t.reopenCount}`);
      commit();
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
      t.attachments.push({ id: 'a' + now().toString(36), name: file.name, size: file.size, by: actor.id, at: now() });
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
      Object.assign(D().settings, patch);
      audit(actor.id, 'settings', null, label || 'Settings updated'); commit();
    },
    saveUser(actor, u) {
      if (actor.role !== 'super_admin') deny('Only the Super Admin can manage users.');
      need(u.name && u.name.trim(), 'Name is required.');
      need(T.ROLES[u.role], 'Invalid role.');
      const d = D();
      if (u.id) { const ex = T.user(u.id); Object.assign(ex, u); audit(actor.id, 'user', null, `User updated: ${u.name}`); }
      else { u.id = 'u' + (Math.max(...d.users.map(x => +x.id.slice(1))) + 1); u.active = true; u.onLeave = false; d.users.push(u); audit(actor.id, 'user', null, `User created: ${u.name} (${T.ROLES[u.role]})`); }
      commit(); return u;
    },
    saveDept(actor, name) {
      if (actor.role !== 'super_admin') deny('Only the Super Admin can manage departments.');
      need(name && name.trim(), 'Department name is required.');
      const d = D(); const id = 'd' + (Math.max(...d.departments.map(x => +x.id.slice(1))) + 1);
      const palette = ['#7c3aed', '#0d9488', '#ea580c', '#2563eb', '#be123c'];
      d.departments.push({ id, name: name.trim(), color: palette[d.departments.length % palette.length] });
      audit(actor.id, 'department', null, `Department created: ${name.trim()}`); commit();
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
    saveRecurring(actor, r) {
      if (!T.canCreate(actor)) deny();
      need(r.title && r.title.trim(), 'Title is required.');
      need(T.user(r.ownerId), 'Select an assignee.');
      const d = D();
      if (r.id) Object.assign(d.recurring.find(x => x.id === r.id), r);
      else { r.id = 'r' + (d.recurring.length + 1) + now().toString(36).slice(-3); r.createdBy = actor.id; r.active = true; r.lastKey = null; d.recurring.push(r); }
      audit(actor.id, 'recurring', null, `Recurring template saved: ${r.title} (${r.frequency})`); commit();
      T.engine.run();
    },
    toggleRecurring(actor, id) {
      if (!T.canCreate(actor)) deny();
      const r = D().recurring.find(x => x.id === id); r.active = !r.active;
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
    const onTime = ratio(dueTimely.filter(t => t.firstSubmittedAt && t.firstSubmittedAt <= t.kpiDueAt), dueTimely);
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
    const late = due.filter(t => !t.firstSubmittedAt ? t.kpiDueAt < at : t.firstSubmittedAt > t.kpiDueAt);
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
          const t = T.api.createTask(creator, { title: `${r.title} — ${per.key.replace(/^(W|monthly:|quarterly:|annual:)/, '')}`, description: r.description || `Recurring ${r.frequency} activity.`, deptId: r.deptId, category: r.category, priority: r.priority, ownerId: r.ownerId, dueAt: per.due, expectedTatHrs: r.tatHrs, recurringId: r.id, allowPastDue: true, reminder: 'standard' });
          d.audit.push(Object.freeze({ at, by: 'system', action: 'recurring', taskId: t.id, detail: `Generated from recurring template ${r.id}` }));
        } catch (e) { console.warn('Recurring generation failed', r.id, e.message); }
      });

      // 2. per-task reminders and escalations — stop automatically once completed / cancelled / submitted
      d.tasks.forEach(t => {
        if (!T.isOpen(t) || t.status === 'pending_review' || t.archived) return;
        const left = t.dueAt - at;
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
      const managers = d.users.filter(u => u.active && (u.role === 'manager' || u.role === 'dept_head'));
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
