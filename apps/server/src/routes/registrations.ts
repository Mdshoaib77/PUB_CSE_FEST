import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Event, Invitation, Notification, Registration, Shift, ShiftAssignment, Team, TeamMember, User } from '../models';
import { isStaff, requireAuth } from '../middleware/auth';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { oid, ok, parse, wrap } from '../utils/http';
import { assertOpen, cancelRegistration, decideRegistration, registerIndividual, registerTeam } from '../services/registration';
import { notify as notifyLink, notifyTyped as notify } from '../services/notify';
import { env } from '../config/env';
import { logAction } from '../utils/audit';
import { canResend, checkAnswer, checkInvite, inviteExpiry, inviteSlotKey, isInviteExpired, normalizeEmail } from '../services/invite-rules';
import { inviteLink, liveInviteFilter, sendInviteEmail } from '../services/invites';
import { requireRole } from '../middleware/auth';
import { emitTo } from '../sockets/io';

const r = Router();
r.use(requireAuth);
const staff = requireRole('organiser', 'coordinator');

r.post(
  '/events/:id/register',
  wrap(async (req, res) => {
    const eventId = oid(req.params.id);
    const { teamId } = parse(z.object({ teamId: z.string().optional() }), req.body ?? {});
    const reg = teamId ? await registerTeam(eventId, oid(teamId), req.user!.id) : await registerIndividual(eventId, req.user!.id);
    ok(res, reg, 201);
  }),
);

r.delete(
  '/registrations/:id',
  wrap(async (req, res) => ok(res, await cancelRegistration(oid(req.params.id), { id: req.user!.id, isStaff: isStaff(req.user) }))),
);
r.post(
  '/registrations/:id/approve',
  staff,
  wrap(async (req, res) => ok(res, await decideRegistration(oid(req.params.id), 'approve', req.user!.id))),
);
r.post(
  '/registrations/:id/reject',
  staff,
  wrap(async (req, res) => ok(res, await decideRegistration(oid(req.params.id), 'reject', req.user!.id))),
);

r.get(
  '/me/registrations',
  wrap(async (req, res) => {
    const tms = await TeamMember.find({ userId: req.user!.id });
    const regs = await Registration.find({ $or: [{ userId: req.user!.id }, { teamId: { $in: tms.map((t) => t.teamId) } }], status: { $ne: 'cancelled' } }).sort(
      { createdAt: -1 },
    );
    const events = await Event.find({ _id: { $in: regs.map((g) => g.eventId) } });
    ok(
      res,
      regs.map((g) => ({ ...g.toJSON(), event: events.find((e) => e.id === String(g.eventId)) })),
    );
  }),
);

// ---- teams
r.post(
  '/events/:id/teams',
  wrap(async (req, res) => {
    const e = await Event.findById(oid(req.params.id));
    if (!e) throw notFound('Event not found');
    if (e.participationType !== 'team') throw unprocessable('This event does not use teams');
    assertOpen(e);
    const { name } = parse(z.object({ name: z.string().trim().min(2).max(60) }), req.body);
    if (await TeamMember.exists({ eventId: e._id, userId: req.user!.id })) throw conflict('You are already in a team for this event');
    const team = await Team.create({ eventId: e._id, name, leaderId: req.user!.id });
    try {
      await TeamMember.create({ teamId: team._id, eventId: e._id, userId: req.user!.id });
    } catch (err) {
      await Team.deleteOne({ _id: team._id });
      throw err;
    }
    ok(res, team, 201);
  }),
);

async function teamView(teamId: string) {
  const team = await Team.findById(teamId);
  if (!team) throw notFound('Team not found');
  const members = await TeamMember.find({ teamId });
  const users = await User.find({ _id: { $in: members.map((m) => m.userId) } }).select('name email');
  const invites = await Invitation.find({ teamId, ...liveInviteFilter() });
  return { ...team.toJSON(), members: users.map((u) => ({ id: u.id, name: u.name, email: u.email })), pendingInvitations: invites.length };
}
r.get(
  '/teams/:id',
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const isMember = await TeamMember.exists({ teamId: id, userId: req.user!.id });
    if (!isMember && !isStaff(req.user)) throw forbidden();
    ok(res, await teamView(id));
  }),
);

/** Invitation sends are capped per user (the in-memory limiter is skipped under test). */
const inviteLimiter = env.isTest
  ? (_q: unknown, _s: unknown, n: () => void) => n()
  : rateLimit({ windowMs: 60 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.user?.id ?? 'anon'), message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many invitations. Try again later.' } } });

const throwVerdict = (v: { status: 409 | 422; message: string }) => {
  throw v.status === 409 ? conflict(v.message) : unprocessable(v.message);
};
async function leaderTeam(teamId: string, userId: string) {
  const team = await Team.findById(teamId);
  if (!team) throw notFound('Team not found');
  if (String(team.leaderId) !== userId) throw forbidden('Only the team leader can invite members');
  const event = await Event.findById(team.eventId);
  if (!event) throw notFound('Event not found');
  return { team, event };
}
const teamIsRegistered = async (teamId: unknown) => !!(await Registration.exists({ teamId, status: { $in: ['pending_approval', 'confirmed', 'waitlisted'] } }));

r.post(
  '/teams/:id/invitations',
  inviteLimiter,
  wrap(async (req, res) => {
    const { team, event } = await leaderTeam(oid(req.params.id), req.user!.id);
    assertOpen(event);
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email().max(254) }), req.body);
    const invitee = await User.findOne({ email });
    if (invitee && String(invitee._id) === req.user!.id) throw unprocessable('You cannot invite yourself');
    const slotKey = inviteSlotKey(team._id, { userId: invitee?._id, email });
    const now = new Date();
    const [existing, memberCount, livePending, inTeam, locked] = await Promise.all([
      Invitation.findOne({ slotKey }),
      TeamMember.countDocuments({ teamId: team._id }),
      Invitation.countDocuments({ teamId: team._id, ...liveInviteFilter(now) }),
      invitee ? TeamMember.exists({ eventId: team.eventId, userId: invitee._id }) : null,
      teamIsRegistered(team._id),
    ]);
    const v = checkInvite({ memberCount, maxSize: event.teamSize?.max ?? 1, inviteeInEventTeam: !!inTeam, rosterLocked: locked, existing, livePendingCount: livePending, now });
    if (!v.ok) throwVerdict(v);
    const expiresAt = inviteExpiry(now);
    const set = { status: 'pending', eventId: team.eventId, invitedBy: req.user!.id, inviteeEmail: email, expiresAt, lastSentAt: now, ...(invitee ? { inviteeId: invitee._id } : {}) };
    let inv;
    try {
      inv = await Invitation.findOneAndUpdate({ slotKey }, { $set: set, $setOnInsert: { teamId: team._id } }, { upsert: true, new: true });
    } catch (err) {
      throw (err as { code?: number }).code === 11000 ? conflict('That person already has a pending invitation to this team') : err;
    }
    if (invitee) await notifyLink(invitee._id, 'Team invitation', `${req.user!.name} invited you to team "${team.name}" for ${event.title}`, `/events?invite=${inv.id}`);
    const emailSent = await sendInviteEmail({ to: email, teamName: team.name, eventTitle: event.title, inviterName: req.user!.name, invitationId: inv.id, expiresAt });
    await logAction(req.user, 'invitation.send', { type: 'Invitation', id: inv.id }, { teamId: String(team._id), email, accountExists: !!invitee, emailSent }, req);
    ok(res, { ...inv.toJSON(), link: inviteLink(inv.id), emailSent, accountExists: !!invitee }, 201);
  }),
);

r.get(
  '/teams/:id/invitations',
  wrap(async (req, res) => {
    const team = await Team.findById(oid(req.params.id));
    if (!team) throw notFound('Team not found');
    if (String(team.leaderId) !== req.user!.id && !isStaff(req.user)) throw forbidden('Only the team leader can see invitations');
    const now = new Date();
    const invs = await Invitation.find({ teamId: team._id, status: 'pending' }).sort({ createdAt: -1 });
    const users = await User.find({ _id: { $in: invs.map((i) => i.inviteeId).filter(Boolean) } }).select('name email');
    ok(
      res,
      invs.map((i) => {
        const u = users.find((x) => x.id === String(i.inviteeId));
        return { _id: i.id, email: i.inviteeEmail ?? u?.email ?? '', name: u?.name, accountExists: !!i.inviteeId, expiresAt: i.expiresAt, lastSentAt: i.lastSentAt, expired: isInviteExpired(i as never, now), link: inviteLink(i.id) };
      }),
    );
  }),
);

r.post(
  '/teams/:id/invitations/:invId/resend',
  inviteLimiter,
  wrap(async (req, res) => {
    const { team, event } = await leaderTeam(oid(req.params.id), req.user!.id);
    assertOpen(event);
    const inv = await Invitation.findOne({ _id: oid(req.params.invId), teamId: team._id, status: 'pending' });
    if (!inv) throw notFound('Pending invitation not found');
    const now = new Date();
    if (!canResend(inv.lastSentAt, now)) throw conflict('This invitation was just sent. Wait a moment before resending.');
    if ((await TeamMember.countDocuments({ teamId: team._id })) >= (event.teamSize?.max ?? 1)) throw unprocessable('The team is already full');
    if (await teamIsRegistered(team._id)) throw unprocessable('This team is already registered; the roster is locked');
    inv.expiresAt = inviteExpiry(now);
    inv.lastSentAt = now;
    await inv.save();
    const to = inv.inviteeEmail ?? (inv.inviteeId ? (await User.findById(inv.inviteeId).select('email'))?.email : undefined) ?? '';
    if (inv.inviteeId) await notifyLink(inv.inviteeId, 'Team invitation', `${req.user!.name} invited you to team "${team.name}" for ${event.title}`, `/events?invite=${inv.id}`);
    const emailSent = await sendInviteEmail({ to, teamName: team.name, eventTitle: event.title, inviterName: req.user!.name, invitationId: inv.id, expiresAt: inv.expiresAt });
    await logAction(req.user, 'invitation.resend', { type: 'Invitation', id: inv.id }, { teamId: String(team._id), emailSent }, req);
    ok(res, { _id: inv.id, expiresAt: inv.expiresAt, emailSent, link: inviteLink(inv.id) });
  }),
);

r.delete(
  '/teams/:id/invitations/:invId',
  wrap(async (req, res) => {
    const { team } = await leaderTeam(oid(req.params.id), req.user!.id);
    const inv = await Invitation.findOneAndUpdate({ _id: oid(req.params.invId), teamId: team._id, status: 'pending' }, { $set: { status: 'cancelled' } }, { new: true });
    if (!inv) throw notFound('Pending invitation not found');
    await logAction(req.user, 'invitation.cancel', { type: 'Invitation', id: inv.id }, { teamId: String(team._id) }, req);
    ok(res, { _id: inv.id, status: inv.status });
  }),
);

r.get(
  '/me/invitations',
  wrap(async (req, res) => {
    const me = await User.findById(req.user!.id).select('email');
    const invs = await Invitation.find({
      $and: [
        liveInviteFilter(),
        { $or: [{ inviteeId: req.user!.id }, ...(me?.email ? [{ inviteeId: { $exists: false }, inviteeEmail: normalizeEmail(me.email) }] : [])] },
      ],
    });
    const teams = await Team.find({ _id: { $in: invs.map((i) => i.teamId) } });
    const events = await Event.find({ _id: { $in: invs.map((i) => i.eventId) } }).select('title');
    const inviters = await User.find({ _id: { $in: invs.map((i) => i.invitedBy) } }).select('name');
    ok(
      res,
      invs.map((i) => ({
        ...i.toJSON(),
        team: teams.find((t) => t.id === String(i.teamId)),
        eventTitle: events.find((e) => e.id === String(i.eventId))?.title,
        inviterName: inviters.find((u) => u.id === String(i.invitedBy))?.name,
      })),
    );
  }),
);

/** Load an invitation for the signed-in invitee; an e-mail-only invite for their address is attached to their account on the spot. */
async function answerable(invId: string, user: { id: string; name: string }) {
  const inv = await Invitation.findById(invId);
  const me = await User.findById(user.id).select('email');
  if (!inv || !me) throw notFound('Invitation not found');
  const v = checkAnswer(inv as never, { id: user.id, email: me.email }, new Date());
  if (!v.ok) throw v.code === 'NOT_YOURS' ? notFound(v.message) : v.code === 'EXPIRED' ? unprocessable(v.message) : conflict(v.message);
  if (!inv.inviteeId) {
    inv.inviteeId = user.id as never;
    inv.slotKey = `${String(inv.teamId)}:u:${user.id}`;
    try {
      await inv.save();
    } catch (err) {
      throw (err as { code?: number }).code === 11000 ? conflict('You already have an invitation to this team') : err;
    }
  }
  return inv;
}

r.post(
  '/invitations/:id/accept',
  wrap(async (req, res) => {
    const inv = await answerable(oid(req.params.id), req.user!);
    const event = await Event.findById(inv.eventId);
    assertOpen(event!);
    const taken = await Registration.exists({ teamId: inv.teamId, status: { $in: ['pending_approval', 'confirmed', 'waitlisted'] } });
    if (taken) throw unprocessable('This team is already registered; the roster is locked');
    // Insert first (unique index blocks double-membership), then verify the size cap; roll back if two accepts raced past the limit.
    const team = await Team.findById(inv.teamId);
    if (!team) throw notFound('Team not found');
    const maxSize = event!.teamSize?.max ?? 1;
    try {
      await TeamMember.create({ teamId: inv.teamId, eventId: inv.eventId, userId: req.user!.id });
    } catch (err) {
      throw (err as { code?: number }).code === 11000 ? conflict('You are already in a team for this event') : err;
    }
    const size = await TeamMember.countDocuments({ teamId: inv.teamId });
    if (size > maxSize) {
      await TeamMember.deleteOne({ teamId: inv.teamId, userId: req.user!.id });
      throw unprocessable('The team is already full');
    }
    await Team.updateOne({ _id: inv.teamId }, { memberCount: size });
    inv.status = 'accepted';
    await inv.save();
    await notify(team.leaderId, 'invitation', `${req.user!.name} joined your team "${team.name}"`, { eventId: String(inv.eventId) });
    await notify(req.user!.id, 'invitation', `You joined team "${team.name}" for ${event!.title}`, { eventId: String(inv.eventId) });
    await logAction(req.user, 'invitation.accept', { type: 'Invitation', id: inv.id }, { teamId: String(inv.teamId) }, req);
    ok(res, await teamView(String(inv.teamId)));
  }),
);

r.post(
  '/invitations/:id/reject',
  wrap(async (req, res) => {
    const inv = await answerable(oid(req.params.id), req.user!);
    inv.status = 'rejected';
    await inv.save();
    const team = await Team.findById(inv.teamId);
    if (team) {
      await notify(team.leaderId, 'invitation', `${req.user!.name} declined your invitation to team "${team.name}"`, { eventId: String(inv.eventId) });
      await notify(req.user!.id, 'invitation', `You declined the invitation to team "${team.name}"`, { eventId: String(inv.eventId) });
    }
    await logAction(req.user, 'invitation.reject', { type: 'Invitation', id: inv.id }, { teamId: String(inv.teamId) }, req);
    ok(res, inv);
  }),
);

r.delete(
  '/teams/:id/members/:userId',
  wrap(async (req, res) => {
    const team = await Team.findById(oid(req.params.id));
    if (!team) throw notFound('Team not found');
    const target = oid(req.params.userId, 'user id');
    const isLeader = String(team.leaderId) === req.user!.id;
    if (!isLeader && target !== req.user!.id) throw forbidden();
    if (target === String(team.leaderId)) throw unprocessable('The team leader cannot be removed; cancel the registration or contact an organiser');
    if (await Registration.exists({ teamId: team._id, status: { $in: ['pending_approval', 'confirmed', 'waitlisted'] } }))
      throw unprocessable('The team is registered; cancel the registration before changing members');
    const del = await TeamMember.deleteOne({ teamId: team._id, userId: target });
    if (del.deletedCount) await Team.updateOne({ _id: team._id }, { memberCount: await TeamMember.countDocuments({ teamId: team._id }) });
    ok(res, await teamView(team.id));
  }),
);

// ---- notifications & dashboard
const syncOtherTabs = (userId: string) => emitTo(`user:${userId}`, 'notification:sync', {});

r.get(
  '/notifications',
  wrap(async (req, res) => {
    // Lenient on purpose (bad values fall back to defaults) so older clients keep working.
    const { limit, skip, unread } = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).catch(50),
        skip: z.coerce.number().int().min(0).max(10000).catch(0),
        unread: z.enum(['1', '0']).optional().catch(undefined),
      }),
      req.query,
    );
    const f: Record<string, unknown> = { userId: req.user!.id };
    if (unread === '1') f.readAt = null;
    ok(res, await Notification.find(f).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit));
  }),
);
/** The bell badge. Counted in the database, so it stays correct even with more than 50 notifications. */
r.get(
  '/notifications/unread-count',
  wrap(async (req, res) => ok(res, { count: await Notification.countDocuments({ userId: req.user!.id, readAt: null }) })),
);
/**
 * Mark notifications as seen. `upTo` (ISO date, optional) limits this to notifications that existed when the client
 * rendered its list, so one that arrives a moment later is NOT silently marked as read before the person has seen it.
 */
r.post(
  '/notifications/read-all',
  wrap(async (req, res) => {
    const { upTo } = parse(z.object({ upTo: z.coerce.date().optional() }), req.body ?? {});
    const f: Record<string, unknown> = { userId: req.user!.id, readAt: null };
    if (upTo) f.createdAt = { $lte: upTo };
    await Notification.updateMany(f, { readAt: new Date() });
    syncOtherTabs(req.user!.id);
    ok(res, { done: true, unread: await Notification.countDocuments({ userId: req.user!.id, readAt: null }) });
  }),
);
r.post(
  '/notifications/:id/read',
  wrap(async (req, res) => {
    await Notification.updateOne({ _id: oid(req.params.id), userId: req.user!.id, readAt: null }, { readAt: new Date() });
    syncOtherTabs(req.user!.id);
    ok(res, { done: true });
  }),
);
r.delete(
  '/notifications/:id',
  wrap(async (req, res) => {
    const d = await Notification.deleteOne({ _id: oid(req.params.id), userId: req.user!.id });
    if (!d.deletedCount) throw notFound('Notification not found');
    syncOtherTabs(req.user!.id);
    ok(res, { deleted: true });
  }),
);
r.delete(
  '/notifications',
  wrap(async (req, res) => {
    const d = await Notification.deleteMany({ userId: req.user!.id });
    syncOtherTabs(req.user!.id);
    ok(res, { deleted: d.deletedCount });
  }),
);

r.get(
  '/me/dashboard',
  wrap(async (req, res) => {
    const uid = req.user!.id;
    const tms = await TeamMember.find({ userId: uid });
    const [regs, unread, invites, assigns] = await Promise.all([
      Registration.find({
        $or: [{ userId: uid }, { teamId: { $in: tms.map((t) => t.teamId) } }],
        status: { $in: ['pending_approval', 'confirmed', 'waitlisted'] },
      }),
      Notification.countDocuments({ userId: uid, readAt: null }),
      Invitation.countDocuments({ inviteeId: uid, ...liveInviteFilter() }),
      ShiftAssignment.find({ volunteerId: uid, status: 'assigned' }),
    ]);
    const shifts = await Shift.find({ _id: { $in: assigns.map((a) => a.shiftId) }, end: { $gt: new Date() } })
      .sort({ start: 1 })
      .limit(5);
    const summary: Record<string, unknown> = {
      registrations: {
        confirmed: regs.filter((g) => g.status === 'confirmed').length,
        waitlisted: regs.filter((g) => g.status === 'waitlisted').length,
        pending: regs.filter((g) => g.status === 'pending_approval').length,
      },
      unreadNotifications: unread,
      pendingInvitations: invites,
      upcomingShifts: shifts,
    };
    if (isStaff(req.user)) {
      const [events, pendingApprovals] = await Promise.all([
        Event.countDocuments({ status: 'published' }),
        Registration.countDocuments({ status: 'pending_approval' }),
      ]);
      summary.staff = { publishedEvents: events, pendingApprovals };
    }
    ok(res, summary);
  }),
);

export default r;
