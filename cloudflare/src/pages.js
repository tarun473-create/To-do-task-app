/* Server-rendered pages outside the app: sign-in, set password, one-time setup. */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const page = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Task360</title><link rel="stylesheet" href="/app/css/styles.css">
<style>body{display:block}.box{max-width:420px;margin:9vh auto;padding:28px}.wide{max-width:560px}.or{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:12px;margin:16px 0}.or::before,.or::after{content:"";flex:1;height:1px;background:var(--border)}</style>
<script>try{var t=localStorage.getItem('task360.theme');if(t)document.documentElement.dataset.theme=t;else if(matchMedia('(prefers-color-scheme: dark)').matches)document.documentElement.dataset.theme='dark'}catch(e){}</script>
</head><body>${inner}</body></html>`;
const brand = sub => `<div style="display:flex;align-items:center;gap:10px;margin-bottom:18px"><div class="brand-logo">360</div><div><b style="font-size:17px">Task360</b><div class="small muted">${esc(sub)}</div></div></div>`;
const msgBox = (cls, text) => text ? `<div class="alert ${cls}">${esc(text)}</div>` : '';

export function loginPage({ microsoft, message, messageClass, email }) {
  return page('Sign in', `<div class="card box">${brand('Team Performance & Accountability Hub')}
    ${msgBox(messageClass || 'danger', message)}
    ${microsoft ? `<a class="btn primary" href="/auth/microsoft" style="width:100%;justify-content:center;padding:11px 12px">Sign in with Microsoft</a>
      <p class="small muted" style="text-align:center;margin:8px 0 0">Use your Sunsure work account — the same login as Outlook and Teams.</p>
      <div class="or">or sign in with email and password</div>` : ''}
    <form method="post" action="/auth/password">
      <label class="field"><span>Work email</span><input class="input" type="email" name="email" required autocomplete="username" placeholder="name@sunsure.in" value="${esc(email || '')}"></label>
      <label class="field"><span>Password</span><input class="input" type="password" name="password" required autocomplete="current-password"></label>
      <button class="btn ${microsoft ? '' : 'primary'}" type="submit" style="width:100%;justify-content:center">Sign in</button>
    </form>
    <p class="small muted" style="margin-top:14px">First time? Use your work email and the starting password your administrator gave you. You will choose your own password straight away. Forgot your password? Ask your Task360 administrator to reset it.</p>
  </div>`);
}

export function passwordPage({ first, message }) {
  return page('Set your password', `<div class="card box">${brand('Set your password')}
    ${first ? msgBox('info', 'You signed in with the starting password. Choose your own password to continue.') : ''}
    ${msgBox('danger', message)}
    <form method="post" action="/auth/change-password">
      <label class="field"><span>New password (at least 10 characters, letters and a number)</span><input class="input" type="password" name="password" required minlength="10" autocomplete="new-password"></label>
      <label class="field"><span>Repeat new password</span><input class="input" type="password" name="confirm" required minlength="10" autocomplete="new-password"></label>
      <button class="btn primary" type="submit" style="width:100%;justify-content:center">Save password</button>
    </form></div>`);
}

export function setupPage({ state, message, summary, tokenSet }) {
  let inner;
  if (state === 'done') inner = `${msgBox('info', summary)}<p>Next: open the <a href="/login">sign-in page</a>.</p><p class="small muted">You can now delete the SETUP_TOKEN secret in Cloudflare.</p>`;
  else if (state === 'already') inner = `${msgBox('info', 'Task360 is already set up. This page is switched off.')}<p><a href="/login">Go to sign-in</a></p>`;
  else if (!tokenSet) inner = msgBox('warn', 'Add a SETUP_TOKEN secret (any code of at least 16 characters) in Cloudflare, then reload this page.');
  else inner = `${msgBox('danger', message)}
    <form method="post" action="/api/setup" enctype="multipart/form-data">
      <input type="hidden" name="mode" value="import">
      <label class="field"><span>Setup code (your SETUP_TOKEN)</span><input class="input" type="password" name="token" required autocomplete="off"></label>
      <label class="field"><span>Task360 export file (.json) — from Admin Settings → Data → Download a copy</span><input class="input" type="file" name="file" accept=".json,application/json" required></label>
      <button class="btn primary" type="submit" style="width:100%;justify-content:center">Create tables and load my data</button>
    </form>
    <details style="margin-top:16px"><summary class="small muted" style="cursor:pointer">Or start with an empty workspace</summary>
      <form method="post" action="/api/setup" enctype="multipart/form-data" style="margin-top:10px">
        <input type="hidden" name="mode" value="empty">
        <label class="field"><span>Setup code</span><input class="input" type="password" name="token" required autocomplete="off"></label>
        <label class="field"><span>Your name</span><input class="input" name="name" required></label>
        <label class="field"><span>Your work email</span><input class="input" type="email" name="email" required></label>
        <button class="btn" type="submit" style="width:100%;justify-content:center">Create empty workspace</button>
      </form></details>`;
  return page('Setup', `<div class="card box wide">${brand('One-time setup')}${inner}</div>`);
}
