/* Task360 — data store, seed data and persistence.
 * In this standalone build all data lives in the browser (localStorage) and is
 * DEMONSTRATION data. The production design (docs/ARCHITECTURE.md, db/schema.sql)
 * moves every mutation behind server APIs backed by PostgreSQL.
 */
window.T360 = window.T360 || {};
(function (T) {
  'use strict';

  const STORAGE_KEY = 'task360.v2';
  const HOUR = 3600e3, DAY = 24 * HOUR;

  T.HOUR = HOUR; T.DAY = DAY;

  T.STATUSES = [
    { id: 'assigned', label: 'Assigned', desc: 'Assigned but not acknowledged' },
    { id: 'acknowledged', label: 'Acknowledged', desc: 'Employee has accepted the task' },
    { id: 'in_progress', label: 'In Progress', desc: 'Employee is working on the task' },
    { id: 'on_hold', label: 'On Hold', desc: 'Pending a specific dependency' },
    { id: 'in_approval', label: 'In Approval', desc: 'Waiting for approval before submission' },
    { id: 'pending_review', label: 'Pending Review', desc: 'Submitted, awaiting manager approval' },
    { id: 'completed', label: 'Completed', desc: 'Reviewed and closed' },
    { id: 'reopened', label: 'Reopened', desc: 'Further correction or action required' },
    { id: 'cancelled', label: 'Cancelled', desc: 'Cancelled — excluded from KPI' }
  ];
  T.PRIORITIES = [
    { id: 'low', label: 'Low', tat: 72 },
    { id: 'medium', label: 'Medium', tat: 48 },
    { id: 'high', label: 'High', tat: 24 },
    { id: 'critical', label: 'Critical', tat: 8 }
  ];
  T.ROLES = {
    super_admin: 'Super Admin',
    dept_head: 'Department Head',
    manager: 'Reporting Manager',
    employee: 'Employee'
  };
  T.CATEGORIES = ['Reconciliation', 'Payments', 'Collections', 'Statutory compliance', 'Reporting', 'Month-end close', 'Audit', 'Vendor management', 'Ad hoc'];
  T.REMINDERS = [
    { id: 'standard', label: 'Standard (before deadline & on overdue)' },
    { id: 'daily', label: 'Daily until completed' },
    { id: 'none', label: 'Escalation rules only' }
  ];

  T.defaultSettings = () => ({
    companyName: 'Finance & Accounts',
    timezone: 'Asia/Kolkata',
    workingDays: [1, 2, 3, 4, 5, 6],              // Mon–Sat (0 = Sunday)
    businessHours: { start: '09:30', end: '18:30' },
    holidays: [
      { date: '2026-01-26', name: 'Republic Day' },
      { date: '2026-03-04', name: 'Holi' },
      { date: '2026-08-15', name: 'Independence Day' },
      { date: '2026-10-02', name: 'Gandhi Jayanti' },
      { date: '2026-10-20', name: 'Dussehra' },
      { date: '2026-11-09', name: 'Diwali (observed)' },
      { date: '2026-11-24', name: 'Guru Nanak Jayanti' },
      { date: '2026-12-25', name: 'Christmas' }
    ],
    kpiWeights: { onTime: 35, completion: 25, quality: 20, tat: 10, responsiveness: 10 },
    kpiPolicy: { excludeExternal: true, excludeCancelled: true },
    closeItems: [],          // month-end close checklist (activities assigned month by month)
    rules: {
      ackReminderHrs: 4,
      dueReminderHrs: 24,
      urgentReminderHrs: 2,
      escalation1Days: 1,
      escalation2Days: 2,
      dailyFollowUpTime: '10:00',
      digestTime: '09:00'
    },
    channels: { inApp: true, email: true, teams: true }
  });

  /* ---------- deterministic RNG for seed ---------- */
  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  /* Build an epoch for a given IST calendar date/time. */
  T.istToEpoch = function (dateStr, timeStr) {
    return new Date(`${dateStr}T${timeStr || '00:00'}:00+05:30`).getTime();
  };
  T.epochToIstParts = function (ms) {
    const d = new Date(ms + 5.5 * HOUR);
    return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: d.getUTCHours(), mm: d.getUTCMinutes(), dow: d.getUTCDay() };
  };
  const pad = n => String(n).padStart(2, '0');
  T.istDateStr = ms => { const p = T.epochToIstParts(ms); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
  T.istTimeStr = ms => { const p = T.epochToIstParts(ms); return `${pad(p.hh)}:${pad(p.mm)}`; };

  /* ---------- seed ---------- */
  function seed() {
    const r = rng(360);
    const pick = a => a[Math.floor(r() * a.length)];
    const now = Date.now();

    const departments = [
      { id: 'd1', name: 'Treasury', color: '#4f46e5' },
      { id: 'd2', name: 'Accounts Payable', color: '#0891b2' },
      { id: 'd3', name: 'Accounts Receivable', color: '#16a34a' },
      { id: 'd4', name: 'Compliance', color: '#d97706' },
      { id: 'd5', name: 'MIS & Closing', color: '#db2777' }
    ];
    const users = [
      { id: 'u1', name: 'Tarun Rajput', role: 'super_admin', deptId: null, managerId: null, email: 'tarun.rajput@example.com' },
      { id: 'u3', name: 'Priya Nair', role: 'manager', deptId: 'd1', teams: ['d1', 'd4'], managerId: 'u1', email: 'priya.nair@example.com' },
      { id: 'u4', name: 'Vikram Singh', role: 'manager', deptId: 'd2', teams: ['d2', 'd3', 'd5'], managerId: 'u1', email: 'vikram.singh@example.com' },
      { id: 'u5', name: 'Ananya Gupta', role: 'employee', deptId: 'd1', managerId: 'u3', email: 'ananya.gupta@example.com' },
      { id: 'u6', name: 'Rohit Verma', role: 'employee', deptId: 'd1', managerId: 'u3', email: 'rohit.verma@example.com' },
      { id: 'u7', name: 'Sneha Iyer', role: 'employee', deptId: 'd2', managerId: 'u4', email: 'sneha.iyer@example.com' },
      { id: 'u8', name: 'Karan Patel', role: 'employee', deptId: 'd2', managerId: 'u4', email: 'karan.patel@example.com' },
      { id: 'u9', name: 'Meera Joshi', role: 'employee', deptId: 'd3', managerId: 'u4', email: 'meera.joshi@example.com' },
      { id: 'u10', name: 'Arjun Rao', role: 'employee', deptId: 'd3', managerId: 'u4', email: 'arjun.rao@example.com' },
      { id: 'u11', name: 'Neha Kulkarni', role: 'employee', deptId: 'd4', managerId: 'u3', email: 'neha.kulkarni@example.com' },
      { id: 'u12', name: 'Siddharth Das', role: 'employee', deptId: 'd5', managerId: 'u4', email: 'siddharth.das@example.com' },
      { id: 'u13', name: 'Pooja Reddy', role: 'employee', deptId: 'd5', managerId: 'u4', email: 'pooja.reddy@example.com' }
    ];
    users.forEach(u => { u.active = true; u.onLeave = false; u.backupId = null; });
    // Make u3/u4 also a department-level "home" for display
    const skill = { u5: .93, u6: .8, u7: .88, u8: .7, u9: .9, u10: .82, u11: .62, u12: .86, u13: .76 };

    const titles = {
      d1: ['Daily cash position report', 'Bank reconciliation — HDFC current account', 'FD renewal proposal', 'Forex hedge confirmation', 'Cash flow forecast — next 13 weeks', 'Bank guarantee renewal', 'Working capital limit utilisation report', 'Interest accrual on borrowings'],
      d2: ['Vendor payment run', 'Vendor ledger reconciliation — top 20', 'GRN–invoice three-way match exceptions', 'MSME vendor ageing review', 'Debit note processing', 'Employee reimbursement batch', 'Vendor master KYC update', 'Advance to suppliers clean-up'],
      d3: ['Customer collection follow-up — overdue > 60 days', 'Invoice dispatch confirmation', 'Debtors ageing report', 'Customer ledger confirmation', 'Credit note approval batch', 'Unapplied receipts clean-up', 'Bad debt provisioning workings', 'E-invoice IRN exceptions'],
      d4: ['GSTR-1 filing', 'GSTR-3B filing', 'TDS payment & challan', 'TDS return (24Q/26Q) preparation', 'GST input credit reconciliation (2B vs books)', 'Statutory audit query response', 'Transfer pricing documentation', 'Advance tax computation'],
      d5: ['Month-end provisions', 'Trial balance review', 'MIS pack — management review', 'Fixed asset register update', 'Prepaid expense amortisation', 'Budget vs actual variance report', 'Intercompany reconciliation', 'Board presentation financials']
    };
    const catFor = { d1: 'Reconciliation', d2: 'Payments', d3: 'Collections', d4: 'Statutory compliance', d5: 'Month-end close' };
    const empByDept = {};
    users.filter(u => u.role === 'employee').forEach(u => (empByDept[u.deptId] = empByDept[u.deptId] || []).push(u));
    const mgrOf = uid => users.find(u => u.id === uid).managerId;

    const tasks = [];
    const notifications = [];
    let seq = 1;
    const snapTo = (ms, hh, mm) => T.istToEpoch(T.istDateStr(ms), `${pad(hh)}:${pad(mm)}`);

    for (let i = 0; i < 96; i++) {
      const dept = departments[i % 5];
      const owner = pick(empByDept[dept.id]);
      const mgr = mgrOf(owner.id);
      const pr = r() < .12 ? 'critical' : r() < .38 ? 'high' : r() < .78 ? 'medium' : 'low';
      const tat = T.PRIORITIES.find(p => p.id === pr).tat;
      const createdAt = snapTo(now - (2 + r() * 44) * DAY, 9 + Math.floor(r() * 7), Math.floor(r() * 4) * 15);
      const dueAt = snapTo(createdAt + Math.max(tat * HOUR * (1 + r() * 2.5), 10 * HOUR), 18, 0);
      const s = skill[owner.id];
      const t = {
        id: 'T360-' + String(seq++).padStart(4, '0'),
        title: pick(titles[dept.id]),
        description: 'Prepare, review and upload supporting workings to the shared folder. Flag exceptions to the reporting manager.',
        deptId: dept.id, category: catFor[dept.id], priority: pr,
        ownerId: owner.id, createdBy: mgr, reviewerId: mgr, collaborators: [],
        createdAt, assignedAt: createdAt, startDate: T.istDateStr(createdAt),
        dueAt, originalDueAt: dueAt, kpiDueAt: dueAt, expectedTatHrs: tat,
        status: 'assigned', progress: 0, reminder: r() < .3 ? 'daily' : 'standard',
        kpi: r() < .93, kpiWeight: pr === 'critical' ? 3 : pr === 'high' ? 2 : 1,
        externalDependency: null, dependsOn: [],
        ackAt: null, startedAt: null, firstSubmittedAt: null, submittedAt: null, completedAt: null,
        reopenCount: 0, recurringId: null, archived: false,
        comments: [], checklist: [], attachments: [], ownership: [{ userId: owner.id, from: createdAt, to: null, reason: 'Initial assignment' }],
        deadlineChanges: [], history: []
      };
      const hist = (at, by, action, detail) => t.history.push({ at, by, action, detail: detail || '' });
      hist(createdAt, mgr, 'created', `Task created and assigned to ${owner.name}`);
      t.checklist = [{ id: 'c1', text: 'Collect source data', done: false }, { id: 'c2', text: 'Prepare workings', done: false }, { id: 'c3', text: 'Upload evidence', done: false }];

      // acknowledgement
      const ackDelay = (s > .85 ? r() * 2.5 : s > .75 ? r() * 5 : 1 + r() * 9) * HOUR;
      const past = dueAt < now;
      const roll = r();
      const ackAt = createdAt + ackDelay;
      if (ackAt < now) { t.ackAt = ackAt; t.status = 'acknowledged'; hist(ackAt, owner.id, 'acknowledged', 'Task acknowledged'); }
      if (t.ackAt && t.ackAt + 2 * HOUR < now && (dueAt < now || r() > .25)) { t.startedAt = t.ackAt + HOUR; t.status = 'in_progress'; t.progress = 20; hist(t.startedAt, owner.id, 'status', 'In Progress'); }

      const finish = (subAt) => {
        if (subAt > now) return false;
        t.firstSubmittedAt = t.submittedAt = subAt; t.progress = 100; t.checklist.forEach(c => c.done = true);
        hist(subAt, owner.id, 'submitted', 'Completion submitted: all workings uploaded.');
        t.attachments.push({ id: 'a1', name: `${t.title.split(' ')[0]}_workings.xlsx`, size: 48211, by: owner.id, at: subAt });
        const reviewAt = subAt + (2 + r() * 20) * HOUR;
        if (reviewAt > now || (now - subAt < 4 * DAY && r() < .5)) { t.status = 'pending_review'; return true; }
        if (r() > s + .05) { // reopened once
          t.reopenCount = 1; hist(reviewAt, mgr, 'reopened', 'Reopened: supporting schedule missing for two line items.');
          const resub = reviewAt + (3 + r() * 20) * HOUR;
          if (resub > now) { t.status = 'reopened'; t.progress = 70; t.submittedAt = null; return true; }
          t.submittedAt = resub; hist(resub, owner.id, 'submitted', 'Resubmitted with corrections.');
          const rev2 = resub + 4 * HOUR;
          if (rev2 > now) { t.status = 'pending_review'; return true; }
          t.status = 'completed'; t.completedAt = rev2; hist(rev2, mgr, 'approved', 'Approved and closed.');
          return true;
        }
        t.status = 'completed'; t.completedAt = reviewAt; hist(reviewAt, mgr, 'approved', 'Approved and closed.');
        return true;
      };

      if (roll < .04) { t.status = 'cancelled'; hist(createdAt + DAY, mgr, 'cancelled', 'Cancelled: requirement withdrawn by management.'); }
      else if (past) {
        if (r() < s + .1) {
          const onTime = r() < s;
          const span = dueAt - (t.startedAt || createdAt);
          const subAt = onTime ? (t.startedAt || createdAt) + span * (.35 + r() * .6) : dueAt + (2 + r() * 60) * HOUR;
          if (!finish(subAt)) { t.status = 'in_progress'; t.progress = 60; }
        } else {
          t.progress = Math.floor(r() * 7) * 10;
          if (!t.ackAt) { t.status = 'assigned'; }
          else if (r() < .3) { t.status = 'on_hold'; hist(dueAt - 6 * HOUR, owner.id, 'on_hold', 'On hold: awaiting bank statement from relationship manager.'); }
        }
      } else {
        if (t.startedAt && r() < .2) finish(t.startedAt + (dueAt - t.startedAt) * r() * .5);
        else if (t.startedAt) t.progress = 10 + Math.floor(r() * 7) * 10;
      }
      if (t.status === 'in_progress' || t.status === 'reopened') t.checklist[0].done = true;
      if (r() < .25 && t.status !== 'cancelled') {
        const at = createdAt + 5 * HOUR;
        if (at < now) t.comments.push({ id: 'm1', by: owner.id, at, text: 'Started collating data; will share draft by tomorrow.' });
      }
      // a few with approved external dependency
      if (past && t.status === 'on_hold' && r() < .6) {
        t.externalDependency = { reason: 'Awaiting bank / auditor input', approvedBy: mgr, approvedAt: dueAt - 3 * HOUR };
        hist(dueAt - 3 * HOUR, mgr, 'external_dependency', 'External dependency approved — excluded from timeliness KPI.');
      }
      t.history.sort((a, b) => a.at - b.at);
      tasks.push(t);
    }

    // Deadline revision example (manager-attributed)
    const dt = tasks.find(t => t.status === 'in_progress' && t.dueAt > now);
    if (dt) {
      const nd = dt.dueAt + 2 * DAY;
      dt.deadlineChanges.push({ at: dt.createdAt + 6 * HOUR, by: dt.createdBy, from: dt.dueAt, to: nd, reason: 'Scope expanded to include second bank account.', attribution: 'manager' });
      dt.history.push({ at: dt.createdAt + 6 * HOUR, by: dt.createdBy, action: 'deadline_changed', detail: `Deadline revised (manager-attributed): Scope expanded to include second bank account.` });
      dt.dueAt = nd; dt.kpiDueAt = nd;
    }
    // Dependency example
    const open = tasks.filter(t => !['completed', 'cancelled'].includes(t.status));
    if (open.length > 3) { open[0].dependsOn = [open[1].id]; open[2].dependsOn = [open[3].id]; }

    const recurring = [
      { id: 'r1', title: 'Daily bank reconciliation', deptId: 'd1', ownerId: 'u5', createdBy: 'u3', priority: 'high', frequency: 'daily', dueTime: '17:00', tatHrs: 8, category: 'Reconciliation', active: true, lastKey: null },
      { id: 'r2', title: 'Weekly vendor payment run', deptId: 'd2', ownerId: 'u7', createdBy: 'u4', priority: 'high', frequency: 'weekly', weekday: 5, dueTime: '16:00', tatHrs: 24, category: 'Payments', active: true, lastKey: null },
      { id: 'r3', title: 'GSTR-3B filing', deptId: 'd4', ownerId: 'u11', createdBy: 'u3', priority: 'critical', frequency: 'monthly', dayOfMonth: 20, dueTime: '18:00', tatHrs: 48, category: 'Statutory compliance', active: true, lastKey: null },
      { id: 'r4', title: 'TDS payment & challan', deptId: 'd4', ownerId: 'u11', createdBy: 'u3', priority: 'critical', frequency: 'monthly', dayOfMonth: 7, dueTime: '15:00', tatHrs: 24, category: 'Statutory compliance', active: true, lastKey: null },
      { id: 'r5', title: 'Monthly book closing', deptId: 'd5', ownerId: 'u12', createdBy: 'u4', priority: 'high', frequency: 'monthly', dayOfMonth: 5, dueTime: '18:00', tatHrs: 72, category: 'Month-end close', active: true, lastKey: null },
      { id: 'r6', title: 'Quarterly advance tax computation', deptId: 'd4', ownerId: 'u11', createdBy: 'u3', priority: 'high', frequency: 'quarterly', dayOfMonth: 10, dueTime: '18:00', tatHrs: 72, category: 'Statutory compliance', active: true, lastKey: null }
    ];

    return {
      version: 1, demo: true, seededAt: now, seq,
      settings: T.defaultSettings(),
      departments, users, tasks, recurring, notifications,
      audit: [{ at: now, by: 'system', action: 'seed', taskId: null, detail: 'Demonstration data generated' }],
      sentKeys: {}, leaves: []
    };
  }

  T.store = {
    data: null,
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) { this.data = JSON.parse(raw); return; }
      } catch (e) { console.warn('Storage unavailable, using in-memory data', e); }
      this.data = seed();
      this.save();
    },
    save() {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch (e) { /* in-memory only */ }
    },
    reset() { this.data = seed(); this.save(); },
    /* Clear all demo tasks and people; keep departments and settings; keep the Super Admin. */
    resetEmpty() {
      const d = this.data || seed();
      const admin = Object.assign({}, d.users.find(u => u.role === 'super_admin') || { id: 'u1', name: 'Tarun Rajput', role: 'super_admin', email: '' },
        { managerId: null, deptId: null, teams: [], active: true, onLeave: false, backupId: null });
      const now = Date.now();
      this.data = {
        version: 1, demo: false, seededAt: now, seq: 1, settings: d.settings || T.defaultSettings(),
        departments: d.departments, users: [admin], tasks: [], recurring: [], notifications: [],
        audit: [{ at: now, by: admin.id, action: 'reset', taskId: null, detail: 'Demo data cleared; empty workspace started' }], sentKeys: {}, leaves: []
      };
      this.save();
    },
    exportJSON() { return JSON.stringify(this.data, null, 2); },
    importJSON(text) {
      const d = JSON.parse(text);
      if (!d || !Array.isArray(d.tasks) || !Array.isArray(d.users)) throw new Error('Not a Task360 backup file');
      this.data = d; this.save();
    }
  };
})(window.T360);
