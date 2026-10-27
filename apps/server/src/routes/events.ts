import { Router } from 'express';
import { z } from 'zod';
import { ACTIVITY_KINDS, EVENT_STATUSES, EVENT_TYPES, eventSchema } from '@festhub/shared';
import { Activity, Event, Registration, Seat, Team, TeamMember, User, Venue } from '../models';
import { hasRole, isStaff, optionalAuth, requireAuth, requireRole } from '../middleware/auth';
import { conflict, notFound, unprocessable } from '../utils/errors';
import { oid, ok, parse, wrap } from '../utils/http';
import { audit } from '../utils/audit';
import { findOverlaps, fmtRange, suggestNextSlot } from '../services/clash';
import { withLocks } from '../services/lock';
import { eventConflicts, readiness } from '../services/readiness';
import { fillFreeSeats } from '../services/registration';
import { notifyTyped as notify } from '../services/notify';
import { removeEventImage } from '../services/uploads';
import { venueInputSchema } from '../services/venue-rules';
import { deleteActivity } from '../services/cascade';

const r = Router();
const staff = requireRole('organiser', 'coordinator');
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- venues
r.get(
  '/venues',
  requireAuth,
  wrap(async (_q, res) => ok(res, await Venue.find().sort({ name: 1 }))),
);
r.post(
  '/venues',
  requireAuth,
  requireRole('organiser'), // admin satisfies organiser checks; coordinators may not manage venues
  wrap(async (req, res) => {
    const b = parse(venueInputSchema, req.body ?? {});
    if (await Venue.exists({ name: new RegExp(`^${esc(b.name)}$`, 'i') })) throw conflict(`A venue named "${b.name}" already exists`);
    try {
      ok(res, await Venue.create(b), 201);
    } catch (e) {
      if ((e as { code?: number })?.code === 11000) throw conflict(`A venue named "${b.name}" already exists`);
      throw e;
    }
  }),
);

// ---- events
r.get(
  '/events',
  optionalAuth,
  wrap(async (req, res) => {
    const f: Record<string, unknown> = {};
    const q = String(req.query.q ?? '').trim();
    if (q) f.$or = [{ title: { $regex: esc(q), $options: 'i' } }, { description: { $regex: esc(q), $options: 'i' } }];
    if (req.query.type && (EVENT_TYPES as readonly string[]).includes(String(req.query.type))) f.type = req.query.type;
    if (isStaff(req.user)) {
      if (req.query.status && (EVENT_STATUSES as readonly string[]).includes(String(req.query.status))) f.status = req.query.status;
    } else f.status = { $in: ['published', 'completed', 'cancelled'] }; // drafts are never public
    if (req.query.from) f.startAt = { ...(f.startAt as object), $gte: new Date(String(req.query.from)) };
    if (req.query.to) f.startAt = { ...(f.startAt as object), $lte: new Date(String(req.query.to)) };
    const events = await Event.find(f).sort({ startAt: 1 }).limit(100);
    let mine = new Map<string, string>();
    if (req.user) {
      const regs = await Registration.find({
        eventId: { $in: events.map((e) => e._id) },
        status: { $in: ['pending_approval', 'confirmed', 'waitlisted'] },
        $or: [{ userId: req.user.id }, { teamId: { $in: (await TeamMember.find({ userId: req.user.id })).map((m) => m.teamId) } }],
      });
      mine = new Map(regs.map((g) => [String(g.eventId), g.status]));
    }
    const taken = new Map<string, number>(
      await Promise.all(events.map(async (e) => [e.id, await Seat.countDocuments({ eventId: e._id })] as [string, number])),
    );
    const venues = new Map((await Venue.find({ _id: { $in: events.map((e) => e.venueId).filter(Boolean) } })).map((v) => [v.id, v.name]));
    ok(
      res,
      events.map((e) => ({
        ...e.toJSON(),
        venueName: e.venueId ? venues.get(String(e.venueId)) : undefined,
        confirmedCount: taken.get(e.id) ?? 0,
        spotsLeft: Math.max(0, e.capacity - (taken.get(e.id) ?? 0)),
        myRegistrationStatus: mine.get(e.id) ?? null,
      })),
    );
  }),
);

r.get(
  '/events/:id',
  optionalAuth,
  wrap(async (req, res) => {
    const e = await Event.findById(oid(req.params.id));
    if (!e || (e.status === 'draft' && !isStaff(req.user))) throw notFound('Event not found');
    const [venue, activities] = await Promise.all([
      e.venueId ? Venue.findById(e.venueId) : null,
      Activity.find({ eventId: e._id, status: 'scheduled' }).sort({ start: 1 }),
    ]);
    let myRegistration = null,
      myTeam = null;
    if (req.user) {
      const tm = await TeamMember.findOne({ eventId: e._id, userId: req.user.id });
      if (tm) {
        const t = await Team.findById(tm.teamId);
        const members = await TeamMember.find({ teamId: tm.teamId });
        const us = await User.find({ _id: { $in: members.map((m) => m.userId) } }).select('name email');
        myTeam = { ...t!.toJSON(), members: us.map((u) => ({ id: u.id, name: u.name, email: u.email })) };
      }
      myRegistration = await Registration.findOne({
        eventId: e._id,
        status: { $in: ['pending_approval', 'confirmed', 'waitlisted'] },
        $or: [{ userId: req.user.id }, ...(tm ? [{ teamId: tm.teamId }] : [])],
      });
    }
    const taken = await Seat.countDocuments({ eventId: e._id });
    ok(res, { ...e.toJSON(), confirmedCount: taken, venue, activities, spotsLeft: Math.max(0, e.capacity - taken), myRegistration, myTeam });
  }),
);

function checkDates(b: { startAt: Date; endAt: Date; registrationDeadline: Date; teamSize: { min: number; max: number } }) {
  if (b.endAt <= b.startAt) throw unprocessable('The event must end after it starts');
  if (b.registrationDeadline > b.endAt) throw unprocessable('The registration deadline must be before the event ends');
  if (b.teamSize.max < b.teamSize.min) throw unprocessable('Maximum team size cannot be smaller than the minimum');
}

r.post(
  '/events',
  requireAuth,
  requireRole('organiser'),
  wrap(async (req, res) => {
    const b = parse(eventSchema, req.body);
    checkDates(b);
    const e = await Event.create({ ...b, imageUrl: b.imageUrl || undefined, createdBy: req.user!.id });
    await audit(req.user!.id, 'event.create', 'Event', e.id);
    ok(res, e, 201);
  }),
);

r.patch(
  '/events/:id',
  requireAuth,
  requireRole('organiser'),
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const e = await Event.findById(id);
    if (!e) throw notFound('Event not found');
    const b = parse(eventSchema.partial(), req.body);
    const merged = {
      startAt: b.startAt ?? e.startAt,
      endAt: b.endAt ?? e.endAt,
      registrationDeadline: b.registrationDeadline ?? e.registrationDeadline,
      teamSize: b.teamSize ?? e.teamSize ?? { min: 1, max: 1 },
    };
    checkDates(merged);
    const takenSeats = await Seat.countDocuments({ eventId: id });
    if (b.capacity !== undefined && b.capacity < takenSeats) throw unprocessable(`Capacity cannot be lower than the ${takenSeats} seats already taken`);
    const grew = b.capacity !== undefined && b.capacity > e.capacity;
    const oldImage = e.imageUrl;
    const { imageUrl, ...rest } = b;
    Object.assign(e, rest);
    if (imageUrl !== undefined) e.imageUrl = imageUrl || undefined; // '' clears the cover
    await e.save();
    if (imageUrl !== undefined && oldImage && oldImage !== e.imageUrl) await removeEventImage(oldImage); // don't leak replaced uploads
    if (grew) await fillFreeSeats(id);
    await audit(req.user!.id, 'event.update', 'Event', id);
    ok(res, await Event.findById(id));
  }),
);

r.post(
  '/events/:id/publish',
  requireAuth,
  requireRole('organiser'),
  wrap(async (req, res) => {
    const e = await Event.findOneAndUpdate({ _id: oid(req.params.id), status: 'draft' }, { status: 'published' }, { new: true });
    if (!e) throw conflict('Only draft events can be published');
    await audit(req.user!.id, 'event.publish', 'Event', e.id);
    ok(res, e);
  }),
);

r.post(
  '/events/:id/cancel',
  requireAuth,
  requireRole('organiser'),
  wrap(async (req, res) => {
    const e = await Event.findOneAndUpdate({ _id: oid(req.params.id), status: { $in: ['draft', 'published'] } }, { status: 'cancelled' }, { new: true });
    if (!e) throw conflict('This event cannot be cancelled');
    const regs = await Registration.find({ eventId: e._id, status: { $in: ['pending_approval', 'confirmed', 'waitlisted'] } });
    for (const g of regs) {
      const ids = g.userId ? [g.userId] : (await TeamMember.find({ teamId: g.teamId })).map((m) => m.userId);
      await Promise.all(ids.map((u) => notify(u, 'event', `${e.title} was cancelled`, { eventId: e.id })));
    }
    await audit(req.user!.id, 'event.cancel', 'Event', e.id);
    ok(res, e);
  }),
);

r.get(
  '/events/:id/registrations',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const regs = await Registration.find({ eventId: oid(req.params.id), status: { $ne: 'cancelled' } }).sort({ createdAt: 1 });
    const users = await User.find({ _id: { $in: regs.map((g) => g.userId).filter(Boolean) } }).select('name email');
    const teams = await Team.find({ _id: { $in: regs.map((g) => g.teamId).filter(Boolean) } });
    // Coordinators may view the list, but member emails are organiser/admin only (admin satisfies organiser).
    const showEmail = hasRole(req.user, 'organiser');
    const members = await TeamMember.find({ teamId: { $in: teams.map((t) => t._id) } }).sort({ createdAt: 1 });
    const memberUsers = await User.find({ _id: { $in: [...members.map((m) => m.userId), ...teams.map((t) => t.leaderId)] } }).select('name email');
    const byId = new Map(memberUsers.map((u) => [u.id as string, u]));
    const teamMembers = (t: (typeof teams)[number]) => {
      const rows = members.filter((m) => String(m.teamId) === t.id).map((m) => String(m.userId));
      const ids = rows.includes(String(t.leaderId)) ? rows : [String(t.leaderId), ...rows];
      return ids
        .map((uid) => {
          const u = byId.get(uid);
          return { userId: uid, name: u?.name ?? 'Unknown user', ...(showEmail ? { email: u?.email ?? '' } : {}), isLeader: uid === String(t.leaderId) };
        })
        .sort((a, b) => Number(b.isLeader) - Number(a.isLeader));
    };
    ok(
      res,
      regs.map((g) => {
        const team = teams.find((t) => t.id === String(g.teamId)) ?? null;
        const user = users.find((u) => u.id === String(g.userId)) ?? null;
        const mem = team ? teamMembers(team) : undefined;
        return {
          ...g.toJSON(),
          user,
          team: team ? { ...team.toJSON(), members: mem, memberCount: mem!.length } : null,
        };
      }),
    );
  }),
);

// ---- activities & rounds (schedule + clash detection)
const activitySchema = z.object({
  title: z.string().trim().min(2).max(120),
  kind: z.enum(ACTIVITY_KINDS),
  parentId: z.string().optional(),
  start: z.coerce.date(),
  end: z.coerce.date(),
  venueId: z.string().optional(),
  submissionDeadline: z.coerce.date().optional(),
});

async function assertNoVenueClash(venueId: unknown, start: Date, end: Date, selfId?: string) {
  if (!venueId) return;
  const others = await Activity.find({ venueId, status: 'scheduled', ...(selfId ? { _id: { $ne: selfId } } : {}) });
  const hits = findOverlaps({ start, end }, others);
  if (hits.length) {
    const venue = await Venue.findById(venueId);
    const next = suggestNextSlot(others, end.getTime() - start.getTime(), start);
    throw conflict(
      `Venue clash at ${venue?.name ?? 'this venue'}: ${hits.map((h) => `"${h.title}" (${fmtRange(h)})`).join(', ')}. ` +
        `Pick another venue, or move this activity to start at ${next.toISOString().slice(0, 16).replace('T', ' ')} UTC or later.`,
      { conflicts: hits.map((h) => ({ id: h.id, title: h.title, start: h.start, end: h.end })), suggestedStart: next },
    );
  }
}

r.get(
  '/events/:id/activities',
  requireAuth,
  wrap(async (req, res) => ok(res, await Activity.find({ eventId: oid(req.params.id), status: 'scheduled' }).sort({ start: 1 }))),
);

r.post(
  '/events/:id/activities',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const e = await Event.findById(oid(req.params.id));
    if (!e) throw notFound('Event not found');
    const b = parse(activitySchema, req.body);
    if (b.end <= b.start) throw unprocessable('An activity must end after it starts');
    const venueId = b.venueId ?? e.venueId;
    // check + insert happen under the venue lock so two simultaneous bookings cannot both pass
    const a = await withLocks(venueId ? [`venue:${venueId}`] : [], async () => {
      await assertNoVenueClash(venueId, b.start, b.end);
      return Activity.create({ ...b, venueId, eventId: e._id });
    });
    await audit(req.user!.id, 'activity.create', 'Activity', a.id);
    ok(res, a, 201);
  }),
);

r.patch(
  '/activities/:id',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const a = await Activity.findById(oid(req.params.id));
    if (!a) throw notFound('Activity not found');
    const b = parse(activitySchema.partial(), req.body);
    const start = b.start ?? a.start,
      end = b.end ?? a.end,
      venueId = b.venueId ?? a.venueId;
    if (end <= start) throw unprocessable('An activity must end after it starts');
    await withLocks(venueId ? [`venue:${venueId}`] : [], async () => {
      await assertNoVenueClash(venueId, start, end, a.id);
      Object.assign(a, b);
      await a.save();
    });
    ok(res, a);
  }),
);

r.delete(
  '/activities/:id',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const a = await Activity.findById(id);
    if (!a) throw notFound('Activity not found');
    await deleteActivity(id); // hard delete + cascade (entries, rubric, scores, results)
    await audit(req.user!.id, 'activity.delete', 'Activity', id, { title: a.title });
    ok(res, { deleted: true, id });
  }),
);

r.get(
  '/events/:id/schedule/conflicts',
  requireAuth,
  staff,
  wrap(async (req, res) => ok(res, await eventConflicts(oid(req.params.id)))),
);
r.get(
  '/events/:id/readiness',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const d = await readiness(oid(req.params.id));
    if (!d) throw notFound('Event not found');
    ok(res, d);
  }),
);

export default r;
