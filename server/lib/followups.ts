import { runFollowUps } from './engine';
import { transact } from './repo';

/* One follow-up engine pass: reminders, overdue notices, escalations, digests, recurring tasks. */
export async function runFollowUpPass(): Promise<number> {
  return transact(loaded => {
    const out = runFollowUps(loaded.data);
    return { data: out.data, result: out.sent };
  });
}
