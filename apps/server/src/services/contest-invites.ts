import rateLimit from 'express-rate-limit';
import { Contest, ContestRegistration, ContestTeam, ContestTeamInvitation } from '../models';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { logAction } from '../utils/audit';
import { mailEnabled, sendMail } from './mailer';
import { notify } from './notify';
import { normalizeEmail, planAttach } from './contest-invite-rules';

/** Per-user cap on invitation sends/resends (skipped under test, like the other limiters). */
export const contestInviteLimiter = env.isTest
  ? (_q: unknown, _s: unknown, n: () => void) => n()
  : rateLimit({
      windowMs: 60 * 60_000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => String(req.user?.id ?? 'anon'),
      message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many invitations. Try again later.' } },
    });

/** Where the e-mail / notification link goes: the contest page, which shows the Accept / Decline banner. */
export const contestInviteLink = (contestId: unknown, invId: unknown) => `${env.appUrl}/contests/${String(contestId)}?invite=${String(invId)}`;
export const contestInvitePath = (contestId: unknown, invId: unknown) => `/contests/${String(contestId)}?invite=${String(invId)}`;

/** Still waiting and not past its expiry date. */
export const liveContestInviteFilter = (now = new Date()) => ({ status: 'pending', $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }] });

/** Flip pending invitations that ran past their expiry to `expired` (kept for the leader's list; Resend revives them). */
export const sweepExpiredContestInvites = (filter: Record<string, unknown>, now = new Date()) =>
  ContestTeamInvitation.updateMany({ ...filter, status: 'pending', expiresAt: { $lte: now } }, { $set: { status: 'expired' } });

/** Send the invitation e-mail. Never throws; false when SMTP is off or delivery failed (the in-app notice still works). */
export async function sendContestInviteEmail(p: { to: string; teamName: string; contestTitle: string; inviterName: string; contestId: unknown; invitationId: unknown; expiresAt: Date }): Promise<boolean> {
  if (!mailEnabled() || !p.to) return false;
  try {
    return await sendMail({
      to: p.to,
      subject: `${p.inviterName} invited you to team "${p.teamName}" for ${p.contestTitle}`,
      text: [
        `Hi,`,
        ``,
        `${p.inviterName} invited you to join the team "${p.teamName}" in the programming contest "${p.contestTitle}" on FestHub.`,
        ``,
        `Accept or decline here: ${contestInviteLink(p.contestId, p.invitationId)}`,
        `(If you do not have an account yet, register with this e-mail address and the invitation will be waiting for you.)`,
        ``,
        `This invitation expires on ${p.expiresAt.toUTCString()}.`,
      ].join('\n'),
    });
  } catch (err) {
    logger.warn('contest invite e-mail failed', { message: (err as Error).message });
    return false;
  }
}

/** Attach e-mail-only contest invitations to a user who just registered or logged in with that address. Never throws. */
export async function attachContestInvites(user: { id: string; email: string; name?: string }): Promise<number> {
  try {
    const email = normalizeEmail(user.email);
    if (!email) return 0;
    const rows = await ContestTeamInvitation.find({ inviteeEmail: email, status: 'pending', $or: [{ inviteeId: { $exists: false } }, { inviteeId: null }] });
    if (!rows.length) return 0;
    const mine = await ContestTeamInvitation.find({ inviteeId: user.id }).select('teamId');
    const plan = planAttach(
      rows.map((r) => ({ id: r.id, teamId: r.teamId, status: r.status as string, expiresAt: r.expiresAt, createdAt: (r as unknown as { createdAt?: Date }).createdAt, inviteeId: r.inviteeId })),
      mine.map((m) => m.teamId),
    );
    if (plan.drop.length) await ContestTeamInvitation.deleteMany({ _id: { $in: plan.drop } });
    let n = 0;
    for (const id of plan.attach) {
      const inv = rows.find((r) => r.id === id)!;
      try {
        inv.inviteeId = user.id as never;
        inv.slotKey = `${String(inv.teamId)}:u:${user.id}`;
        await inv.save();
      } catch (err) {
        if ((err as { code?: number }).code === 11000) await ContestTeamInvitation.deleteOne({ _id: inv._id });
        else logger.warn('attach contest invite failed', { message: (err as Error).message });
        continue;
      }
      n++;
      const [team, contest] = await Promise.all([ContestTeam.findById(inv.teamId), Contest.findById(inv.contestId)]);
      await notify(user.id, 'Contest team invitation', `You have been invited to team "${team?.name ?? 'a team'}" for ${contest?.title ?? 'a contest'}`, contestInvitePath(inv.contestId, inv.id));
      await logAction({ id: user.id, name: user.name }, 'contest.invitation.attach', { type: 'ContestTeamInvitation', id: inv.id }, { teamId: String(inv.teamId) });
    }
    return n;
  } catch (err) {
    logger.warn('attachContestInvites failed', { message: (err as Error).message });
    return 0;
  }
}

/** Is this person already on a team in this contest? */
export const onContestTeam = (contestId: unknown, userId: unknown) => ContestRegistration.exists({ contestId, userId });
