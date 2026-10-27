/**
 * Pure rules for contest-team invitations (no database). Expiry, e-mail normalisation, answer checks, resend cooldown and the
 * attach-on-login plan are shared with the event-team invitations in ./invite-rules.
 */
import { MAX_PENDING_PER_TEAM, isInviteExpired, type InviteLike } from './invite-rules';

export { INVITE_TTL_DAYS, MAX_PENDING_PER_TEAM, canResend, checkAnswer, inviteExpiry, inviteSlotKey, isInviteExpired, normalizeEmail, planAttach } from './invite-rules';

export type ContestInviteVerdict =
  | { ok: true; action: 'create' | 'renew' }
  | { ok: false; code: 'CONTEST_ENDED' | 'ALREADY_ON_TEAM' | 'TEAM_FULL' | 'DUPLICATE' | 'TOO_MANY_PENDING'; status: 409 | 422; message: string };

export interface ContestInviteCheck {
  /** Contest end time; invitations are only possible while the contest is still open (not ended). */
  contestEndAt: Date | string;
  memberCount: number;
  maxSize: number;
  /** Invitee already belongs to a team in this contest (any team). */
  inviteeOnTeam?: boolean;
  existing?: InviteLike | null;
  livePendingCount: number;
  now?: Date;
}

/** May the team leader invite this person right now? */
export function checkContestInvite(i: ContestInviteCheck): ContestInviteVerdict {
  const now = i.now ?? new Date();
  if (now.getTime() >= new Date(i.contestEndAt).getTime()) return { ok: false, code: 'CONTEST_ENDED', status: 422, message: 'This contest has ended' };
  if (i.inviteeOnTeam) return { ok: false, code: 'ALREADY_ON_TEAM', status: 409, message: 'That person is already on a team in this contest' };
  if (i.memberCount >= i.maxSize) return { ok: false, code: 'TEAM_FULL', status: 422, message: `The team is already full (maximum ${i.maxSize} members)` };
  if (i.existing && i.existing.status === 'pending' && !isInviteExpired(i.existing, now))
    return { ok: false, code: 'DUPLICATE', status: 409, message: 'That person already has a pending invitation to this team' };
  if (i.livePendingCount >= MAX_PENDING_PER_TEAM)
    return { ok: false, code: 'TOO_MANY_PENDING', status: 422, message: `A team can have at most ${MAX_PENDING_PER_TEAM} pending invitations. Cancel some first.` };
  return { ok: true, action: i.existing ? 'renew' : 'create' };
}
