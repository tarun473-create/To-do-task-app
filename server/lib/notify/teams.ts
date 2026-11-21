/* Microsoft Teams channel post via a Teams "Workflows" webhook
 * (Teams → channel → Workflows → "Post to a channel when a webhook request is received").
 * The payload is an Adaptive Card; the card names the employee concerned. */
import { env } from '../env';

export async function postToTeams(card: { title: string; text: string; facts: [string, string][]; url?: string }) {
  const content = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
    body: [
      { type: 'TextBlock', text: card.title, weight: 'Bolder', size: 'Medium', wrap: true },
      { type: 'TextBlock', text: card.text, wrap: true },
      { type: 'FactSet', facts: card.facts.map(([title, value]) => ({ title, value })) }
    ],
    actions: card.url ? [{ type: 'Action.OpenUrl', title: 'Open in Task360', url: card.url }] : []
  };
  const res = await fetch(env.teamsWebhookUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content }] }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Teams webhook ${res.status}: ${t}`.slice(0, 300));
  }
}
