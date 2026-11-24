/* Task360 — shared team page adapter.
 * Loaded only by the published team page (window.T360_CONFIG.mode === 'shared').
 * Sign-in: the viewer's Claude account (the page's `user` capability), matched to a Task360
 * team member by the email the Super Admin entered, or linked from an access request.
 * Storage: the page's shared database (`db` capability) — kept permanently, live for everyone:
 *   app/main        settings, departments, team members, recurring templates, admin audit log
 *   tasks/<id>      one document per task (its full history, approvals, comments)
 *   inbox/<userId>  each member's recent in-app notifications
 *   requests/<id>   access requests from people not yet on the team (stores only their id)
 *   locks/engine    short lease so only one open page runs the follow-up engine at a time
 * Every action runs through the same rules engine (js/engine.js) as the other editions.
 */
(function (T) {
  'use strict';
  if (!T.isShared || !T.isShared()) return;

  const HOLDER = 'tab-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DEFAULT_DEPTS = ['Treasury', 'Accounts Payable', 'Accounts Receivable', 'Compliance', 'MIS & Closing'];
  const PALETTE = ['#4f46e5', '#0891b2', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#0d9488', '#ea580c'];

  let db = null, user = null, me = null;
  let appDoc = null, appKnown = false;
  const taskDocs = new Map();       // task id -> { task, sentKeys }
  const inbox = new Map();          // member id -> items (newest first)
  let requests = [];                // [{ claudeId, at }]
  let started = false, inTx = false, pendingRebuild = false, debounce = null;
  const listeners = [];
  let memberWaiter = null;

  /* ---------------- boot screens ---------------- */
  function screen(html) {
    document.getElementById('app').classList.add('booting');
    document.getElementById('view').innerHTML = `<div class="card boot-card"><div class="brand" style="padding:0 0 14px"><div class="brand-logo">360</div><div class="brand-text"><b>Task360</b><span>Performance &amp; Accountability</span></div></div>${html}</div>`;
  }

  /* ---------------- local dataset from the shared documents ---------------- */
  function rebuild() {
    if (!appDoc) return;
    if (inTx) { pendingRebuild = true; return; }
    const a = appDoc;
    const tasks = [...taskDocs.values()].map(x => x && x.task).filter(Boolean).sort((x, y) => (x.id > y.id ? 1 : -1));
    const maxNum = tasks.reduce((m, t) => Math.max(m, parseInt(t.id.slice(5), 10) || 0), 0);
    const sentKeys = Object.assign({}, a.engineKeys || {});
    taskDocs.forEach(x => Object.assign(sentKeys, (x && x.sentKeys) || {}));
    const notifications = [];
    inbox.forEach(items => (items || []).forEach(n => notifications.push(n)));
    notifications.sort((x, y) => x.at - y.at);
    const audit = [...(a.auditLog || [])];
    tasks.forEach(t => (t.history || []).forEach(h => audit.push({ at: h.at, by: h.by, action: h.action, taskId: t.id, detail: h.detail })));
    audit.sort((x, y) => x.at - y.at);
    T.store.data = clone({
      version: 1, demo: false, seq: Math.max(a.seq || 1, maxNum + 1), settings: a.settings, departments: a.departments || [],
      users: a.users || [], recurring: a.recurring || [], tasks, notifications, audit, sentKeys, leaves: []
    });
  }
  function changed() {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      rebuild();
      if (memberWaiter && appDoc && matchUser()) { const w = memberWaiter; memberWaiter = null; w(); }
      if (started && !inTx) listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
    }, 120);
  }

  /* ---------------- subscriptions ---------------- */
  function subscribe(ref, onData, label) {
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(finish, 10000);
      ref.onSnapshot(snap => { onData(snap); if (!snap.metadata.fromCache) finish(); changed(); },
        err => { console.warn(`Task360: ${label} listener stopped`, err && err.code); finish(); if (started) T.ui.toast('Live updates stopped. Reload the page to reconnect.', true); });
    });
  }
  const subscribeApp = () => subscribe(db.doc('app/main'), snap => { appKnown = true; appDoc = snap.exists ? clone(snap.data()) : null; }, 'app');
  const subscribeTasks = () => subscribe(db.collection('tasks'), snap => { taskDocs.clear(); snap.docs.forEach(d => taskDocs.set(d.id, clone(d.data()))); }, 'tasks');
  const subscribeInbox = () => subscribe(db.collection('inbox'), snap => { inbox.clear(); snap.docs.forEach(d => inbox.set(d.id, clone((d.data() || {}).items || []))); }, 'inbox');
  const subscribeRequests = () => subscribe(db.collection('requests'), snap => { requests = snap.docs.map(d => clone(d.data())).filter(r => r && r.claudeId); }, 'requests');

  /* ---------------- identity ---------------- */
  function matchUser() {
    const users = (appDoc && appDoc.users) || [];
    const email = (me.email || '').toLowerCase();
    return users.find(u => u.claudeId && u.claudeId === me.id)
      || (email && users.find(u => !u.claudeId && u.email && u.email.toLowerCase() === email))
      || (me.isOwner && users.find(u => u.role === 'super_admin' && !u.claudeId))
      || null;
  }

  /* ---------------- locking + transactions ---------------- */
  /* Short cooperative lock: held at most 8 s, and cut to 1 s as soon as the save is done
     (leases have no release call, so a renewal with the minimum length ends it early). */
  const held = new Set();
  async function lock(path) {
    for (let i = 0; i < 40; i++) {
      const r = await db.doc(path).acquire({ holder: HOLDER, ttlMs: 8000 }).catch(() => ({ acquired: false }));
      if (r.acquired) { held.add(path); return; }
      await wait(200 + Math.random() * 250);
    }
    throw new Error('Someone else is saving this right now. Please try again in a moment.');
  }
  function unlockAll() {
    held.forEach(path => db.doc(path).acquire({ holder: HOLDER, ttlMs: 1000 }).catch(() => {}));
    held.clear();
  }
  async function refreshDocs(paths) {
    for (const p of paths) {
      const s = await db.doc(p).get();
      if (p === 'app/main') { if (s.exists) appDoc = clone(s.data()); }
      else if (p.startsWith('tasks/') && s.exists) taskDocs.set(p.slice(6), clone(s.data()));
    }
  }
  const appPart = d => JSON.stringify({ settings: d.settings, departments: d.departments, users: d.users, recurring: d.recurring, seq: d.seq });
  const keyTask = k => { const m = /^(T360-\d+):/.exec(k); return m ? m[1] : null; };
  const pruneKeys = keys => { const cut = Date.now() - 120 * T.DAY; return Object.fromEntries(Object.entries(keys).filter(([, v]) => !(v < cut))); };

  async function persist(before) {
    const d = T.store.data, meId = T.config.meId;
    const rewritten = new Set();
    for (const t of d.tasks) if (before.tasks.get(t.id) !== JSON.stringify(t)) rewritten.add(t.id);
    for (const id of rewritten) {
      const t = d.tasks.find(x => x.id === id);
      const keys = Object.assign({}, (taskDocs.get(id) || {}).sentKeys || {});
      Object.keys(d.sentKeys).forEach(k => { if (keyTask(k) === id) keys[k] = d.sentKeys[k]; });
      const body = clone({ task: t, sentKeys: keys, updatedAt: Date.now(), updatedBy: meId });
      await db.doc('tasks/' + id).set(body);
      taskDocs.set(id, body);
    }
    // reminder keys on tasks that were not otherwise changed: merge-only, never overwrite the task
    const byTask = {}, engineKeys = {};
    Object.keys(d.sentKeys).filter(k => !before.keys.has(k)).forEach(k => {
      const id = keyTask(k);
      if (id && !rewritten.has(id)) (byTask[id] = byTask[id] || {})[k] = d.sentKeys[k];
      else if (!id) engineKeys[k] = d.sentKeys[k];
    });
    for (const [id, keys] of Object.entries(byTask)) {
      if (taskDocs.has(id)) await db.doc('tasks/' + id).update({ sentKeys: keys }).catch(e => console.warn('sentKeys update failed', id, e && e.code));
    }
    const newAudit = d.audit.slice(before.auditLen).filter(a => !a.taskId);
    if (appPart(d) !== before.app || newAudit.length || Object.keys(engineKeys).length) {
      const body = clone(Object.assign({}, appDoc, {
        settings: d.settings, departments: d.departments, users: d.users, recurring: d.recurring, seq: d.seq,
        auditLog: [...(appDoc.auditLog || []), ...newAudit].slice(-500),
        engineKeys: pruneKeys(Object.assign({}, appDoc.engineKeys || {}, engineKeys)), updatedAt: Date.now(), updatedBy: meId
      }));
      await db.doc('app/main').set(body);
      appDoc = body;
    }
    // notifications: append to each recipient's inbox (newest first, last 150 kept)
    const fresh = d.notifications.filter(n => !before.notifIds.has(n.id));
    const byUser = {};
    fresh.forEach(n => (byUser[n.to] = byUser[n.to] || []).push(Object.assign({}, n, { id: n.id + '-' + Math.random().toString(36).slice(2, 7) })));
    for (const [uid, notes] of Object.entries(byUser)) {
      try {
        await lock('inbox/' + uid);
        const s = await db.doc('inbox/' + uid).get();
        const items = s.exists ? [...((s.data() || {}).items || [])] : [];
        const next = clone([...notes.reverse(), ...items].slice(0, 150));
        await db.doc('inbox/' + uid).set({ items: next, updatedAt: Date.now() });
        inbox.set(uid, next);
      } catch (e) { console.warn('Task360: notification not delivered to', uid, e && (e.code || e.message)); }
    }
  }

  async function transact(paths, fn) {
    if (T.viewOnly) throw new Error('You have view-only access. Ask the owner to give you Contributor access in this page’s Share menu.');
    while (inTx) await wait(40);
    inTx = true;
    try {
      for (const p of paths) await lock(p);
      await refreshDocs(paths);
      inTx = false; rebuild(); inTx = true;
      const d = T.store.data;
      const before = { tasks: new Map(d.tasks.map(t => [t.id, JSON.stringify(t)])), app: appPart(d), notifIds: new Set(d.notifications.map(n => n.id)), auditLen: d.audit.length, keys: new Set(Object.keys(d.sentKeys)) };
      const result = fn();
      await persist(before);
      return result === undefined ? null : clone(result);
    } catch (e) {
      if (e && e.code === 'quota_exceeded') throw new Error('The shared database is full. Archive or remove old data, or move to the server edition.');
      if (e && e.code === 'invalid_argument' && !e.message) throw new Error('This change could not be saved.');
      throw e;
    } finally {
      unlockAll();
      inTx = false;
      if (pendingRebuild) { pendingRebuild = false; }
      changed();
    }
  }

  /* ---------------- wire the engine API to the shared store ---------------- */
  const APP_ACTIONS = new Set(['createTask', 'duplicate', 'saveUser', 'saveDept', 'renameDept', 'updateSettings', 'setLeave', 'saveRecurring', 'toggleRecurring', 'saveCloseItem', 'planClose']);
  const lockFor = (name, args) => APP_ACTIONS.has(name) || typeof args[0] !== 'string' || !/^T360-\d+$/.test(args[0]) ? ['app/main'] : ['tasks/' + args[0]];
  const original = Object.assign({}, T.api);
  Object.keys(original).forEach(name => {
    if (name === 'markRead') return;
    // The actor is always the signed-in person, whatever the caller passes.
    T.api[name] = (_actor, ...args) => transact(lockFor(name, args), () => original[name](T.user(T.config.meId), ...args));
  });
  T.api.markRead = (actor, ids) => {
    T.store.data.notifications.forEach(n => { if (n.to === actor.id && (!ids || ids.includes(n.id))) n.read = true; });
    (async () => {
      const path = 'inbox/' + T.config.meId;
      await lock(path);
      const s = await db.doc(path).get(); if (!s.exists) return;
      const items = ((s.data() || {}).items || []).map(n => (!ids || ids.includes(n.id) ? Object.assign({}, n, { read: true }) : n));
      await db.doc(path).set(clone({ items, updatedAt: Date.now() }));
    })().catch(() => {}).finally(unlockAll);
  };
  const runSync = T.engine.run.bind(T.engine);
  T.engine.run = function () { return inTx ? runSync() : transact(['app/main'], () => runSync()); };
  T.store.load = function () { rebuild(); };
  T.store.save = function () { /* saved to the shared database by transact() */ };
  T.store.reset = () => { throw new Error('Not available on the shared team page.'); };
  T.store.importJSON = () => { throw new Error('Not available on the shared team page.'); };

  /* ---------------- follow-up engine: one open page at a time ---------------- */
  async function followUpTick() {
    if (T.viewOnly || document.hidden || inTx) return 0;
    const lease = await db.doc('locks/engine').acquire({ holder: HOLDER, ttlMs: 55000 }).catch(() => ({ acquired: false }));
    if (!lease.acquired) return 0;
    return transact(['app/main'], () => runSync()).catch(e => { console.warn('Task360 follow-up run failed', e && e.message); return 0; });
  }

  /* ---------------- first-run setup (owner) ---------------- */
  function setupScreen() {
    return new Promise(resolve => {
      screen(`<h2>Set up Task360 for your team</h2>
        <p class="muted">This creates an empty workspace with no demo data. You become the Super Admin; you then add your team members and their tasks.</p>
        <label class="field"><span>Your name *</span><input class="input" id="su-name" value="${esc(me.name || '')}" placeholder="e.g. Tarun Rajput"></label>
        <label class="field"><span>Your work email *</span><input class="input" id="su-email" type="email" value="${esc(me.email || '')}" placeholder="name@company.com"></label>
        <label class="field"><span>Department / function name</span><input class="input" id="su-co" value="Finance &amp; Accounts"></label>
        <label class="field"><span>Teams (one per line — you can add or rename later)</span><textarea class="input" id="su-depts" rows="5">${DEFAULT_DEPTS.join('\n')}</textarea></label>
        <button class="btn primary" id="su-go">Create workspace</button> <span class="small muted" id="su-msg"></span>`);
      document.getElementById('su-go').onclick = async () => {
        const name = document.getElementById('su-name').value.trim(), email = document.getElementById('su-email').value.trim().toLowerCase();
        const msg = document.getElementById('su-msg');
        if (name.length < 2) { msg.textContent = 'Enter your name.'; return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = 'Enter a valid work email.'; return; }
        const depts = [...new Set(document.getElementById('su-depts').value.split('\n').map(s => s.trim()).filter(Boolean))].slice(0, 30);
        if (!depts.length) { msg.textContent = 'Add at least one team.'; return; }
        const settings = T.defaultSettings(); settings.companyName = document.getElementById('su-co').value.trim() || 'Finance & Accounts';
        const at = Date.now();
        const body = {
          settings, departments: depts.map((n, i) => ({ id: 'd' + (i + 1), name: n.slice(0, 80), color: PALETTE[i % PALETTE.length] })),
          users: [{ id: 'u1', name, role: 'super_admin', deptId: null, managerId: null, teams: [], email, active: true, onLeave: false, backupId: null, claudeId: me.id }],
          recurring: [], seq: 1, demo: false, engineKeys: {}, createdAt: at, updatedAt: at,
          auditLog: [{ at, by: 'u1', action: 'setup', taskId: null, detail: `Task360 workspace created by ${name}` }]
        };
        document.getElementById('su-go').disabled = true; msg.textContent = 'Creating…';
        try { await db.doc('app/main').set(body); appDoc = clone(body); resolve(true); }
        catch (e) { document.getElementById('su-go').disabled = false; msg.textContent = 'Could not create the workspace: ' + (e.message || e.code); }
      };
    });
  }

  /* ---------------- not (yet) a team member ---------------- */
  function notMemberScreen() {
    return new Promise(resolve => {
      memberWaiter = () => resolve(true);
      const who = me.name ? `${esc(me.name)}${me.email ? ` (${esc(me.email)})` : ''}` : 'your Claude account';
      screen(`<h2>You’re not on the Task360 team yet</h2>
        <p>You are signed in as <b>${who}</b>. Ask the Task360 administrator to add you under <b>Team &amp; Workload → Add team member</b> using this email, or send an access request below.</p>
        <button class="btn primary" id="rq-go">Ask for access</button> <span class="small muted" id="rq-msg"></span>
        <p class="small muted" style="margin-top:14px">This page opens automatically as soon as you are added.</p>`);
      document.getElementById('rq-go').onclick = async () => {
        const m = document.getElementById('rq-msg');
        try { await db.doc('requests/' + me.id).set({ claudeId: me.id, at: Date.now() }); m.textContent = 'Request sent. You’ll get in as soon as you are added.'; document.getElementById('rq-go').disabled = true; }
        catch (e) { m.textContent = 'Could not send the request. You may have view-only access to this page — ask the owner to share it with you as Contributor.'; }
      };
    });
  }

  async function linkIdentity(u) {
    if (u.claudeId === me.id && (u.email || !me.email)) return;
    await lock('app/main');
    const s = await db.doc('app/main').get(); if (!s.exists) return;
    const body = clone(s.data());
    const x = body.users.find(v => v.id === u.id); if (!x) return;
    x.claudeId = me.id; if (!x.email && me.email) x.email = me.email.toLowerCase();
    body.auditLog = [...(body.auditLog || []), { at: Date.now(), by: u.id, action: 'sign_in_linked', taskId: null, detail: `${x.name} signed in for the first time; Claude account linked` }].slice(-500);
    await db.doc('app/main').set(body); appDoc = body;
    unlockAll();
    await db.doc('requests/' + me.id).delete().catch(() => {});
  }

  /* ---------------- boot ---------------- */
  T.beforeInit = async function () {
    screen('<h2>Opening Task360…</h2><p class="muted">Signing you in and loading your team’s data.</p>');
    const C = window.claude;
    if (!C || typeof C.use !== 'function') { screen('<h2>Open this page in Claude</h2><p>Task360’s team workspace works inside claude.ai, where you are signed in with your Claude account.</p>'); return false; }
    [db, user] = await Promise.all([C.use('db'), C.use('user')]);
    if (!db || !user) { screen('<h2>Sign in to use Task360</h2><p>Sign in to your Claude account (with access to this page) to see and work on your team’s tasks.</p>'); return false; }
    me = await user.me();
    if (!me.id) { screen('<h2>Sign in to use Task360</h2><p>Your Claude account could not be identified on this page. Sign in, or ask the owner to share the page with you.</p>'); return false; }
    const can = await user.can('data.write');
    T.viewOnly = can === false;
    C.use('downloads').then(dl => {
      if (dl) T.saveFile = (filename, content) => dl.save({ filename, data: content }).catch(e => { if (e && e.code !== 'declined') T.ui.toast('Could not save the file: ' + (e.message || e.code), true); });
    });
    await subscribeApp();
    if (!appKnown) { screen('<h2>Can’t reach your team’s data yet</h2><p>Check your connection, then <a href="#" onclick="location.reload();return false">reload the page</a>.</p>'); return false; }
    if (!appDoc) {
      if (!me.isOwner) { screen('<h2>Task360 isn’t set up yet</h2><p>The page owner needs to open it once to create the workspace.</p>'); return false; }
      if (T.viewOnly) { screen('<h2>Task360 isn’t set up yet</h2><p>You can only view this page.</p>'); return false; }
      await setupScreen();
    }
    let u = matchUser();
    if (!u) { await notMemberScreen(); u = matchUser(); }
    if (!u.active) { screen('<h2>Your Task360 access is switched off</h2><p>Ask the administrator to reactivate your account.</p>'); return false; }
    if (!T.viewOnly) await linkIdentity(u).catch(e => console.warn('Task360: could not link account', e && e.message));
    T.config.meId = u.id;
    const subs = [subscribeTasks(), subscribeInbox()];
    if (u.role === 'super_admin') subs.push(subscribeRequests());
    await Promise.all(subs);
    rebuild();
    document.getElementById('app').classList.remove('booting');
    if (T.viewOnly) {
      const b = document.createElement('div'); b.className = 'alert warn'; b.style.margin = '12px 20px 0';
      b.textContent = 'View only: you can see tasks but not change them. Ask the page owner to share it with you as Contributor.';
      document.querySelector('.main').insertBefore(b, document.getElementById('view'));
    }
    started = true;
    return true;
  };

  /* ---------------- API used by the app and views ---------------- */
  T.shared = {
    onChange(fn) { listeners.push(fn); },
    startFollowUps() { setTimeout(followUpTick, 4000); setInterval(followUpTick, 60e3); },
    runNow() { return T.engine.run(); },
    requests: () => requests.slice().sort((a, b) => a.at - b.at),
    async profiles(ids) { return user ? user.profiles(ids) : {}; },
    async search(q) { return user ? user.search(q) : []; },
    async dismissRequest(claudeId) { await db.doc('requests/' + claudeId).delete(); }
  };
})(window.T360);
