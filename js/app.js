/* Task360 — app shell: routing, navigation, search, notifications, theme. */
(function (T) {
  'use strict';
  const { $, $$, esc, ui: U } = T;
  const D = () => T.store.data;

  const NAV = [
    { section: 'Overview' },
    { id: 'dashboard', label: 'Management Dashboard', ico: '◧' },
    { id: 'tasks', q: { preset: 'my' }, label: 'My Tasks', ico: '☑', count: me => D().tasks.filter(t => t.ownerId === me.id && T.isOpen(t) && t.status !== 'pending_review').length, countCls: 'muted' },
    { id: 'tasks', q: { preset: 'assigned' }, label: 'Assigned by Me', ico: '➚', roles: ['super_admin', 'dept_head', 'manager'] },
    { id: 'tasks', q: { preset: 'approvals' }, label: 'Approvals for Me', ico: '✓', count: me => T.visibleTasks(me).filter(t => !t.archived && T.waitingOnMe(t, me)).length },
    { id: 'tasks', q: { preset: 'overdue' }, label: 'Overdue Tasks', ico: '⚠', count: me => T.visibleTasks(me).filter(t => T.isOverdue(t) && !t.archived).length },
    { section: 'Views' },
    { id: 'tasks', q: {}, label: 'All Tasks (List)', ico: '☰' },
    { id: 'board', label: 'Kanban Board', ico: '▦' },
    { id: 'calendar', label: 'Calendar', ico: '📅' },
    { id: 'workflow', label: 'Workflow Tracker', ico: '⇢' },
    { section: 'Team' },
    { id: 'team', label: 'Team & Workload', ico: '👥', roles: ['super_admin', 'dept_head', 'manager'] },
    { id: 'kpi', label: 'KPI & Performance', ico: '📈' },
    { id: 'followups', label: 'Follow-up Centre', ico: '🔔' },
    { id: 'recurring', label: 'Recurring Tasks', ico: '↻' },
    { section: 'Insights' },
    { id: 'reports', label: 'Reports & Analytics', ico: '📊' },
    { id: 'assistant', label: 'AI Assistant', ico: '✦' },
    { id: 'audit', label: 'Audit Trail', ico: '🛡', roles: ['super_admin', 'dept_head', 'manager'] },
    { id: 'admin', label: 'Admin Settings', ico: '⚙', roles: ['super_admin'] }
  ];

  const parse = () => {
    const h = location.hash.replace(/^#\/?/, '') || 'dashboard';
    const [path, query] = h.split('?');
    const q = {}; (query || '').split('&').filter(Boolean).forEach(p => { const [k, v] = p.split('='); q[decodeURIComponent(k)] = decodeURIComponent(v || ''); });
    return { path, q };
  };

  T.app = {
    meId: null,
    me() { return T.user(this.meId) || D().users[0]; },
    go(path, q = {}, replace) {
      const s = Object.entries(q).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      const h = `#/${path}${s ? '?' + s : ''}`;
      if (replace) { history.replaceState(null, '', h); this.render(); } else location.hash = h;
    },
    refresh() { this.render(); },
    render() {
      let { path, q } = parse(); const me = this.me();
      let openId = null;
      if (path.startsWith('task/')) { openId = decodeURIComponent(path.slice(5)); path = 'tasks'; }
      const view = T.views[path] || T.views.dashboard;
      const active = document.activeElement, activeF = active && active.dataset && active.dataset.f, caret = active && active.selectionStart;
      try { view(q, me); } catch (e) { console.error(e); $('#view').innerHTML = `<div class="card alert danger">Something went wrong rendering this page: ${esc(e.message)}</div>`; }
      if (activeF) { const el = $(`[data-f="${activeF}"]`); if (el && el.type !== 'date' && el.tagName === 'INPUT') { el.focus(); try { el.setSelectionRange(caret, caret); } catch (_) {} } }
      this.renderNav(path, q); this.renderBell();
      $('#newTaskBtn').classList.toggle('hidden', !T.canCreate(me));
      $('#app').classList.remove('mobile-open');
      if (openId && !$('#layer').innerHTML) U.openTask(openId);
    },
    /* Server edition: re-render after fresh data arrived, without disturbing someone who is typing. */
    applyFresh(force) {
      const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
      const modal = $('#layer .modal');
      if (!force && (typing || modal)) { this.renderBell(); this.renderNav(parse().path, parse().q); return; }
      const open = U.currentTask && $('#layer .drawer') ? U.currentTask : null;
      this.render();
      if (open && !modal) U.openTask(open.id, open.tab);
    },
    renderNav(path, q) {
      const me = this.me();
      $('#nav').innerHTML = NAV.filter(n => !n.roles || n.roles.includes(me.role)).map(n => {
        if (n.section) return `<div class="nav-section">${n.section}</div>`;
        const href = `#/${n.id}${n.q && Object.keys(n.q).length ? '?' + Object.entries(n.q).map(([k, v]) => `${k}=${v}`).join('&') : ''}`;
        const isActive = n.id === path && (!n.q || (n.q.preset || '') === (q.preset || ''));
        const c = n.count ? n.count(me) : 0;
        return `<a href="${href}" class="${isActive ? 'active' : ''}" title="${n.label}"><span class="ico">${n.ico}</span><span class="label">${n.label}</span>${c ? `<span class="count" ${n.countCls ? 'style="background:var(--grey)"' : ''}>${c}</span>` : ''}</a>`;
      }).join('');
      $('#sidebarFoot').innerHTML = `Signed in as <b>${esc(me.name)}</b><br>${T.ROLES[me.role]} · times in IST`;
    },
    renderBell() {
      const n = T.myNotifications(this.me().id).filter(x => !x.read).length;
      const dot = $('#bellDot'); dot.textContent = n > 99 ? '99+' : n; dot.classList.toggle('hidden', !n);
      if (!$('#notifPanel').classList.contains('hidden')) this.renderNotifPanel();
    },
    renderNotifPanel() {
      const me = this.me(), list = T.myNotifications(me.id).slice(0, 40);
      $('#notifPanel').innerHTML = `<div class="card-head" style="padding:10px 14px;margin:0;border-bottom:1px solid var(--border)"><b>Notifications</b><span><a href="#" id="np-all" class="small">Mark all read</a> · <a href="#/followups" class="small">History</a></span></div>
        ${list.map(n => `<div class="notif ${n.read ? '' : 'unread'}" data-n="${n.id}" data-t="${n.taskId || ''}"><div class="small muted">${esc(T.notifTypeLabel(n.type))} · ${T.rel(n.at)}</div>${esc(n.message)}</div>`).join('') || '<div class="empty">You are all caught up.</div>'}`;
      $('#np-all').onclick = e => { e.preventDefault(); T.api.markRead(me); this.renderBell(); this.renderNav(parse().path, parse().q); };
      $$('#notifPanel [data-n]').forEach(el => el.onclick = () => { T.api.markRead(me, [el.dataset.n]); $('#notifPanel').classList.add('hidden'); this.renderBell(); if (el.dataset.t) U.openTask(el.dataset.t); });
    },
    renderUserSwitch() {
      if (!$('#userSwitch')) return; // server edition: no demo user switcher
      const order = ['super_admin', 'dept_head', 'manager', 'employee'];
      $('#userSwitch').innerHTML = order.map(r => `<optgroup label="${T.ROLES[r]}">${D().users.filter(u => u.role === r && u.active).map(u => `<option value="${u.id}" ${u.id === this.meId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</optgroup>`).join('');
    },
    init() {
      T.store.load();
      let saved = null, theme = null;
      try { saved = localStorage.getItem('task360.me.v2'); theme = localStorage.getItem('task360.theme'); } catch (_) {}
      if (T.isServer()) {
        this.meId = T.config.meId;
        $('.role-switch').outerHTML = `<form method="post" action="/auth/signout" style="display:flex;align-items:center;gap:8px"><span class="small"><b>${esc(this.me().name)}</b><br><span class="muted">${T.ROLES[this.me().role]}</span></span><button class="btn sm" type="submit">Sign out</button></form>`;
      } else if (T.isShared()) {
        this.meId = T.config.meId;
        $('.role-switch').outerHTML = `<span class="small" title="Signed in with your Claude account"><b>${esc(this.me().name)}</b><br><span class="muted">${T.ROLES[this.me().role]}</span></span>`;
      } else this.meId = saved && T.user(saved) ? saved : (D().users.find(u => u.role === 'super_admin' && u.active) || D().users[0]).id;
      const badge = $('.demo-badge');
      if (!D().demo) badge.remove();
      else if (T.isServer()) badge.title = 'The shared database contains demonstration data';
      if (theme) document.documentElement.dataset.theme = theme;
      else if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
      const demoSwitch = !T.isServer() && !T.isShared();
      if (demoSwitch) this.renderUserSwitch();

      if (demoSwitch) $('#userSwitch').onchange = e => { this.meId = e.target.value; try { localStorage.setItem('task360.me.v2', this.meId); } catch (_) {} U.closeLayer(); U.toast(`Signed in as ${this.me().name} (${T.ROLES[this.me().role]})`); this.go('dashboard'); this.render(); };
      $('#themeBtn').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = t; try { localStorage.setItem('task360.theme', t); } catch (_) {} };
      $('#collapseBtn').onclick = () => $('#app').classList.toggle('collapsed');
      $('#mobileMenu').onclick = () => $('#app').classList.toggle('mobile-open');
      $('#newTaskBtn').onclick = () => U.openCreate();
      $('#bellBtn').onclick = e => { e.stopPropagation(); const p = $('#notifPanel'); p.classList.toggle('hidden'); if (!p.classList.contains('hidden')) this.renderNotifPanel(); };
      document.addEventListener('click', e => {
        if (!e.target.closest('#notifPanel') && !e.target.closest('#bellBtn')) $('#notifPanel').classList.add('hidden');
        if (!e.target.closest('.search')) $('#searchResults').classList.add('hidden');
      });
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { U.closeLayer(); $('#notifPanel').classList.add('hidden'); }
        if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#globalSearch').focus(); }
      });

      // global search
      const gs = $('#globalSearch'), sr = $('#searchResults');
      gs.oninput = () => {
        const q = gs.value.trim().toLowerCase(); if (q.length < 2) return sr.classList.add('hidden');
        const me = this.me();
        const tasks = T.visibleTasks(me).filter(t => `${t.id} ${t.title} ${t.description} ${t.category}`.toLowerCase().includes(q)).slice(0, 8);
        const people = T.visibleUsers(me).filter(u => u.name.toLowerCase().includes(q)).slice(0, 4);
        const depts = T.visibleDepts(me).filter(d => d.name.toLowerCase().includes(q)).slice(0, 3);
        sr.innerHTML = [
          ...tasks.map(t => `<a href="#" data-st="${t.id}"><span class="tid">${t.id}</span> ${esc(t.title)} <span class="small muted">· ${esc(T.userName(t.ownerId))}</span></a>`),
          ...people.map(u => `<a href="${T.drill({ owner: u.id })}">👤 ${esc(u.name)} <span class="small muted">· ${T.ROLES[u.role]}</span></a>`),
          ...depts.map(d => `<a href="${T.drill({ dept: d.id })}">🏢 ${esc(d.name)}</a>`),
          `<a href="${T.drill({ q: gs.value.trim() })}" class="small">Search all tasks for “${esc(gs.value.trim())}” →</a>`
        ].join('');
        sr.classList.remove('hidden');
        $$('[data-st]', sr).forEach(a => a.onclick = e => { e.preventDefault(); sr.classList.add('hidden'); U.openTask(a.dataset.st); });
        $$('a[href^="#/"]', sr).forEach(a => a.addEventListener('click', () => { sr.classList.add('hidden'); gs.value = ''; }));
      };
      gs.onkeydown = e => { if (e.key === 'Enter') { sr.classList.add('hidden'); this.go('tasks', { q: gs.value.trim() }); gs.value = ''; } };

      window.addEventListener('hashchange', () => {
        U.closeLayer(); this.render();
        if (T.isServer()) T.remote.refresh().then(changed => { if (changed) this.applyFresh(true); }).catch(() => {});
      });
      if (T.isServer()) {
        this.render();
        // The follow-up engine runs on the server (scheduled job). Here we only pull fresh data;
        // the page is re-rendered only when no dialog is open and the user is not typing.
        setInterval(() => {
          if (document.hidden) return;
          T.remote.refresh().then(changed => { if (changed) this.applyFresh(false); }).catch(() => {});
        }, 30e3);
        return;
      }
      if (T.isShared()) {
        this.render();
        // Live: every change a teammate saves arrives through the shared database.
        T.shared.onChange(() => this.applyFresh(false));
        T.shared.startFollowUps();
        return;
      }
      T.engine.run();
      this.render();
      // Follow-up engine heartbeat (the server edition runs this as a scheduled job)
      setInterval(() => { const n = T.engine.run(); if (n) { this.renderBell(); this.renderNav(parse().path, parse().q); } }, 60e3);
      // Keep multiple open tabs in sync
      window.addEventListener('storage', e => { if (e.key === 'task360.v2') { T.store.load(); this.render(); } });
    }
  };

  // The shared team page signs the viewer in and loads the shared data before the app starts.
  document.addEventListener('DOMContentLoaded', () => {
    Promise.resolve(T.beforeInit ? T.beforeInit() : true).then(go => { if (go !== false) T.app.init(); });
  });
})(window.T360);
