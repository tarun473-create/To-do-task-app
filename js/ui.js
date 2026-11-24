/* Task360 — shared UI helpers and components (task table, drawer, modals). */
(function (T) {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  T.$ = $; T.$$ = $$;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  T.esc = esc;

  T.ui = {};
  const U = T.ui;

  U.toast = (msg, err) => {
    const el = document.createElement('div'); el.className = 'toast' + (err ? ' err' : ''); el.textContent = msg;
    $('#toasts').appendChild(el); setTimeout(() => el.remove(), err ? 5000 : 3000);
  };
  /* Run an API call and surface validation / permission errors. */
  U.act = (fn, okMsg) => {
    /* Always returns a Promise: actions are synchronous in the standalone build and
       go over the network (server-validated) in the server edition. */
    return Promise.resolve().then(fn)
      .then(r => { if (okMsg) U.toast(okMsg); T.app.refresh(); return r ?? true; })
      .catch(e => { U.toast(e.message, true); return false; });
  };

  const COLORS = ['#4f46e5', '#0891b2', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#0d9488', '#ea580c', '#2563eb', '#be123c', '#65a30d', '#9333ea', '#0284c7'];
  U.avatar = (uid, withName = true) => {
    const u = T.user(uid); if (!u) return '—';
    const ini = u.name.split(' ').map(x => x[0]).slice(0, 2).join('');
    const c = COLORS[(+uid.slice(1)) % COLORS.length];
    return `<span class="who"><span class="avatar" style="background:${c}">${esc(ini)}</span>${withName ? esc(u.name) : ''}</span>`;
  };
  U.status = t => `<span class="pill s-${t.status}">${esc(T.statusLabel(t.status))}</span>` + (T.isOverdue(t) ? ` <span class="pill flag-overdue" title="Overdue flag">Overdue${T.overdueDays(t) ? ' ' + T.overdueDays(t) + 'd' : ''}</span>` : '');
  U.priority = p => `<span class="pill p-${p}">${esc(T.priorityLabel(p))}</span>`;
  U.progress = p => `<span class="progress"><i style="width:${p}%"></i></span> <span class="small muted">${p}%</span>`;
  U.statusColor = { assigned: '#64748b', acknowledged: '#0284c7', in_progress: '#4f46e5', on_hold: '#d97706', pending_review: '#7c3aed', in_approval: '#0f766e', completed: '#16a34a', reopened: '#dc2626', cancelled: '#94a3b8', overdue: '#dc2626' };

  /* ---------- donut chart (SVG) ---------- */
  U.donut = (segments, size = 170) => {
    const total = segments.reduce((a, s) => a + s.value, 0) || 1;
    const r = size / 2, ir = r * .62; let a0 = -Math.PI / 2;
    const paths = segments.filter(s => s.value > 0).map(s => {
      const a1 = a0 + (s.value / total) * Math.PI * 2 - 0.0001;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const p = (rad, ang) => `${r + rad * Math.cos(ang)},${r + rad * Math.sin(ang)}`;
      const d = `M${p(r, a0)} A${r},${r} 0 ${large} 1 ${p(r, a1)} L${p(ir, a1)} A${ir},${ir} 0 ${large} 0 ${p(ir, a0)} Z`;
      a0 = a1 + 0.0001;
      return `<path d="${d}" fill="${s.color}" data-go="${esc(s.go)}"><title>${esc(s.label)}: ${s.value}</title></path>`;
    }).join('');
    return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Status distribution">${paths}
      <text x="50%" y="48%" text-anchor="middle" font-size="24" font-weight="700" fill="currentColor">${total === 1 && !segments.some(s => s.value) ? 0 : total}</text>
      <text x="50%" y="62%" text-anchor="middle" font-size="11" fill="currentColor" opacity=".6">tasks</text></svg>`;
  };

  /* ---------- workflow helpers ---------- */
  U.since = ms => {
    if (!ms) return '';
    const h = (Date.now() - ms) / T.HOUR;
    return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
  };
  U.stageLine = t => {
    if (!T.isOpen(t)) return '';
    const s = T.stageOf(t);
    return `<div class="stage-line">${esc(s.stage)}${s.waitingOn ? ` · waiting on ${esc(T.userName(s.waitingOn))}` : ''}${s.since ? ` · ${U.since(s.since)}` : ''}</div>`;
  };
  /* Full workflow of one task: every stage, who, when, and where it is now. */
  U.workflow = t => {
    const steps = [];
    const st = t.status, closed = st === 'completed', cancelled = st === 'cancelled';
    const appr = t.approvals || [];
    const reached = { ack: !!t.ackAt, work: !!(t.startedAt || t.ackAt), approvals: T.approvalsDone(t) || !!t.firstSubmittedAt && !appr.length, submitted: ['pending_review', 'completed'].includes(st) };
    steps.push({ cls: 'done', title: 'Assigned', meta: `${T.userName(t.createdBy)} → ${T.userName(t.ownerId)} · ${T.fmt(t.assignedAt)}` });
    steps.push({ cls: t.ackAt ? 'done' : st === 'assigned' ? 'now' : 'todo', title: 'Acknowledged', meta: t.ackAt ? `${T.fmt(t.ackAt)}` : `Waiting on ${T.userName(t.ownerId)}` });
    const working = ['acknowledged', 'in_progress', 'reopened', 'on_hold'].includes(st) && !(T.hasApprovals(t) && T.approvalsDone(t));
    steps.push({ cls: reached.submitted || st === 'in_approval' || T.approvalsDone(t) ? 'done' : working ? 'now' : 'todo',
      title: st === 'on_hold' ? 'Work (on hold)' : st === 'reopened' ? 'Rework after review' : 'Work in progress',
      meta: `${t.progress}% done${t.startedAt ? ` · started ${T.fmt(t.startedAt)}` : ''}` });
    appr.forEach(a => {
      const cls = a.status === 'approved' ? 'done' : a.status === 'pending' ? 'now' : a.status === 'rejected' ? 'bad' : 'todo';
      const meta = a.status === 'approved' ? `Approved by ${T.userName(a.by || a.approverId)} · ${T.fmt(a.decidedAt)}${a.note ? ` · “${a.note}”` : ''}`
        : a.status === 'pending' ? `Waiting on ${T.userName(a.approverId)} since ${T.fmt(a.requestedAt)} (${U.since(a.requestedAt)})`
        : a.status === 'rejected' ? `Rejected by ${T.userName(a.by || a.approverId)} · ${T.fmt(a.decidedAt)} · “${a.note}”`
        : `Approver: ${T.userName(a.approverId)}`;
      steps.push({ cls, title: `Approval: ${a.label}`, meta });
    });
    if (appr.length && T.approvalsDone(t) && !reached.submitted && T.isOpen(t)) steps.push({ cls: 'now', title: 'Ready to submit', meta: `All approvals received · waiting on ${T.userName(t.ownerId)}` });
    steps.push({ cls: reached.submitted ? 'done' : 'todo', title: 'Submitted for final review', meta: t.submittedAt ? T.fmt(t.submittedAt) : t.firstSubmittedAt ? `First submitted ${T.fmt(t.firstSubmittedAt)}` : '—' });
    steps.push({ cls: closed ? 'done' : st === 'pending_review' ? 'now' : cancelled ? 'bad' : 'todo', title: cancelled ? 'Cancelled' : 'Reviewed & closed',
      meta: closed ? `${T.userName(t.reviewerId || t.createdBy)} · ${T.fmt(t.completedAt)}` : st === 'pending_review' ? `Waiting on ${T.userName(t.reviewerId || t.createdBy)} since ${T.fmt(t.submittedAt)}` : `Reviewer: ${T.userName(t.reviewerId || t.createdBy)}` });
    const s = T.stageOf(t);
    const icon = c => c === 'done' ? '✓' : c === 'bad' ? '✕' : c === 'now' ? '●' : '';
    return `${T.isOpen(t) ? `<div class="now-box"><b>Now:</b> ${esc(s.stage)}${s.waitingOn ? ` — waiting on <b>${esc(T.userName(s.waitingOn))}</b>` : ''}${s.since ? ` for ${U.since(s.since)}` : ''}</div>` : ''}
      <ol class="flow">${steps.map(x => `<li class="${x.cls}"><span class="dotx">${icon(x.cls)}</span><div><div class="st-title">${esc(x.title)}</div><div class="st-meta">${esc(x.meta)}</div></div></li>`).join('')}</ol>`;
  };
  U.approvalLog = t => {
    const log = t.approvalLog || [];
    if (!log.length) return '<div class="muted small">No approval requests yet.</div>';
    return `<div class="table-wrap"><table><thead><tr><th>Round</th><th>Step</th><th>Approver</th><th>Requested</th><th>Decision</th><th>Note</th></tr></thead><tbody>${log.map(e => `<tr>
      <td>${e.round}</td><td class="small">${esc(e.label)}</td><td class="small nowrap">${esc(T.userName(e.approverId))}</td><td class="small nowrap">${T.fmt(e.requestedAt)}</td>
      <td class="small nowrap">${e.decision ? `<span class="pill ${e.decision === 'approved' ? 's-completed' : e.decision === 'rejected' ? 's-reopened' : 's-assigned'}">${esc(e.decision)}</span> ${T.fmt(e.decidedAt)}${e.decidedBy && e.decidedBy !== e.approverId ? ` by ${esc(T.userName(e.decidedBy))}` : ''}` : '<span class="pill s-in_approval">pending</span>'}</td>
      <td class="small">${esc([e.note, e.decisionNote].filter(Boolean).join(' / '))}</td></tr>`).join('')}</tbody></table></div>`;
  };
  /* Approval-steps editor used by the create form, the recurring form and "Approval steps". */
  U.approvalEditor = (steps, excludeId) => {
    const people = T.store.data.users.filter(u => u.active && u.id !== excludeId);
    const row = (s, i) => `<div class="appr-row" data-appr-row>
      <input class="input" data-appr-label placeholder="Step name, e.g. Checker review" value="${esc(s.label || '')}" maxlength="60">
      <select class="input" data-appr-user><option value="">— approver —</option>${people.map(u => `<option value="${u.id}" ${s.approverId === u.id ? 'selected' : ''}>${esc(u.name)} (${T.ROLES[u.role]})</option>`).join('')}</select>
      <button type="button" class="btn sm" data-appr-del title="Remove step">✕</button></div>`;
    return `<div data-appr-box>${(steps.length ? steps : [{}]).map(row).join('')}</div>
      <button type="button" class="btn sm" data-appr-add>＋ Add approval step</button>
      <div class="small muted" style="margin-top:6px">Approvals happen in this order. The assignee can submit only after every step is approved.</div>
      <template data-appr-tpl>${row({}, 0)}</template>`;
  };
  U.wireApprovalEditor = root => {
    const box = $('[data-appr-box]', root);
    const wireDel = () => $$('[data-appr-del]', root).forEach(b => b.onclick = () => { if ($$('[data-appr-row]', root).length > 1) b.closest('[data-appr-row]').remove(); else { b.closest('[data-appr-row]').querySelector('select').value = ''; } });
    $('[data-appr-add]', root).onclick = () => { if ($$('[data-appr-row]', root).length >= 5) return U.toast('Up to 5 approval steps.', true); box.insertAdjacentHTML('beforeend', $('[data-appr-tpl]', root).innerHTML); wireDel(); };
    wireDel();
  };
  U.readApprovals = root => $$('[data-appr-row]', root).map(r => ({ label: $('[data-appr-label]', r).value.trim(), approverId: $('[data-appr-user]', r).value })).filter(s => s.approverId);

  /* ---------- task table ---------- */
  U.taskTable = (tasks, opts = {}) => {
    if (!tasks.length) return `<div class="empty">No tasks match the current filters.</div>`;
    const rows = tasks.map(t => `<tr class="click" data-task="${t.id}">
      <td><div class="task-title">${esc(t.title)}</div><div class="tid">${t.id}${t.closeRef ? ` · 📘 ${esc(T.periodLabel(t.closeRef.period))} close` : ''}${t.recurringId ? ' · ↻ recurring' : ''}${t.dependsOn.length ? ' · ⛓ dependency' : ''}${t.archived ? ' · archived' : ''}</div></td>
      <td>${U.avatar(t.ownerId)}</td>
      <td class="nowrap">${esc(T.deptName(t.deptId))}</td>
      <td>${U.priority(t.priority)}</td>
      <td>${U.status(t)}${U.stageLine(t)}</td>
      <td class="nowrap"><div>${T.fmt(t.dueAt)}</div>${t.dueAt !== t.originalDueAt ? `<div class="small muted">orig. ${T.fmtDate(t.originalDueAt)}</div>` : ''}</td>
      <td class="nowrap">${U.progress(t.progress)}</td>
      ${opts.hideAge ? '' : `<td class="right">${T.ageDays(t)}d</td>`}
    </tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>
      <th class="sortable" data-sort="title">Task</th><th class="sortable" data-sort="owner">Assignee</th><th class="sortable" data-sort="dept">Department</th>
      <th class="sortable" data-sort="priority">Priority</th><th class="sortable" data-sort="status">Status</th><th class="sortable" data-sort="due">Due (IST)</th>
      <th class="sortable" data-sort="progress">Progress</th>${opts.hideAge ? '' : '<th class="sortable right" data-sort="age">Age</th>'}
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  };
  const PRI_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
  U.sortTasks = (tasks, key, dir = 1) => {
    const f = {
      title: t => t.title.toLowerCase(), owner: t => T.userName(t.ownerId), dept: t => T.deptName(t.deptId),
      priority: t => PRI_ORDER[t.priority], status: t => (T.isOverdue(t) ? '0' : '1') + t.status, due: t => t.dueAt, progress: t => t.progress, age: t => T.ageDays(t)
    }[key] || (t => t.dueAt);
    return [...tasks].sort((a, b) => { const x = f(a), y = f(b); return (x > y ? 1 : x < y ? -1 : 0) * dir; });
  };

  /* ---------- layers ---------- */
  U.closeLayer = () => { $('#layer').innerHTML = ''; document.body.style.overflow = ''; U.currentTask = null; };
  U.modal = (title, body, foot, onMount) => {
    $('#layer').innerHTML = `<div class="overlay" data-close></div><div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="close-x" data-close aria-label="Close">×</button></div>
      <div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
    $$('#layer [data-close]').forEach(b => b.onclick = U.closeLayer);
    const first = $('#layer .modal input, #layer .modal textarea, #layer .modal select'); if (first) first.focus();
    if (onMount) onMount($('#layer .modal'));
  };
  /* Prompt for a mandatory reason (plus optional extra fields). */
  U.reasonPrompt = (title, label, extraHtml, onOk) => {
    U.modal(title, `${extraHtml || ''}<label class="field"><span>${esc(label)} *</span><textarea class="input" id="rp-reason" placeholder="Required — recorded in the audit trail"></textarea></label>`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rp-ok">Confirm</button>`, m => {
        $$('[data-close]', m).forEach(b => b.onclick = U.closeLayer);
        $('#rp-ok').onclick = () => { if (onOk($('#rp-reason').value, m) !== false) {} };
      });
  };

  /* ---------- create task modal ---------- */
  U.workloadHint = uid => {
    const open = T.store.data.tasks.filter(t => t.ownerId === uid && T.isOpen(t));
    const od = open.filter(t => T.isOverdue(t)).length, crit = open.filter(t => t.priority === 'critical').length;
    const u = T.user(uid);
    const level = open.length >= 10 || od >= 3 ? 'warn' : '';
    return `<div class="workload-hint ${level ? 'alert warn' : ''}">Workload: <b>${open.length}</b> active · <b style="color:var(--danger)">${od}</b> overdue · ${crit} critical${u && u.onLeave ? ` · <b>On leave</b> → backup ${esc(T.userName(u.backupId))}` : ''}${level ? ' — consider another assignee' : ''}</div>`;
  };
  U.openCreate = (preset = {}) => {
    const me = T.app.me();
    if (!T.canCreate(me)) return U.toast('Employees cannot create tasks. Switch to a manager to assign work.', true);
    const users = T.assignableUsers(me), depts = T.visibleDepts(me);
    const tomorrow = T.istDateStr(Date.now() + T.DAY);
    const openTasks = T.visibleTasks(me).filter(T.isOpen);
    U.modal('Create new task', `
      <label class="field"><span>Task title *</span><input class="input" id="ct-title" maxlength="160" placeholder="e.g. GST input credit reconciliation — October" value="${esc(preset.title || '')}"></label>
      <label class="field"><span>Task description</span><textarea class="input" id="ct-desc" placeholder="Scope, expected output, where to save evidence"></textarea></label>
      <div class="grid2">
        <label class="field"><span>Department</span><select class="input" id="ct-dept">${depts.map(d => `<option value="${d.id}" ${preset.deptId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Category</span><select class="input" id="ct-cat">${T.CATEGORIES.map(c => `<option>${esc(c)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Assign to *</span><select class="input" id="ct-owner"></select></label>
      <div id="ct-hint"></div>
      <div class="grid3">
        <label class="field"><span>Start date</span><input class="input" type="date" id="ct-start" value="${T.istDateStr(Date.now())}"></label>
        <label class="field"><span>Due date *</span><input class="input" type="date" id="ct-date" value="${preset.date || tomorrow}"></label>
        <label class="field"><span>Due time (IST) *</span><input class="input" type="time" id="ct-time" value="18:00"></label>
      </div>
      <label class="field"><span>Priority</span><div class="seg" id="ct-pri">${T.PRIORITIES.map(p => `<button type="button" data-p="${p.id}" class="${p.id === 'medium' ? 'on' : ''}">${p.label}</button>`).join('')}</div></label>
      <div class="grid3">
        <label class="field"><span>Expected TAT (hours)</span><input class="input" type="number" min="1" id="ct-tat" value="48"></label>
        <label class="field"><span>KPI weight</span><select class="input" id="ct-w"><option value="1">1 — normal</option><option value="2">2 — important</option><option value="3">3 — key deliverable</option></select></label>
        <label class="field"><span>Automatic follow-up</span><select class="input" id="ct-rem">${T.REMINDERS.map(r => `<option value="${r.id}">${esc(r.label)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Depends on (optional)</span><select class="input" id="ct-dep"><option value="">— none —</option>${openTasks.slice(0, 200).map(t => `<option value="${t.id}">${t.id} · ${esc(t.title)} (${esc(T.userName(t.ownerId))})</option>`).join('')}</select></label>
      <label class="field"><span>Checklist (one item per line)</span><textarea class="input" id="ct-check" placeholder="Collect data&#10;Prepare workings&#10;Upload evidence"></textarea></label>
      <label class="check"><input type="checkbox" id="ct-appr-on"> Requires approval before submission</label>
      <div id="ct-appr" class="hidden" style="margin:-4px 0 14px">${U.approvalEditor([], null)}</div>
      <label class="check"><input type="checkbox" id="ct-kpi" checked> Include task in employee KPI</label>
    `, `<button class="btn" data-close>Cancel</button><button class="btn primary" id="ct-go">Create &amp; assign task</button>`, m => {
      $$('[data-close]', m).forEach(b => b.onclick = U.closeLayer);
      const fillOwners = () => {
        const dept = $('#ct-dept').value;
        const list = users.filter(u => T.userDepts(u).includes(dept));
        const rest = users.filter(u => !list.includes(u));
        $('#ct-owner').innerHTML = list.map(u => `<option value="${u.id}">${esc(u.name)}${u.onLeave ? ' (on leave)' : ''}</option>`).join('') +
          (rest.length ? `<optgroup label="Other teams">${rest.map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(T.deptNames(u))}</option>`).join('')}</optgroup>` : '');
        if (preset.ownerId) $('#ct-owner').value = preset.ownerId;
        $('#ct-hint').innerHTML = U.workloadHint($('#ct-owner').value);
      };
      $('#ct-dept').onchange = fillOwners; fillOwners();
      U.wireApprovalEditor($('#ct-appr'));
      $('#ct-appr-on').onchange = e => $('#ct-appr').classList.toggle('hidden', !e.target.checked);
      $('#ct-owner').onchange = () => $('#ct-hint').innerHTML = U.workloadHint($('#ct-owner').value);
      let pri = 'medium';
      $$('#ct-pri button').forEach(b => b.onclick = () => { $$('#ct-pri button').forEach(x => x.classList.remove('on')); b.classList.add('on'); pri = b.dataset.p; $('#ct-tat').value = T.PRIORITIES.find(p => p.id === pri).tat; });
      $('#ct-go').onclick = () => {
        const date = $('#ct-date').value, time = $('#ct-time').value, btn = $('#ct-go');
        btn.disabled = true;
        U.act(() => T.api.createTask(me, {
          title: $('#ct-title').value, description: $('#ct-desc').value, deptId: $('#ct-dept').value, category: $('#ct-cat').value,
          ownerId: $('#ct-owner').value, startDate: $('#ct-start').value, dueAt: date && time ? T.istToEpoch(date, time) : NaN, priority: pri,
          expectedTatHrs: +$('#ct-tat').value, kpiWeight: +$('#ct-w').value, reminder: $('#ct-rem').value, kpi: $('#ct-kpi').checked,
          dependsOn: $('#ct-dep').value ? [$('#ct-dep').value] : [], checklist: $('#ct-check').value.split('\n').map(s => s.trim()),
          approvals: $('#ct-appr-on').checked ? U.readApprovals($('#ct-appr')) : []
        })).then(t => {
          btn.disabled = false;
          if (t && t.id) { U.closeLayer(); U.toast(`${t.id} created and ${T.userName(t.ownerId)} notified`); T.app.refresh(); }
        });
      };
    });
  };

  /* ---------- task drawer ---------- */
  U.openTask = (id, tab = 'details') => {
    const me = T.app.me(), t = T.task(id);
    if (!t || !T.canView(me, t)) return U.toast('Task not found or you do not have access.', true);
    U.currentTask = { id, tab };
    const manage = T.canManage(me, t), owner = T.isOwner(me, t);
    const blockers = T.blockedBy(t);
    const actions = [];
    if (owner && t.status === 'assigned') actions.push(`<button class="btn primary" data-a="ack">✓ Acknowledge</button>`);
    if ((owner || manage) && ['assigned', 'acknowledged', 'on_hold', 'reopened'].includes(t.status)) actions.push(`<button class="btn" data-a="start">▶ Start / resume</button>`);
    if ((owner || manage) && ['acknowledged', 'in_progress', 'reopened', 'assigned'].includes(t.status)) actions.push(`<button class="btn" data-a="hold">⏸ On hold</button>`);
    const needsApproval = T.hasApprovals(t) && !T.approvalsDone(t);
    const workable = ['acknowledged', 'in_progress', 'reopened', 'assigned', 'on_hold'].includes(t.status);
    const curStep = T.currentApproval(t);
    if (owner && workable && needsApproval) actions.push(`<button class="btn primary" data-a="sendappr">➜ Send for approval</button>`);
    if (owner && workable) actions.push(`<button class="btn ${needsApproval ? '' : 'primary'}" data-a="submit" ${blockers.length ? 'disabled title="Blocked by dependency"' : needsApproval ? 'disabled title="Approval is required before submission"' : ''}>Submit completion</button>`);
    if (owner && curStep) actions.push(`<button class="btn" data-a="withdraw">Withdraw approval request</button>`);
    if (curStep && (curStep.approverId === me.id || me.role === 'super_admin')) actions.push(`<button class="btn ok" data-a="approk">✓ Approve${curStep.approverId !== me.id ? ' (on behalf)' : ''}: ${esc(curStep.label)}</button><button class="btn danger" data-a="apprno">✕ Reject</button>`);
    if (manage && T.isOpen(t) && !['in_approval', 'pending_review'].includes(t.status)) actions.push(`<button class="btn" data-a="apprsteps">${T.hasApprovals(t) ? 'Edit approval steps' : '＋ Approval steps'}</button>`);
    if (manage && t.status === 'pending_review' && !owner) actions.push(`<button class="btn ok" data-a="approve">✓ Approve</button><button class="btn danger" data-a="reopen">↺ Reopen</button>`);
    if (manage && t.status === 'completed') actions.push(`<button class="btn danger" data-a="reopen">↺ Reopen</button>`);
    if (manage && T.isOpen(t)) actions.push(`<button class="btn" data-a="reassign">⇄ Reassign</button><button class="btn" data-a="deadline">📅 Change deadline</button>`);
    if (manage && T.isOpen(t)) actions.push(`<button class="btn" data-a="ext">${t.externalDependency ? 'Remove external exclusion' : 'Approve external dependency'}</button>`);
    if (manage) actions.push(`<button class="btn" data-a="dup">⧉ Duplicate</button><button class="btn" data-a="archive">${t.archived ? 'Unarchive' : 'Archive'}</button>`);
    if (manage && T.isOpen(t)) actions.push(`<button class="btn danger" data-a="cancel">Cancel task</button>`);

    const tatAct = T.actualTatHrs(t);
    const tabs = ['details', 'comments', 'history', 'ownership'];
    const body = {
      details: `
        ${T.isOverdue(t) ? `<div class="alert danger">Overdue by ${T.rel(t.dueAt).replace(' ago', '')} (${T.overdueDays(t)} working day(s)). Status retained: ${T.statusLabel(t.status)}.</div>` : ''}
        ${blockers.length ? `<div class="alert warn">⛓ Blocked by ${blockers.map(b => `<a href="#" data-open="${b.id}">${b.id}</a> (${esc(T.userName(b.ownerId))} — bottleneck)`).join(', ')}</div>` : ''}
        ${t.externalDependency ? `<div class="alert info">External dependency approved by ${esc(T.userName(t.externalDependency.approvedBy))}: ${esc(t.externalDependency.reason)} — excluded from timeliness KPI.</div>` : ''}
        <p>${esc(t.description) || '<span class="muted">No description</span>'}</p>
        ${t.scheduleRequired ? `<div class="alert ${(t.attachments || []).length ? 'info' : 'warn'}">📎 Schedule required — ${(t.attachments || []).length ? 'attached. You can submit when the work is done.' : 'attach the schedule (Attachments below) before submitting.'}</div>` : ''}
        <div class="section-title">Workflow — where this task is now</div>
        ${U.workflow(t)}
        ${T.hasApprovals(t) || (t.approvalLog || []).length ? `<div class="section-title">Approval history</div>${U.approvalLog(t)}` : ''}
        <div class="section-title">Details</div>
        <dl class="meta-grid">
          <dt>Assignee</dt><dd>${U.avatar(t.ownerId)}</dd>
          <dt>Created by</dt><dd>${U.avatar(t.createdBy)} · ${T.fmt(t.createdAt)}</dd>
          <dt>Reviewer</dt><dd>${U.avatar(t.reviewerId)}</dd>
          <dt>Department</dt><dd>${esc(T.deptName(t.deptId))} · ${esc(t.category)}${t.module ? ` · ${esc(t.module)}` : ''}</dd>
          ${t.closeRef ? `<dt>Month-end close</dt><dd><a href="#/close?period=${t.closeRef.period}">${esc(T.periodLabel(t.closeRef.period))} close</a> · activity ${esc(t.closeRef.sl)}</dd>` : ''}
          ${(t.collaborators || []).length ? `<dt>Co-owners</dt><dd>${t.collaborators.map(c => U.avatar(c)).join(' ')}</dd>` : ''}
          <dt>Priority</dt><dd>${U.priority(t.priority)} · KPI weight ${t.kpiWeight} ${t.kpi ? '' : '· <b>excluded from KPI</b>'}</dd>
          <dt>Due (IST)</dt><dd><b>${T.fmt(t.dueAt)}</b> <span class="muted">(${T.rel(t.dueAt)})</span></dd>
          <dt>Original deadline</dt><dd>${T.fmt(t.originalDueAt)}${t.kpiDueAt !== t.dueAt ? ` · KPI deadline ${T.fmt(t.kpiDueAt)}` : ''}</dd>
          <dt>Assigned</dt><dd>${T.fmt(t.assignedAt)}</dd>
          <dt>Acknowledged</dt><dd>${T.fmt(t.ackAt)}</dd>
          <dt>First submitted</dt><dd>${T.fmt(t.firstSubmittedAt)}</dd>
          <dt>Completed</dt><dd>${T.fmt(t.completedAt)}</dd>
          <dt>TAT</dt><dd>Expected ${t.expectedTatHrs} h · Actual ${T.fmtHrs(tatAct)}${tatAct != null ? ` · Deviation <b style="color:${tatAct > t.expectedTatHrs ? 'var(--danger)' : 'var(--ok)'}">${tatAct > t.expectedTatHrs ? '+' : ''}${T.fmtHrs(tatAct - t.expectedTatHrs)}</b>` : ''}</dd>
          <dt>Follow-up</dt><dd>${esc((T.REMINDERS.find(r => r.id === t.reminder) || {}).label || t.reminder)}</dd>
          <dt>Reopened</dt><dd>${t.reopenCount} time(s)</dd>
        </dl>
        <div class="section-title">Progress</div>
        ${(owner || manage) && T.isOpen(t) && t.status !== 'pending_review' ? `<input type="range" min="0" max="100" step="5" value="${t.progress}" id="td-prog"> <b id="td-prog-v">${t.progress}%</b>` : U.progress(t.progress)}
        <div class="section-title">Checklist</div>
        <div class="checklist">${t.checklist.map(c => `<label><input type="checkbox" data-check="${c.id}" ${c.done ? 'checked' : ''} ${(owner || manage) ? '' : 'disabled'}> ${esc(c.text)}</label>`).join('') || '<span class="muted small">No checklist items</span>'}</div>
        ${(owner || manage) ? `<div style="display:flex;gap:6px;margin-top:6px"><input class="input" id="td-newcheck" placeholder="Add checklist item"><button class="btn sm" id="td-addcheck">Add</button></div>` : ''}
        <div class="section-title">Attachments / evidence</div>
        ${t.attachments.map(a => `<div class="small">📎 ${a.path && T.isServer() ? `<a href="/api/attachments/${encodeURIComponent(t.id)}/${encodeURIComponent(a.id)}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)} <span class="muted">· ${(a.size / 1024).toFixed(0)} KB · ${esc(T.userName(a.by))} · ${T.fmt(a.at)}</span></div>`).join('') || '<span class="muted small">No attachments</span>'}
        ${(owner || manage) ? `<div style="margin-top:6px"><input type="file" id="td-file"></div><div class="small muted">${T.isServer() ? 'Files are stored privately; links expire after a few minutes. Max 25 MB.' : T.isShared() ? 'Records the file name as evidence. Keep the file itself in your shared drive and mention its location in a comment.' : 'Demo build records file metadata only; the server edition stores files in private storage with signed links.'}</div>` : ''}
        <div class="section-title">Dependencies</div>
        ${t.dependsOn.length ? t.dependsOn.map(d => { const x = T.task(d); return x ? `<div class="small"><a href="#" data-open="${x.id}">${x.id}</a> ${esc(x.title)} — ${U.status(x)} · ${esc(T.userName(x.ownerId))}</div>` : ''; }).join('') : '<span class="muted small">None</span>'}
        ${manage ? `<div style="display:flex;gap:6px;margin-top:6px"><input class="input" id="td-dep" placeholder="Task ID, e.g. T360-0012"><button class="btn sm" id="td-adddep">Add dependency</button></div>` : ''}
        ${t.deadlineChanges.length ? `<div class="section-title">Deadline revisions</div>${t.deadlineChanges.map(c => `<div class="small">${T.fmt(c.at)} · ${esc(T.userName(c.by))}: ${T.fmt(c.from)} → ${T.fmt(c.to)} <span class="pill p-medium">${c.attribution}</span><br><span class="muted">${esc(c.reason)}</span></div>`).join('')}` : ''}
      `,
      comments: `${t.comments.map(c => `<div class="comment"><div class="small"><b>${esc(T.userName(c.by))}</b> <span class="muted">· ${T.fmt(c.at)}</span></div>${esc(c.text)}</div>`).join('') || '<div class="muted">No comments yet.</div>'}
        <textarea class="input" id="td-comment" placeholder="Write a progress update or comment…"></textarea><div style="margin-top:6px"><button class="btn primary sm" id="td-post">Post comment</button></div>`,
      history: `<div class="small muted" style="margin-bottom:8px">Immutable record — entries cannot be edited or deleted.</div><div class="timeline">${[...t.history].reverse().map(h => `<div class="ev"><b>${esc(h.action.replace(/_/g, ' '))}</b> · ${esc(T.userName(h.by))} <span class="muted small">· ${T.fmt(h.at)}</span><div class="small">${esc(h.detail)}</div></div>`).join('')}</div>`,
      ownership: `<table><thead><tr><th>Owner</th><th>From</th><th>To</th><th>Reason</th></tr></thead><tbody>${t.ownership.map(o => `<tr><td>${U.avatar(o.userId)}</td><td class="small">${T.fmt(o.from)}</td><td class="small">${o.to ? T.fmt(o.to) : 'current'}</td><td class="small">${esc(o.reason)}${o.endReason ? `<br><span class="muted">Ended: ${esc(o.endReason)} (${esc(o.cause || '')})</span>` : ''}</td></tr>`).join('')}</tbody></table>
        <p class="small muted">KPI fairness: each owner is measured only from their own assignment time. Previous owners are not scored on reassigned work.</p>`
    };

    $('#layer').innerHTML = `<div class="overlay" data-close></div><aside class="drawer" role="dialog" aria-modal="true">
      <div class="drawer-head"><div><div class="tid">${t.id} · ${esc(T.deptName(t.deptId))}</div><h2 style="margin:2px 0 6px">${esc(t.title)}</h2><div>${U.status(t)} ${U.priority(t.priority)}</div></div><button class="close-x" data-close aria-label="Close">×</button></div>
      <div class="drawer-body"><div class="tabs">${tabs.map(x => `<button data-tab="${x}" class="${x === tab ? 'on' : ''}">${x[0].toUpperCase() + x.slice(1)}${x === 'comments' ? ` (${t.comments.length})` : ''}</button>`).join('')}</div>${body[tab]}</div>
      ${actions.length ? `<div class="drawer-foot">${actions.join('')}</div>` : ''}
    </aside>`;
    const L = $('#layer');
    $$('[data-close]', L).forEach(b => b.onclick = U.closeLayer);
    $$('[data-tab]', L).forEach(b => b.onclick = () => U.openTask(id, b.dataset.tab));
    $$('[data-open]', L).forEach(a => a.onclick = e => { e.preventDefault(); U.openTask(a.dataset.open); });
    const reopenDrawer = () => { T.app.refresh(); U.openTask(id, tab); };
    const run = (fn, msg) => { U.act(fn, msg).then(ok => { if (ok) reopenDrawer(); }) };

    const prog = $('#td-prog', L);
    if (prog) { prog.oninput = () => $('#td-prog-v').textContent = prog.value + '%'; prog.onchange = () => run(() => T.api.setProgress(me, id, +prog.value), 'Progress saved'); }
    $$('[data-check]', L).forEach(c => c.onchange = () => run(() => T.api.toggleChecklist(me, id, c.dataset.check)));
    const ac = $('#td-addcheck', L); if (ac) ac.onclick = () => run(() => T.api.addChecklist(me, id, $('#td-newcheck').value));
    const fi = $('#td-file', L); if (fi) fi.onchange = () => fi.files[0] && run(() => U.uploadAttachment(me, id, fi.files[0]), 'Attachment saved');
    const ad = $('#td-adddep', L); if (ad) ad.onclick = () => run(() => T.api.addDependency(me, id, $('#td-dep').value.trim().toUpperCase()), 'Dependency added');
    const pc = $('#td-post', L); if (pc) pc.onclick = () => run(() => T.api.comment(me, id, $('#td-comment').value), 'Comment posted');

    const A = {
      ack: () => run(() => T.api.acknowledge(me, id), 'Acknowledged'),
      start: () => run(() => T.api.setStatus(me, id, 'in_progress'), 'Moved to In Progress'),
      hold: () => U.reasonPrompt('Put task on hold', 'Dependency / reason', '', r => { U.act(() => T.api.setStatus(me, id, 'on_hold', r), 'Task on hold').then(ok => { if (ok) reopenDrawer(); }) }),
      submit: () => U.reasonPrompt('Submit completion', 'Completion remarks', `<div class="alert info">The submission timestamp is recorded by the system — it cannot be entered manually. Attach evidence on the Details tab before submitting.</div>`, r => { U.act(() => T.api.submit(me, id, r), 'Submitted for review').then(ok => { if (ok) reopenDrawer(); }) }),
      approve: () => run(() => T.api.approve(me, id), 'Approved and closed'),
      sendappr: () => {
        const first = t.approvals.find(a => a.status !== 'approved');
        U.modal('Send for approval', `<div class="alert info">Goes to <b>${esc(T.userName(first.approverId))}</b> for “${esc(first.label)}”.${t.approvals.length > 1 ? ` Then: ${esc(t.approvals.filter(a => a !== first && a.status !== 'approved').map(a => `${a.label} (${T.userName(a.approverId)})`).join(' → ') || 'none')}.` : ''}</div>
          <label class="field"><span>Note for the approver (optional)</span><textarea class="input" id="sa-note" placeholder="What to check, where the workings are"></textarea></label>`,
          `<button class="btn" data-close>Cancel</button><button class="btn primary" id="sa-ok">Send for approval</button>`, m => {
            $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
            $('#sa-ok').onclick = () => U.act(() => T.api.requestApproval(me, id, $('#sa-note').value), `Sent to ${T.userName(first.approverId)} for approval`).then(ok => { if (ok) reopenDrawer(); });
          });
      },
      withdraw: () => run(() => T.api.withdrawApproval(me, id), 'Approval request withdrawn'),
      approk: () => U.modal(`Approve: ${curStep.label}`, `<label class="field"><span>Comment (optional)</span><textarea class="input" id="ap-note" placeholder="e.g. Checked against bank statement"></textarea></label>`,
        `<button class="btn" data-close>Cancel</button><button class="btn ok" id="ap-ok">✓ Approve</button>`, m => {
          $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
          $('#ap-ok').onclick = () => U.act(() => T.api.decideApproval(me, id, 'approve', $('#ap-note').value), 'Approved').then(ok => { if (ok) reopenDrawer(); });
        }),
      apprno: () => U.reasonPrompt(`Reject: ${curStep.label}`, 'What needs to change?', `<div class="alert warn">The task goes back to ${esc(T.userName(t.ownerId))} to fix and send for approval again.</div>`,
        r => { U.act(() => T.api.decideApproval(me, id, 'reject', r), 'Rejected; assignee notified').then(ok => { if (ok) reopenDrawer(); }); }),
      apprsteps: () => U.modal('Approval before submission', `<p class="small muted" style="margin-top:0">The assignee must get these approvals, in order, before submitting. Leave the approver empty on every row to remove approvals.</p>${U.approvalEditor(t.approvals || [], t.ownerId)}`,
        `<button class="btn" data-close>Cancel</button><button class="btn primary" id="as-ok">Save steps</button>`, m => {
          $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
          U.wireApprovalEditor(m);
          $('#as-ok').onclick = () => U.act(() => T.api.setApprovals(me, id, U.readApprovals(m)), 'Approval steps saved').then(ok => { if (ok) reopenDrawer(); });
        }),
      reopen: () => U.reasonPrompt('Reopen task', 'What needs correction?', '', r => { U.act(() => T.api.reopen(me, id, r), 'Task reopened').then(ok => { if (ok) reopenDrawer(); }) }),
      reassign: () => {
        const opts = T.assignableUsers(me).filter(u => u.id !== t.ownerId).map(u => `<option value="${u.id}">${esc(u.name)} — ${esc(T.deptNames(u))}</option>`).join('');
        U.reasonPrompt('Reassign task', 'Reason for reassignment', `<label class="field"><span>New assignee *</span><select class="input" id="ra-user">${opts}</select></label><div id="ra-hint"></div>
          <label class="field"><span>Cause</span><select class="input" id="ra-cause"><option value="workload">Workload balancing</option><option value="skill">Skill / expertise</option><option value="leave">Leave / absence</option><option value="performance">Performance</option><option value="scope">Scope change</option></select></label>`,
          r => { U.act(() => T.api.reassign(me, id, $('#ra-user').value, r, $('#ra-cause').value), 'Task reassigned; both assignees notified').then(ok => { if (ok) reopenDrawer(); }) });
        const upd = () => $('#ra-hint').innerHTML = U.workloadHint($('#ra-user').value); $('#ra-user').onchange = upd; upd();
      },
      deadline: () => U.reasonPrompt('Change deadline', 'Reason for change', `<div class="alert info">Original deadline (${T.fmt(t.originalDueAt)}) is always preserved.</div><div class="grid2"><label class="field"><span>New due date *</span><input class="input" type="date" id="dl-d" value="${T.istDateStr(t.dueAt + T.DAY)}"></label><label class="field"><span>Due time (IST) *</span><input class="input" type="time" id="dl-t" value="${T.istTimeStr(t.dueAt)}"></label></div>
        <label class="field"><span>Attributable to *</span><select class="input" id="dl-a"><option value="employee">Employee request — KPI keeps original deadline</option><option value="manager">Manager / scope change — KPI uses new deadline</option><option value="external">External dependency — KPI uses new deadline</option></select></label>`,
        r => { const nd = T.istToEpoch($('#dl-d').value, $('#dl-t').value); U.act(() => T.api.changeDeadline(me, id, nd, r, $('#dl-a').value), 'Deadline updated').then(ok => { if (ok) reopenDrawer(); }) }),
      ext: () => t.externalDependency ? run(() => T.api.setExternalDependency(me, id, null), 'Exclusion removed') :
        U.reasonPrompt('Approve external dependency', 'External dependency (who / what)', `<div class="alert info">Approved external dependencies are excluded from on-time and TAT KPIs.</div>`, r => { U.act(() => T.api.setExternalDependency(me, id, r), 'External dependency approved').then(ok => { if (ok) reopenDrawer(); }) }),
      dup: () => U.act(() => T.api.duplicate(me, id)).then(n => { if (n && n.id) { U.toast(`Duplicated as ${n.id}`); U.openTask(n.id); } }),
      archive: () => run(() => T.api.archive(me, id, !t.archived), t.archived ? 'Restored' : 'Archived'),
      cancel: () => U.reasonPrompt('Cancel task', 'Reason for cancellation', '', r => { U.act(() => T.api.cancel(me, id, r), 'Task cancelled; reminders stopped').then(ok => { if (ok) reopenDrawer(); }) })
    };
    $$('[data-a]', L).forEach(b => b.onclick = () => A[b.dataset.a]());
  };

  /* Overridden by js/remote.js in the server edition to upload the file itself. */
  U.uploadAttachment = (me, id, file) => T.api.addAttachment(me, id, { name: file.name, size: file.size });

  /* ---------- export ---------- */
  U.taskRows = tasks => tasks.map(t => ({
    'Task ID': t.id, 'Title': t.title, 'Department': T.deptName(t.deptId), 'Category': t.category, 'Assignee': T.userName(t.ownerId),
    'Created by': T.userName(t.createdBy), 'Priority': T.priorityLabel(t.priority), 'Status': T.statusLabel(t.status), 'Overdue': T.isOverdue(t) ? 'Yes' : 'No',
    'Assigned (IST)': T.fmt(t.assignedAt), 'Original due (IST)': T.fmt(t.originalDueAt), 'Due (IST)': T.fmt(t.dueAt), 'Acknowledged (IST)': T.fmt(t.ackAt),
    'First submitted (IST)': T.fmt(t.firstSubmittedAt), 'Completed (IST)': T.fmt(t.completedAt), 'Expected TAT (h)': t.expectedTatHrs,
    'Actual TAT (h)': T.actualTatHrs(t) == null ? '' : T.actualTatHrs(t).toFixed(1), 'Progress %': t.progress, 'Reopened': t.reopenCount, 'In KPI': t.kpi ? 'Yes' : 'No',
    'Current stage': T.isOpen(t) ? T.stageOf(t).stage : T.statusLabel(t.status), 'Waiting on': T.isOpen(t) && T.stageOf(t).waitingOn ? T.userName(T.stageOf(t).waitingOn) : '',
    'Approvals': (t.approvals || []).map(a => `${a.label}: ${T.userName(a.approverId)} (${a.status})`).join('; ')
  }));
  U.download = (name, content, type) => {
    if (T.saveFile) return T.saveFile(name, content);
    const blob = new Blob([content], { type }); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  U.exportCSV = (name, rows) => {
    if (!rows.length) return U.toast('Nothing to export', true);
    const cols = Object.keys(rows[0]);
    const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    U.download(name + '.csv', '﻿' + [cols.map(q).join(','), ...rows.map(r => cols.map(c => q(r[c])).join(','))].join('\r\n'), 'text/csv;charset=utf-8');
  };
  U.exportExcel = (name, rows) => {
    if (!rows.length) return U.toast('Nothing to export', true);
    if (T.saveFile) return U.exportCSV(name, rows); // the shared page saves CSV, which opens in Excel
    const cols = Object.keys(rows[0]);
    const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"></head><body><table border="1"><tr>${cols.map(c => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map(r => `<tr>${cols.map(c => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
    U.download(name + '.xls', html, 'application/vnd.ms-excel');
  };
})(window.T360);
