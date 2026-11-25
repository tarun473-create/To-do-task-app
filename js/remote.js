/* Task360 — server-edition adapter.
 * Loaded only by the server edition (window.T360_CONFIG.mode === 'server').
 * Replaces browser storage with the shared database: every T.api call is sent to
 * POST /api/actions, where the server re-runs the same rules engine authoritatively
 * (with the signed-in user as actor, server timestamps and server-side permission checks),
 * persists the result and returns the refreshed data the user is allowed to see.
 */
(function (T) {
  'use strict';
  if (!T.isServer || !T.isServer()) return;

  const boot = window.T360_BOOT;
  let version = boot && boot.version;

  T.store.load = function () { this.data = window.T360_BOOT; };
  T.store.save = function () { /* persisted by the server */ };
  T.store.reset = () => { throw new Error('Not available in the server edition.'); };
  T.store.importJSON = () => { throw new Error('Not available in the server edition.'); };

  async function call(url, body, isForm) {
    const res = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: isForm ? { 'x-task360': '1' } : { 'content-type': 'application/json', 'x-task360': '1' },
      body: isForm ? body : JSON.stringify(body || {})
    });
    if (res.status === 401) { location.href = '/login?expired=1'; throw new Error('Your session has expired. Please sign in again.'); }
    let json = {};
    try { json = await res.json(); } catch (_) { /* non-JSON error */ }
    if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
    if (json.data) { T.store.data = json.data; version = json.data.version; }
    return json;
  }

  // Wrap every engine API call (except markRead, which has its own endpoint).
  Object.keys(T.api).forEach(name => {
    if (name === 'markRead') return;
    T.api[name] = async (_actor, ...args) => (await call('/api/actions', { action: name, args })).result;
  });
  T.api.markRead = (actor, ids) => {
    T.store.data.notifications.forEach(n => { if (n.to === actor.id && (!ids || ids.includes(n.id))) n.read = true; });
    call('/api/notifications/read', { ids: ids || null }).catch(() => {});
  };
  // The follow-up engine runs on the server's schedule, not in the browser.
  T.engine.run = () => 0;

  T.ui.uploadAttachment = async (_me, taskId, file) => {
    if (file.size > 25 * 1024 * 1024) throw new Error('Files must be 25 MB or smaller.');
    // 1) server checks permission and issues a short-lived signed upload URL (private bucket)
    const sign = await call('/api/attachments/sign', { taskId, name: file.name, size: file.size });
    // 2) the browser uploads the file straight to storage
    const put = await fetch(sign.signedUrl, { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file });
    if (!put.ok) throw new Error(`Upload failed (${put.status}). Please try again.`);
    // 3) server verifies the stored object and records it on the task (audited)
    return (await call('/api/attachments/complete', { taskId, path: sign.path, name: file.name, mime: file.type })).result;
  };

  T.remote = {
    /* Pull fresh data; resolves true when anything changed. */
    async refresh() {
      const res = await fetch('/api/bootstrap', { credentials: 'same-origin', headers: { 'x-task360': '1' } });
      if (res.status === 401) { location.href = '/login?expired=1'; return false; }
      if (!res.ok) return false;
      const json = await res.json();
      if (json.data.version === version) return false;
      T.store.data = json.data; version = json.data.version;
      return true;
    },
    async runEngine() { return (await call('/api/engine/run', {})).sent || 0; },
    async setPassword(userId) { return call('/api/admin/set-password', { userId }); }
  };
})(window.T360);
