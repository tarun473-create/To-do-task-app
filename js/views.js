/* Task360 — page views. Each view renders into #view and wires its own events. */
(function (T) {
  'use strict';
  const { $, $$, esc, ui: U } = T;
  const D = () => T.store.data;
  T.views = {};
  const V = T.views;

  /* ---------- shared filtering ---------- */
  T.escalatedIds = () => { const s = new Set(); Object.keys(D().sentKeys).forEach(k => { const m = k.match(/^(T360-\d+):esc[12]:/); if (m) s.add(m[1]); }); return s; };
  T.filterTasks = (tasks, f, me) => {
    const esc_ = f.preset === 'escalated' ? T.escalatedIds() : null;
    const q = (f.q || '').toLowerCase();
    const from = f.from ? T.istToEpoch(f.from, '00:00') : null, to = f.to ? T.istToEpoch(f.to, '23:59') : null;
    return tasks.filter(t => {
      if (!f.archived && t.archived && f.preset !== 'archived') return false;
      switch (f.preset) {
        case 'my': if (t.ownerId !== me.id) return false; break;
        case 'assigned': if (t.createdBy !== me.id) return false; break;
        case 'overdue': if (!T.isOverdue(t)) return false; break;
        case 'approvals': if (!T.waitingOnMe(t, me)) return false; break;
        case 'in_approval': if (t.status !== 'in_approval') return false; break;
        case 'today': if (!T.dueToday(t)) return false; break;
        case 'critical': if (!(t.priority === 'critical' && T.isOpen(t))) return false; break;
        case 'pending': if (!T.isOpen(t)) return false; break;
        case 'reopened': if (!t.reopenCount) return false; break;
        case 'recurring': if (!t.recurringId) return false; break;
        case 'escalated': if (!esc_.has(t.id)) return false; break;
        case 'ontime': if (!(T.submittedOnTime(t))) return false; break;
        case 'late': if (!((t.firstSubmittedAt && !T.submittedOnTime(t)) || T.isOverdue(t))) return false; break;
        case 'archived': if (!t.archived) return false; break;
      }
      if (f.status) { if (f.status === 'overdue' ? !T.isOverdue(t) : f.status === 'not_started' ? !['assigned', 'acknowledged'].includes(t.status) : t.status !== f.status) return false; }
      if (f.dept && t.deptId !== f.dept) return false;
      if (f.owner && t.ownerId !== f.owner) return false;
      if (f.priority && t.priority !== f.priority) return false;
      if (f.category && t.category !== f.category) return false;
      if (f.age) { const a = T.ageDays(t); const [lo, hi] = f.age.split('-').map(Number); if (!T.isOpen(t) || a < lo || (hi && a > hi)) return false; }
      if (from && t.dueAt < from) return false;
      if (to && t.dueAt > to) return false;
      if (q && !(`${t.id} ${t.title} ${t.description} ${T.userName(t.ownerId)} ${T.deptName(t.deptId)} ${t.category}`.toLowerCase().includes(q))) return false;
      return true;
    });
  };
  const qs = o => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  T.drill = f => `#/tasks?${qs(f)}`;

  const filterBar = (f, me, opts = {}) => {
    const users = T.visibleUsers(me).filter(u => u.role === 'employee' || u.role === 'manager');
    const sel = (id, label, items, val) => `<select class="input" data-f="${id}"><option value="">${label}</option>${items.map(([v, l]) => `<option value="${v}" ${val === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
    return `<div class="filters">
      ${opts.search !== false ? `<input class="input" data-f="q" placeholder="Filter…" value="${esc(f.q || '')}" style="min-width:180px">` : ''}
      ${sel('dept', 'All departments', T.visibleDepts(me).map(d => [d.id, d.name]), f.dept)}
      ${me.role !== 'employee' ? sel('owner', 'All employees', users.map(u => [u.id, u.name]), f.owner) : ''}
      ${opts.status !== false ? sel('status', 'All statuses', [['overdue', '⚠ Overdue (flag)'], ['not_started', 'Not started'], ...T.STATUSES.map(s => [s.id, s.label])], f.status) : ''}
      ${sel('priority', 'All priorities', T.PRIORITIES.map(p => [p.id, p.label]), f.priority)}
      ${opts.category !== false ? sel('category', 'All task types', T.CATEGORIES.map(c => [c, c]), f.category) : ''}
      <label class="small muted">Due from <input class="input" type="date" data-f="from" value="${f.from || ''}"></label>
      <label class="small muted">to <input class="input" type="date" data-f="to" value="${f.to || ''}"></label>
      <button class="btn sm" data-clear>Clear</button>
    </div>`;
  };
  const wireFilters = (root, f, path) => {
    $$('[data-f]', root).forEach(el => {
      const ev = el.tagName === 'INPUT' && el.type !== 'date' ? 'input' : 'change';
      let timer;
      el.addEventListener(ev, () => { clearTimeout(timer); timer = setTimeout(() => { f[el.dataset.f] = el.value; T.app.go(path, f, true); }, ev === 'input' ? 250 : 0); });
    });
    const c = $('[data-clear]', root); if (c) c.onclick = () => T.app.go(path, f.preset ? { preset: f.preset } : {});
  };
  const wireRows = root => $$('[data-task]', root).forEach(r => r.onclick = () => U.openTask(r.dataset.task));
  const wireGo = root => $$('[data-go]', root).forEach(el => el.addEventListener('click', e => { e.preventDefault(); location.hash = el.dataset.go; }));
  const pct = (a, b) => b ? Math.round(100 * a / b) : 0;

  /* ================= DASHBOARD ================= */
  V.dashboard = (f, me) => {
    const all = T.filterTasks(T.visibleTasks(me), { ...f, preset: '' }, me);
    const live = all.filter(t => t.status !== 'cancelled');
    const done = live.filter(t => t.status === 'completed'), open = live.filter(T.isOpen);
    const overdue = live.filter(t => T.isOverdue(t)), notStarted = live.filter(t => ['assigned', 'acknowledged'].includes(t.status) && !T.isOverdue(t));
    const inProg = live.filter(t => ['in_progress', 'on_hold', 'reopened'].includes(t.status) && !T.isOverdue(t));
    const review = live.filter(t => t.status === 'pending_review');
    const inAppr = live.filter(t => t.status === 'in_approval');
    const submitted = live.filter(t => t.firstSubmittedAt);
    const ontime = submitted.filter(T.submittedOnTime);
    const tats = submitted.map(T.actualTatHrs);
    const avgTat = tats.length ? tats.reduce((a, b) => a + b, 0) / tats.length : null;
    const escIds = T.escalatedIds(); const escCount = live.filter(t => escIds.has(t.id)).length;
    const base = { dept: f.dept || '', owner: f.owner || '', priority: f.priority || '', from: f.from || '', to: f.to || '' };
    const go = extra => T.drill({ ...base, ...extra });

    const cards = [
      ['Total tasks', live.length, '', go({}), 'all except cancelled'],
      ['Completed', done.length, 'green', go({ status: 'completed' })],
      ['Pending', open.length, 'blue', go({ preset: 'pending' })],
      ['Overdue', overdue.length, 'red', go({ status: 'overdue' })],
      ['Due today', live.filter(T.dueToday).length, 'amber', go({ preset: 'today' })],
      ['Critical open', live.filter(t => t.priority === 'critical' && T.isOpen(t)).length, 'red', go({ preset: 'critical' })],
      ['Pending final review', review.length, 'violet', go({ status: 'pending_review' })],
      ['In approval', inAppr.length, 'blue', go({ status: 'in_approval' }), 'before submission'],
      ['On-time delivery', pct(ontime.length, submitted.length) + '%', 'green', go({ preset: 'ontime' }), `${ontime.length} of ${submitted.length} submitted`],
      ['Avg. turnaround', T.fmtHrs(avgTat), '', go({ status: 'completed' }), 'assignment → submission'],
      ['Reopened', live.filter(t => t.reopenCount).length, 'amber', go({ preset: 'reopened' })],
      ['Escalations', escCount, 'red', go({ preset: 'escalated' })],
      ['Not started', notStarted.length, '', go({ status: 'not_started' })]
    ];
    const seg = [
      { label: 'Completed', value: done.length, color: U.statusColor.completed, go: go({ status: 'completed' }) },
      { label: 'In progress', value: inProg.length, color: U.statusColor.in_progress, go: go({ status: 'in_progress' }) },
      { label: 'In approval', value: inAppr.filter(t => !T.isOverdue(t)).length, color: U.statusColor.in_approval, go: go({ status: 'in_approval' }) },
      { label: 'Pending review', value: review.length, color: U.statusColor.pending_review, go: go({ status: 'pending_review' }) },
      { label: 'Overdue', value: overdue.length, color: U.statusColor.overdue, go: go({ status: 'overdue' }) },
      { label: 'Not started', value: notStarted.length, color: U.statusColor.assigned, go: go({ status: 'not_started' }) }
    ];
    const depts = T.visibleDepts(me).map(d => {
      const ts = live.filter(t => t.deptId === d.id), sub = ts.filter(t => t.firstSubmittedAt);
      const due = ts.filter(t => t.kpiDueAt <= Date.now() || t.firstSubmittedAt);
      const ot = due.length ? pct(due.filter(t => T.submittedOnTime(t)).length, due.length) : null;
      return { d, total: ts.length, ot, od: ts.filter(t => T.isOverdue(t)).length, sub: sub.length };
    });
    const emps = T.visibleUsers(me).filter(u => u.role === 'employee' || u.role === 'manager').map(u => {
      const ts = live.filter(t => t.ownerId === u.id && T.isOpen(t));
      return { u, open: ts.length, od: ts.filter(t => T.isOverdue(t)).length };
    }).sort((a, b) => b.open - a.open);
    const maxOpen = Math.max(1, ...emps.map(e => e.open));
    const ageing = [['0-3', '0–3 d'], ['4-7', '4–7 d'], ['8-15', '8–15 d'], ['16-30', '16–30 d'], ['31-9999', '30+ d']].map(([k, l]) => {
      const [lo, hi] = k.split('-').map(Number); return { k, l, n: open.filter(t => { const a = T.ageDays(t); return a >= lo && a <= hi; }).length };
    });
    const maxAge = Math.max(1, ...ageing.map(a => a.n));
    const pri = T.PRIORITIES.map(p => ({ p, open: open.filter(t => t.priority === p.id).length, od: overdue.filter(t => t.priority === p.id).length }));
    const attention = open.filter(t => T.isOverdue(t) || T.dueToday(t) || t.status === 'pending_review' && t.ownerId !== me.id).sort((a, b) => a.dueAt - b.dueAt).slice(0, 8);

    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Management dashboard</h1><div class="sub">${esc(D().settings.companyName)} · ${me.role === 'employee' ? 'My overview' : 'Team overview'} · all figures are clickable</div></div>
        <div class="actions"><button class="btn" id="dash-export">Export CSV</button></div></div>
      ${filterBar(f, me, { search: false, status: false, category: false })}
      <div class="cards">${cards.map(([l, v, c, g, h]) => `<a class="card stat ${c}" href="${g}"><div class="label">${l}</div><div class="value">${v}</div>${h ? `<div class="hint">${h}</div>` : ''}</a>`).join('')}</div>
      <div class="dash-grid">
        <div class="card span-5"><div class="card-head"><h2>Task status</h2></div>
          <div class="donut-wrap">${U.donut(seg)}<div class="status-list">${seg.map(s => `<div data-go="${s.go}"><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${s.color};margin-right:8px"></i>${s.label}</span><b>${s.value}</b></div>`).join('')}</div></div></div>
        <div class="card span-7"><div class="card-head"><h2>Department performance</h2><span class="small muted">on-time % of tasks due</span></div>
          ${depts.map(x => `<div class="bar-row" data-go="${go({ dept: x.d.id })}"><span class="name">${esc(x.d.name)}</span><span class="bar"><i style="width:${x.ot ?? 0}%;background:${x.ot == null ? 'var(--grey)' : x.ot >= 90 ? 'var(--ok)' : x.ot >= 75 ? 'var(--primary)' : 'var(--warn)'}"></i></span><b class="right">${x.ot == null ? '—' : x.ot + '%'}</b></div>
            <div class="small muted" style="margin:-4px 0 4px 160px">${x.total} tasks · <span style="color:var(--danger)">${x.od} overdue</span></div>`).join('')}</div>
        <div class="card span-6"><div class="card-head"><h2>Employee workload</h2><span class="legend"><span><i style="background:var(--primary)"></i>Active</span><span><i style="background:var(--danger)"></i>Overdue</span></span></div>
          ${emps.map(e => `<div class="bar-row" data-go="${go({ owner: e.u.id, preset: 'pending' })}"><span class="name">${esc(e.u.name)}${e.u.onLeave ? ' 🏖' : ''}</span><span class="bar"><i style="width:${100 * (e.open - e.od) / maxOpen}%;background:var(--primary)"></i><i style="width:${100 * e.od / maxOpen}%;background:var(--danger)"></i></span><b class="right">${e.open}</b></div>`).join('') || '<div class="empty">No employees in scope</div>'}</div>
        <div class="card span-6"><div class="card-head"><h2>Task ageing (open tasks)</h2></div>
          <div class="vbars">${ageing.map(a => `<div class="col" data-go="${go({ age: a.k })}"><b>${a.n}</b><i style="height:${100 * a.n / maxAge}%;background:${a.k.startsWith('31') || a.k.startsWith('16') ? 'var(--danger)' : 'var(--primary)'}"></i><span>${a.l}</span></div>`).join('')}</div>
          <div class="section-title">Priority-wise</div>
          ${pri.map(p => `<div class="bar-row" data-go="${go({ priority: p.p.id, preset: 'pending' })}"><span class="name">${U.priority(p.p.id)}</span><span class="bar"><i style="width:${pct(p.open - p.od, Math.max(1, open.length))}%;background:var(--primary)"></i><i style="width:${pct(p.od, Math.max(1, open.length))}%;background:var(--danger)"></i></span><b class="right">${p.open}</b></div>`).join('')}</div>
        <div class="card span-12"><div class="card-head"><h2>Requires attention today</h2><a href="${go({ status: 'overdue' })}">View all overdue →</a></div>${U.taskTable(attention)}</div>
      </div>`;
    const v = $('#view'); wireFilters(v, f, 'dashboard'); wireGo(v); wireRows(v);
    $('#dash-export').onclick = () => U.exportCSV('task360-dashboard-tasks', U.taskRows(live));
  };

  /* ================= TASK LISTS ================= */
  const PRESET_TITLES = { '': 'All tasks', my: 'My tasks', assigned: 'Assigned by me', overdue: 'Overdue tasks', approvals: 'Approvals waiting for me', in_approval: 'Tasks in approval', today: 'Due today', critical: 'Critical open tasks', pending: 'Pending tasks', reopened: 'Reopened tasks', recurring: 'Recurring task instances', escalated: 'Escalated tasks', ontime: 'Submitted on time', late: 'Late / overdue', archived: 'Archived tasks' };
  let sortState = { key: 'due', dir: 1 };
  V.tasks = (f, me) => {
    const list = U.sortTasks(T.filterTasks(T.visibleTasks(me), f, me), sortState.key, sortState.dir);
    const title = PRESET_TITLES[f.preset || ''] || 'Tasks';
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>${title}</h1><div class="sub">${list.length} task(s)${f.preset === 'approvals' ? ' awaiting your review' : ''}</div></div>
        <div class="actions"><a class="btn" href="#/board?${qs(f)}">▦ Board</a><a class="btn" href="#/calendar">📅 Calendar</a><button class="btn" id="exp-csv">Export CSV</button><button class="btn" id="exp-xls">Export Excel</button></div></div>
      <div class="tabs">${['', 'my', 'assigned', 'overdue', 'approvals', 'in_approval', 'today', 'recurring', 'archived'].filter(p => me.role !== 'employee' || p !== 'assigned').map(p => `<button data-preset="${p}" class="${(f.preset || '') === p ? 'on' : ''}">${PRESET_TITLES[p]}</button>`).join('')}</div>
      ${filterBar(f, me)}
      <div class="card" style="padding:0">${U.taskTable(list)}</div>`;
    const v = $('#view'); wireFilters(v, f, 'tasks'); wireRows(v);
    $$('[data-preset]', v).forEach(b => b.onclick = () => T.app.go('tasks', { ...f, preset: b.dataset.preset }));
    $$('th[data-sort]', v).forEach(th => th.onclick = () => { sortState = { key: th.dataset.sort, dir: sortState.key === th.dataset.sort ? -sortState.dir : 1 }; V.tasks(f, me); });
    $('#exp-csv').onclick = () => U.exportCSV('task360-tasks', U.taskRows(list));
    $('#exp-xls').onclick = () => U.exportExcel('task360-tasks', U.taskRows(list));
  };

  /* ================= KANBAN ================= */
  V.board = (f, me) => {
    const list = T.filterTasks(T.visibleTasks(me), f, me).filter(t => t.status !== 'cancelled');
    const cols = ['assigned', 'acknowledged', 'in_progress', 'on_hold', 'reopened', 'in_approval', 'pending_review', 'completed'];
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>Kanban board</h1><div class="sub">Drag a card to change status. Moves are validated against the workflow rules.</div></div><div class="actions"><a class="btn" href="#/tasks?${qs(f)}">☰ List</a></div></div>
      ${filterBar(f, me, { status: false })}
      <div class="board">${cols.map(c => {
        const items = U.sortTasks(list.filter(t => t.status === c), 'due').slice(0, c === 'completed' ? 25 : 200);
        return `<div class="column" data-col="${c}"><div class="column-head"><span class="pill s-${c}">${T.statusLabel(c)}</span><span class="muted small">${list.filter(t => t.status === c).length}</span></div>
        ${items.map(t => `<div class="kcard" draggable="true" data-task="${t.id}"><div class="tid">${t.id}</div><div class="task-title">${esc(t.title)}</div>
          <div class="row">${U.avatar(t.ownerId, false)} ${U.priority(t.priority)} ${T.isOverdue(t) ? '<span class="pill flag-overdue">Overdue</span>' : ''}<span class="small muted">${T.fmtDate(t.dueAt)}</span></div></div>`).join('')}
        ${c === 'completed' && list.filter(t => t.status === c).length > 25 ? `<a class="small" href="${T.drill({ status: 'completed' })}">View all completed →</a>` : ''}</div>`;
      }).join('')}</div>`;
    const v = $('#view'); wireFilters(v, f, 'board'); wireRows(v);
    let dragId = null;
    $$('.kcard', v).forEach(k => k.addEventListener('dragstart', e => { dragId = k.dataset.task; e.dataTransfer.effectAllowed = 'move'; }));
    $$('.column', v).forEach(col => {
      col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-over'); });
      col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
      col.addEventListener('drop', e => {
        e.preventDefault(); col.classList.remove('drag-over'); if (!dragId) return;
        const target = col.dataset.col, t = T.task(dragId); if (t.status === target) return;
        const id = dragId; dragId = null;
        const map = {
          acknowledged: () => T.api.acknowledge(me, id),
          in_progress: () => T.api.setStatus(me, id, 'in_progress'),
          completed: () => T.api.approve(me, id)
        };
        if (target === 'on_hold') return U.reasonPrompt('Put task on hold', 'Dependency / reason', '', r => { U.act(() => T.api.setStatus(me, id, 'on_hold', r), 'On hold').then(ok => { if (ok) U.closeLayer(); }) });
        if (target === 'pending_review') return U.reasonPrompt('Submit completion', 'Completion remarks', '', r => { U.act(() => T.api.submit(me, id, r), 'Submitted for review').then(ok => { if (ok) U.closeLayer(); }) });
        if (target === 'in_approval') return U.act(() => T.api.requestApproval(me, id, ''), 'Sent for approval');
        if (t.status === 'in_approval') return U.toast('Open the task to approve or reject the current approval step.', true);
        if (target === 'reopened') return U.reasonPrompt('Reopen task', 'What needs correction?', '', r => { U.act(() => T.api.reopen(me, id, r), 'Reopened').then(ok => { if (ok) U.closeLayer(); }) });
        if (!map[target]) return U.toast(`Tasks cannot be moved back to ${T.statusLabel(target)}.`, true);
        U.act(map[target], `Moved to ${T.statusLabel(target)}`);
      });
    });
  };

  /* ================= CALENDAR ================= */
  let calOffset = 0;
  V.calendar = (f, me) => {
    const list = T.filterTasks(T.visibleTasks(me), { ...f, from: '', to: '' }, me).filter(t => t.status !== 'cancelled');
    const p = T.epochToIstParts(Date.now());
    let y = p.y, m = p.m + calOffset; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; }
    const first = T.istToEpoch(`${y}-${String(m).padStart(2, '0')}-01`, '12:00');
    const startDow = (T.epochToIstParts(first).dow + 6) % 7; // Monday first
    const start = first - startDow * T.DAY;
    const today = T.istDateStr(Date.now());
    const byDay = {}; list.forEach(t => (byDay[T.istDateStr(t.dueAt)] = byDay[T.istDateStr(t.dueAt)] || []).push(t));
    const hol = Object.fromEntries(D().settings.holidays.map(h => [h.date, h.name]));
    let cells = '';
    for (let i = 0; i < 42; i++) {
      const ms = start + i * T.DAY, ds = T.istDateStr(ms), pp = T.epochToIstParts(ms);
      const evs = (byDay[ds] || []).sort((a, b) => a.dueAt - b.dueAt);
      cells += `<div class="day ${pp.m !== m ? 'other' : ''} ${ds === today ? 'today' : ''} ${hol[ds] ? 'holiday' : ''}"><div class="num"><span>${pp.d}</span>${hol[ds] ? `<span class="small" title="${esc(hol[ds])}">🎉</span>` : ''}</div>
        ${evs.slice(0, 4).map(t => `<span class="ev" data-task="${t.id}" style="background:${T.isOverdue(t) ? 'var(--danger-soft)' : 'var(--surface-2)'};border-left:3px solid ${T.isOverdue(t) ? 'var(--danger)' : U.statusColor[t.status]}">${T.fmtTime(t.dueAt)} ${esc(t.title)}</span>`).join('')}
        ${evs.length > 4 ? `<a class="small" href="${T.drill({ from: ds, to: ds })}">+${evs.length - 4} more</a>` : ''}</div>`;
    }
    const label = new Date(first).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    $('#view').innerHTML = `<div class="page-head"><div><h1>Calendar</h1><div class="sub">Tasks by due date (IST). Holidays are highlighted.</div></div>
      <div class="actions"><button class="btn" id="cal-prev">‹</button><b style="align-self:center;min-width:130px;text-align:center">${label}</b><button class="btn" id="cal-next">›</button><button class="btn" id="cal-today">Today</button></div></div>
      ${filterBar(f, me, { status: false })}
      <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => `<div class="dow">${d}</div>`).join('')}${cells}</div>`;
    const v = $('#view'); wireFilters(v, f, 'calendar'); wireRows(v);
    $('#cal-prev').onclick = () => { calOffset--; V.calendar(f, me); };
    $('#cal-next').onclick = () => { calOffset++; V.calendar(f, me); };
    $('#cal-today').onclick = () => { calOffset = 0; V.calendar(f, me); };
  };

  /* ================= KPI ================= */
  V.kpi = (f, me) => {
    const offset = +(f.month || 0);
    const range = T.monthRange(offset);
    const W = D().settings.kpiWeights;
    const people = T.visibleUsers(me).filter(u => (u.role === 'employee' || u.role === 'manager') && (!f.dept || T.userDepts(u).includes(f.dept)));
    const rows = people.map(u => ({ u, k: T.computeKpi(u.id, range.from, range.to) })).sort((a, b) => (b.k.score ?? -1) - (a.k.score ?? -1));
    const sel = f.user ? T.user(f.user) : (me.role === 'employee' ? me : null);
    const months = [0, -1, -2, -3, -4, -5].map(o => ({ o, ...T.monthRange(o) }));

    let detail = '';
    if (sel && people.some(p => p.id === sel.id)) {
      const k = T.computeKpi(sel.id, range.from, range.to);
      const trend = [-5, -4, -3, -2, -1, 0].map(o => { const r = T.monthRange(o); return { r, s: T.computeKpi(sel.id, r.from, r.to).score }; });
      const weakest = T.KPI_PARAMS.filter(p => k.metrics[p.key].value != null).sort((a, b) => k.metrics[a.key].value - k.metrics[b.key].value)[0];
      detail = `<div class="card span-12"><div class="card-head"><h2>${U.avatar(sel.id)} — KPI basis for ${range.label}</h2><a href="#/kpi?${qs({ ...f, user: '' })}">Close ×</a></div>
        <div class="dash-grid"><div class="span-4"><div class="kpi-score ${k.band.cls}">${k.score == null ? '—' : k.score.toFixed(1) + '%'}</div><div class="band ${k.band.cls}">${k.band.label}</div>
          <p class="small muted">${k.counts.total} KPI tasks with deadlines this month · ${k.counts.due} due so far · ${k.counts.completed} completed · ${k.counts.overdue} overdue · ${k.counts.external} excluded (external dependency)</p>
          ${weakest ? `<div class="alert warn">Improvement area: <b>${weakest.label}</b> (${k.metrics[weakest.key].value.toFixed(0)}%)</div>` : ''}
          <div class="section-title">Delay attribution</div><div class="small">Employee-caused late: <b>${k.delays.employee}</b> · Manager revisions: <b>${k.delays.manager}</b> · External: <b>${k.delays.external}</b></div>
          <div class="section-title">6-month trend</div><div class="vbars" style="height:110px">${trend.map(x => `<div class="col"><b>${x.s == null ? '—' : x.s.toFixed(0)}</b><i style="height:${x.s ?? 0}%"></i><span>${x.r.label.split(' ')[0]}</span></div>`).join('')}</div></div>
        <div class="span-8"><table><thead><tr><th>Parameter</th><th>Weight</th><th>Score</th><th>Count</th><th>Contribution</th></tr></thead><tbody>
          ${T.KPI_PARAMS.map(p => { const m = k.metrics[p.key]; return `<tr><td><b>${p.label}</b><div class="small muted">${p.basis}</div></td><td>${W[p.key]}%</td><td><b>${m.value == null ? 'n/a' : m.value.toFixed(1) + '%'}</b></td><td class="small">${m.num}/${m.den}</td><td>${m.value == null ? '—' : (m.value * W[p.key] / 100).toFixed(1)}</td></tr>`; }).join('')}
          </tbody></table><p class="small muted">Score = Σ(parameter × weight) ÷ Σ(weights of parameters with data). Each task is weighted by its KPI weight (1–3). Scores are computed by the system — no user can edit them.</p>
          <div class="section-title">Tasks counted</div>${U.taskTable(U.sortTasks(k.tasks, 'due'), { hideAge: true })}</div></div></div>`;
    }

    $('#view').innerHTML = `<div class="page-head"><div><h1>KPI &amp; performance</h1><div class="sub">Transparent, system-calculated scores · period by KPI deadline</div></div>
      <div class="actions"><select class="input" id="kpi-month" style="width:auto">${months.map(x => `<option value="${x.o}" ${x.o === offset ? 'selected' : ''}>${x.label}</option>`).join('')}</select>
      ${me.role !== 'employee' ? `<select class="input" id="kpi-dept" style="width:auto"><option value="">All departments</option>${T.visibleDepts(me).map(d => `<option value="${d.id}" ${f.dept === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : ''}
      <button class="btn" id="kpi-exp">Export Excel</button></div></div>
      <div class="dash-grid">
        ${detail}
        <div class="card span-8"><div class="card-head"><h2>Employee KPI scores — ${range.label}</h2><span class="small muted">Weights: ${T.KPI_PARAMS.map(p => `${p.label.split(' ')[0]} ${W[p.key]}%`).join(' · ')}</span></div>
          <div class="table-wrap"><table><thead><tr><th>Employee</th><th>Dept</th><th>On-time</th><th>Completion</th><th>Quality</th><th>TAT</th><th>Response</th><th>KPI</th></tr></thead><tbody>
          ${rows.map(({ u, k }) => `<tr class="click" data-user="${u.id}"><td>${U.avatar(u.id)}</td><td class="small">${esc(T.deptNames(u))}</td>${T.KPI_PARAMS.map(p => `<td>${k.metrics[p.key].value == null ? '<span class="muted">n/a</span>' : k.metrics[p.key].value.toFixed(0) + '%'}</td>`).join('')}<td><b class="${k.band.cls}">${k.score == null ? '—' : k.score.toFixed(1) + '%'}</b><div class="small ${k.band.cls}">${k.band.label}</div></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No employees in scope</td></tr>'}
          </tbody></table></div></div>
        <div class="card span-4"><div class="card-head"><h2>Interactive KPI calculator</h2></div>
          <div class="kpi-score" id="calc-score">—</div><div class="band" id="calc-band"></div>
          <div style="margin-top:12px">${T.KPI_PARAMS.map((p, i) => `<div class="slider-row"><span class="small">${p.label}<br><span class="muted">Weight ${W[p.key]}%</span></span><input type="range" min="0" max="100" value="${[90, 95, 85, 80, 90][i]}" data-calc="${p.key}"><b data-calc-v="${p.key}"></b></div>`).join('')}</div>
          <button class="btn sm" id="calc-reset">Reset example</button>
          <div class="section-title">KPI safeguards</div>
          <ul class="small muted" style="padding-left:18px;margin:0"><li>Original deadline retained; employee-requested extensions don't move the KPI deadline.</li><li>Reassignment reasons recorded; each owner scored only from their own assignment.</li><li>Approved external dependencies excluded from timeliness.</li><li>Cancelled tasks excluded.</li><li>Manager and employee delays tracked separately.</li></ul>
        </div>
      </div>`;
    const v = $('#view'); wireRows(v);
    $$('[data-user]', v).forEach(r => r.onclick = () => T.app.go('kpi', { ...f, user: r.dataset.user }));
    $('#kpi-month').onchange = e => T.app.go('kpi', { ...f, month: e.target.value });
    const kd = $('#kpi-dept'); if (kd) kd.onchange = e => T.app.go('kpi', { ...f, dept: e.target.value, user: '' });
    const calc = () => {
      let n = 0, w = 0; T.KPI_PARAMS.forEach(p => { const val = +$(`[data-calc="${p.key}"]`).value; $(`[data-calc-v="${p.key}"]`).textContent = val + '%'; n += val * W[p.key]; w += W[p.key]; });
      const s = w ? n / w : 0, b = T.kpiBand(s); $('#calc-score').textContent = s.toFixed(1) + '%'; $('#calc-score').className = 'kpi-score ' + b.cls; $('#calc-band').textContent = b.label; $('#calc-band').className = 'band ' + b.cls;
    };
    $$('[data-calc]', v).forEach(i => i.oninput = calc); calc();
    $('#calc-reset').onclick = () => { [90, 95, 85, 80, 90].forEach((x, i) => $(`[data-calc="${T.KPI_PARAMS[i].key}"]`).value = x); calc(); };
    $('#kpi-exp').onclick = () => U.exportExcel(`task360-kpi-${range.label.replace(' ', '-')}`, rows.map(({ u, k }) => ({
      Employee: u.name, Department: T.deptNames(u), Period: range.label,
      ...Object.fromEntries(T.KPI_PARAMS.map(p => [p.label + ' %', k.metrics[p.key].value == null ? 'n/a' : k.metrics[p.key].value.toFixed(1)])),
      'KPI score %': k.score == null ? '' : k.score.toFixed(1), Band: k.band.label, 'Tasks': k.counts.total, 'Overdue': k.counts.overdue
    })));
  };

  /* ================= TEAM WORKLOAD ================= */
  V.team = (f, me) => {
    if (me.role === 'employee') return V.denied();
    const people = T.visibleUsers(me).filter(u => u.role === 'employee' || u.role === 'manager');
    const range = T.monthRange(0);
    const rows = people.map(u => {
      const ts = T.visibleTasks(me).filter(t => t.ownerId === u.id && !t.archived);
      const open = ts.filter(T.isOpen);
      return { u, open: open.length, od: open.filter(t => T.isOverdue(t)).length, crit: open.filter(t => t.priority === 'critical').length, today: open.filter(T.dueToday).length, review: ts.filter(t => t.status === 'pending_review').length, k: T.computeKpi(u.id, range.from, range.to) };
    });
    const admin = me.role === 'super_admin';
    const depts = T.visibleDepts(me).map(d => ({
      d, managers: D().users.filter(u => u.active && u.role === 'manager' && (u.teams || []).includes(d.id)),
      members: D().users.filter(u => u.active && T.userDepts(u).includes(d.id)).length,
      open: T.visibleTasks(me).filter(t => t.deptId === d.id && T.isOpen(t) && !t.archived).length
    }));
    $('#view').innerHTML = `<div class="page-head"><div><h1>Team management &amp; workload</h1><div class="sub">Check capacity before assigning · manage leave and backups${admin ? ' · add team members and departments' : ''}</div></div>
      ${admin ? `<div class="actions"><button class="btn primary" id="tm-add-user">＋ Add team member</button><button class="btn" id="tm-add-dept">＋ Add department</button></div>` : ''}</div>
      <div class="card" style="padding:0;margin-bottom:16px"><div class="card-head" style="padding:14px 16px 0"><h2>Departments</h2><span class="small muted">${depts.length} department(s)</span></div><div class="table-wrap"><table><thead><tr><th>Department</th><th>Managed by</th><th>Team members</th><th>Open tasks</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>
      ${depts.map(x => `<tr><td><span class="who"><i style="width:10px;height:10px;border-radius:3px;display:inline-block;background:${esc(x.d.color || 'var(--primary)')}"></i><b>${esc(x.d.name)}</b></span></td>
        <td class="small">${x.managers.map(m => esc(m.name)).join(', ') || '<span class="muted">No manager yet</span>'}</td>
        <td>${x.members}</td><td><a href="${T.drill({ dept: x.d.id, preset: 'pending' })}">${x.open}</a></td>
        ${admin ? `<td class="nowrap"><button class="btn sm" data-add-member="${x.d.id}">＋ Add member</button> <button class="btn sm" data-rename="${x.d.id}">Rename</button></td>` : ''}</tr>`).join('')}
      </tbody></table></div></div>
      ${admin && T.isShared() ? '<div id="tm-requests"></div>' : ''}
      ${(T.isShared() || T.isServer()) && admin ? `<div class="card" style="padding:0;margin-bottom:16px"><div class="card-head" style="padding:14px 16px 0"><h2>Sign-in status</h2><span class="small muted">${T.isServer() ? 'Username = work email. Give each person a temporary password; they choose their own at first sign-in.' : 'People sign in with their Claude account (same work email)'}</span></div><div class="table-wrap"><table><thead><tr><th>Member</th><th>Role</th><th>Work email (username)</th><th>Status</th>${T.isServer() ? '<th></th>' : ''}</tr></thead><tbody>
        ${D().users.filter(u => u.active).map(u => `<tr><td>${U.avatar(u.id)}</td><td class="small">${T.ROLES[u.role]}</td><td class="small">${esc(u.email || '—')}</td><td>${u.claudeId || u.linked ? '<span class="pill s-completed">Signed in</span>' : '<span class="pill s-assigned">Not signed in yet</span>'}</td>${T.isServer() ? `<td class="nowrap">${u.email ? `<button class="btn sm" data-setpw="${u.id}">${u.linked ? 'Reset password' : 'Set temporary password'}</button>` : '<span class="small muted">add email first</span>'}</td>` : ''}</tr>`).join('')}
      </tbody></table></div></div>` : ''}
      <div class="card" style="padding:0"><div class="card-head" style="padding:14px 16px 0"><h2>Team members &amp; workload</h2><span class="small muted">${rows.length} employee(s)</span></div><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Manager</th><th>Active</th><th>Overdue</th><th>Critical</th><th>Due today</th><th>In review</th><th>KPI (${range.label})</th><th>Leave / backup</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${U.avatar(r.u.id)}<div class="small muted">${T.ROLES[r.u.role]}</div></td><td class="small">${esc(T.deptNames(r.u))}</td><td class="small">${esc(T.userName(r.u.managerId))}</td>
        <td><a href="${T.drill({ owner: r.u.id, preset: 'pending' })}"><b>${r.open}</b></a></td><td><a href="${T.drill({ owner: r.u.id, status: 'overdue' })}" style="color:var(--danger)"><b>${r.od}</b></a></td><td>${r.crit}</td><td>${r.today}</td><td>${r.review}</td>
        <td class="${r.k.band.cls}"><b>${r.k.score == null ? '—' : r.k.score.toFixed(0) + '%'}</b></td>
        <td class="small">${r.u.onLeave ? `🏖 On leave → ${esc(T.userName(r.u.backupId))}` : '<span class="muted">Available</span>'}</td>
        <td class="nowrap"><button class="btn sm" data-assign="${r.u.id}">＋ Assign</button> <button class="btn sm" data-leave="${r.u.id}">${r.u.onLeave ? 'End leave' : 'Leave'}</button></td></tr>`).join('')}
      </tbody></table></div>${rows.length ? '' : `<div class="empty">No team members yet.${admin ? ' Click “＋ Add team member” to add the first one.' : ''}</div>`}</div>`;
    const v = $('#view');
    if (admin && T.isShared()) renderRequests(me);
    if (admin && T.isServer()) $$('[data-setpw]', v).forEach(b => b.onclick = () => {
      const u = T.user(b.dataset.setpw);
      U.modal(`${u.linked ? 'Reset' : 'Set'} password — ${u.name}`, T.config.initialPassword ? `<p><b>${esc(u.name)}</b> goes back to the company starting password. Any password they set stops working, and they must choose a new one when they next sign in.</p>` : `<p>This creates a new temporary password for <b>${esc(u.name)}</b>. Any password they had stops working. They must choose their own password the first time they sign in.</p>`,
        `<button class="btn" data-close>Cancel</button><button class="btn primary" id="pw-go">${T.config.initialPassword ? 'Reset to starting password' : 'Create temporary password'}</button>`, m => {
          $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
          $('#pw-go').onclick = () => { $('#pw-go').disabled = true; T.remote.setPassword(u.id).then(r => {
            const url = location.origin + '/login';
            if (r.initial) {
              $('.modal-body', m).innerHTML = `<div class="alert info">Password reset. ${esc(u.name)} signs in at <b>${esc(url)}</b> with <b>${esc(r.email)}</b> and the company starting password, then must choose a new password straight away. Their other sessions were signed out.</div>`;
              $('.modal-foot', m).innerHTML = '<button class="btn primary" data-close>Done</button>'; $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
              return;
            }
            $('.modal-body', m).innerHTML = `<div class="alert info">Share these privately with ${esc(u.name)} (for example in person or by Teams chat). This password is shown only once.</div>
              <dl class="meta-grid"><dt>Sign-in page</dt><dd><b>${esc(url)}</b></dd><dt>Username</dt><dd><b>${esc(r.email)}</b></dd><dt>Temporary password</dt><dd><b style="font-family:ui-monospace,Menlo,monospace;font-size:16px" id="pw-val">${esc(r.password)}</b></dd></dl>
              <button class="btn sm" id="pw-copy">Copy all</button>`;
            $('.modal-foot', m).innerHTML = '<button class="btn primary" data-close>Done</button>'; $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
            $('#pw-copy').onclick = () => navigator.clipboard.writeText(`Task360 sign-in: ${url}\nUsername: ${r.email}\nTemporary password: ${r.password}`).then(() => U.toast('Copied')).catch(() => U.toast('Select the text and copy it manually.', true));
          }).catch(e => { U.toast(e.message, true); const g = $('#pw-go'); if (g) g.disabled = false; }); };
        });
    });
    if (admin) {
      $('#tm-add-user').onclick = () => editUser(me, null);
      $('#tm-add-dept').onclick = () => deptModal(me, null);
      $$('[data-add-member]', v).forEach(b => b.onclick = () => editUser(me, null, b.dataset.addMember));
      $$('[data-rename]', v).forEach(b => b.onclick = () => deptModal(me, b.dataset.rename));
    }
    $$('[data-assign]', v).forEach(b => b.onclick = () => U.openCreate({ ownerId: b.dataset.assign, deptId: T.user(b.dataset.assign).deptId }));
    $$('[data-leave]', v).forEach(b => b.onclick = () => {
      const u = T.user(b.dataset.leave);
      if (u.onLeave) return U.act(() => T.api.setLeave(me, u.id, false), `${u.name} marked available`);
      const opts = people.filter(p => p.id !== u.id && !p.onLeave).map(p => `<option value="${p.id}">${esc(p.name)} — ${esc(T.deptNames(p))}</option>`).join('');
      U.modal(`Mark ${u.name} on leave`, `<div class="alert info">Open tasks are temporarily handed to the backup. Ownership history is retained, and new tasks assigned to ${esc(u.name)} route to the backup automatically.</div>
        <label class="field"><span>Backup employee</span><select class="input" id="lv-b">${opts}</select></label>`, `<button class="btn" data-close>Cancel</button><button class="btn primary" id="lv-ok">Confirm</button>`, m => {
        $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
        $('#lv-ok').onclick = () => { U.act(() => T.api.setLeave(me, u.id, true, $('#lv-b').value), 'Leave recorded; tasks handed to backup').then(ok => { if (ok) U.closeLayer(); }) };
      });
    });
  };

  /* ================= FOLLOW-UP CENTRE ================= */
  V.followups = (f, me) => {
    const all = D().notifications.filter(n => T.seesAll(me) || n.to === me.id || T.visibleUsers(me).some(u => u.id === n.to));
    const list = all.filter(n => !f.type || n.type === f.type).sort((a, b) => b.at - a.at).slice(0, 300);
    const R = D().settings.rules;
    const types = [...new Set(all.map(n => n.type))];
    const rules = [
      ['Task created', 'Assignment notification', 'Employee'], [`Not acknowledged in ${R.ackReminderHrs} hours`, 'Reminder', 'Employee'],
      [`${R.dueReminderHrs} hours before deadline`, 'Deadline reminder', 'Employee'], [`${R.urgentReminderHrs} hours before deadline`, 'Urgent reminder', 'Employee'],
      ['Deadline crossed', 'Overdue notification', 'Employee'], [`Overdue by ${R.escalation1Days} working day(s)`, 'First escalation', 'Reporting manager'],
      [`Overdue by ${R.escalation2Days} working days`, 'Second escalation', 'Department head'], ['Task reassigned', 'Reassignment notification', 'Old and new assignee'],
      ['Completion submitted', 'Review notification', 'Task creator / reviewer'], [`Daily at ${R.dailyFollowUpTime} (working days)`, 'Daily follow-up (if enabled)', 'Employee'],
      [`Working days at ${R.digestTime}`, 'Daily management digest', 'Managers'], ['Every Monday', 'Weekly performance summary', 'Manager'], ['Month-end', 'Monthly KPI report', 'Department head']
    ];
    $('#view').innerHTML = `<div class="page-head"><div><h1>Follow-up centre</h1><div class="sub">Automatic reminders &amp; escalations · last engine run ${T.engine.lastRun ? T.fmt(T.engine.lastRun) : 'never'} · duplicates prevented by delivery keys</div></div>
      <div class="actions"><button class="btn primary" id="run-engine">▶ Run follow-up engine now</button><button class="btn" id="fu-exp">Export log</button></div></div>
      <div class="dash-grid"><div class="card span-5"><div class="card-head"><h2>Escalation matrix</h2>${me.role === 'super_admin' ? '<a href="#/admin">Configure →</a>' : ''}</div>
        <table><thead><tr><th>Trigger</th><th>Action</th><th>Recipient</th></tr></thead><tbody>${rules.map(r => `<tr><td class="small">${r[0]}</td><td class="small">${r[1]}</td><td class="small">${r[2]}</td></tr>`).join('')}</tbody></table>
        <p class="small muted">Reminders stop automatically when a task is submitted, completed or cancelled. ${T.isShared() ? 'On this team page, reminders and escalations are created while anyone on the team has Task360 open, and arrive in the 🔔 notification centre (email and Teams need the server edition).' : T.isServer() ? 'Email &amp; Teams are sent by the server through Microsoft Graph; ✓ sent · ~ queued · ✕ failed · – skipped (channel not configured).' : 'Email &amp; Teams deliveries are <b>simulated</b> in this standalone build; the server edition sends them via Microsoft Graph and records the delivery status here.'}</p></div>
      <div class="card span-7"><div class="card-head"><h2>Notification delivery history</h2><select class="input" id="fu-type" style="width:auto"><option value="">All types</option>${types.map(t => `<option value="${t}" ${f.type === t ? 'selected' : ''}>${esc(T.notifTypeLabel(t))}</option>`).join('')}</select></div>
        <div class="table-wrap" style="max-height:620px"><table><thead><tr><th>When (IST)</th><th>Type</th><th>To</th><th>Message</th><th>Channels</th></tr></thead><tbody>
        ${list.map(n => `<tr ${n.taskId ? `class="click" data-task="${n.taskId}"` : ''}><td class="small nowrap">${T.fmt(n.at)}</td><td class="small">${esc(T.notifTypeLabel(n.type))}</td><td class="small nowrap">${esc(T.userName(n.to))}</td><td class="small">${esc(n.message)}</td><td class="small nowrap">${n.channels.map(c => `<span title="${esc(c.status + (c.error ? ': ' + c.error : ''))}">${c.channel === 'in-app' ? '🔔' : c.channel === 'email' ? '✉' : '💬'}${({ delivered: '✓', sent: '✓', failed: '✕', skipped: '–' })[c.status] || '~'}</span>`).join(' ')}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No notifications</td></tr>'}
        </tbody></table></div></div></div>`;
    const v = $('#view'); wireRows(v);
    $('#run-engine').onclick = () => Promise.resolve(T.isServer() ? T.remote.runEngine() : T.engine.run())
      .then(n => { U.toast(n ? `${n} new notification(s) sent` : 'Engine ran — nothing new to send (duplicates suppressed)'); T.app.refresh(); })
      .catch(e => U.toast(e.message, true));
    $('#fu-type').onchange = e => T.app.go('followups', { type: e.target.value });
    $('#fu-exp').onclick = () => U.exportCSV('task360-notifications', list.map(n => ({ 'When (IST)': T.fmt(n.at), Type: T.notifTypeLabel(n.type), To: T.userName(n.to), Task: n.taskId || '', Message: n.message, Channels: n.channels.map(c => `${c.channel}:${c.status}`).join(' ') })));
  };

  /* ================= RECURRING ================= */
  V.recurring = (f, me) => {
    const list = D().recurring.filter(r => T.seesAll(me) || r.ownerId === me.id || r.createdBy === me.id || T.reportees(me).has(r.ownerId));
    const fr = r => r.frequency === 'weekly' ? `Weekly · ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][r.weekday ?? 5]}` : r.frequency === 'daily' ? 'Daily · working days' : `${r.frequency[0].toUpperCase() + r.frequency.slice(1)} · day ${r.dayOfMonth}`;
    $('#view').innerHTML = `<div class="page-head"><div><h1>Recurring tasks</h1><div class="sub">Templates generate a new task each period automatically</div></div>
      <div class="actions">${T.canCreate(me) ? '<button class="btn primary" id="rec-new">＋ New recurring task</button>' : ''}<a class="btn" href="${T.drill({ preset: 'recurring' })}">View generated instances</a></div></div>
      <div class="card" style="padding:0"><table><thead><tr><th>Template</th><th>Schedule</th><th>Due time</th><th>Assignee</th><th>Department</th><th>Priority</th><th>Last generated</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map(r => `<tr><td class="task-title">${esc(r.title)}</td><td class="small">${fr(r)}</td><td class="small">${r.dueTime} IST</td><td>${U.avatar(r.ownerId)}</td><td class="small">${esc(T.deptName(r.deptId))}</td><td>${U.priority(r.priority)}</td><td class="small">${esc(r.lastKey || '—')}</td>
        <td>${r.active ? '<span class="pill s-completed">Active</span>' : '<span class="pill s-cancelled">Paused</span>'}</td><td>${T.canCreate(me) ? `<button class="btn sm" data-toggle="${r.id}">${r.active ? 'Pause' : 'Resume'}</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No recurring tasks</td></tr>'}
      </tbody></table></div>`;
    const v = $('#view');
    $$('[data-toggle]', v).forEach(b => b.onclick = () => U.act(() => T.api.toggleRecurring(me, b.dataset.toggle), 'Updated'));
    const nb = $('#rec-new'); if (nb) nb.onclick = () => {
      const users = T.assignableUsers(me);
      U.modal('New recurring task', `<label class="field"><span>Title *</span><input class="input" id="rc-t" placeholder="e.g. Daily bank reconciliation"></label>
        <div class="grid2"><label class="field"><span>Frequency</span><select class="input" id="rc-f"><option value="daily">Daily (working days)</option><option value="weekly">Weekly</option><option value="monthly" selected>Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></label>
        <label class="field"><span>Day of month / weekday (0=Sun)</span><input class="input" type="number" id="rc-d" value="10" min="0" max="28"></label></div>
        <div class="grid2"><label class="field"><span>Assignee</span><select class="input" id="rc-o">${users.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Due time (IST)</span><input class="input" type="time" id="rc-tm" value="18:00"></label></div>
        <div class="grid2"><label class="field"><span>Priority</span><select class="input" id="rc-p">${T.PRIORITIES.map(p => `<option value="${p.id}" ${p.id === 'high' ? 'selected' : ''}>${p.label}</option>`).join('')}</select></label>
        <label class="field"><span>Category</span><select class="input" id="rc-c">${T.CATEGORIES.map(c => `<option>${esc(c)}</option>`).join('')}</select></label></div>
        <label class="check"><input type="checkbox" id="rc-appr-on"> Each task requires approval before submission</label>
        <div id="rc-appr" class="hidden">${U.approvalEditor([], null)}</div>`,
        `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rc-ok">Save template</button>`, m => {
          $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
          U.wireApprovalEditor($('#rc-appr'));
          $('#rc-appr-on').onchange = e => $('#rc-appr').classList.toggle('hidden', !e.target.checked);
          $('#rc-ok').onclick = () => {
            const fq = $('#rc-f').value, dn = +$('#rc-d').value, owner = T.user($('#rc-o').value);
            const p = T.PRIORITIES.find(x => x.id === $('#rc-p').value);
            U.act(() => T.api.saveRecurring(me, { title: $('#rc-t').value, frequency: fq, dayOfMonth: dn || 1, weekday: Math.min(dn, 6), ownerId: owner && owner.id, deptId: owner && owner.deptId, dueTime: $('#rc-tm').value, priority: p.id, tatHrs: p.tat, category: $('#rc-c').value, approvals: $('#rc-appr-on').checked ? U.readApprovals($('#rc-appr')) : [] }), 'Recurring template saved').then(ok => { if (ok) U.closeLayer(); })
          };
        });
    };
  };

  /* ================= REPORTS ================= */
  V.reports = (f, me) => {
    const period = f.period || 'month';
    const now = Date.now();
    const range = period === 'week' ? { from: now - 7 * T.DAY, to: now, label: 'Last 7 days' } : period === 'prev' ? T.monthRange(-1) : T.monthRange(0);
    const vis = T.visibleTasks(me).filter(t => t.status !== 'cancelled');
    const created = vis.filter(t => t.createdAt >= range.from && t.createdAt <= range.to);
    const completed = vis.filter(t => t.completedAt && t.completedAt >= range.from && t.completedAt <= range.to);
    const dueIn = vis.filter(t => t.kpiDueAt >= range.from && t.kpiDueAt <= Math.min(range.to, now));
    const ontime = dueIn.filter(t => T.submittedOnTime(t));
    const overdueNow = vis.filter(t => T.isOverdue(t));
    const byDept = T.visibleDepts(me).map(d => {
      const due = dueIn.filter(t => t.deptId === d.id);
      return { d, created: created.filter(t => t.deptId === d.id).length, completed: completed.filter(t => t.deptId === d.id).length, due: due.length, ot: due.filter(t => T.submittedOnTime(t)).length, od: overdueNow.filter(t => t.deptId === d.id).length };
    });
    const tatRows = completed.filter(t => t.firstSubmittedAt).map(t => ({ t, a: T.actualTatHrs(t) })).sort((a, b) => (b.a - b.t.expectedTatHrs) - (a.a - a.t.expectedTatHrs)).slice(0, 10);
    $('#view').innerHTML = `<div class="page-head"><div><h1>Reports &amp; analytics</h1><div class="sub">${range.label}</div></div>
      <div class="actions"><div class="seg">${[['week', 'Weekly'], ['month', 'This month'], ['prev', 'Last month']].map(([k, l]) => `<button data-period="${k}" class="${period === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="btn" id="rp-xls">Export Excel</button><button class="btn" id="rp-print">Print / PDF</button></div></div>
      <div class="cards">
        <div class="card stat" data-go="${T.drill({})}"><div class="label">Tasks created</div><div class="value">${created.length}</div></div>
        <div class="card stat green" data-go="${T.drill({ status: 'completed' })}"><div class="label">Tasks completed</div><div class="value">${completed.length}</div></div>
        <div class="card stat blue"><div class="label">Due in period</div><div class="value">${dueIn.length}</div></div>
        <div class="card stat green" data-go="${T.drill({ preset: 'ontime' })}"><div class="label">On-time rate</div><div class="value">${pct(ontime.length, dueIn.length)}%</div></div>
        <div class="card stat red" data-go="${T.drill({ status: 'overdue' })}"><div class="label">Overdue now</div><div class="value">${overdueNow.length}</div></div>
      </div>
      <div class="dash-grid">
        <div class="card span-7"><div class="card-head"><h2>Department summary</h2></div><table><thead><tr><th>Department</th><th>Created</th><th>Completed</th><th>Due</th><th>On-time</th><th>Overdue now</th></tr></thead><tbody>
          ${byDept.map(x => `<tr class="click" data-go="${T.drill({ dept: x.d.id })}"><td>${esc(x.d.name)}</td><td>${x.created}</td><td>${x.completed}</td><td>${x.due}</td><td><b>${x.due ? pct(x.ot, x.due) + '%' : '—'}</b></td><td style="color:var(--danger)">${x.od}</td></tr>`).join('')}</tbody></table></div>
        <div class="card span-5"><div class="card-head"><h2>Largest TAT deviations</h2></div><table><thead><tr><th>Task</th><th>Expected</th><th>Actual</th></tr></thead><tbody>
          ${tatRows.map(({ t, a }) => `<tr class="click" data-task="${t.id}"><td class="small"><b>${esc(t.title)}</b><br><span class="muted">${esc(T.userName(t.ownerId))}</span></td><td class="small">${t.expectedTatHrs} h</td><td class="small" style="color:${a > t.expectedTatHrs ? 'var(--danger)' : 'var(--ok)'}">${T.fmtHrs(a)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No completed tasks in period</td></tr>'}</tbody></table></div>
        <div class="card span-12"><div class="card-head"><h2>Overdue task report</h2></div>${U.taskTable(U.sortTasks(overdueNow, 'due'))}</div>
      </div>`;
    const v = $('#view'); wireGo(v); wireRows(v);
    $$('[data-period]', v).forEach(b => b.onclick = () => T.app.go('reports', { period: b.dataset.period }));
    $('#rp-print').onclick = () => window.print();
    $('#rp-xls').onclick = () => U.exportExcel(`task360-report-${period}`, U.taskRows([...new Set([...created, ...completed, ...overdueNow])]));
  };

  /* ================= AUDIT ================= */
  V.audit = (f, me) => {
    if (me.role === 'employee') return V.denied();
    const q = (f.q || '').toLowerCase();
    const list = D().audit.filter(a => T.seesAll(me) ? true : a.taskId ? T.canView(me, T.task(a.taskId)) : false)
      .filter(a => !f.action || a.action === f.action)
      .filter(a => !q || `${a.taskId} ${a.detail} ${T.userName(a.by)}`.toLowerCase().includes(q))
      .sort((a, b) => b.at - a.at);
    const actions = [...new Set(D().audit.map(a => a.action))].sort();
    $('#view').innerHTML = `<div class="page-head"><div><h1>Audit trail</h1><div class="sub">Append-only log of every assignment, reassignment, deadline change, comment and status update · ${list.length} entries</div></div>
      <div class="actions"><button class="btn" id="au-exp">Export CSV</button></div></div>
      <div class="filters"><input class="input" data-f="q" placeholder="Search audit…" value="${esc(f.q || '')}"><select class="input" data-f="action"><option value="">All actions</option>${actions.map(a => `<option ${f.action === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
      <div class="card" style="padding:0"><div class="table-wrap" style="max-height:70vh"><table><thead><tr><th>When (IST)</th><th>User</th><th>Action</th><th>Task</th><th>Detail</th></tr></thead><tbody>
      ${list.slice(0, 500).map(a => `<tr ${a.taskId ? `class="click" data-task="${a.taskId}"` : ''}><td class="small nowrap">${T.fmt(a.at)}</td><td class="small nowrap">${esc(T.userName(a.by))}</td><td><span class="pill s-acknowledged">${esc(a.action)}</span></td><td class="tid">${a.taskId || ''}</td><td class="small">${esc(a.detail)}</td></tr>`).join('')}
      </tbody></table></div>${list.length > 500 ? '<div class="small muted" style="padding:10px">Showing latest 500 — export for the full log.</div>' : ''}</div>`;
    const v = $('#view'); wireFilters(v, f, 'audit'); wireRows(v);
    $('#au-exp').onclick = () => U.exportCSV('task360-audit', list.map(a => ({ 'When (IST)': T.fmt(a.at), User: T.userName(a.by), Action: a.action, Task: a.taskId || '', Detail: a.detail })));
  };

  /* ================= ADMIN ================= */
  V.admin = (f, me) => {
    if (me.role !== 'super_admin') return V.denied('Admin settings are available to the Super Admin only.');
    const s = D().settings, tab = f.tab || 'users';
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const body = {
      users: `<div class="card" style="padding:0"><table><thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Reports to</th><th>Email</th><th>Status</th><th></th></tr></thead><tbody>
        ${D().users.map(u => `<tr><td>${U.avatar(u.id)}</td><td>${T.ROLES[u.role]}</td><td class="small">${esc(T.deptNames(u))}${u.role === 'manager' ? ' <span class="muted">(runs)</span>' : ''}</td><td class="small">${esc(u.managerId ? T.userName(u.managerId) : '—')}</td><td class="small">${esc(u.email)}</td><td>${u.active ? '<span class="pill s-completed">Active</span>' : '<span class="pill s-cancelled">Inactive</span>'}</td><td><button class="btn sm" data-edit="${u.id}">Edit</button></td></tr>`).join('')}
        </tbody></table></div><div style="margin-top:10px;display:flex;gap:8px"><button class="btn primary" data-edit="">＋ Add team member</button><button class="btn" id="nd-add">＋ Add department</button></div>`,
      kpi: `<div class="card" style="max-width:640px"><h2>KPI weightage</h2><p class="small muted">Must total 100%. Changes apply to all KPI calculations immediately and are audited.</p>
        ${T.KPI_PARAMS.map(p => `<div class="slider-row"><span>${p.label}</span><input type="number" class="input" min="0" max="100" data-w="${p.key}" value="${s.kpiWeights[p.key]}"><span>%</span></div>`).join('')}
        <div id="w-total" class="small"></div>
        <label class="check"><input type="checkbox" id="pol-ext" ${s.kpiPolicy.excludeExternal ? 'checked' : ''}> Exclude approved external dependencies from timeliness KPIs</label>
        <label class="check"><input type="checkbox" id="pol-can" ${s.kpiPolicy.excludeCancelled ? 'checked' : ''}> Exclude cancelled tasks</label>
        <button class="btn primary" id="w-save">Save KPI settings</button></div>`,
      rules: `<div class="card" style="max-width:640px"><h2>Reminder &amp; escalation rules</h2>
        <div class="grid2">
          <label class="field"><span>Acknowledgement reminder after (hours)</span><input class="input" type="number" min="1" data-r="ackReminderHrs" value="${s.rules.ackReminderHrs}"></label>
          <label class="field"><span>Deadline reminder (hours before)</span><input class="input" type="number" min="1" data-r="dueReminderHrs" value="${s.rules.dueReminderHrs}"></label>
          <label class="field"><span>Urgent reminder (hours before)</span><input class="input" type="number" min="1" data-r="urgentReminderHrs" value="${s.rules.urgentReminderHrs}"></label>
          <label class="field"><span>Daily follow-up time (IST)</span><input class="input" type="time" data-r="dailyFollowUpTime" value="${s.rules.dailyFollowUpTime}"></label>
          <label class="field"><span>1st escalation — overdue working days</span><input class="input" type="number" min="1" data-r="escalation1Days" value="${s.rules.escalation1Days}"></label>
          <label class="field"><span>2nd escalation — overdue working days</span><input class="input" type="number" min="1" data-r="escalation2Days" value="${s.rules.escalation2Days}"></label>
          <label class="field"><span>Morning digest time (IST)</span><input class="input" type="time" data-r="digestTime" value="${s.rules.digestTime}"></label>
        </div>
        <div class="section-title">Channels</div>
        <label class="check"><input type="checkbox" data-ch="inApp" ${s.channels.inApp ? 'checked' : ''}> In-app notification centre</label>
        <label class="check"><input type="checkbox" data-ch="email" ${s.channels.email ? 'checked' : ''}> Outlook / email (via Microsoft Graph — server)</label>
        <label class="check"><input type="checkbox" data-ch="teams" ${s.channels.teams ? 'checked' : ''}> Microsoft Teams (via Graph / webhook — server)</label>
        <button class="btn primary" id="r-save">Save rules</button></div>`,
      calendar: `<div class="card" style="max-width:640px"><h2>Working days, hours &amp; holidays</h2>
        <div class="section-title">Working days</div><div style="display:flex;gap:10px;flex-wrap:wrap">${days.map((d, i) => `<label class="check"><input type="checkbox" data-day="${i}" ${s.workingDays.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
        <div class="grid2"><label class="field"><span>Business hours start</span><input class="input" type="time" id="bh-s" value="${s.businessHours.start}"></label><label class="field"><span>Business hours end</span><input class="input" type="time" id="bh-e" value="${s.businessHours.end}"></label></div>
        <button class="btn primary" id="cal-save">Save</button>
        <div class="section-title">Holidays</div>
        <table><tbody>${s.holidays.sort((a, b) => a.date.localeCompare(b.date)).map((h, i) => `<tr><td>${h.date}</td><td>${esc(h.name)}</td><td><button class="btn sm danger" data-delhol="${h.date}">Remove</button></td></tr>`).join('')}</tbody></table>
        <div style="display:flex;gap:6px;margin-top:8px"><input class="input" type="date" id="hol-d"><input class="input" id="hol-n" placeholder="Holiday name"><button class="btn" id="hol-add">Add</button></div></div>`,
      data: T.isShared() ? `<div class="card" style="max-width:680px"><h2>Data</h2><div class="alert info">Every change is saved straight away to this page’s shared database and kept permanently, so you can review it later. Each task keeps its full history (who did what and when), approvals and comments; the Audit Trail shows everything together.</div>
        <button class="btn" id="dt-exp">Download a copy (JSON)</button></div>` : T.isServer() ? `<div class="card" style="max-width:640px"><h2>Data</h2><div class="alert info">Data is stored in the shared PostgreSQL database${D().demo ? ' and currently contains <b>demonstration data</b> (see server/README.md to start with an empty database)' : ''}. Database backups are handled by Supabase.</div>
        <button class="btn" id="dt-exp">Download snapshot of what you can see (JSON)</button></div>` : `<div class="card" style="max-width:640px"><h2>Data</h2><div class="alert warn">This standalone build stores <b>demonstration data</b> in this browser only. Deploy the server edition (see server/README.md) for multi-user access and permanent storage.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="dt-exp">Download backup (JSON)</button><label class="btn">Restore backup<input type="file" id="dt-imp" accept=".json" hidden></label><button class="btn danger" id="dt-reset">${window.T360_SEED ? 'Start the trial again' : 'Reset demo data'}</button><button class="btn danger" id="dt-empty">Start empty workspace</button></div>
        <p class="small muted">“Start empty workspace” clears all demo tasks and people and keeps your departments, with ${esc((D().users.find(u => u.role === 'super_admin') || {}).name || 'you')} as Super Admin.</p></div>`
    };
    $('#view').innerHTML = `<div class="page-head"><div><h1>Admin settings</h1><div class="sub">System configuration — every change is audited</div></div></div>
      <div class="tabs">${[['users', 'Users & departments'], ['kpi', 'KPI policy'], ['rules', 'Reminders & escalation'], ['calendar', 'Working calendar'], ['data', 'Data']].map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>${body[tab]}`;
    const v = $('#view');
    $$('[data-tab]', v).forEach(b => b.onclick = () => T.app.go('admin', { tab: b.dataset.tab }));
    if (tab === 'users') {
      $$('[data-edit]', v).forEach(b => b.onclick = () => editUser(me, b.dataset.edit));
      $('#nd-add').onclick = () => deptModal(me, null);
    }
    if (tab === 'kpi') {
      const tot = () => { const t = $$('[data-w]', v).reduce((a, i) => a + (+i.value || 0), 0); $('#w-total').innerHTML = `Total: <b style="color:${t === 100 ? 'var(--ok)' : 'var(--danger)'}">${t}%</b>`; return t; };
      $$('[data-w]', v).forEach(i => i.oninput = tot); tot();
      $('#w-save').onclick = () => {
        if (tot() !== 100) return U.toast('Weights must total exactly 100%.', true);
        const w = Object.fromEntries($$('[data-w]', v).map(i => [i.dataset.w, +i.value]));
        U.act(() => T.api.updateSettings(me, { kpiWeights: w, kpiPolicy: { excludeExternal: $('#pol-ext').checked, excludeCancelled: $('#pol-can').checked } }, `KPI weights set to ${JSON.stringify(w)}`), 'KPI settings saved');
      };
    }
    if (tab === 'rules') $('#r-save').onclick = () => {
      const rules = { ...s.rules }; $$('[data-r]', v).forEach(i => rules[i.dataset.r] = i.type === 'number' ? Math.max(1, +i.value) : i.value);
      if (rules.escalation2Days <= rules.escalation1Days) return U.toast('Second escalation must be later than the first.', true);
      const channels = Object.fromEntries($$('[data-ch]', v).map(i => [i.dataset.ch, i.checked]));
      U.act(() => T.api.updateSettings(me, { rules, channels }, 'Reminder/escalation rules updated'), 'Rules saved');
    };
    if (tab === 'calendar') {
      $('#cal-save').onclick = () => {
        const wd = $$('[data-day]', v).filter(i => i.checked).map(i => +i.dataset.day);
        if (!wd.length) return U.toast('Select at least one working day.', true);
        U.act(() => T.api.updateSettings(me, { workingDays: wd, businessHours: { start: $('#bh-s').value, end: $('#bh-e').value } }, 'Working calendar updated'), 'Saved');
      };
      $('#hol-add').onclick = () => {
        const d = $('#hol-d').value, n = $('#hol-n').value.trim(); if (!d || !n) return U.toast('Enter date and name.', true);
        U.act(() => T.api.updateSettings(me, { holidays: [...s.holidays.filter(h => h.date !== d), { date: d, name: n }] }, `Holiday added: ${d} ${n}`), 'Holiday added');
      };
      $$('[data-delhol]', v).forEach(b => b.onclick = () => U.act(() => T.api.updateSettings(me, { holidays: s.holidays.filter(h => h.date !== b.dataset.delhol) }, `Holiday removed: ${b.dataset.delhol}`), 'Removed'));
    }
    if (tab === 'data') {
      $('#dt-exp').onclick = () => U.download('task360-backup.json', T.store.exportJSON(), 'application/json');
      if (T.isServer() || T.isShared()) return;
      $('#dt-imp').onchange = e => { const fl = e.target.files[0]; if (!fl) return; fl.text().then(txt => U.act(() => T.store.importJSON(txt), 'Backup restored')); };
      const twoStep = (btn, label, fn) => btn.onclick = () => { if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = label; return; } fn(); };
      twoStep($('#dt-reset'), window.T360_SEED ? 'Click again to start the trial again' : 'Click again to reload demo data', () => { T.store.reset(); T.engine.run(); U.toast(window.T360_SEED ? 'Trial started again' : 'Demo data reloaded'); T.app.refresh(); });
      twoStep($('#dt-empty'), 'Click again to clear all demo data', () => { T.store.resetEmpty(); U.toast('Demo data cleared — empty workspace ready'); T.app.go('team'); T.app.refresh(); });
    }
  };
  /* Add or rename a department (Super Admin). */
  function deptModal(me, id) {
    const dept = id ? T.dept(id) : null;
    const mgrs = D().users.filter(u => u.active && u.role === 'manager');
    U.modal(dept ? 'Rename department' : 'Add department', `<label class="field"><span>Department name *</span><input class="input" id="dm-n" maxlength="80" placeholder="e.g. Taxation, Payroll, Internal Audit" value="${esc(dept ? dept.name : '')}"></label>
      ${dept ? '' : `<label class="field"><span>Managed by (reporting manager)</span><select class="input" id="dm-m"><option value="">— assign later —</option>${mgrs.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></label>
      <p class="small muted">The manager can then assign and review this department’s tasks. You can also give a manager more departments when editing them.</p>`}`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="dm-ok">${dept ? 'Save' : 'Add department'}</button>`, m => {
        $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
        $('#dm-ok').onclick = () => {
          const name = $('#dm-n').value;
          U.act(() => dept ? T.api.renameDept(me, id, name) : T.api.saveDept(me, name, $('#dm-m').value || null), dept ? 'Department renamed' : `Department “${name.trim()}” added`)
            .then(ok => { if (ok) U.closeLayer(); });
        };
      });
  }

  /* Access requests from people who opened the team page but are not on the team yet. */
  async function renderRequests(me) {
    const box = $('#tm-requests'); if (!box) return;
    const reqs = T.shared.requests(); if (!reqs.length) { box.innerHTML = ''; return; }
    const ps = await T.shared.profiles(reqs.map(r => r.claudeId));
    if (!$('#tm-requests')) return;
    box.innerHTML = `<div class="card" style="padding:0;margin-bottom:16px"><div class="card-head" style="padding:14px 16px 0"><h2>Access requests</h2><span class="small muted">${reqs.length} waiting</span></div><div class="table-wrap"><table><tbody>
      ${reqs.map(r => `<tr><td data-rq-name="${esc(r.claudeId)}"></td><td class="small" data-rq-email="${esc(r.claudeId)}"></td><td class="small muted">${T.fmt(r.at)}</td><td class="nowrap"><button class="btn sm primary" data-rq-add="${esc(r.claudeId)}">Add to team</button> <button class="btn sm" data-rq-no="${esc(r.claudeId)}">Dismiss</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
    reqs.forEach(r => {
      const p = ps[r.claudeId] || {};
      box.querySelector(`[data-rq-name="${CSS.escape(r.claudeId)}"]`).textContent = p.name || 'Someone in your organization';
      box.querySelector(`[data-rq-email="${CSS.escape(r.claudeId)}"]`).textContent = p.email || '';
    });
    $$('[data-rq-add]', box).forEach(b => b.onclick = () => { const p = ps[b.dataset.rqAdd] || {}; editUser(me, null, null, { name: p.name || '', email: p.email || '', claudeId: b.dataset.rqAdd }); });
    $$('[data-rq-no]', box).forEach(b => b.onclick = () => T.shared.dismissRequest(b.dataset.rqNo).then(() => renderRequests(me)).catch(e => U.toast(e.message || 'Could not dismiss', true)));
  }

  function editUser(me, id, presetDept, preset) {
    const depts = D().departments;
    const deptMgr = d => (D().users.find(x => x.active && x.role === 'manager' && (x.teams || []).includes(d)) || {}).id || '';
    const startDept = presetDept || (depts[0] && depts[0].id) || null;
    const u = id ? T.user(id) : { name: (preset && preset.name) || '', role: 'employee', deptId: startDept, depts: startDept && presetDept ? [startDept] : [], managerId: presetDept ? deptMgr(startDept) : '', email: (preset && preset.email) || '', teams: [] };
    const self = id && id === me.id;
    const mine = T.userDepts(u);
    let claudeId = (preset && preset.claudeId) || null;
    const mgrs = D().users.filter(x => x.role !== 'employee' && x.id !== id && x.active);
    U.modal(id ? 'Edit team member' : 'Add team member', `${!id && T.isShared() ? `<label class="field"><span>Find a colleague in your organization</span><input class="input" id="eu-find" placeholder="Type a name or email" autocomplete="off"></label><div id="eu-hits" class="small" style="margin:-6px 0 10px"></div>` : ''}<label class="field"><span>Full name *</span><input class="input" id="eu-n" value="${esc(u.name)}"></label>
      <label class="field"><span>Work email${T.isServer() || T.isShared() ? ' * (the email they sign in with)' : ''}</span><input class="input" id="eu-e" type="email" value="${esc(u.email)}" placeholder="name@company.com"></label>
      <label class="field"><span>Role</span><select class="input" id="eu-r" ${self ? 'disabled title="You cannot change your own role"' : ''}>${Object.entries(T.ROLES).map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select>${self ? '<span class="small muted">You cannot change your own role.</span>' : ''}</label>
      <label class="field"><span>Departments (tick all that apply)</span><div style="display:flex;gap:4px 14px;flex-wrap:wrap">${depts.map(d => `<label class="check" style="margin:0"><input type="checkbox" data-dept="${d.id}" ${mine.includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('')}</div><span class="small muted" id="eu-dept-hint"></span></label>
      <label class="field"><span>Reports to</span><select class="input" id="eu-m"><option value="">— none —</option>${mgrs.map(m => `<option value="${m.id}" ${u.managerId === m.id ? 'selected' : ''}>${esc(m.name)} (${T.ROLES[m.role]})</option>`).join('')}</select></label>
      ${id && !self ? `<label class="check"><input type="checkbox" id="eu-a" ${u.active ? 'checked' : ''}> Active</label>` : ''}`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="eu-ok">Save</button>`, m => {
        $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
        const hint = { employee: 'Sees and works on tasks assigned to them.', manager: 'A Reporting Manager assigns, reviews and approves tasks in every department ticked.', dept_head: 'Sees all departments.', super_admin: 'Sees all departments and manages people, departments and settings.' };
        const syncRole = () => { $('#eu-dept-hint').textContent = hint[$('#eu-r').value] || ''; };
        $('#eu-r').onchange = syncRole; syncRole();
        if (!id) $$('[data-dept]', m).forEach(c => c.onchange = () => { if (!$('#eu-m').value && c.checked) { const mg = deptMgr(c.dataset.dept); if (mg) $('#eu-m').value = mg; } });
        const find = $('#eu-find');
        if (find) {
          const show = hits => {
            const box = $('#eu-hits'); box.innerHTML = '';
            hits.forEach(h => { const a = document.createElement('button'); a.type = 'button'; a.className = 'chip'; a.style.margin = '2px'; a.textContent = h.name + (h.email ? ` · ${h.email}` : '');
              a.onclick = () => { $('#eu-n').value = h.name; if (h.email) $('#eu-e').value = h.email; claudeId = h.id; box.textContent = `Selected: ${h.name}`; }; box.appendChild(a); });
          };
          find.onfocus = () => T.shared.search('').then(show);
          find.oninput = () => T.shared.search(find.value).then(show);
        }
        $('#eu-ok').onclick = () => {
          const picked = $$('[data-dept]', m).filter(i => i.checked).map(i => i.dataset.dept);
          const rec = { id: id || undefined, name: $('#eu-n').value.trim(), email: $('#eu-e').value.trim(), role: $('#eu-r').value, depts: picked, deptId: picked[0] || null, managerId: $('#eu-m').value || null, teams: [] };
          if (id) rec.active = self ? true : $('#eu-a').checked;
          if (!id && (T.isServer() || T.isShared()) && !rec.email) return U.toast('Email is required — the person signs in with it.', true);
          if (!id && claudeId) rec.claudeId = claudeId;
          U.act(() => T.api.saveUser(me, rec), id ? 'Team member updated' : `${rec.name} added to the team`).then(ok => {
            if (!ok) return;
            U.closeLayer(); T.app.renderUserSwitch();
            if (!id && T.isShared() && claudeId) T.shared.dismissRequest(claudeId).catch(() => {});
          })
        };
      });
  }

  /* ================= AI ASSISTANT (rule-based, data-grounded) ================= */
  const chatLog = [];
  T.assistantAnswer = (q, me) => {
    const s = q.toLowerCase();
    const vis = T.visibleTasks(me).filter(t => !t.archived && t.status !== 'cancelled');
    const open = vis.filter(T.isOpen);
    const line = t => `• ${t.id} ${t.title} — ${T.userName(t.ownerId)}, due ${T.fmt(t.dueAt)}${T.isOverdue(t) ? ` (OVERDUE ${T.overdueDays(t)}d)` : ''}`;
    const emps = T.visibleUsers(me).filter(u => u.role === 'employee' || u.role === 'manager');
    if (/attention|today|focus|priorit/.test(s)) {
      const od = open.filter(t => T.isOverdue(t)).sort((a, b) => a.dueAt - b.dueAt), today = open.filter(t => T.dueToday(t) && !T.isOverdue(t)), rev = open.filter(t => t.status === 'pending_review' && t.ownerId !== me.id), crit = open.filter(t => t.priority === 'critical' && !T.isOverdue(t));
      return `Here is what needs your attention:\n\n🔴 Overdue (${od.length}):\n${od.slice(0, 6).map(line).join('\n') || '  none'}\n\n🟠 Due today (${today.length}):\n${today.slice(0, 6).map(line).join('\n') || '  none'}\n\n🟣 Awaiting your approval (${rev.length}):\n${rev.slice(0, 5).map(line).join('\n') || '  none'}\n\n⚡ Other critical open (${crit.length}):\n${crit.slice(0, 4).map(line).join('\n') || '  none'}\n\nRecommendation: clear approvals first (they unblock KPI credit), then chase the oldest overdue items.`;
    }
    if (/pendency|workload|most tasks|highest|busiest|capacity/.test(s)) {
      const r = emps.map(u => ({ u, o: open.filter(t => t.ownerId === u.id).length, od: open.filter(t => t.ownerId === u.id && T.isOverdue(t)).length })).sort((a, b) => b.o - a.o);
      if (!r.length) return 'No employees in your scope.';
      const light = [...r].sort((a, b) => a.o - b.o)[0];
      return `Pendency by employee (open tasks / overdue):\n${r.map(x => `• ${x.u.name}: ${x.o} open / ${x.od} overdue`).join('\n')}\n\nHighest pendency: ${r[0].u.name} (${r[0].o}). Lightest load: ${light.u.name} (${light.o}).\nRecommendation: route new work to ${light.u.name}${r[0].od > 1 ? ` and consider reassigning one overdue task from ${r[0].u.name}` : ''}.`;
    }
    if (/department|missing deadline|consistently|dept/.test(s)) {
      const r = T.visibleDepts(me).map(d => { const due = vis.filter(t => t.deptId === d.id && (t.kpiDueAt <= Date.now() || t.firstSubmittedAt)); const late = due.filter(t => (t.firstSubmittedAt && !T.submittedOnTime(t)) || T.isOverdue(t)); return { d, due: due.length, late: late.length, rate: due.length ? 100 * late.length / due.length : 0 }; }).sort((a, b) => b.rate - a.rate);
      return `Deadline misses by department (late or overdue ÷ tasks due):\n${r.map(x => `• ${x.d.name}: ${x.late}/${x.due} (${x.rate.toFixed(0)}%)`).join('\n')}\n\n${r[0] ? `${r[0].d.name} is missing deadlines most often. Review its workload and recurring task TATs.` : ''}`;
    }
    if (/bottleneck|depend|block/.test(s)) {
      const blocked = open.filter(t => T.blockedBy(t).length);
      const holds = open.filter(t => t.status === 'on_hold');
      return `Bottlenecks:\n\n⛓ Tasks blocked by dependencies (${blocked.length}):\n${blocked.map(t => `• ${t.id} ${t.title} waits on ${T.blockedBy(t).map(b => `${b.id} (${T.userName(b.ownerId)})`).join(', ')}`).join('\n') || '  none'}\n\n⏸ On hold (${holds.length}):\n${holds.slice(0, 8).map(line).join('\n') || '  none'}`;
    }
    if (/kpi|score|perform|best|top|worst|lowest/.test(s)) {
      const r = T.monthRange(0); const rows = emps.map(u => ({ u, k: T.computeKpi(u.id, r.from, r.to) })).filter(x => x.k.score != null).sort((a, b) => b.k.score - a.k.score);
      if (!rows.length) return 'Not enough KPI data for this month yet.';
      return `KPI ranking for ${r.label}:\n${rows.map((x, i) => `${i + 1}. ${x.u.name} — ${x.k.score.toFixed(1)}% (${x.k.band.label})`).join('\n')}\n\nNeeds support: ${rows.filter(x => x.k.score < 70).map(x => x.u.name).join(', ') || 'nobody below 70%'}.`;
    }
    if (/overdue|late|delay/.test(s)) {
      const od = open.filter(t => T.isOverdue(t)).sort((a, b) => a.dueAt - b.dueAt);
      return `${od.length} overdue task(s):\n${od.slice(0, 15).map(line).join('\n') || 'none 🎉'}`;
    }
    if (/approv|review/.test(s)) {
      const rev = open.filter(t => t.status === 'pending_review'), appr = open.filter(t => t.status === 'in_approval');
      return `${appr.length} task(s) waiting for approval before submission:\n${appr.map(t => `${line(t)} — waiting on ${T.userName(T.stageOf(t).waitingOn)} (${T.stageOf(t).stage})`).join('\n') || 'none'}\n\n${rev.length} task(s) submitted and pending final review:\n${rev.map(line).join('\n') || 'none'}`;
    }
    const who = emps.find(u => s.includes(u.name.toLowerCase().split(' ')[0]));
    if (who) {
      const mine = open.filter(t => t.ownerId === who.id), r = T.monthRange(0), k = T.computeKpi(who.id, r.from, r.to);
      return `${who.name} (${T.deptName(who.deptId)}): ${mine.length} open, ${mine.filter(t => T.isOverdue(t)).length} overdue. KPI ${r.label}: ${k.score == null ? 'n/a' : k.score.toFixed(1) + '% (' + k.band.label + ')'}.\n${mine.slice(0, 8).map(line).join('\n')}`;
    }
    return 'I can answer questions about your team’s actual task data. Try:\n• Which tasks require my attention today?\n• Who has the highest pendency?\n• Which department is consistently missing deadlines?\n• Show bottlenecks\n• KPI ranking this month\n• Or ask about a person by first name.';
  };
  V.assistant = (f, me) => {
    if (!chatLog.length) chatLog.push({ who: 'bot', text: `Hello ${me.name.split(' ')[0]}. I answer using only Task360 data you are authorised to see. What would you like to know?` });
    const sugg = ['Which tasks require my attention today?', 'Who has the highest pendency?', 'Which department is consistently missing deadlines?', 'Show bottlenecks', 'KPI ranking this month'];
    $('#view').innerHTML = `<div class="page-head"><div><h1>AI management assistant</h1><div class="sub">Answers from live application data, filtered by your access, using a built-in rules engine (no data leaves Task360).</div></div></div>
      <div class="card" style="max-width:900px"><div class="chat" id="chat">${chatLog.map(m => `<div class="msg ${m.who}">${esc(m.text)}</div>`).join('')}</div>
      <div class="chips">${sugg.map(x => `<button class="chip">${esc(x)}</button>`).join('')}</div>
      <form id="chat-f" style="display:flex;gap:8px"><input class="input" id="chat-q" placeholder="Ask about pendency, overdue work, bottlenecks, KPIs…" autocomplete="off"><button class="btn primary">Ask</button></form></div>`;
    const ask = q => { if (!q.trim()) return; chatLog.push({ who: 'user', text: q }, { who: 'bot', text: T.assistantAnswer(q, me) }); V.assistant(f, me); };
    const c = $('#chat'); c.scrollTop = c.scrollHeight;
    $$('.chip').forEach(b => b.onclick = () => ask(b.textContent));
    $('#chat-f').onsubmit = e => { e.preventDefault(); ask($('#chat-q').value); };
    $('#chat-q').focus();
  };

  /* ================= WORKFLOW TRACKER ================= */
  V.workflow = (f, me) => {
    const list = T.filterTasks(T.visibleTasks(me), { ...f, preset: '' }, me).filter(t => T.isOpen(t) && !t.archived)
      .map(t => ({ t, s: T.stageOf(t) })).sort((a, b) => (a.s.since || 0) - (b.s.since || 0));
    const groups = {};
    list.forEach(x => { const k = x.t.status === 'in_approval' ? 'Waiting for approval' : x.t.status === 'pending_review' ? 'Waiting for final review' : x.t.status === 'assigned' ? 'Waiting for acknowledgement' : x.t.status === 'on_hold' ? 'On hold' : T.approvalsDone(x.t) ? 'Approved, ready to submit' : 'With the assignee'; (groups[k] = groups[k] || []).push(x); });
    const order = ['Waiting for acknowledgement', 'With the assignee', 'On hold', 'Waiting for approval', 'Approved, ready to submit', 'Waiting for final review'];
    const mine = list.filter(x => x.s.waitingOn === me.id).length;
    $('#view').innerHTML = `<div class="page-head"><div><h1>Workflow tracker</h1><div class="sub">Where every open task is right now, and who it is waiting on · longest waiting first</div></div>
      <div class="actions"><a class="btn" href="${T.drill({ preset: 'approvals' })}">Waiting for me (${mine})</a></div></div>
      ${filterBar(f, me, { status: false, category: false })}
      <div class="cards">${order.map(k => `<div class="card stat" data-jump="${esc(k)}"><div class="label">${esc(k)}</div><div class="value">${(groups[k] || []).length}</div></div>`).join('')}</div>
      ${order.filter(k => (groups[k] || []).length).map(k => `<div class="card" style="padding:0;margin-bottom:16px" id="grp-${order.indexOf(k)}"><div class="card-head" style="padding:14px 16px 0"><h2>${esc(k)}</h2><span class="small muted">${groups[k].length}</span></div>
        <div class="table-wrap"><table><thead><tr><th>Task</th><th>Assignee</th><th>Current stage</th><th>Waiting on</th><th>Waiting for</th><th>Approvals</th><th>Due (IST)</th></tr></thead><tbody>
        ${groups[k].map(({ t, s }) => `<tr class="click" data-task="${t.id}"><td><div class="task-title">${esc(t.title)}</div><div class="tid">${t.id} · ${esc(T.deptName(t.deptId))}</div></td>
          <td>${U.avatar(t.ownerId)}</td><td class="small">${esc(s.stage)}</td><td>${s.waitingOn ? U.avatar(s.waitingOn) : '—'}${s.waitingOn === me.id ? ' <span class="pill s-in_approval">you</span>' : ''}</td>
          <td class="small nowrap">${s.since ? U.since(s.since) : '—'}</td>
          <td class="small nowrap">${T.hasApprovals(t) ? `${t.approvals.filter(a => a.status === 'approved').length}/${t.approvals.length} approved` : '<span class="muted">none</span>'}</td>
          <td class="small nowrap">${T.fmt(t.dueAt)} ${T.isOverdue(t) ? '<span class="pill flag-overdue">Overdue</span>' : ''}</td></tr>`).join('')}
        </tbody></table></div></div>`).join('') || '<div class="card empty">No open tasks match the filters.</div>'}`;
    const v = $('#view'); wireFilters(v, f, 'workflow'); wireRows(v);
    $$('[data-jump]', v).forEach(c => c.onclick = () => { const el = $('#grp-' + order.indexOf(c.dataset.jump)); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  };

  /* ================= MONTH-END CLOSE ================= */
  V.close = (f, me) => {
    const admin = T.canSeeAll(me);
    const now = T.epochToIstParts(Date.now());
    const key = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
    const shift = (y, m, k) => { m += k; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return key(y, m); };
    const defaultPeriod = shift(now.y, now.m, now.d <= 20 ? -1 : 0); // early in a month you close the previous month
    const period = /^\d{4}-\d{2}$/.test(f.period || '') ? f.period : defaultPeriod;
    const months = [-4, -3, -2, -1, 0, 1].map(k => shift(now.y, now.m, k));
    if (!months.includes(period)) months.unshift(period);
    const items = T.closeItems();
    const assignerOf = items.filter(i => i.active && i.assignerId === me.id);
    const canPlan = admin || assignerOf.length > 0;
    const tab = f.tab === 'dash' ? 'dash' : f.tab === 'plan' && canPlan ? 'plan' : f.tab === 'items' && admin ? 'items' : 'tracker';
    const tasks = T.closeTasks(period).filter(t => T.canView(me, t));
    const byItem = new Map(tasks.map(t => [t.closeRef.itemId, t]));
    const label = T.periodLabel(period);
    const users = D().users.filter(u => u.active);
    const opt = (sel, list) => list.map(u => `<option value="${u.id}" ${sel === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('');
    const names = ids => (ids || []).map(T.userName).join(', ');

    const head = `<div class="page-head"><div><h1>Month-end close</h1><div class="sub">${esc(label)} close · ${items.filter(i => i.active).length} activities on the checklist</div></div>
      <div class="actions"><select class="input" id="cl-month" style="width:auto">${months.map(p => `<option value="${p}" ${p === period ? 'selected' : ''}>${esc(T.periodLabel(p))} close</option>`).join('')}</select></div></div>
      <div class="tabs">${[['tracker', 'Close tracker'], ['dash', 'Dashboard'], ...(canPlan ? [['plan', `Plan & assign ${label}`]] : []), ...(admin ? [['items', 'Activities']] : [])].map(([k, l]) => `<button data-cltab="${k}" class="${tab === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`;

    let body = '';
    if (tab === 'tracker') {
      const done = tasks.filter(t => t.status === 'completed').length;
      const od = tasks.filter(t => T.isOverdue(t)).length;
      const notYet = admin ? items.filter(i => i.active && !byItem.has(i.id)).length : 0;
      const pctDone = tasks.length ? Math.round(100 * done / tasks.length) : 0;
      const rows = admin ? items.filter(i => i.active || byItem.has(i.id)).map(i => ({ i, t: byItem.get(i.id) })) : tasks.map(t => ({ i: items.find(x => x.id === t.closeRef.itemId) || { sl: t.closeRef.sl, title: t.title }, t }));
      body = `<div class="cards">
          <div class="card stat green"><div class="label">Completed</div><div class="value">${done}/${tasks.length}</div><div class="hint">${pctDone}% of assigned</div></div>
          <div class="card stat blue"><div class="label">Open</div><div class="value">${tasks.filter(T.isOpen).length}</div></div>
          <div class="card stat violet"><div class="label">In approval / review</div><div class="value">${tasks.filter(t => ['in_approval', 'pending_review'].includes(t.status)).length}</div></div>
          <div class="card stat red"><div class="label">Overdue</div><div class="value">${od}</div></div>
          ${admin ? `<div class="card stat amber"><div class="label">Not assigned yet</div><div class="value">${notYet}</div>${notYet ? '<div class="hint">use Plan &amp; assign</div>' : ''}</div>` : ''}
        </div>
        <div class="card" style="margin-bottom:16px"><div class="bar" style="height:12px"><i style="width:${pctDone}%;background:var(--ok)"></i></div></div>
        ${admin && tasks.some(t => T.isOpen(t) && t.status !== 'pending_review') ? `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px"><button class="btn" id="tl-change" disabled>📅 Change due dates</button><span class="small muted">Tick open activities to move their due dates (one or many).</span></div>` : ''}
        <div class="card" style="padding:0"><div class="table-wrap"><table><thead><tr><th>${admin ? '<input type="checkbox" id="tl-all" title="Select all open"> ' : ''}#</th><th>Activity</th><th>Assigner</th><th>Owner</th><th>Approver</th><th>Due (IST)</th><th>Status / where it is</th><th>Schedule</th></tr></thead><tbody>
        ${rows.map(({ i, t }) => t ? `<tr class="click" data-task="${t.id}"><td class="tid nowrap">${admin && T.isOpen(t) && t.status !== 'pending_review' ? `<input type="checkbox" data-tl="${t.id}"> ` : ''}${esc(i.sl)}</td><td><div class="task-title">${esc(i.title)}</div><div class="tid">${t.id}${t.module ? ' · ' + esc(t.module) : ''}</div></td>
            <td class="small nowrap">${esc(T.userName(t.createdBy))}</td>
            <td>${U.avatar(t.ownerId)}${t.collaborators.length ? `<div class="small muted">with ${esc(names(t.collaborators))}</div>` : ''}</td>
            <td class="small nowrap">${(t.approvals || []).length ? t.approvals.map(a => `${esc(T.userName(a.approverId))} <span class="pill ${a.status === 'approved' ? 's-completed' : a.status === 'pending' ? 's-in_approval' : a.status === 'rejected' ? 's-reopened' : 's-assigned'}">${esc(a.status)}</span>`).join('<br>') : '<span class="muted">—</span>'}</td>
            <td class="small nowrap">${T.fmt(t.dueAt)}${(t.deadlineChanges || []).length ? `<div class="muted">was ${T.fmtDate(t.originalDueAt)}</div>` : ''}</td><td>${U.status(t)}${U.stageLine(t)}</td>
            <td class="small">${t.scheduleRequired ? ((t.attachments || []).length ? '<span class="pill s-completed">Attached</span>' : '<span class="pill s-on_hold">Required</span>') : '<span class="muted">—</span>'}</td></tr>`
          : `<tr><td class="tid">${esc(i.sl)}</td><td><div class="task-title">${esc(i.title)}</div><div class="tid">${esc([i.module, i.area].filter(Boolean).join(' · '))}</div></td><td class="small muted">${i.assignerId ? esc(T.userName(i.assignerId)) : '—'}</td><td class="small muted">${i.ownerId ? esc(T.userName(i.ownerId)) + ' (default)' : 'No default owner'}</td><td class="small muted">${T.closeApprover(i, i.ownerId) ? esc(T.userName(T.closeApprover(i, i.ownerId))) : '—'}</td><td class="small muted">WD ${i.dueWd || 5}</td><td><span class="pill s-assigned">Not assigned for ${esc(label)}</span></td><td class="small">${i.scheduleRequired ? 'Required' : '—'}</td></tr>`).join('') || `<tr><td colspan="8" class="empty">${admin ? 'No activities yet. Add them on the Activities tab.' : `You have no month-end close activities for ${esc(label)}.`}</td></tr>`}
        </tbody></table></div></div>`;
    }

    if (tab === 'plan') {
      const mineOnly = list => admin ? list : list.filter(i => i.assignerId === me.id);
      const open = mineOnly(items.filter(i => i.active && !byItem.has(i.id)));
      const created = mineOnly(items.filter(i => byItem.has(i.id)));
      body = `<div class="alert info">${admin ? '' : '<b>Your activities as assigner.</b> '}For each activity choose this month’s assigner (who assigns it and does the final review), owner, due date and approver (who approves the work before it can be submitted), then create the tasks. Owners are notified straight away. Due dates default to the activity’s working day (WD) after month end, skipping weekly offs and holidays.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px"><button class="btn" id="pl-xl-down">⬇ Download ${esc(label)} calendar (Excel)</button><label class="btn">⬆ Upload filled calendar<input type="file" id="pl-xl-up" accept=".xlsx,.xls,.csv" hidden></label></div>
        <div id="pl-upload-notes"></div>
        ${open.length ? `<div class="card" style="padding:0"><div class="table-wrap"><table><thead><tr><th><input type="checkbox" id="pl-all" checked title="Tick all"></th><th>#</th><th>Activity</th><th>Assigner</th><th>Owner *</th><th>Co-owners</th><th>Approver</th><th>Due date</th><th>Schedule</th></tr></thead><tbody>
        ${open.map(i => `<tr data-plan="${i.id}"><td><input type="checkbox" data-pl-on checked></td><td class="tid">${esc(i.sl)}</td>
          <td style="min-width:220px"><div class="task-title">${esc(i.title)}</div><div class="tid">${esc([i.module, i.area].filter(Boolean).join(' · '))}</div></td>
          <td>${admin ? `<select class="input" data-pl-asg style="min-width:140px">${opt(i.assignerId || me.id, users.filter(u => u.role !== 'employee'))}</select>` : `<span class="small">${esc(me.name)}</span>`}</td>
          <td><select class="input" data-pl-owner style="min-width:150px"><option value="">— choose —</option>${opt(i.ownerId, admin ? users : T.assignableUsers(me))}</select></td>
          <td>${coPicker(i.coOwners || [], users)}</td>
          <td><select class="input" data-pl-appr data-auto="${i.approverId ? '0' : '1'}" style="min-width:140px"><option value="">— no approval —</option>${opt(T.closeApprover(i, i.ownerId), users)}</select><div class="small muted" data-pl-appr-hint>${i.approverId ? '' : 'reporting manager'}</div></td>
          <td><input class="input" type="date" data-pl-due value="${T.closeDueDate(period, i.dueWd || 5)}" style="min-width:140px"><div class="small muted">WD ${i.dueWd || 5}</div></td>
          <td class="small">${i.scheduleRequired ? 'Required' : '—'}</td></tr>`).join('')}
        </tbody></table></div></div>
        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:12px">
          <label class="small muted">Due time (IST) <input class="input" type="time" id="pl-time" value="18:00" style="width:auto"></label>
          <label class="check" style="margin:0"><input type="checkbox" id="pl-save" checked> Save these ${admin ? 'assigners, ' : ''}owners and approvers as next month’s defaults</label>
          <button class="btn primary" id="pl-go">Create tasks for ${esc(label)} close</button></div>
        <p class="small muted">Co-owners can see and comment on the task; the owner submits it.</p>` : `<div class="card empty">${items.length ? `Every activity already has a task for ${esc(label)}. See the Close tracker.` : 'No activities yet. Add them on the Activities tab.'}</div>`}
        ${created.length ? `<div class="section-title">Already assigned for ${esc(label)} (${created.length})</div><div class="small">${created.map(i => { const t = byItem.get(i.id); return `<a href="#" data-open="${t.id}">${esc(i.sl)}. ${esc(i.title)}</a> → ${esc(T.userName(t.ownerId))}`; }).join(' · ')}</div>` : ''}`;
    }

    if (tab === 'dash') {
      const [py, pm] = period.split('-').map(Number);
      const win = [-5, -4, -3, -2, -1, 0].map(k => shift(py, pm, k));
      const all = T.visibleTasks(me).filter(t => t.closeRef && win.includes(t.closeRef.period) && t.status !== 'cancelled');
      const cur = all.filter(t => t.closeRef.period === period);
      const tally = list => {
        const c = { assigned: list.length, on_time: 0, late: 0, overdue: 0, open: 0, delay: 0 };
        list.forEach(t => { const o = T.closeOutcome(t); c[o.key]++; if (o.key === 'late') c.delay += o.delayMs; });
        const decided = c.on_time + c.late + c.overdue;
        c.rate = decided ? Math.round(100 * c.on_time / decided) : null;
        c.avgDelay = c.late ? c.delay / c.late : null;
        return c;
      };
      const k = tally(cur);
      const pctTxt = r => r == null ? '—' : r + '%';
      const days = ms => ms == null ? '—' : ms < T.DAY ? `${Math.max(1, Math.round(ms / T.HOUR))} h` : `${(ms / T.DAY).toFixed(1)} d`;
      const trend = win.map(p => ({ p, c: tally(all.filter(t => t.closeRef.period === p)) }));
      const group = (keyOf, nameOf) => {
        const m = new Map();
        all.forEach(t => { const key = keyOf(t); if (!m.has(key)) m.set(key, []); m.get(key).push(t); });
        return [...m.entries()].map(([key, list]) => ({ key, name: nameOf(key), now: tally(list.filter(t => t.closeRef.period === period)), six: tally(list) }))
          .filter(g => g.now.assigned || g.six.assigned).sort((a, b) => (a.six.rate ?? 101) - (b.six.rate ?? 101));
      };
      const owners = group(t => t.ownerId, T.userName), depts = group(t => t.deptId, T.deptName);
      const rowsFor = list => list.map(g => `<tr><td>${esc(g.name)}</td><td>${g.now.assigned}</td><td style="color:var(--ok)">${g.now.on_time}</td><td style="color:var(--danger)">${g.now.late}</td><td style="color:var(--danger)"><b>${g.now.overdue}</b></td><td>${g.now.open}</td>
        <td><b>${pctTxt(g.now.rate)}</b></td><td>${pctTxt(g.six.rate)} <span class="small muted">(${g.six.on_time}/${g.six.on_time + g.six.late + g.six.overdue})</span></td><td class="small">${days(g.six.avgDelay)}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No month-end tasks yet.</td></tr>';
      const itemIds = [...new Set(all.map(t => t.closeRef.itemId))];
      const gridItems = itemIds.map(id => items.find(i => i.id === id) || { id, sl: (all.find(t => t.closeRef.itemId === id).closeRef.sl), title: all.find(t => t.closeRef.itemId === id).title.replace(/ — .*$/, '') }).sort((a, b) => (a.sl || 0) - (b.sl || 0));
      const cell = t => {
        if (!t) return '<td class="small muted" style="text-align:center">–</td>';
        const o = T.closeOutcome(t), mark = o.revised ? '<sup title="Due date was changed">*</sup>' : '';
        const style = { on_time: 'background:var(--ok-soft);color:var(--ok)', late: 'background:var(--danger-soft);color:var(--danger)', overdue: 'background:var(--danger);color:#fff', open: 'background:var(--info-soft);color:var(--info)' }[o.key];
        const txt = { on_time: '✓', late: '+' + days(o.delayMs), overdue: '! ' + days(o.delayMs), open: '•' }[o.key];
        const tip = { on_time: 'On time', late: 'Submitted late', overdue: 'Overdue, not submitted', open: 'Open, not due yet' }[o.key] + ` — ${T.userName(t.ownerId)}, due ${T.fmt(t.dueAt)}`;
        return `<td class="click small" data-task="${t.id}" title="${esc(tip)}" style="text-align:center;font-weight:600;${style}">${txt}${mark}</td>`;
      };
      body = `<div class="cards">
          <div class="card stat"><div class="label">Assigned · ${esc(label)}</div><div class="value">${k.assigned}</div></div>
          <div class="card stat green"><div class="label">On time</div><div class="value">${k.on_time}</div></div>
          <div class="card stat red"><div class="label">Late</div><div class="value">${k.late}</div><div class="hint">avg delay ${days(k.avgDelay)}</div></div>
          <div class="card stat red"><div class="label">Overdue (not submitted)</div><div class="value">${k.overdue}</div></div>
          <div class="card stat blue"><div class="label">Open, not due yet</div><div class="value">${k.open}</div></div>
          <div class="card stat ${k.rate == null ? '' : k.rate >= 90 ? 'green' : k.rate >= 75 ? 'amber' : 'red'}"><div class="label">On-time rate</div><div class="value">${pctTxt(k.rate)}</div><div class="hint">of activities due</div></div>
        </div>
        <div class="dash-grid">
          <div class="card span-5"><div class="card-head"><h2>On-time rate — last 6 closes</h2></div>
            <div class="vbars">${trend.map(x => `<div class="col" data-period="${x.p}"><b>${pctTxt(x.c.rate)}</b><i style="height:${x.c.rate ?? 0}%;background:${x.c.rate == null ? 'var(--grey)' : x.c.rate >= 90 ? 'var(--ok)' : x.c.rate >= 75 ? 'var(--warn)' : 'var(--danger)'}"></i><span>${esc(T.periodLabel(x.p))}<br>${x.c.assigned} tasks</span></div>`).join('')}</div></div>
          <div class="card span-7" style="padding:0"><div class="card-head" style="padding:14px 16px 0"><h2>By department</h2><span class="small muted">this month · last 6 closes</span></div><div class="table-wrap"><table><thead><tr><th>Department</th><th>Assigned</th><th>On time</th><th>Late</th><th>Overdue</th><th>Open</th><th>On-time %</th><th>6 closes</th><th>Avg delay</th></tr></thead><tbody>${rowsFor(depts)}</tbody></table></div></div>
          <div class="card span-12" style="padding:0"><div class="card-head" style="padding:14px 16px 0"><h2>By owner</h2><span class="small muted">lowest on-time rate first</span></div><div class="table-wrap"><table><thead><tr><th>Owner</th><th>Assigned</th><th>On time</th><th>Late</th><th>Overdue</th><th>Open</th><th>On-time %</th><th>6 closes</th><th>Avg delay</th></tr></thead><tbody>${rowsFor(owners)}</tbody></table></div></div>
          <div class="card span-12" style="padding:0"><div class="card-head" style="padding:14px 16px 0"><h2>Each activity, month by month</h2><span class="legend"><span><i style="background:var(--ok)"></i>✓ on time</span><span><i style="background:var(--danger-soft)"></i>+ late by</span><span><i style="background:var(--danger)"></i>! overdue</span><span><i style="background:var(--info)"></i>• open</span><span>* due date changed</span></span></div>
            <div class="table-wrap"><table><thead><tr><th>#</th><th>Activity</th>${win.map(p => `<th style="text-align:center">${esc(T.periodLabel(p))}</th>`).join('')}<th>On time</th></tr></thead><tbody>
            ${gridItems.map(i => { const ts = win.map(p => all.find(t => t.closeRef.period === p && t.closeRef.itemId === i.id)); const c = tally(ts.filter(Boolean)); return `<tr><td class="tid">${esc(i.sl)}</td><td class="small" style="min-width:220px">${esc(i.title)}</td>${ts.map(cell).join('')}<td class="small nowrap"><b>${c.on_time}</b>/${c.on_time + c.late + c.overdue}</td></tr>`; }).join('') || '<tr><td colspan="9" class="empty">No month-end tasks in these months yet.</td></tr>'}
            </tbody></table></div></div>
        </div>
        <p class="small muted">On time = submitted for final review on or before the due date in force (after any approved date change). Late = submitted after it. Overdue = past the due date and not submitted yet.</p>`;
    }
    if (tab === 'items') {
      body = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap"><span class="small muted">The checklist every month starts from. Changes apply to months you assign after the change.</span><span style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="ci-xl-down">⬇ Download Excel template</button><label class="btn">⬆ Upload checklist (Excel)<input type="file" id="ci-xl-up" accept=".xlsx,.xls,.csv" hidden></label><button class="btn primary" id="ci-add">＋ Add activity</button></span></div>
        <div class="card" style="padding:0"><div class="table-wrap"><table><thead><tr><th>#</th><th>Activity</th><th>Module</th><th>Department</th><th>Schedule</th><th>Assigner</th><th>Default owner</th><th>Approver</th><th>Due</th><th></th></tr></thead><tbody>
        ${items.map(i => `<tr style="${i.active ? '' : 'opacity:.55'}"><td class="tid">${esc(i.sl)}</td><td class="task-title">${esc(i.title)}${i.active ? '' : ' <span class="pill s-cancelled">inactive</span>'}</td>
          <td class="small">${esc([i.module, i.area].filter(Boolean).join(' · ') || '—')}</td><td class="small">${esc(T.deptName(i.deptId))}</td><td class="small">${i.scheduleRequired ? 'Required' : '—'}</td>
          <td class="small">${i.assignerId ? esc(T.userName(i.assignerId)) : '<span style="color:var(--danger)">not set</span>'}</td>
          <td class="small">${i.ownerId ? esc(T.userName(i.ownerId)) : '<span style="color:var(--danger)">not set</span>'}${(i.coOwners || []).length ? `<div class="muted">+ ${esc(names(i.coOwners))}</div>` : ''}</td>
          <td class="small">${i.approverId === 'none' ? '<span class="muted">No approval</span>' : i.approverId ? esc(T.userName(i.approverId)) : `<span class="muted">Reporting manager${T.closeApprover(i, i.ownerId) ? ` (${esc(T.userName(T.closeApprover(i, i.ownerId)))})` : ''}</span>`}</td><td class="small nowrap">WD ${i.dueWd || 5}</td><td><button class="btn sm" data-ci-edit="${i.id}">Edit</button></td></tr>`).join('') || '<tr><td colspan="10" class="empty">No activities yet.</td></tr>'}
        </tbody></table></div></div>`;
    }

    $('#view').innerHTML = head + body;
    const v = $('#view'); wireRows(v);
    $('#cl-month').onchange = e => T.app.go('close', { period: e.target.value, tab });
    $$('[data-cltab]', v).forEach(b => b.onclick = () => T.app.go('close', { period, tab: b.dataset.cltab }));
    $$('[data-open]', v).forEach(a => a.onclick = e => { e.preventDefault(); U.openTask(a.dataset.open); });
    $$('.co-pick', v).forEach(d => d.addEventListener('change', () => {
      const picked = $$('[data-co-id]', d).filter(c => c.checked).map(c => c.parentElement.textContent.trim());
      $('summary', d).textContent = picked.length ? picked.join(', ') : '＋ Add';
    }));
    if (tab === 'dash') $$('[data-period]', v).forEach(c => c.onclick = () => T.app.go('close', { period: c.dataset.period, tab: 'dash' }));
    if (tab === 'tracker' && $('#tl-change')) {
      const boxes = () => $$('[data-tl]', v), sel = () => boxes().filter(b => b.checked).map(b => b.dataset.tl);
      const sync = () => { const n = sel().length; $('#tl-change').disabled = !n; $('#tl-change').textContent = n ? `📅 Change due dates (${n} selected)` : '📅 Change due dates'; };
      boxes().forEach(b => { b.addEventListener('click', e => e.stopPropagation()); b.addEventListener('change', sync); });
      $('#tl-all').onchange = e => { boxes().forEach(b => b.checked = e.target.checked); sync(); };
      $('#tl-change').onclick = () => timelineModal(me, sel(), period);
    }
    if (tab === 'plan' && $('#pl-xl-down')) {
      $('#pl-xl-down').onclick = () => downloadCloseTemplate(period).catch(e => U.toast(e.message, true));
      $('#pl-xl-up').onchange = e => { const fl = e.target.files[0]; if (fl) uploadPlan(me, fl, v); e.target.value = ''; };
    }
    if (tab === 'plan' && $('#pl-go')) {
      $('#pl-all').onchange = e => $$('[data-pl-on]', v).forEach(c => c.checked = e.target.checked);
      // Approver follows the owner's reporting manager until someone picks an approver by hand.
      $$('[data-plan]', v).forEach(tr => {
        const ap = $('[data-pl-appr]', tr), hint = $('[data-pl-appr-hint]', tr);
        $('[data-pl-owner]', tr).addEventListener('change', e => { if (ap.dataset.auto === '1') { ap.value = T.closeApprover({}, e.target.value) || ''; hint.textContent = 'reporting manager'; } });
        ap.addEventListener('change', () => { ap.dataset.auto = '0'; hint.textContent = ''; });
      });
      $('#pl-go').onclick = () => {
        const time = $('#pl-time').value || '18:00';
        const rows = $$('[data-plan]', v).filter(r => $('[data-pl-on]', r).checked).map(r => ({
          itemId: r.dataset.plan, ownerId: $('[data-pl-owner]', r).value || null,
          coOwners: $$('[data-co-id]', r).filter(c => c.checked).map(c => c.dataset.coId),
          dueAt: $('[data-pl-due]', r).value ? T.istToEpoch($('[data-pl-due]', r).value, time) : NaN,
          approverId: $('[data-pl-appr]', r).value || null,
          assignerId: $('[data-pl-asg]', r) ? $('[data-pl-asg]', r).value : me.id
        }));
        if (!rows.length) return U.toast('Tick at least one activity.', true);
        const btn = $('#pl-go'); btn.disabled = true; btn.textContent = 'Creating tasks…';
        U.act(() => T.api.planClose(me, period, rows, $('#pl-save').checked)).then(r => {
          if (r && r.created) { U.toast(`${r.created} task(s) assigned for ${label} close; owners notified`); T.app.go('close', { period, tab: 'tracker' }); }
          else { const b2 = $('#pl-go'); if (b2) { b2.disabled = false; b2.textContent = `Create tasks for ${label} close`; } }
        });
      };
    }
    if (tab === 'items') {
      $('#ci-add').onclick = () => closeItemModal(me, null);
      $('#ci-xl-down').onclick = () => downloadCloseTemplate(period).catch(e => U.toast(e.message, true));
      $('#ci-xl-up').onchange = e => { const fl = e.target.files[0]; if (fl) uploadChecklist(me, fl); e.target.value = ''; };
      $$('[data-ci-edit]', v).forEach(b => b.onclick = () => closeItemModal(me, b.dataset.ciEdit));
    }
  };
  /* ================= MONTH-END CLOSE: EXCEL TEMPLATE ================= */
  const XL_COLS = [
    ['sl', 'Sl'], ['title', 'Activity'], ['schedule', 'Schedule required (YES/NO)'], ['module', 'Module'], ['area', 'Sub-module'],
    ['dept', 'Department'], ['owner', 'Owner'], ['co', 'Co-owners (separate with /)'], ['assigner', 'Assigner'],
    ['approver', "Approver (blank = owner's reporting manager, NONE = no approval)"], ['wd', 'Due working day after month end'],
    ['due', 'Due date (DD-MM-YYYY)'], ['assign', 'Assign this month (YES/NO)'], ['active', 'Active (YES/NO)']
  ];
  const fmtDMY = ds => ds ? ds.split('-').reverse().join('-') : '';
  /* Build the Excel workbook: the checklist with this month's dates, plus a sheet of valid names and instructions. */
  async function downloadCloseTemplate(period) {
    const X = await U.loadXLSX();
    const label = T.periodLabel(period);
    const items = T.closeItems();
    const rows = items.length ? items.map(i => {
      const app = i.approverId === 'none' ? 'NONE' : i.approverId ? T.userName(i.approverId) : '';
      return [i.sl, i.title, i.scheduleRequired ? 'YES' : 'NO', i.module || '', i.area || '', i.deptId ? T.deptName(i.deptId) : '',
        i.ownerId ? T.userName(i.ownerId) : '', (i.coOwners || []).map(T.userName).join(' / '), i.assignerId ? T.userName(i.assignerId) : '',
        app, i.dueWd || 5, fmtDMY(T.closeDueDate(period, i.dueWd || 5)), i.active ? 'YES' : 'NO', i.active ? 'YES' : 'NO'];
    }) : [[1, 'Bank reconciliation', 'NO', 'Banking', 'Treasury', D().departments[0] ? D().departments[0].name : '', '', '', '', '', 3, fmtDMY(T.closeDueDate(period, 3)), 'YES', 'YES']];
    const head = XL_COLS.map(c => c[1]);
    head[11] = `Due date for ${label} close (DD-MM-YYYY)`; head[12] = `Assign for ${label} (YES/NO)`;
    const ws = X.utils.aoa_to_sheet([head, ...rows]);
    ws['!cols'] = [6, 48, 12, 14, 14, 20, 20, 26, 18, 26, 12, 18, 14, 10].map(w => ({ wch: w }));
    ws['!autofilter'] = { ref: `A1:N${rows.length + 1}` };
    const people = D().users.filter(u => u.active).map(u => [u.name, u.email || '', T.ROLES[u.role], T.deptNames(u), T.userName(u.managerId)]);
    const help = [
      ['How to use this template'],
      ['1. Edit the "Close calendar" sheet in Excel. Keep the header row. One row per activity.'],
      ['2. Owner, Co-owners, Assigner and Approver: use the names (or work emails) exactly as on the "People" sheet. Separate several co-owners with /.'],
      ["3. Approver: leave blank to use the owner's reporting manager; write NONE if the activity needs no approval."],
      ['4. Due working day: the working day after month end when it is due (e.g. 3 = third working day; weekly offs and holidays are skipped).'],
      [`5. Due date: the date for ${label} close. Leave blank to use the working day.`],
      ['6. Upload on Month-end Close → Activities to update the checklist (all months), or on Plan & assign to fill in one month before creating its tasks.'],
      ['7. Active = NO removes an activity from future months. Assign this month = NO skips it for that month only.'],
      [], ['Departments'], ...D().departments.map(d => [d.name])
    ];
    const wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, ws, 'Close calendar');
    const wp = X.utils.aoa_to_sheet([['Name', 'Work email', 'Role', 'Departments', 'Reports to'], ...people]);
    wp['!cols'] = [24, 32, 18, 40, 22].map(w => ({ wch: w }));
    X.utils.book_append_sheet(wb, wp, 'People');
    const wh = X.utils.aoa_to_sheet(help); wh['!cols'] = [{ wch: 120 }];
    X.utils.book_append_sheet(wb, wh, 'How to fill');
    const out = X.write(wb, { bookType: 'xlsx', type: 'array' });
    U.download(`Month-end close calendar - ${label}.xlsx`, out, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  }

  /* Read an uploaded .xlsx / .csv into activity rows, resolving people and departments. */
  async function readCloseFile(file) {
    const X = await U.loadXLSX();
    const wb = X.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets['Close calendar'] || wb.Sheets[wb.SheetNames[0]];
    const grid = X.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: false });
    if (!grid.length) throw new Error('The file is empty.');
    const head = grid[0].map(h => String(h).trim().toLowerCase());
    const col = {};
    const find = (key, test) => { const i = head.findIndex(test); if (i >= 0 && col[key] === undefined) col[key] = i; };
    find('sl', h => h === 'sl' || h === 'sl #' || h === 'sl no' || h === '#');
    find('title', h => h.startsWith('activity'));
    find('schedule', h => h.startsWith('schedule'));
    find('area', h => h.startsWith('sub-module') || h.startsWith('sub module') || h.startsWith('submodule'));
    find('module', h => h === 'module' || h.startsWith('module'));
    find('dept', h => h.startsWith('department'));
    find('co', h => h.startsWith('co-owner') || h.startsWith('co owner') || h.startsWith('coowner'));
    find('owner', h => h === 'owner' || h.startsWith('owner'));
    find('assigner', h => h.startsWith('assigner') || h.startsWith('assigned by'));
    find('approver', h => h.startsWith('approver'));
    find('wd', h => h.startsWith('due working day') || h === 'wd' || h.startsWith('due wd'));
    find('due', h => h.startsWith('due date'));
    find('assign', h => h.startsWith('assign for') || h.startsWith('assign this month'));
    find('active', h => h.startsWith('active'));
    if (col.title === undefined) throw new Error('Could not find the "Activity" column. Use the downloaded template.');
    const users = D().users.filter(u => u.active);
    const person = (txt, problems, what) => {
      const s = String(txt || '').trim(); if (!s) return null;
      const q = s.toLowerCase();
      const hits = users.filter(u => (u.email || '').toLowerCase() === q || u.name.toLowerCase() === q);
      const pref = hits.length ? hits : users.filter(u => u.name.toLowerCase().startsWith(q + ' ') || u.name.toLowerCase().split(' ')[0] === q);
      if (pref.length === 1) return pref[0].id;
      problems.push(pref.length ? `${what} “${s}” matches ${pref.map(u => u.name).join(' and ')} — write the full name` : `${what} “${s}” is not a team member`);
      return undefined;
    };
    const yes = v => /^(y|yes|true|1)$/i.test(String(v).trim());
    const no = v => /^(n|no|false|0)$/i.test(String(v).trim());
    const toDate = v => {
      if (v === '' || v == null) return null;
      if (typeof v === 'number') { const d = new Date(Math.round((v - 25569) * 86400000)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
      const s = String(v).trim(); let m;
      if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
      if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      const mon = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
      if ((m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{4})$/.exec(s)) && mon[m[2].toLowerCase()]) return `${m[3]}-${String(mon[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      return undefined;
    };
    const rows = [];
    grid.slice(1).forEach((r, idx) => {
      const get = k => (col[k] === undefined ? '' : r[col[k]]);
      const title = String(get('title') || '').trim();
      if (!title) return;
      const problems = [];
      const deptTxt = String(get('dept') || '').trim();
      const dept = deptTxt ? D().departments.find(d => d.name.toLowerCase() === deptTxt.toLowerCase()) : null;
      if (deptTxt && !dept) problems.push(`department “${deptTxt}” not found`);
      const apTxt = String(get('approver') || '').trim();
      const approverId = !apTxt ? null : /^none$/i.test(apTxt) ? 'none' : person(apTxt, problems, 'approver');
      const co = String(get('co') || '').split(/[\/,;]/).map(x => x.trim()).filter(Boolean).map(x => person(x, problems, 'co-owner')).filter(Boolean);
      const due = toDate(get('due'));
      if (due === undefined) problems.push(`due date “${get('due')}” not understood (use DD-MM-YYYY)`);
      rows.push({
        line: idx + 2, sl: parseInt(get('sl'), 10) || null, title,
        scheduleRequired: yes(get('schedule')), module: String(get('module') || '').trim(), area: String(get('area') || '').trim(),
        deptId: dept ? dept.id : null, ownerId: person(get('owner'), problems, 'owner'), coOwners: co,
        assignerId: person(get('assigner'), problems, 'assigner'), approverId,
        dueWd: parseInt(get('wd'), 10) || 5, due: due || null,
        assign: col.assign === undefined || String(get('assign')).trim() === '' ? true : !no(get('assign')),
        active: col.active === undefined || String(get('active')).trim() === '' ? true : !no(get('active')),
        problems
      });
    });
    if (!rows.length) throw new Error('No activities found in the file.');
    return rows;
  }

  /* Activities tab: preview, then update the checklist. */
  function uploadChecklist(me, file) {
    readCloseFile(file).then(rows => {
      const existing = T.closeItems();
      const isNew = r => !existing.some(x => (r.sl && x.sl === r.sl) || x.title.toLowerCase() === r.title.toLowerCase());
      const bad = rows.filter(r => r.problems.length), good = rows.filter(r => !r.problems.length);
      U.modal('Upload close checklist', `<p>${rows.length} activit${rows.length === 1 ? 'y' : 'ies'} in the file: <b>${good.filter(isNew).length} new</b>, <b>${good.filter(r => !isNew(r)).length} to update</b>${bad.length ? `, <b style="color:var(--danger)">${bad.length} with problems</b>` : ''}.</p>
        ${bad.length ? `<div class="alert warn"><b>These rows will be skipped until fixed:</b><br>${bad.slice(0, 25).map(r => `Row ${r.line} (${esc(r.title)}): ${esc(r.problems.join('; '))}`).join('<br>')}${bad.length > 25 ? `<br>…and ${bad.length - 25} more` : ''}</div>` : ''}
        <p class="small muted">Activities are matched by Sl (or by name). Activities not in the file are left unchanged. Blank approver = owner’s reporting manager.</p>`,
        `<button class="btn" data-close>Cancel</button><button class="btn primary" id="up-ok" ${good.length ? '' : 'disabled'}>Apply ${good.length} row(s)</button>`, m => {
          $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
          $('#up-ok').onclick = () => U.act(() => T.api.importCloseItems(me, good.map(r => ({ sl: r.sl, title: r.title, scheduleRequired: r.scheduleRequired, module: r.module, area: r.area, deptId: r.deptId, ownerId: r.ownerId, coOwners: r.coOwners, assignerId: r.assignerId, approverId: r.approverId, dueWd: r.dueWd, active: r.active }))))
            .then(res => { if (res) { U.closeLayer(); U.toast(`Checklist updated: ${res.added} added, ${res.updated} updated`); } });
        });
    }).catch(e => U.toast(e.message, true));
  }

  /* Plan tab: fill this month's rows from the file; the user reviews, then creates the tasks. */
  function uploadPlan(me, file, v) {
    readCloseFile(file).then(rows => {
      const items = T.closeItems(); let filled = 0; const notes = [];
      rows.forEach(r => {
        const it = items.find(x => (r.sl && x.sl === r.sl) || x.title.toLowerCase() === r.title.toLowerCase());
        const tr = it && $(`[data-plan="${it.id}"]`, v);
        if (!tr) { notes.push(`Row ${r.line} (${r.title}): ${it ? 'already assigned this month or not yours' : 'not on the checklist — add it on the Activities tab first'}`); return; }
        if (r.problems.length) notes.push(`Row ${r.line} (${r.title}): ${r.problems.join('; ')}`);
        $('[data-pl-on]', tr).checked = r.assign;
        if (r.ownerId) $('[data-pl-owner]', tr).value = r.ownerId;
        const asg = $('[data-pl-asg]', tr); if (asg && r.assignerId) asg.value = r.assignerId;
        const ap = $('[data-pl-appr]', tr);
        if (r.approverId === 'none') { ap.value = ''; ap.dataset.auto = '0'; }
        else if (r.approverId) { ap.value = r.approverId; ap.dataset.auto = '0'; }
        else { ap.value = T.closeApprover({}, $('[data-pl-owner]', tr).value) || ''; ap.dataset.auto = '1'; }
        if (r.coOwners.length || r.ownerId) { $$('[data-co-id]', tr).forEach(c => { c.checked = r.coOwners.includes(c.dataset.coId); }); const d = $('.co-pick', tr); if (d) d.dispatchEvent(new Event('change')); }
        if (r.due) $('[data-pl-due]', tr).value = r.due;
        filled++;
      });
      const box = $('#pl-upload-notes');
      box.innerHTML = `<div class="alert ${notes.length ? 'warn' : 'info'}">Filled ${filled} activit${filled === 1 ? 'y' : 'ies'} from <b>${esc(file.name)}</b>. Check the table, then click <b>Create tasks</b>.${notes.length ? '<br>' + notes.slice(0, 20).map(esc).join('<br>') + (notes.length > 20 ? `<br>…and ${notes.length - 20} more` : '') : ''}</div>`;
    }).catch(e => U.toast(e.message, true));
  }

  /* Super Admin: move the due dates of the selected month-end tasks. */
  function timelineModal(me, ids, period) {
    const first = T.task(ids[0]);
    U.modal(`Change timeline — ${ids.length} activit${ids.length === 1 ? 'y' : 'ies'}`, `
      <div class="alert info">The original due date stays on each task. Owners are notified of the new date.</div>
      <label class="check"><input type="radio" name="tl-mode" value="shift" checked> Move by&nbsp;<input class="input" type="number" id="tl-days" value="2" min="-30" max="30" style="width:80px">&nbsp;working day(s) <span class="small muted">(negative = earlier; holidays and weekly offs skipped)</span></label>
      <label class="check"><input type="radio" name="tl-mode" value="set"> Set all to&nbsp;<input class="input" type="date" id="tl-date" value="${T.istDateStr(first.dueAt + T.DAY)}" style="width:auto">&nbsp;<input class="input" type="time" id="tl-time" value="${T.istTimeStr(first.dueAt)}" style="width:auto"></label>
      <label class="field"><span>Attributable to *</span><select class="input" id="tl-attr"><option value="manager">Management decision / timeline revised — KPI uses the new date</option><option value="external">External dependency — KPI uses the new date</option><option value="employee">Employee request — KPI keeps the original date</option></select></label>
      <label class="field"><span>Reason *</span><textarea class="input" id="tl-reason" placeholder="e.g. Audit timelines moved; close extended by two working days"></textarea></label>
      <div class="small muted">${ids.map(id => { const t = T.task(id); return `${esc(t.closeRef ? t.closeRef.sl + '. ' : '')}${esc(t.title.replace(/ — .*$/, ''))} — now ${T.fmt(t.dueAt)}`; }).slice(0, 12).join('<br>')}${ids.length > 12 ? `<br>…and ${ids.length - 12} more` : ''}</div>`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="tl-ok">Change due dates</button>`, m => {
        $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
        $('#tl-ok').onclick = () => {
          const mode = $('input[name="tl-mode"]:checked', m).value;
          const spec = mode === 'set' ? { mode, dueAt: $('#tl-date').value && $('#tl-time').value ? T.istToEpoch($('#tl-date').value, $('#tl-time').value) : NaN } : { mode, days: parseInt($('#tl-days').value, 10) };
          U.act(() => T.api.bulkChangeDeadline(me, ids, spec, $('#tl-reason').value, $('#tl-attr').value))
            .then(r => { if (r) { U.closeLayer(); U.toast(`Due date changed for ${r.changed} activit${r.changed === 1 ? 'y' : 'ies'}; owners notified`); } });
        };
      });
  }

  /* Compact multi-person picker: shows the chosen names; opens a tick list. */
  function coPicker(selected, users) {
    const names = selected.map(T.userName);
    return `<details class="co-pick"><summary>${names.length ? esc(names.join(', ')) : '＋ Add'}</summary><div class="co-list">${users.map(u => `<label><input type="checkbox" data-co-id="${u.id}" ${selected.includes(u.id) ? 'checked' : ''}> ${esc(u.name)}</label>`).join('')}</div></details>`;
  }
  function closeItemModal(me, id) {
    const i = id ? T.closeItems().find(x => x.id === id) : { title: '', module: '', area: '', scheduleRequired: false, ownerId: null, coOwners: [], deptId: null, dueWd: 5, approverId: null, assignerId: null, active: true };
    const users = D().users.filter(u => u.active);
    U.modal(id ? `Edit activity ${i.sl}` : 'Add close activity', `<label class="field"><span>Activity *</span><input class="input" id="ci-t" value="${esc(i.title)}" maxlength="160"></label>
      <div class="grid2"><label class="field"><span>Module</span><input class="input" id="ci-m" value="${esc(i.module)}" placeholder="e.g. Payable"></label><label class="field"><span>Sub-module / area</span><input class="input" id="ci-a" value="${esc(i.area)}" placeholder="e.g. Vendors"></label></div>
      <div class="grid2"><label class="field"><span>Department</span><select class="input" id="ci-d"><option value="">Owner’s department</option>${D().departments.map(d => `<option value="${d.id}" ${i.deptId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Due on working day (after month end)</span><input class="input" type="number" min="1" max="23" id="ci-wd" value="${i.dueWd || 5}"></label></div>
      <label class="field"><span>Assigner (assigns it each month and does the final review)</span><select class="input" id="ci-as"><option value="">— not set —</option>${users.filter(u => u.role !== 'employee').map(u => `<option value="${u.id}" ${i.assignerId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <div class="grid2"><label class="field"><span>Default owner</span><select class="input" id="ci-o"><option value="">— none —</option>${users.map(u => `<option value="${u.id}" ${i.ownerId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Approver (approves before submission)</span><select class="input" id="ci-ap"><option value="">Owner’s reporting manager (default)</option><option value="none" ${i.approverId === 'none' ? 'selected' : ''}>No approval needed</option>${users.map(u => `<option value="${u.id}" ${i.approverId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label></div>
      <label class="field"><span>Default co-owners</span><div id="ci-co">${coPicker(i.coOwners || [], users)}</div></label>
      <label class="check"><input type="checkbox" id="ci-s" ${i.scheduleRequired ? 'checked' : ''}> Schedule required (must be attached before the task can be submitted)</label>
      ${id ? `<label class="check"><input type="checkbox" id="ci-act" ${i.active ? 'checked' : ''}> Active (on the checklist)</label>` : ''}`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="ci-ok">Save</button>`, m => {
        $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
        $$('.co-pick', m).forEach(d => d.addEventListener('change', () => { const n = $$('[data-co-id]', d).filter(c => c.checked).map(c => c.parentElement.textContent.trim()); $('summary', d).textContent = n.length ? n.join(', ') : '＋ Add'; }));
        $('#ci-ok').onclick = () => U.act(() => T.api.saveCloseItem(me, {
          id: id || undefined, title: $('#ci-t').value, module: $('#ci-m').value, area: $('#ci-a').value, deptId: $('#ci-d').value || null,
          dueWd: +$('#ci-wd').value, ownerId: $('#ci-o').value || null, approverId: $('#ci-ap').value || null, assignerId: $('#ci-as').value || null,
          coOwners: $$('#ci-co [data-co-id]').filter(c => c.checked).map(c => c.dataset.coId), scheduleRequired: $('#ci-s').checked, active: id ? $('#ci-act').checked : true
        }), 'Activity saved').then(ok => { if (ok) U.closeLayer(); });
      });
  }

  V.denied = msg => { $('#view').innerHTML = `<div class="card empty"><h2>Access restricted</h2><p>${esc(msg || 'Your role does not have access to this page.')}</p><a class="btn" href="#/dashboard">Back to dashboard</a></div>`; };
})(window.T360);
