import { Event, Registration, Seat, Team, TeamMember, User } from '../models';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { notifyTyped as notify } from './notify';

type EventDoc = InstanceType<typeof Event>;
const SEAT_STATES = ['pending_approval', 'confirmed'];
const ACTIVE_STATES = ['pending_approval', 'confirmed', 'waitlisted'];
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

export function assertOpen(event: EventDoc, now = new Date()) {
  if (event.status !== 'published') throw unprocessable('Registration is not open for this event');
  if (now.getTime() > event.registrationDeadline.getTime()) throw unprocessable('The registration deadline has passed');
}

export function assertEligible(event: EventDoc, user: { department?: string | null; batch?: string | null }) {
  const el = event.eligibility;
  const norm = (s?: string | null) => (s ?? '').trim().toLowerCase();
  if (el?.department && norm(el.department) !== norm(user.department)) throw unprocessable(`This event is only for the ${el.department} department`);
  if (el?.batch && norm(el.batch) !== norm(user.batch)) throw unprocessable(`This event is only for batch ${el.batch}`);
}

const isDupErr = isDup;
export const seatsTaken = (eventId: unknown) => Seat.countDocuments({ eventId });

/**
 * Claim a seat for a registration by INSERTING Seat(eventId, seatNo). The unique index guarantees that two
 * concurrent requests can never get the same seatNo, so seats can never exceed capacity (works on any MongoDB engine).
 */
async function claimSeat(eventId: unknown, capacity: number, registrationId: unknown): Promise<boolean> {
  let n = (await seatsTaken(eventId)) + 1; // hint: first probably-free seat number
  for (let tries = 0; tries < capacity + 5; tries++) {
    // Find the lowest free number from the hint upward; at most `capacity` numbers exist.
    if (n > capacity) {
      const used = new Set((await Seat.find({ eventId }).select('seatNo')).map((x) => x.seatNo));
      let free = 0;
      for (let i = 1; i <= capacity; i++)
        if (!used.has(i)) {
          free = i;
          break;
        }
      if (!free) return false;
      n = free;
    }
    try {
      await Seat.create({ eventId, seatNo: n, registrationId });
      return true;
    } catch (e) {
      if (!isDupErr(e)) throw e;
      n += 1;
    }
  }
  return false;
}

/** Core: insert the registration (unique index blocks duplicates), then claim a seat. Waitlist order = creation order (ObjectId). */
async function createRegistration(event: EventDoc, p: { subjectKey: string; userId?: string; teamId?: string }) {
  let reg;
  try {
    reg = await Registration.create({ eventId: event._id, ...p, status: 'waitlisted', holdsSeat: false });
  } catch (e) {
    if (isDup(e)) throw conflict('You are already registered for this event');
    throw e;
  }
  if (await claimSeat(event._id, event.capacity, reg._id)) {
    reg.status = event.requiresApproval ? 'pending_approval' : 'confirmed';
    reg.holdsSeat = true;
    await reg.save();
  } else {
    // Position = how many waitlisted registrations were created before this one, plus one.
    reg.waitlistPosition = (await Registration.countDocuments({ eventId: event._id, status: 'waitlisted', _id: { $lt: reg._id } })) + 1;
    await reg.save();
  }
  return reg;
}

export async function registerIndividual(eventId: string, userId: string) {
  const event = await Event.findById(eventId);
  if (!event) throw notFound('Event not found');
  if (event.participationType !== 'individual') throw unprocessable('This event requires team registration');
  assertOpen(event);
  const user = await User.findById(userId);
  if (!user) throw notFound('User not found');
  assertEligible(event, user);
  const reg = await createRegistration(event, { subjectKey: `u:${userId}`, userId });
  await notify(userId, 'registration', statusMessage(event.title, reg.status, reg.waitlistPosition), { eventId });
  return reg;
}

export async function registerTeam(eventId: string, teamId: string, actorId: string) {
  const event = await Event.findById(eventId);
  if (!event) throw notFound('Event not found');
  if (event.participationType !== 'team') throw unprocessable('This event is for individual registration');
  assertOpen(event);
  const team = await Team.findById(teamId);
  if (!team || String(team.eventId) !== eventId) throw notFound('Team not found for this event');
  if (String(team.leaderId) !== actorId) throw forbidden('Only the team leader can register the team');
  const members = await TeamMember.find({ teamId });
  if (members.length < (event.teamSize?.min ?? 1) || members.length > (event.teamSize?.max ?? 1))
    throw unprocessable(`Team size must be between ${event.teamSize?.min ?? 1} and ${event.teamSize?.max ?? 1} (currently ${members.length})`);
  for (const m of members) {
    const u = await User.findById(m.userId);
    if (u) assertEligible(event, u);
  }
  const reg = await createRegistration(event, { subjectKey: `t:${teamId}`, teamId });
  await Promise.all(members.map((m) => notify(m.userId, 'registration', statusMessage(event.title, reg.status, reg.waitlistPosition, team.name), { eventId })));
  return reg;
}

export const statusMessage = (title: string, status: string, pos?: number | null, team?: string) =>
  `${team ? `Team ${team}: ` : ''}${title} – ` +
  (
    {
      confirmed: 'registration confirmed',
      pending_approval: 'registration received, awaiting approval',
      waitlisted: `you are on the waiting list (position ${pos ?? '?'})`,
      rejected: 'registration rejected',
      cancelled: 'registration cancelled',
    } as Record<string, string>
  )[status];

/** Give the freed seat to the first waitlisted registration (FIFO by creation order). The Seat row is transferred, so nobody can jump the queue. */
export async function releaseSeatAndPromote(eventId: unknown, freedRegistrationId?: unknown) {
  const event = await Event.findById(eventId);
  if (!event) return;
  const seat = freedRegistrationId ? await Seat.findOne({ registrationId: freedRegistrationId }) : null;
  for (let i = 0; i < 50; i++) {
    const next = await Registration.findOne({ eventId, status: 'waitlisted' }).sort({ _id: 1 });
    if (!next) break;
    // Guarded state change: only one process can promote a given registration.
    const won = await Registration.findOneAndUpdate(
      { _id: next._id, status: 'waitlisted' },
      { $set: { status: event.requiresApproval ? 'pending_approval' : 'confirmed', holdsSeat: true }, $unset: { waitlistPosition: 1 } },
      { new: true },
    );
    if (!won) continue;
    if (seat) await Seat.updateOne({ _id: seat._id }, { registrationId: won._id });
    else if (!(await claimSeat(eventId, event.capacity, won._id))) {
      await Registration.updateOne({ _id: won._id }, { status: 'waitlisted', holdsSeat: false });
      return;
    }
    await notifyReg(won, event.title, `a seat opened up – ${won.status === 'confirmed' ? 'you are now confirmed' : 'your registration is awaiting approval'}`);
    return;
  }
  if (seat) await Seat.deleteOne({ _id: seat._id });
}

/** After the organiser raises capacity: fill free seats from the waitlist. */
export async function fillFreeSeats(eventId: string) {
  const event = await Event.findById(eventId);
  if (!event) return;
  for (let i = 0; i < 1000; i++) {
    const next = await Registration.findOne({ eventId, status: 'waitlisted' }).sort({ _id: 1 });
    if (!next) return;
    if (!(await claimSeat(eventId, event.capacity, next._id))) return;
    const won = await Registration.findOneAndUpdate(
      { _id: next._id, status: 'waitlisted' },
      { $set: { status: event.requiresApproval ? 'pending_approval' : 'confirmed', holdsSeat: true }, $unset: { waitlistPosition: 1 } },
      { new: true },
    );
    if (!won) {
      await Seat.deleteOne({ registrationId: next._id });
      continue;
    }
    await notifyReg(won, event.title, 'a seat opened up – you are now confirmed');
  }
}

async function notifyReg(reg: { userId?: unknown; teamId?: unknown; eventId?: unknown }, title: string, msg: string) {
  if (reg.userId) return notify(reg.userId, 'waitlist', `${title}: ${msg}`, { eventId: reg.eventId });
  const members = await TeamMember.find({ teamId: reg.teamId });
  await Promise.all(members.map((m) => notify(m.userId, 'waitlist', `${title}: ${msg}`, { eventId: reg.eventId })));
}

export async function cancelRegistration(regId: string, actor: { id: string; isStaff: boolean }) {
  const reg = await Registration.findById(regId);
  if (!reg) throw notFound('Registration not found');
  let mine = reg.userId && String(reg.userId) === actor.id;
  if (!mine && reg.teamId) {
    const t = await Team.findById(reg.teamId);
    mine = !!t && String(t.leaderId) === actor.id;
  }
  if (!mine && !actor.isStaff) throw forbidden('You can only cancel your own registration');
  // Atomic state change: returns the previous doc so only one concurrent cancel frees the seat.
  const prev = await Registration.findOneAndUpdate(
    { _id: regId, status: { $in: ACTIVE_STATES } },
    { $set: { status: 'cancelled', holdsSeat: false, subjectKey: `cancelled:${regId}` }, $unset: { waitlistPosition: 1 } },
  );
  if (!prev) throw conflict('This registration is already cancelled or closed');
  if (prev.holdsSeat) await releaseSeatAndPromote(prev.eventId, prev._id);
  return Registration.findById(regId);
}

export async function decideRegistration(regId: string, decision: 'approve' | 'reject', actorId: string) {
  const reg = await Registration.findById(regId);
  if (!reg) throw notFound('Registration not found');
  const to = decision === 'approve' ? 'confirmed' : 'rejected';
  const prev = await Registration.findOneAndUpdate(
    { _id: regId, status: 'pending_approval' },
    { $set: { status: to, decidedBy: actorId, holdsSeat: decision === 'approve', ...(decision === 'reject' ? { subjectKey: `rejected:${regId}` } : {}) } },
  );
  if (!prev) throw conflict('Only registrations awaiting approval can be approved or rejected');
  const event = await Event.findById(reg.eventId);
  if (decision === 'reject') await releaseSeatAndPromote(reg.eventId, reg._id);
  await notifyReg(reg, event?.title ?? 'Event', decision === 'approve' ? 'your registration was approved' : 'your registration was rejected');
  return Registration.findById(regId);
}

export { SEAT_STATES, ACTIVE_STATES, AppError };
