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
        case 'approvals': if (t.status !== 'pending_review' || t.ownerId === me.id) return false; break;
        case 'today': if (!T.dueToday(t)) return false; break;
        case 'critical': if (!(t.priority === 'critical' && T.isOpen(t))) return false; break;
        case 'pending': if (!T.isOpen(t)) return false; break;
        case 'reopened': if (!t.reopenCount) return false; break;
        case 'recurring': if (!t.recurringId) return false; break;
        case 'escalated': if (!esc_.has(t.id)) return false; break;
        case 'ontime': if (!(t.firstSubmittedAt && t.firstSubmittedAt <= t.kpiDueAt)) return false; break;
        case 'late': if (!((t.firstSubmittedAt && t.firstSubmittedAt > t.kpiDueAt) || T.isOverdue(t))) return false; break;
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
    const submitted = live.filter(t => t.firstSubmittedAt);
    const ontime = submitted.filter(t => t.firstSubmittedAt <= t.kpiDueAt);
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
      ['Pending approval', review.length, 'violet', go({ status: 'pending_review' })],
      ['On-time delivery', pct(ontime.length, submitted.length) + '%', 'green', go({ preset: 'ontime' }), `${ontime.length} of ${submitted.length} submitted`],
      ['Avg. turnaround', T.fmtHrs(avgTat), '', go({ status: 'completed' }), 'assignment → submission'],
      ['Reopened', live.filter(t => t.reopenCount).length, 'amber', go({ preset: 'reopened' })],
      ['Escalations', escCount, 'red', go({ preset: 'escalated' })],
      ['Not started', notStarted.length, '', go({ status: 'not_started' })]
    ];
    const seg = [
      { label: 'Completed', value: done.length, color: U.statusColor.completed, go: go({ status: 'completed' }) },
      { label: 'In progress', value: inProg.length, color: U.statusColor.in_progress, go: go({ status: 'in_progress' }) },
      { label: 'Pending review', value: review.length, color: U.statusColor.pending_review, go: go({ status: 'pending_review' }) },
      { label: 'Overdue', value: overdue.length, color: U.statusColor.overdue, go: go({ status: 'overdue' }) },
      { label: 'Not started', value: notStarted.length, color: U.statusColor.assigned, go: go({ status: 'not_started' }) }
    ];
    const depts = T.visibleDepts(me).map(d => {
      const ts = live.filter(t => t.deptId === d.id), sub = ts.filter(t => t.firstSubmittedAt);
      const due = ts.filter(t => t.kpiDueAt <= Date.now() || t.firstSubmittedAt);
      const ot = due.length ? pct(due.filter(t => t.firstSubmittedAt && t.firstSubmittedAt <= t.kpiDueAt).length, due.length) : null;
      return { d, total: ts.length, ot, od: ts.filter(t => T.isOverdue(t)).length, sub: sub.length };
    });
    const emps = T.visibleUsers(me).filter(u => u.role === 'employee').map(u => {
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
  const PRESET_TITLES = { '': 'All tasks', my: 'My tasks', assigned: 'Assigned by me', overdue: 'Overdue tasks', approvals: 'Pending approvals', today: 'Due today', critical: 'Critical open tasks', pending: 'Pending tasks', reopened: 'Reopened tasks', recurring: 'Recurring task instances', escalated: 'Escalated tasks', ontime: 'Submitted on time', late: 'Late / overdue', archived: 'Archived tasks' };
  let sortState = { key: 'due', dir: 1 };
  V.tasks = (f, me) => {
    const list = U.sortTasks(T.filterTasks(T.visibleTasks(me), f, me), sortState.key, sortState.dir);
    const title = PRESET_TITLES[f.preset || ''] || 'Tasks';
    $('#view').innerHTML = `
      <div class="page-head"><div><h1>${title}</h1><div class="sub">${list.length} task(s)${f.preset === 'approvals' ? ' awaiting your review' : ''}</div></div>
        <div class="actions"><a class="btn" href="#/board?${qs(f)}">▦ Board</a><a class="btn" href="#/calendar">📅 Calendar</a><button class="btn" id="exp-csv">Export CSV</button><button class="btn" id="exp-xls">Export Excel</button></div></div>
      <div class="tabs">${['', 'my', 'assigned', 'overdue', 'approvals', 'today', 'recurring', 'archived'].filter(p => me.role !== 'employee' || !['assigned', 'approvals'].includes(p)).map(p => `<button data-preset="${p}" class="${(f.preset || '') === p ? 'on' : ''}">${PRESET_TITLES[p]}</button>`).join('')}</div>
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
    const cols = ['assigned', 'acknowledged', 'in_progress', 'on_hold', 'reopened', 'pending_review', 'completed'];
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
    const people = T.visibleUsers(me).filter(u => u.role === 'employee' && (!f.dept || u.deptId === f.dept));
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
          ${rows.map(({ u, k }) => `<tr class="click" data-user="${u.id}"><td>${U.avatar(u.id)}</td><td class="small">${esc(T.deptName(u.deptId))}</td>${T.KPI_PARAMS.map(p => `<td>${k.metrics[p.key].value == null ? '<span class="muted">n/a</span>' : k.metrics[p.key].value.toFixed(0) + '%'}</td>`).join('')}<td><b class="${k.band.cls}">${k.score == null ? '—' : k.score.toFixed(1) + '%'}</b><div class="small ${k.band.cls}">${k.band.label}</div></td></tr>`).join('') || '<tr><td colspan="8" class="empty">No employees in scope</td></tr>'}
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
      Employee: u.name, Department: T.deptName(u.deptId), Period: range.label,
      ...Object.fromEntries(T.KPI_PARAMS.map(p => [p.label + ' %', k.metrics[p.key].value == null ? 'n/a' : k.metrics[p.key].value.toFixed(1)])),
      'KPI score %': k.score == null ? '' : k.score.toFixed(1), Band: k.band.label, 'Tasks': k.counts.total, 'Overdue': k.counts.overdue
    })));
  };

  /* ================= TEAM WORKLOAD ================= */
  V.team = (f, me) => {
    if (me.role === 'employee') return V.denied();
    const people = T.visibleUsers(me).filter(u => u.role === 'employee');
    const range = T.monthRange(0);
    const rows = people.map(u => {
      const ts = D().tasks.filter(t => t.ownerId === u.id && !t.archived);
      const open = ts.filter(T.isOpen);
      return { u, open: open.length, od: open.filter(t => T.isOverdue(t)).length, crit: open.filter(t => t.priority === 'critical').length, today: open.filter(T.dueToday).length, review: ts.filter(t => t.status === 'pending_review').length, k: T.computeKpi(u.id, range.from, range.to) };
    });
    const admin = me.role === 'super_admin';
    const depts = T.visibleDepts(me).map(d => ({
      d, managers: D().users.filter(u => u.active && u.role === 'manager' && (u.teams || []).includes(d.id)),
      members: D().users.filter(u => u.active && u.role === 'employee' && u.deptId === d.id).length,
      open: D().tasks.filter(t => t.deptId === d.id && T.isOpen(t) && !t.archived).length
    }));
    $('#view').innerHTML = `<div class="page-head"><div><h1>Team management &amp; workload</h1><div class="sub">Check capacity before assigning · manage leave and backups${admin ? ' · add team members and departments' : ''}</div></div>
      ${admin ? `<div class="actions"><button class="btn primary" id="tm-add-user">＋ Add team member</button><button class="btn" id="tm-add-dept">＋ Add department</button></div>` : ''}</div>
      <div class="card" style="padding:0;margin-bottom:16px"><div class="card-head" style="padding:14px 16px 0"><h2>Departments</h2><span class="small muted">${depts.length} department(s)</span></div><div class="table-wrap"><table><thead><tr><th>Department</th><th>Managed by</th><th>Team members</th><th>Open tasks</th>${admin ? '<th></th>' : ''}</tr></thead><tbody>
      ${depts.map(x => `<tr><td><span class="who"><i style="width:10px;height:10px;border-radius:3px;display:inline-block;background:${esc(x.d.color || 'var(--primary)')}"></i><b>${esc(x.d.name)}</b></span></td>
        <td class="small">${x.managers.map(m => esc(m.name)).join(', ') || '<span class="muted">No manager yet</span>'}</td>
        <td>${x.members}</td><td><a href="${T.drill({ dept: x.d.id, preset: 'pending' })}">${x.open}</a></td>
        ${admin ? `<td class="nowrap"><button class="btn sm" data-add-member="${x.d.id}">＋ Add member</button> <button class="btn sm" data-rename="${x.d.id}">Rename</button></td>` : ''}</tr>`).join('')}
      </tbody></table></div></div>
      <div class="card" style="padding:0"><div class="card-head" style="padding:14px 16px 0"><h2>Team members &amp; workload</h2><span class="small muted">${rows.length} employee(s)</span></div><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Manager</th><th>Active</th><th>Overdue</th><th>Critical</th><th>Due today</th><th>In review</th><th>KPI (${range.label})</th><th>Leave / backup</th><th></th></tr></thead><tbody>
      ${rows.map(r => `<tr><td>${U.avatar(r.u.id)}</td><td class="small">${esc(T.deptName(r.u.deptId))}</td><td class="small">${esc(T.userName(r.u.managerId))}</td>
        <td><a href="${T.drill({ owner: r.u.id, preset: 'pending' })}"><b>${r.open}</b></a></td><td><a href="${T.drill({ owner: r.u.id, status: 'overdue' })}" style="color:var(--danger)"><b>${r.od}</b></a></td><td>${r.crit}</td><td>${r.today}</td><td>${r.review}</td>
        <td class="${r.k.band.cls}"><b>${r.k.score == null ? '—' : r.k.score.toFixed(0) + '%'}</b></td>
        <td class="small">${r.u.onLeave ? `🏖 On leave → ${esc(T.userName(r.u.backupId))}` : '<span class="muted">Available</span>'}</td>
        <td class="nowrap"><button class="btn sm" data-assign="${r.u.id}">＋ Assign</button> <button class="btn sm" data-leave="${r.u.id}">${r.u.onLeave ? 'End leave' : 'Leave'}</button></td></tr>`).join('')}
      </tbody></table></div>${rows.length ? '' : `<div class="empty">No team members yet.${admin ? ' Click “＋ Add team member” to add the first one.' : ''}</div>`}</div>`;
    const v = $('#view');
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
      const opts = people.filter(p => p.id !== u.id && !p.onLeave).map(p => `<option value="${p.id}" ${p.deptId === u.deptId ? '' : ''}>${esc(p.name)} — ${esc(T.deptName(p.deptId))}</option>`).join('');
      U.modal(`Mark ${u.name} on leave`, `<div class="alert info">Open tasks are temporarily handed to the backup. Ownership history is retained, and new tasks assigned to ${esc(u.name)} route to the backup automatically.</div>
        <label class="field"><span>Backup employee</span><select class="input" id="lv-b">${opts}</select></label>`, `<button class="btn" data-close>Cancel</button><button class="btn primary" id="lv-ok">Confirm</button>`, m => {
        $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
        $('#lv-ok').onclick = () => { U.act(() => T.api.setLeave(me, u.id, true, $('#lv-b').value), 'Leave recorded; tasks handed to backup').then(ok => { if (ok) U.closeLayer(); }) };
      });
    });
  };

  /* ================= FOLLOW-UP CENTRE ================= */
  V.followups = (f, me) => {
    const all = D().notifications.filter(n => T.canSeeAll(me) || n.to === me.id || (me.role === 'manager' && T.visibleUsers(me).some(u => u.id === n.to)));
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
        <p class="small muted">Reminders stop automatically when a task is submitted, completed or cancelled. ${T.isServer() ? 'Email &amp; Teams are sent by the server through Microsoft Graph; ✓ sent · ~ queued · ✕ failed · – skipped (channel not configured).' : 'Email &amp; Teams deliveries are <b>simulated</b> in this standalone build; the server edition sends them via Microsoft Graph and records the delivery status here.'}</p></div>
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
    const list = D().recurring.filter(r => T.canSeeAll(me) || (me.role === 'manager' && T.managerTeams(me).includes(r.deptId)) || r.ownerId === me.id);
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
        <label class="field"><span>Category</span><select class="input" id="rc-c">${T.CATEGORIES.map(c => `<option>${esc(c)}</option>`).join('')}</select></label></div>`,
        `<button class="btn" data-close>Cancel</button><button class="btn primary" id="rc-ok">Save template</button>`, m => {
          $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
          $('#rc-ok').onclick = () => {
            const fq = $('#rc-f').value, dn = +$('#rc-d').value, owner = T.user($('#rc-o').value);
            const p = T.PRIORITIES.find(x => x.id === $('#rc-p').value);
            U.act(() => T.api.saveRecurring(me, { title: $('#rc-t').value, frequency: fq, dayOfMonth: dn || 1, weekday: Math.min(dn, 6), ownerId: owner && owner.id, deptId: owner && owner.deptId, dueTime: $('#rc-tm').value, priority: p.id, tatHrs: p.tat, category: $('#rc-c').value }), 'Recurring template saved').then(ok => { if (ok) U.closeLayer(); })
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
    const ontime = dueIn.filter(t => t.firstSubmittedAt && t.firstSubmittedAt <= t.kpiDueAt);
    const overdueNow = vis.filter(t => T.isOverdue(t));
    const byDept = T.visibleDepts(me).map(d => {
      const due = dueIn.filter(t => t.deptId === d.id);
      return { d, created: created.filter(t => t.deptId === d.id).length, completed: completed.filter(t => t.deptId === d.id).length, due: due.length, ot: due.filter(t => t.firstSubmittedAt && t.firstSubmittedAt <= t.kpiDueAt).length, od: overdueNow.filter(t => t.deptId === d.id).length };
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
    const list = D().audit.filter(a => !a.taskId || T.canView(me, T.task(a.taskId)) || T.canSeeAll(me))
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
        ${D().users.map(u => `<tr><td>${U.avatar(u.id)}</td><td>${T.ROLES[u.role]}</td><td class="small">${u.role === 'manager' ? (u.teams || []).map(T.deptName).join(', ') : esc(T.deptName(u.deptId))}</td><td class="small">${esc(u.managerId ? T.userName(u.managerId) : '—')}</td><td class="small">${esc(u.email)}</td><td>${u.active ? '<span class="pill s-completed">Active</span>' : '<span class="pill s-cancelled">Inactive</span>'}</td><td><button class="btn sm" data-edit="${u.id}">Edit</button></td></tr>`).join('')}
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
      data: T.isServer() ? `<div class="card" style="max-width:640px"><h2>Data</h2><div class="alert info">Data is stored in the shared PostgreSQL database${D().demo ? ' and currently contains <b>demonstration data</b> (see server/README.md to start with an empty database)' : ''}. Database backups are handled by Supabase.</div>
        <button class="btn" id="dt-exp">Download snapshot of what you can see (JSON)</button></div>` : `<div class="card" style="max-width:640px"><h2>Data</h2><div class="alert warn">This standalone build stores <b>demonstration data</b> in this browser only. Deploy the server edition (see server/README.md) for multi-user access and permanent storage.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="dt-exp">Download backup (JSON)</button><label class="btn">Restore backup<input type="file" id="dt-imp" accept=".json" hidden></label><button class="btn danger" id="dt-reset">Reset demo data</button></div></div>`
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
      if (T.isServer()) return;
      $('#dt-imp').onchange = e => { const fl = e.target.files[0]; if (!fl) return; fl.text().then(txt => U.act(() => T.store.importJSON(txt), 'Backup restored')); };
      $('#dt-reset').onclick = () => { if (confirm('Reset all data to a fresh demonstration dataset?')) { T.store.reset(); T.engine.run(); U.toast('Demo data reset'); T.app.refresh(); } };
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

  function editUser(me, id, presetDept) {
    const depts = D().departments;
    const deptMgr = d => (D().users.find(x => x.active && x.role === 'manager' && (x.teams || []).includes(d)) || {}).id || '';
    const startDept = presetDept || (depts[0] && depts[0].id) || null;
    const u = id ? T.user(id) : { name: '', role: 'employee', deptId: startDept, managerId: deptMgr(startDept), email: '', teams: [] };
    const mgrs = D().users.filter(x => x.role !== 'employee' && x.id !== id && x.active);
    U.modal(id ? 'Edit team member' : 'Add team member', `<label class="field"><span>Full name *</span><input class="input" id="eu-n" value="${esc(u.name)}"></label>
      <label class="field"><span>Work email${T.isServer() ? ' *' : ''}</span><input class="input" id="eu-e" type="email" value="${esc(u.email)}" placeholder="name@company.com"></label>
      <div class="grid2"><label class="field"><span>Role</span><select class="input" id="eu-r">${Object.entries(T.ROLES).map(([k, l]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field"><span>Home department</span><select class="input" id="eu-d"><option value="">— none —</option>${depts.map(d => `<option value="${d.id}" ${u.deptId === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label></div>
      <label class="field"><span>Reports to</span><select class="input" id="eu-m"><option value="">— none —</option>${mgrs.map(m => `<option value="${m.id}" ${u.managerId === m.id ? 'selected' : ''}>${esc(m.name)} (${T.ROLES[m.role]})</option>`).join('')}</select></label>
      <label class="field" id="eu-teams-f"><span>Departments this manager runs</span><div style="display:flex;gap:10px;flex-wrap:wrap">${depts.map(d => `<label class="check"><input type="checkbox" data-team="${d.id}" ${(u.teams || []).includes(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`).join('')}</div></label>
      ${id ? `<label class="check"><input type="checkbox" id="eu-a" ${u.active ? 'checked' : ''}> Active</label>` : ''}`,
      `<button class="btn" data-close>Cancel</button><button class="btn primary" id="eu-ok">Save</button>`, m => {
        $$('[data-close]', m).forEach(x => x.onclick = U.closeLayer);
        const syncRole = () => $('#eu-teams-f').classList.toggle('hidden', $('#eu-r').value !== 'manager');
        $('#eu-r').onchange = syncRole; syncRole();
        if (!id) $('#eu-d').onchange = () => { const mg = deptMgr($('#eu-d').value); if (mg) $('#eu-m').value = mg; };
        $('#eu-ok').onclick = () => {
          const rec = { id: id || undefined, name: $('#eu-n').value.trim(), email: $('#eu-e').value.trim(), role: $('#eu-r').value, deptId: $('#eu-d').value || null, managerId: $('#eu-m').value || null, teams: $$('[data-team]', m).filter(i => i.checked).map(i => i.dataset.team) };
          if (id) rec.active = $('#eu-a').checked;
          if (!id && T.isServer() && !rec.email) return U.toast('Email is required — the user signs in with it.', true);
          if (rec.role !== 'manager') rec.teams = [];
          U.act(() => T.api.saveUser(me, rec), id ? 'Team member updated' : `${rec.name} added to the team`).then(ok => { if (ok) { U.closeLayer(); T.app.renderUserSwitch(); } })
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
    const emps = T.visibleUsers(me).filter(u => u.role === 'employee');
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
      const r = T.visibleDepts(me).map(d => { const due = vis.filter(t => t.deptId === d.id && (t.kpiDueAt <= Date.now() || t.firstSubmittedAt)); const late = due.filter(t => (t.firstSubmittedAt && t.firstSubmittedAt > t.kpiDueAt) || T.isOverdue(t)); return { d, due: due.length, late: late.length, rate: due.length ? 100 * late.length / due.length : 0 }; }).sort((a, b) => b.rate - a.rate);
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
      const rev = open.filter(t => t.status === 'pending_review'); return `${rev.length} task(s) pending review:\n${rev.map(line).join('\n') || 'none'}`;
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

  V.denied = msg => { $('#view').innerHTML = `<div class="card empty"><h2>Access restricted</h2><p>${esc(msg || 'Your role does not have access to this page.')}</p><a class="btn" href="#/dashboard">Back to dashboard</a></div>`; };
})(window.T360);
