/* Builds the data payload a signed-in user's browser receives — only what they may see. */
import { scopeFor, type Dataset } from './engine';
import { loadActivity, hashOf } from './repo';

export async function buildBootstrap(data: Dataset, actorId: string) {
  const scope = scopeFor(data, actorId);
  const activity = await loadActivity();
  const visible = new Set(scope.visibleUserIds);
  const taskIds = new Set(scope.data.tasks.map((t: any) => t.id));
  const isMgr = scope.role !== 'employee';
  const notifications = activity.notifications.filter(n =>
    n.to === actorId || scope.canSeeAll || (scope.role === 'manager' && visible.has(n.to)));
  const audit = isMgr ? activity.audit.filter(a => scope.canSeeAll || !a.taskId || taskIds.has(a.taskId)) : [];
  const payload: Dataset = { ...scope.data, notifications, audit };
  payload.version = hashOf(payload);
  return payload;
}
