import { Invitation, Team, Event } from '../models';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { logAction } from '../utils/audit';
import { mailEnabled, sendMail } from './mailer';
import { notify } from './notify';
import { normalizeEmail, planAttach } from './invite-rules';

export const inviteLink = (id: unknown) => `${env.appUrl}/events?invite=${String(id)}`;

/** Pending and not yet expired (rows from before expiry existed have no expiresAt and count as live). */
export const liveInviteFilter = (now = new Date()) => ({ status: 'pending', $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }] });

/** Send the invitation e-mail. Never throws; returns false when SMTP is off or delivery failed (the in-app notice still works). */
export async function sendInviteEmail(p: { to: string; teamName: string; eventTitle: string; inviterName: string; invitationId: unknown; expiresAt: Date }): Promise<boolean> {
  if (!mailEnabled() || !p.to) return false;
  try {
    return await sendMail({
      to: p.to,
      subject: `${p.inviterName} invited you to team "${p.teamName}" for ${p.eventTitle}`,
      text: [
        `Hi,`,
        ``,
        `${p.inviterName} invited you to join the team "${p.teamName}" for the event "${p.eventTitle}" on FestHub.`,
        ``,
        `Accept or decline here: ${inviteLink(p.invitationId)}`,
        `(If you do not have an account yet, register with this e-mail address and the invitation will be waiting for you.)`,
        ``,
        `This invitation expires on ${p.expiresAt.toUTCString()}.`,
      ].join('\n'),
    });
  } catch (err) {
    logger.warn('invite e-mail failed', { message: (err as Error).message });
    return false;
  }
}

/**
 * Attach e-mail-only invitations to a user who just registered or logged in with that address. Never throws (it must not break
 * sign-in). Each attached invitation notifies the new account holder.
 */
export async function attachEmailInvites(user: { id: string; email: string; name?: string }): Promise<number> {
  try {
    const email = normalizeEmail(user.email);
    if (!email) return 0;
    const rows = await Invitation.find({ inviteeEmail: email, status: 'pending', $or: [{ inviteeId: { $exists: false } }, { inviteeId: null }] });
    if (!rows.length) return 0;
    const mine = await Invitation.find({ inviteeId: user.id }).select('teamId');
    const plan = planAttach(
      rows.map((r) => ({ id: r.id, teamId: r.teamId, status: r.status as string, expiresAt: r.expiresAt, createdAt: (r as unknown as { createdAt?: Date }).createdAt, inviteeId: r.inviteeId })),
      mine.map((m) => m.teamId),
    );
    if (plan.drop.length) await Invitation.deleteMany({ _id: { $in: plan.drop } });
    let n = 0;
    for (const id of plan.attach) {
      const inv = rows.find((r) => r.id === id)!;
      try {
        inv.inviteeId = user.id as never;
        inv.slotKey = `${String(inv.teamId)}:u:${user.id}`;
        await inv.save();
      } catch (err) {
        if ((err as { code?: number }).code === 11000) await Invitation.deleteOne({ _id: inv._id });
        else logger.warn('attach invite failed', { message: (err as Error).message });
        continue;
      }
      n++;
      const [team, event] = await Promise.all([Team.findById(inv.teamId), Event.findById(inv.eventId)]);
      await notify(user.id, 'Team invitation', `You have been invited to team "${team?.name ?? 'a team'}" for ${event?.title ?? 'an event'}`, `/events?invite=${inv.id}`);
      await logAction({ id: user.id, name: user.name }, 'invitation.attach', { type: 'Invitation', id: inv.id }, { teamId: String(inv.teamId) });
    }
    return n;
  } catch (err) {
    logger.warn('attachEmailInvites failed', { message: (err as Error).message });
    return 0;
  }
}
