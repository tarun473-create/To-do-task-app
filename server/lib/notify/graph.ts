/* Outlook / Microsoft 365 email via Microsoft Graph (client-credentials flow).
 * Requires an Entra ID app registration with the *application* permission Mail.Send
 * (admin consent), and a mailbox to send from (MS_SENDER_EMAIL), ideally restricted with an
 * Exchange application access policy to that one mailbox. */
import { env } from '../env';

let cached: { token: string; exp: number } | null = null;

async function token(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({
    client_id: env.msClientId, client_secret: env.msClientSecret,
    scope: `${env.msGraphBase}/.default`, grant_type: 'client_credentials'
  });
  const res = await fetch(`${env.msLoginBase}/${encodeURIComponent(env.msTenantId)}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000)
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Graph token error ${res.status}: ${j.error_description || j.error || 'unknown'}`.slice(0, 300));
  cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
  return cached.token;
}

export async function sendMail(to: string, subject: string, html: string) {
  const res = await fetch(`${env.msGraphBase}/v1.0/users/${encodeURIComponent(env.msSender)}/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: false
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (res.status === 401) cached = null;
  if (res.status !== 202 && !res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Graph sendMail ${res.status}: ${t}`.slice(0, 300));
  }
}
