/**
 * Pure team-invitation rules (no database, no I/O) so they can be unit-tested. The routes in routes/registrations.ts and the
 * attach-on-login helper in services/invites.ts call these and translate the verdict into HTTP errors / writes.
 */
export const INVITE_TTL_DAYS = 14;
export const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
export const INVITE_RESEND_COOLDOWN_MS = 30_000;
export const MAX_PENDING_PER_TEAM = 20;

type D = Date | string | number | null | undefined;

export const normalizeEmail = (e: unknown): string => (typeof e === 'string' ? e.trim().toLowerCase() : '');
export const inviteExpiry = (from: Date = new Date()): Date => new Date(from.getTime() + INVITE_TTL_MS);

/** Stable per-team slot: one invitation row per (team, invitee). Account holders are keyed by id, unknown e-mails by address. */
export const inviteSlotKey = (teamId: unknown, who: { userId?: unknown; email?: string }): string =>
  who.userId ? `${String(teamId)}:u:${String(who.userId)}` : `${String(teamId)}:e:${normalizeEmail(who.email)}`;

export interface InviteLike {
  status?: string;
  expiresAt?: D;
  createdAt?: D;
  inviteeId?: unknown;
  inviteeEmail?: string | null;
}

/** Expired when `expiresAt` has passed; rows from before expiry existed fall back to createdAt + 14 days. */
export function isInviteExpired(inv: InviteLike, now: Date = new Date()): boolean {
  const base = inv.expiresAt ? new Date(inv.expiresAt).getTime() : inv.createdAt ? new Date(inv.createdAt).getTime() + INVITE_TTL_MS : NaN;
  return Number.isFinite(base) && base <= now.getTime();
}

export type InviteVerdict =
  | { ok: true; action: 'create' | 'renew' }
  | { ok: false; code: 'ALREADY_IN_TEAM' | 'TEAM_FULL' | 'ROSTER_LOCKED' | 'DUPLICATE' | 'TOO_MANY_PENDING'; status: 409 | 422; message: string };

export interface InviteCheckInput {
  memberCount: number;
  maxSize: number;
  /** Invitee already belongs to a team (any team) for this event. */
  inviteeInEventTeam?: boolean;
  /** The team is already registered, so its roster is locked. */
  rosterLocked?: boolean;
  /** The existing invitation row for this (team, invitee), if any. */
  existing?: InviteLike | null;
  /** Unexpired pending invitations the team already has out. */
  livePendingCount: number;
  now?: Date;
}

/** Decide whether a team leader may send (or re-send) an invitation. */
export function checkInvite(i: InviteCheckInput): InviteVerdict {
  const now = i.now ?? new Date();
  if (i.inviteeInEventTeam) return { ok: false, code: 'ALREADY_IN_TEAM', status: 409, message: 'That person is already in a team for this event' };
  if (i.memberCount >= i.maxSize) return { ok: false, code: 'TEAM_FULL', status: 422, message: 'The team is already full' };
  if (i.rosterLocked) return { ok: false, code: 'ROSTER_LOCKED', status: 422, message: 'This team is already registered; the roster is locked' };
  if (i.existing && i.existing.status === 'pending' && !isInviteExpired(i.existing, now))
    return { ok: false, code: 'DUPLICATE', status: 409, message: 'That person already has a pending invitation to this team' };
  if (i.livePendingCount >= MAX_PENDING_PER_TEAM)
    return { ok: false, code: 'TOO_MANY_PENDING', status: 422, message: `A team can have at most ${MAX_PENDING_PER_TEAM} pending invitations. Cancel some first.` };
  return { ok: true, action: i.existing ? 'renew' : 'create' };
}

export type AnswerVerdict = { ok: true } | { ok: false; code: 'NOT_YOURS' | 'NOT_PENDING' | 'EXPIRED'; message: string };

/** May this user accept/decline this invitation? Matches by account id, or by e-mail for an invite that has not been attached yet. */
export function checkAnswer(inv: InviteLike, user: { id: string; email: string }, now: Date = new Date()): AnswerVerdict {
  const mine = inv.inviteeId ? String(inv.inviteeId) === user.id : !!inv.inviteeEmail && normalizeEmail(inv.inviteeEmail) === normalizeEmail(user.email);
  if (!mine) return { ok: false, code: 'NOT_YOURS', message: 'Invitation not found' };
  if (inv.status !== 'pending') return { ok: false, code: 'NOT_PENDING', message: 'This invitation was already answered' };
  if (isInviteExpired(inv, now)) return { ok: false, code: 'EXPIRED', message: 'This invitation has expired. Ask the team leader to send a new one.' };
  return { ok: true };
}

/** May the leader re-send right now? (30 s cooldown against mail bombing.) */
export const canResend = (lastSentAt: D, now: Date = new Date()): boolean => !lastSentAt || now.getTime() - new Date(lastSentAt).getTime() >= INVITE_RESEND_COOLDOWN_MS;

export interface AttachCandidate extends InviteLike {
  id: string;
  teamId: unknown;
}
/**
 * When someone registers or logs in, which e-mail-only invitations should be attached to the new account?
 * `attach` = pending and live; `drop` = the account already has an invitation for that team (duplicate); `expired` = left alone.
 */
export function planAttach(candidates: AttachCandidate[], teamsAlreadyInvitedTo: Iterable<unknown>, now: Date = new Date()) {
  const seen = new Set([...teamsAlreadyInvitedTo].map(String));
  const out = { attach: [] as string[], drop: [] as string[], expired: [] as string[] };
  for (const c of candidates) {
    if (c.status !== 'pending' || c.inviteeId) continue;
    if (isInviteExpired(c, now)) {
      out.expired.push(c.id);
      continue;
    }
    const t = String(c.teamId);
    if (seen.has(t)) out.drop.push(c.id);
    else {
      seen.add(t);
      out.attach.push(c.id);
    }
  }
  return out;
}
