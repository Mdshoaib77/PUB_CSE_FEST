import { Router } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { env } from '../config/env';
import {
  Announcement,
  Availability,
  CheckIn,
  CheckInToken,
  Event,
  Issue,
  Registration,
  ReplacementRequest,
  Shift,
  ShiftAssignment,
  Task,
  TeamMember,
  User,
} from '../models';
import { hasRole, isStaff, requireAuth, requireRole } from '../middleware/auth';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { oid, ok, parse, wrap } from '../utils/http';
import { audit } from '../utils/audit';
import { coveredByAvailability, findOverlaps, fmtRange } from '../services/clash';
import { notifyTyped as notify } from '../services/notify';
import { withLocks } from '../services/lock';
import { emitTo } from '../sockets/io';
import { deleteAssignment } from '../services/cascade';

const r = Router();
r.use(requireAuth);
const staff = requireRole('organiser', 'coordinator');
const coordinatorOnly = requireRole('coordinator', 'organiser');

// ---------------- volunteer availability, shifts, assignment ----------------
r.put(
  '/me/availability/:eventId',
  requireRole('volunteer', 'organiser', 'coordinator'),
  wrap(async (req, res) => {
    const eventId = oid(req.params.eventId);
    const { slots } = parse(z.object({ slots: z.array(z.object({ start: z.coerce.date(), end: z.coerce.date() })).max(50) }), req.body);
    if (slots.some((s) => s.end <= s.start)) throw unprocessable('Each availability slot must end after it starts');
    ok(res, await Availability.findOneAndUpdate({ userId: req.user!.id, eventId }, { $set: { slots } }, { upsert: true, new: true }));
  }),
);
r.get(
  '/me/availability/:eventId',
  wrap(async (req, res) => ok(res, (await Availability.findOne({ userId: req.user!.id, eventId: oid(req.params.eventId) })) ?? { slots: [] })),
);
r.get(
  '/events/:id/availability',
  staff,
  wrap(async (req, res) => {
    const av = await Availability.find({ eventId: oid(req.params.id) });
    const us = await User.find({ _id: { $in: av.map((a) => a.userId) } }).select('name');
    ok(
      res,
      av.map((a) => ({ ...a.toJSON(), name: us.find((u) => u.id === String(a.userId))?.name })),
    );
  }),
);

r.post(
  '/events/:id/shifts',
  staff,
  wrap(async (req, res) => {
    const eventId = oid(req.params.id);
    if (!(await Event.exists({ _id: eventId }))) throw notFound('Event not found');
    const b = parse(
      z.object({
        title: z.string().trim().min(2),
        start: z.coerce.date(),
        end: z.coerce.date(),
        requiredCount: z.coerce.number().int().min(1).max(100).default(1),
        activityId: z.string().optional(),
      }),
      req.body,
    );
    if (b.end <= b.start) throw unprocessable('A shift must end after it starts');
    ok(res, await Shift.create({ ...b, eventId }), 201);
  }),
);

r.get(
  '/events/:id/shifts',
  wrap(async (req, res) => {
    if (!hasRole(req.user, 'organiser', 'coordinator', 'volunteer', 'judge')) throw forbidden();
    const eventId = oid(req.params.id);
    const [shifts, assigns] = await Promise.all([Shift.find({ eventId }).sort({ start: 1 }), ShiftAssignment.find({ eventId, status: 'assigned' })]);
    const users = await User.find({ _id: { $in: assigns.map((a) => a.volunteerId) } }).select('name');
    ok(
      res,
      shifts.map((s) => ({
        ...s.toJSON(),
        assignments: assigns
          .filter((a) => String(a.shiftId) === s.id)
          .map((a) => ({
            id: a.id,
            volunteerId: String(a.volunteerId),
            name: users.find((u) => u.id === String(a.volunteerId))?.name,
            attendance: a.attendance,
          })),
      })),
    );
  }),
);

/** Shared validation for assigning someone to a shift (also used for replacements). */
async function validateAssignable(shift: InstanceType<typeof Shift>, volunteerId: string, opts: { override?: boolean; ignoreAssignmentId?: string }) {
  const vol = await User.findById(volunteerId);
  if (!vol || !vol.roles.includes('volunteer')) throw unprocessable('That user is not a volunteer');
  const mine = await ShiftAssignment.find({ volunteerId, status: 'assigned', ...(opts.ignoreAssignmentId ? { _id: { $ne: opts.ignoreAssignmentId } } : {}) });
  const others = await Shift.find({ _id: { $in: mine.map((a) => a.shiftId) } });
  const clash = findOverlaps(shift, others);
  if (clash.length) {
    throw conflict(
      `${vol.name} is already on duty during this time: ${clash.map((c) => `"${c.title}" (${fmtRange(c)})`).join(', ')}. Choose another volunteer or move the shift.`,
      { conflicts: clash.map((c) => ({ id: c.id, title: c.title, start: c.start, end: c.end })) },
    );
  }
  const av = await Availability.findOne({ userId: volunteerId, eventId: shift.eventId });
  if (!opts.override && !(av && coveredByAvailability(shift, av.slots as never)))
    throw unprocessable(`${vol.name} has not marked themselves available for ${fmtRange(shift)}. Ask them to update availability, or assign with override.`);
  return vol;
}

r.post(
  '/shifts/:id/assign',
  coordinatorOnly,
  wrap(async (req, res) => {
    const shift = await Shift.findById(oid(req.params.id));
    if (!shift) throw notFound('Shift not found');
    const { volunteerId, override } = parse(z.object({ volunteerId: z.string(), override: z.boolean().optional() }), req.body);
    const volId = oid(volunteerId, 'volunteer id');
    // overlap check + capacity check + insert are one critical section per volunteer and per shift
    const { vol, a } = await withLocks([`volunteer:${volId}`, `shift:${shift.id}`], async () => {
      const vol = await validateAssignable(shift, volId, { override });
      const current = await ShiftAssignment.countDocuments({ shiftId: shift._id, status: 'assigned' });
      if (current >= shift.requiredCount) throw unprocessable('This shift already has all the volunteers it needs');
      const a = await ShiftAssignment.create({ shiftId: shift._id, eventId: shift.eventId, volunteerId: vol._id });
      return { vol, a };
    });
    await notify(vol._id, 'shift', `You were assigned to "${shift.title}" (${fmtRange(shift)})`, { shiftId: shift.id });
    await audit(req.user!.id, 'shift.assign', 'ShiftAssignment', a.id);
    ok(res, a, 201);
  }),
);

r.delete(
  '/assignments/:id',
  coordinatorOnly,
  wrap(async (req, res) => {
    const a = await ShiftAssignment.findById(oid(req.params.id));
    if (!a) throw notFound('Assignment not found');
    await deleteAssignment(a._id); // hard delete: also frees the (shift, volunteer) unique key so they can be re-assigned later
    await notify(a.volunteerId, 'shift', 'You were removed from a volunteer shift', { eventId: String(a.eventId) });
    ok(res, { deleted: true, id: a.id });
  }),
);

r.get(
  '/me/shifts',
  wrap(async (req, res) => {
    const as = await ShiftAssignment.find({ volunteerId: req.user!.id, status: 'assigned' });
    const shifts = await Shift.find({ _id: { $in: as.map((a) => a.shiftId) } }).sort({ start: 1 });
    ok(
      res,
      as.map((a) => ({ assignmentId: a.id, attendance: a.attendance, shift: shifts.find((s) => s.id === String(a.shiftId)) })),
    );
  }),
);

r.post(
  '/assignments/:id/attendance',
  staff,
  wrap(async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(['present', 'absent']) }), req.body);
    const a = await ShiftAssignment.findOneAndUpdate(
      { _id: oid(req.params.id), status: 'assigned' },
      { attendance: status, attendanceAt: new Date(), attendanceBy: req.user!.id },
      { new: true },
    );
    if (!a) throw notFound('Active assignment not found');
    ok(res, a);
  }),
);

// ---------------- replacement requests (coordinator approval) ----------------
r.post(
  '/assignments/:id/replacement',
  wrap(async (req, res) => {
    const a = await ShiftAssignment.findOne({ _id: oid(req.params.id), status: 'assigned' });
    if (!a) throw notFound('Active assignment not found');
    if (String(a.volunteerId) !== req.user!.id) throw forbidden('You can only request a replacement for your own shift');
    const shift = await Shift.findById(a.shiftId);
    if (shift && shift.start < new Date()) throw unprocessable('This shift has already started');
    const b = parse(z.object({ reason: z.string().trim().min(3).max(300), proposedVolunteerId: z.string().optional() }), req.body);
    if (await ReplacementRequest.exists({ assignmentId: a._id, status: 'pending' })) throw conflict('A replacement request for this shift is already pending');
    const rr = await ReplacementRequest.create({ assignmentId: a._id, eventId: a.eventId, requestedBy: req.user!.id, ...b });
    const coords = await User.find({ roles: { $in: ['coordinator', 'organiser'] } }).select('_id');
    await Promise.all(
      coords.map((c) => notify(c._id, 'replacement', `${req.user!.name} requested a replacement for "${shift?.title}"`, { replacementId: rr.id })),
    );
    ok(res, rr, 201);
  }),
);

r.get(
  '/events/:id/replacements',
  staff,
  wrap(async (req, res) => {
    const rs = await ReplacementRequest.find({ eventId: oid(req.params.id) }).sort({ createdAt: -1 });
    const as = await ShiftAssignment.find({ _id: { $in: rs.map((x) => x.assignmentId) } });
    const shifts = await Shift.find({ _id: { $in: as.map((a) => a.shiftId) } });
    const users = await User.find({ _id: { $in: rs.flatMap((x) => [x.requestedBy, x.proposedVolunteerId].filter(Boolean)) } }).select('name');
    ok(
      res,
      rs.map((x) => {
        const a = as.find((y) => y.id === String(x.assignmentId));
        return {
          ...x.toJSON(),
          requesterName: users.find((u) => u.id === String(x.requestedBy))?.name,
          proposedName: users.find((u) => u.id === String(x.proposedVolunteerId))?.name,
          shift: shifts.find((s) => s.id === String(a?.shiftId)),
        };
      }),
    );
  }),
);

r.post(
  '/replacements/:id/approve',
  coordinatorOnly,
  wrap(async (req, res) => {
    const rr = await ReplacementRequest.findById(oid(req.params.id));
    if (!rr) throw notFound('Replacement request not found');
    if (rr.status !== 'pending') throw conflict('This request was already decided');
    const b = parse(z.object({ volunteerId: z.string().optional(), override: z.boolean().optional(), note: z.string().optional() }), req.body ?? {});
    const newVolId = b.volunteerId ?? (rr.proposedVolunteerId ? String(rr.proposedVolunteerId) : undefined);
    if (!newVolId) throw unprocessable('Choose the replacement volunteer to approve this request');
    const old = await ShiftAssignment.findById(rr.assignmentId);
    const shift = old && (await Shift.findById(old.shiftId));
    if (!old || !shift || old.status !== 'assigned') throw unprocessable('The original assignment is no longer active');
    const vol = await withLocks([`volunteer:${newVolId}`, `shift:${shift.id}`], async () => {
      const vol = await validateAssignable(shift, newVolId, { override: b.override }); // re-runs overlap + availability for the replacement
      const claimed = await ReplacementRequest.findOneAndUpdate(
        { _id: rr._id, status: 'pending' },
        { status: 'approved', decidedBy: req.user!.id, decisionNote: b.note, proposedVolunteerId: vol._id },
      );
      if (!claimed) throw conflict('This request was already decided');
      try {
        await ShiftAssignment.create({ shiftId: shift._id, eventId: shift.eventId, volunteerId: vol._id });
      } catch (e) {
        await ReplacementRequest.updateOne({ _id: rr._id }, { status: 'pending' });
        throw e;
      }
      await ShiftAssignment.updateOne({ _id: old._id }, { status: 'replaced' });
      return vol;
    });
    await Promise.all([
      notify(rr.requestedBy, 'replacement', `Your replacement request for "${shift.title}" was approved`),
      notify(vol._id, 'shift', `You were assigned to "${shift.title}" (${fmtRange(shift)})`),
    ]);
    await audit(req.user!.id, 'replacement.approve', 'ReplacementRequest', rr.id);
    ok(res, await ReplacementRequest.findById(rr.id));
  }),
);

r.post(
  '/replacements/:id/reject',
  coordinatorOnly,
  wrap(async (req, res) => {
    const rr = await ReplacementRequest.findOneAndUpdate(
      { _id: oid(req.params.id), status: 'pending' },
      { status: 'rejected', decidedBy: req.user!.id, decisionNote: String(req.body?.note ?? '') },
      { new: true },
    );
    if (!rr) throw conflict('Pending request not found');
    await notify(rr.requestedBy, 'replacement', 'Your replacement request was rejected; please attend your shift');
    ok(res, rr);
  }),
);

// ---------------- tasks ----------------
r.post(
  '/events/:id/tasks',
  staff,
  wrap(async (req, res) => {
    const b = parse(z.object({ title: z.string().trim().min(2), assigneeId: z.string(), shiftId: z.string().optional() }), req.body);
    const t = await Task.create({ ...b, eventId: oid(req.params.id) });
    await notify(b.assigneeId, 'task', `New task: ${b.title}`, { taskId: t.id });
    ok(res, t, 201);
  }),
);
r.get(
  '/events/:id/tasks',
  staff,
  wrap(async (req, res) => ok(res, await Task.find({ eventId: oid(req.params.id) }).sort({ createdAt: -1 }))),
);
r.get(
  '/me/tasks',
  wrap(async (req, res) => ok(res, await Task.find({ assigneeId: req.user!.id }).sort({ createdAt: -1 }))),
);
r.patch(
  '/tasks/:id/complete',
  wrap(async (req, res) => {
    const t = await Task.findById(oid(req.params.id));
    if (!t) throw notFound('Task not found');
    if (String(t.assigneeId) !== req.user!.id && !isStaff(req.user)) throw forbidden();
    t.status = 'done';
    t.completedAt = new Date();
    await t.save();
    ok(res, t);
  }),
);

// ---------------- announcements ----------------
r.post(
  '/events/:id/announcements',
  staff,
  wrap(async (req, res) => {
    const eventId = oid(req.params.id);
    const e = await Event.findById(eventId);
    if (!e) throw notFound('Event not found');
    const b = parse(z.object({ title: z.string().trim().min(2).max(120), body: z.string().trim().min(2).max(2000), pinned: z.boolean().optional() }), req.body);
    const a = await Announcement.create({ ...b, eventId, authorId: req.user!.id });
    const regs = await Registration.find({ eventId, status: { $in: ['confirmed', 'pending_approval', 'waitlisted'] } });
    const ids = new Set<string>();
    for (const g of regs) {
      if (g.userId) ids.add(String(g.userId));
      else (await TeamMember.find({ teamId: g.teamId })).forEach((m) => ids.add(String(m.userId)));
    }
    (await ShiftAssignment.find({ eventId, status: 'assigned' })).forEach((s) => ids.add(String(s.volunteerId)));
    await Promise.all([...ids].map((u) => notify(u, 'announcement', `${e.title}: ${b.title}`, { eventId })));
    emitTo(`event:${eventId}`, 'announcement:new', { id: a.id, title: b.title });
    ok(res, a, 201);
  }),
);
r.get(
  '/events/:id/announcements',
  wrap(async (req, res) =>
    ok(
      res,
      await Announcement.find({ eventId: oid(req.params.id) })
        .sort({ pinned: -1, createdAt: -1 })
        .limit(50),
    ),
  ),
);

// ---------------- issues ----------------
const issueRoles = requireRole('organiser', 'coordinator', 'volunteer', 'judge');
r.post(
  '/events/:id/issues',
  issueRoles,
  wrap(async (req, res) => {
    const b = parse(
      z.object({
        title: z.string().trim().min(3).max(150),
        description: z.string().max(2000).optional(),
        priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
      }),
      req.body,
    );
    ok(res, await Issue.create({ ...b, eventId: oid(req.params.id), reportedBy: req.user!.id }), 201);
  }),
);
r.get(
  '/events/:id/issues',
  issueRoles,
  wrap(async (req, res) => {
    const issues = await Issue.find({ eventId: oid(req.params.id) }).sort({ createdAt: -1 });
    const users = await User.find({ _id: { $in: issues.flatMap((i) => [i.ownerId, i.reportedBy].filter(Boolean)) } }).select('name');
    const nm = (id: unknown) => users.find((u) => u.id === String(id))?.name;
    ok(
      res,
      issues.map((i) => ({ ...i.toJSON(), ownerName: nm(i.ownerId), reporterName: nm(i.reportedBy) })),
    );
  }),
);
r.patch(
  '/issues/:id',
  issueRoles,
  wrap(async (req, res) => {
    const i = await Issue.findById(oid(req.params.id));
    if (!i) throw notFound('Issue not found');
    const b = parse(
      z.object({
        status: z.enum(['open', 'in_progress', 'resolved']).optional(),
        priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        ownerId: z.string().optional(),
        resolution: z.string().trim().max(1000).optional(),
      }),
      req.body,
    );
    const canManage = isStaff(req.user) || String(i.ownerId) === req.user!.id;
    if (!canManage) throw forbidden('Only the owner or a coordinator can update this issue');
    if (b.status === 'resolved' && !(b.resolution || i.resolution)) throw unprocessable('Add a resolution note before marking the issue resolved');
    if ((b.priority || b.ownerId) && !isStaff(req.user)) throw forbidden('Only coordinators can change priority or owner');
    Object.assign(i, b);
    if (b.status === 'resolved') i.resolvedAt = new Date();
    await i.save();
    if (b.ownerId) await notify(b.ownerId, 'issue', `You own the issue: ${i.title}`);
    ok(res, i);
  }),
);
r.post(
  '/issues/:id/comments',
  issueRoles,
  wrap(async (req, res) => {
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(1000) }), req.body);
    const i = await Issue.findByIdAndUpdate(oid(req.params.id), { $push: { comments: { authorId: req.user!.id, text, at: new Date() } } }, { new: true });
    if (!i) throw notFound('Issue not found');
    ok(res, i);
  }),
);

// ---------------- QR check-in ----------------
/** Short-lived (see env.qrTokenTtlSec): a screenshot forwarded to a friend stops working within seconds. */
const signToken = (p: { sub: string; eid: string; jti: string; uid: string }) => jwt.sign(p, env.qrSecret, { expiresIn: env.qrTokenTtlSec });

/** Typable fallback for a missing/blocked camera: 8 characters, no 0/O/1/I. Stored without the dash, shown as XXXX-XXXX. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newManualCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const showCode = (c: string) => `${c.slice(0, 4)}-${c.slice(4)}`;
/** Anything a volunteer might paste or type: a QR token (JWT) or a registration code, with stray spaces, dashes, quotes or line breaks. */
export function classifyScanInput(raw: string): { kind: 'token'; value: string } | { kind: 'code'; value: string } {
  const v = raw.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/\s+/g, '');
  if (v.split('.').length === 3) return { kind: 'token', value: v };
  return { kind: 'code', value: v.replace(/[-_]/g, '').toUpperCase() };
}
async function ensureManualCode(t: InstanceType<typeof CheckInToken>) {
  for (let i = 0; i < 5 && !t.manualCode; i++) {
    try {
      t.manualCode = newManualCode();
      await t.save();
    } catch (e) {
      t.manualCode = undefined;
      if ((e as { code?: number }).code !== 11000) throw e;
    }
  }
  return t.manualCode ? showCode(t.manualCode) : undefined;
}

r.get(
  '/me/checkin-token/:eventId',
  wrap(async (req, res) => {
    const eventId = oid(req.params.eventId);
    const as = String(req.query.as ?? 'participant');
    const uid = req.user!.id;
    let subjectKey: string, subjectType: 'participant' | 'volunteer';
    if (as === 'volunteer') {
      if (!(await ShiftAssignment.exists({ eventId, volunteerId: uid, status: 'assigned' }))) throw unprocessable('You have no volunteer shift in this event');
      subjectKey = `v:${uid}`;
      subjectType = 'volunteer';
    } else {
      const tms = await TeamMember.find({ eventId, userId: uid });
      const reg = await Registration.findOne({ eventId, status: 'confirmed', $or: [{ userId: uid }, ...(tms.length ? [{ teamId: tms[0].teamId }] : [])] });
      if (!reg) throw unprocessable('You need a confirmed registration to get a check-in QR code');
      subjectKey = `p:${reg.id}:${uid}`;
      subjectType = 'participant';
    }
    let t = await CheckInToken.findOne({ eventId, subjectKey });
    if (!t) t = await CheckInToken.create({ eventId, subjectKey, subjectType, userId: uid, jti: crypto.randomBytes(12).toString('hex') });
    if (t.status === 'revoked') throw forbidden('Your check-in code was revoked. Please see a coordinator.');
    ok(res, {
      token: signToken({ sub: subjectKey, eid: eventId, jti: t.jti, uid }),
      manualCode: await ensureManualCode(t),
      subjectType,
      ttlSec: env.qrTokenTtlSec,
      expiresAt: new Date(Date.now() + env.qrTokenTtlSec * 1000).toISOString(),
    });
  }),
);

r.post(
  '/checkin/scan',
  requireRole('volunteer', 'coordinator', 'organiser'),
  wrap(async (req, res) => {
    // `token` carries whatever the operator scanned, pasted or typed: a QR token or a registration code.
    const { token } = parse(z.object({ token: z.string().min(4).max(2000) }), req.body);
    const input = classifyScanInput(token);
    let rec: InstanceType<typeof CheckInToken> | null;
    if (input.kind === 'token') {
      let p: jwt.JwtPayload;
      try {
        p = jwt.verify(input.value, env.qrSecret, { clockTolerance: 3 }) as jwt.JwtPayload;
      } catch (e) {
        if (e instanceof jwt.TokenExpiredError) throw new AppError(400, 'TOKEN_EXPIRED', 'This QR code has expired. Ask the person to wait for the code to refresh and scan again.');
        throw new AppError(400, 'INVALID_TOKEN', 'This QR code is not valid');
      }
      rec = await CheckInToken.findOne({ jti: p.jti });
      if (!rec || rec.subjectKey !== p.sub || String(rec.eventId) !== p.eid) throw new AppError(400, 'INVALID_TOKEN', 'This QR code is not recognised');
    } else {
      if (!/^[A-Z2-9]{8}$/.test(input.value)) throw new AppError(400, 'INVALID_TOKEN', 'That is not a QR token or an 8-character registration code (like K7QM-2XPA)');
      rec = await CheckInToken.findOne({ manualCode: input.value });
      if (!rec) throw new AppError(400, 'INVALID_TOKEN', 'No registration matches that code. Check the characters and try again.');
    }
    if (rec.status === 'revoked') throw new AppError(403, 'REVOKED', 'This QR code was revoked');
    const event = await Event.findById(rec.eventId);
    if (!event || event.status === 'cancelled') throw new AppError(422, 'INELIGIBLE', 'This event is not active');
    // Volunteers may only operate check-in for events they are rostered on.
    if (!isStaff(req.user) && !(await ShiftAssignment.exists({ eventId: rec.eventId, volunteerId: req.user!.id, status: 'assigned' })))
      throw forbidden('You are not on the volunteer roster for this event');
    if (rec.subjectType === 'participant') {
      const regId = rec.subjectKey.split(':')[1];
      const reg = await Registration.findById(regId);
      if (!reg || reg.status !== 'confirmed') throw new AppError(422, 'INELIGIBLE', 'This person no longer has a confirmed registration');
      if (reg.teamId && !(await TeamMember.exists({ teamId: reg.teamId, userId: rec.userId })))
        throw new AppError(422, 'INELIGIBLE', 'This person is no longer in the team');
    } else if (!(await ShiftAssignment.exists({ eventId: rec.eventId, volunteerId: rec.userId, status: 'assigned' }))) {
      throw new AppError(422, 'INELIGIBLE', 'This volunteer has no active shift');
    }
    const person = await User.findById(rec.userId).select('name');
    try {
      const ci = await CheckIn.create({
        eventId: rec.eventId,
        subjectKey: rec.subjectKey,
        subjectType: rec.subjectType,
        userId: rec.userId,
        operatorId: req.user!.id,
      });
      if (rec.subjectType === 'volunteer') {
        const now = new Date();
        const slack = 3600_000;
        const shifts = await Shift.find({
          eventId: rec.eventId,
          start: { $lte: new Date(now.getTime() + slack) },
          end: { $gte: new Date(now.getTime() - slack) },
        });
        await ShiftAssignment.updateMany(
          { eventId: rec.eventId, volunteerId: rec.userId, status: 'assigned', attendance: 'unmarked', shiftId: { $in: shifts.map((s) => s._id) } },
          { attendance: 'present', attendanceAt: now, attendanceBy: req.user!.id },
        );
      }
      emitTo(`event:${rec.eventId}`, 'checkin:new', { type: rec.subjectType });
      ok(res, { name: person?.name, type: rec.subjectType, at: ci.at }, 201);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) {
        const prev = await CheckIn.findOne({ eventId: rec.eventId, subjectKey: rec.subjectKey });
        const op = prev && (await User.findById(prev.operatorId).select('name'));
        throw conflict(
          `${person?.name ?? 'This person'} already checked in at ${prev?.at.toISOString().slice(11, 16)} UTC (operator: ${op?.name ?? 'unknown'})`,
          { at: prev?.at, operator: op?.name },
        );
      }
      throw e;
    }
  }),
);

r.post(
  '/checkin/tokens/:id/revoke',
  staff,
  wrap(async (req, res) => {
    const t = await CheckInToken.findByIdAndUpdate(oid(req.params.id), { status: 'revoked' }, { new: true });
    if (!t) throw notFound('Token not found');
    await audit(req.user!.id, 'checkin.revoke', 'CheckInToken', t.id);
    ok(res, t);
  }),
);
r.get(
  '/events/:id/checkin-tokens',
  staff,
  wrap(async (req, res) => {
    const ts = await CheckInToken.find({ eventId: oid(req.params.id) });
    const us = await User.find({ _id: { $in: ts.map((t) => t.userId) } }).select('name');
    ok(
      res,
      ts.map((t) => ({ id: t.id, subjectType: t.subjectType, status: t.status, name: us.find((u) => u.id === String(t.userId))?.name })),
    );
  }),
);
r.get(
  '/events/:id/attendance',
  staff,
  wrap(async (req, res) => {
    const eventId = oid(req.params.id);
    const cis = await CheckIn.find({ eventId }).sort({ at: -1 });
    const us = await User.find({ _id: { $in: cis.flatMap((c) => [c.userId, c.operatorId]) } }).select('name');
    const nm = (id: unknown) => us.find((u) => u.id === String(id))?.name;
    const assigns = await ShiftAssignment.find({ eventId, status: 'assigned' });
    const tasks = await Task.find({ eventId });
    ok(res, {
      checkIns: cis.map((c) => ({ id: c.id, name: nm(c.userId), type: c.subjectType, at: c.at, operator: nm(c.operatorId) })),
      volunteerAttendance: {
        present: assigns.filter((a) => a.attendance === 'present').length,
        absent: assigns.filter((a) => a.attendance === 'absent').length,
        unmarked: assigns.filter((a) => a.attendance === 'unmarked').length,
      },
      tasks: { done: tasks.filter((t) => t.status === 'done').length, total: tasks.length },
    });
  }),
);

export default r;
