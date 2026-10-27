import { ROLE_LABELS, type Role } from '@festhub/shared';
import { User } from '../models';
import { logger } from '../utils/logger';
import { notifyTyped } from './notify';

/**
 * Notifications for the role request flow. Every helper swallows its own errors (logged, never thrown):
 * a failed notification must never fail the request that triggered it.
 */
const label = (r: string) => ROLE_LABELS[r as Role] ?? r;
const safely = async (what: string, fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    logger.warn('role notification failed', { what, message: (e as Error).message });
  }
};

/** A new request: tell every active organiser and admin (except the requester themselves). */
export const notifyRoleRequested = (req: { id: string; userId: string; role: string }, requesterName: string) =>
  safely('requested', async () => {
    const staff = await User.find({ roles: { $in: ['organiser', 'admin'] }, active: true, _id: { $ne: req.userId } }).select('_id');
    await Promise.allSettled(
      staff.map((s) =>
        notifyTyped(s.id, 'role', `${requesterName} requested the ${req.role} role`, { roleRequestId: req.id, userId: req.userId }, '/admin/role-requests').catch((e: Error) =>
          logger.warn('role notification failed', { what: 'requested', message: e.message }),
        ),
      ),
    );
  });

/** The decision on a request: tell the requester. */
export const notifyRoleDecision = (req: { id: string; userId: string; role: string }, approved: boolean, rejectReason?: string) =>
  safely('decision', () =>
    notifyTyped(
      req.userId,
      'role',
      `Your ${req.role} role request was ${approved ? 'approved' : 'rejected'}${!approved && rejectReason ? `. Reason: ${rejectReason}` : ''}`,
      { roleRequestId: req.id },
      '/dashboard',
    ),
  );

/** Roles changed directly by an organiser; nothing is sent when nothing changed. */
export const notifyRolesChanged = (userId: string, before: readonly string[], after: readonly string[]) =>
  safely('roles-changed', async () => {
    const added = after.filter((r) => !before.includes(r));
    const removed = before.filter((r) => !after.includes(r));
    if (!added.length && !removed.length) return;
    const parts = [added.length ? `added ${added.map(label).join(', ')}` : '', removed.length ? `removed ${removed.map(label).join(', ')}` : ''].filter(Boolean);
    await notifyTyped(userId, 'role', `Your roles were updated: ${parts.join('; ')}.`, undefined, '/dashboard');
  });
