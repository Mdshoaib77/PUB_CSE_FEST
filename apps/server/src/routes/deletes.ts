/**
 * Universal delete endpoints. Rules every route here follows:
 *  - authenticates itself (this router is mounted among public routes, so there is no global requireAuth);
 *  - checks ownership/role on the SERVER (the UI hides buttons, but that is only a courtesy);
 *  - refuses deletes that would corrupt published data (official results, running contests…) with a clear 409;
 *  - deletes children via services/cascade.ts so nothing is orphaned;
 *  - writes an audit row for the destructive, organiser-level actions.
 */
import { Router } from 'express';
import {
  Activity,
  CheckIn,
  CheckInToken,
  Contest,
  Editorial,
  Entry,
  Event,
  Invitation,
  Issue,
  Problem,
  ReplacementRequest,
  Result,
  Rubric,
  Score,
  Announcement,
  Availability,
  Shift,
  Submission,
  Task,
  Team,
  Venue,
  TeamMember,
} from '../models';
import { hasRole, isStaff, requireAuth, requireRole } from '../middleware/auth';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { oid, ok, wrap } from '../utils/http';
import { audit } from '../utils/audit';
import { deleteContest, deleteEntry, deleteEvent, deleteProblem, deleteShift, deleteTeam, deleteVenue } from '../services/cascade';

const r = Router();
const staff = requireRole('organiser', 'coordinator');
const organiser = requireRole('organiser');
const setter = requireRole('judge', 'organiser');

// ------------------------------------------------------------------ events & schedule
r.delete(
  '/events/:id',
  requireAuth,
  organiser,
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const e = await Event.findById(id);
    if (!e) throw notFound('Event not found');
    await deleteEvent(id);
    await audit(req.user!.id, 'event.delete', 'Event', id, { title: e.title });
    ok(res, { deleted: true, id });
  }),
);

r.delete(
  '/venues/:id',
  requireAuth,
  organiser, // organiser/admin only; any venue (default ones too) can be deleted. Events/activities using it are unlinked (cascade.deleteVenue), never left pointing at a missing venue
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const v = await Venue.findById(id).select('name');
    if (!v) throw notFound('Venue not found');
    const out = await deleteVenue(id);
    await audit(req.user!.id, 'venue.delete', 'Venue', id, { name: v.name, ...out });
    ok(res, { deleted: true, id, ...out });
  }),
);

r.delete(
  '/activities/:id/rubric',
  requireAuth,
  organiser,
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    if (await Result.exists({ activityId: id, status: 'official' })) throw conflict('Results are official; delete the results first');
    const d = await Rubric.deleteOne({ activityId: id });
    if (!d.deletedCount) throw notFound('This activity has no rubric');
    ok(res, { deleted: true });
  }),
);

r.delete(
  '/activities/:id/results',
  requireAuth,
  organiser,
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const d = await Result.deleteOne({ activityId: id });
    if (!d.deletedCount) throw notFound('There are no results to delete');
    await audit(req.user!.id, 'result.delete', 'Activity', id);
    ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------ announcements, issues, tasks
r.delete(
  '/announcements/:id',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const d = await Announcement.deleteOne({ _id: oid(req.params.id) });
    if (!d.deletedCount) throw notFound('Announcement not found');
    ok(res, { deleted: true });
  }),
);

r.delete(
  '/issues/:id',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const d = await Issue.deleteOne({ _id: oid(req.params.id) });
    if (!d.deletedCount) throw notFound('Issue not found');
    ok(res, { deleted: true });
  }),
);

r.delete(
  '/issues/:id/comments/:commentId',
  requireAuth,
  wrap(async (req, res) => {
    const issue = await Issue.findById(oid(req.params.id));
    if (!issue) throw notFound('Issue not found');
    const c = issue.comments.id(oid(req.params.commentId, 'comment id'));
    if (!c) throw notFound('Comment not found');
    if (!isStaff(req.user) && String(c.authorId) !== req.user!.id) throw forbidden('You can only delete your own comments');
    c.deleteOne();
    await issue.save();
    ok(res, issue);
  }),
);

r.delete(
  '/tasks/:id',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const d = await Task.deleteOne({ _id: oid(req.params.id) });
    if (!d.deletedCount) throw notFound('Task not found');
    ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------ shifts, replacement requests, availability
r.delete(
  '/shifts/:id',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    if (!(await Shift.exists({ _id: id }))) throw notFound('Shift not found');
    await deleteShift(id, { notifyVolunteers: true });
    ok(res, { deleted: true, id });
  }),
);

r.delete(
  '/replacements/:id',
  requireAuth,
  wrap(async (req, res) => {
    const rr = await ReplacementRequest.findById(oid(req.params.id));
    if (!rr) throw notFound('Replacement request not found');
    const mine = String(rr.requestedBy) === req.user!.id;
    if (!isStaff(req.user) && !(mine && rr.status === 'pending')) throw forbidden('You can only withdraw your own pending request');
    await rr.deleteOne();
    ok(res, { deleted: true });
  }),
);

r.delete(
  '/me/availability/:eventId',
  requireAuth,
  wrap(async (req, res) => {
    await Availability.deleteOne({ userId: req.user!.id, eventId: oid(req.params.eventId) });
    ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------ check-in
r.delete(
  '/checkins/:id',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const d = await CheckIn.deleteOne({ _id: oid(req.params.id) }); // frees the unique (event, subject) key, so the person can be scanned again
    if (!d.deletedCount) throw notFound('Check-in not found');
    ok(res, { deleted: true });
  }),
);

r.delete(
  '/checkin/tokens/:id',
  requireAuth,
  staff,
  wrap(async (req, res) => {
    const d = await CheckInToken.deleteOne({ _id: oid(req.params.id) }); // a fresh code is minted the next time the person opens their QR page
    if (!d.deletedCount) throw notFound('Token not found');
    ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------ teams & invitations
r.delete(
  '/teams/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const t = await Team.findById(id);
    if (!t) throw notFound('Team not found');
    if (!isStaff(req.user) && String(t.leaderId) !== req.user!.id) throw forbidden('Only the team leader can delete the team');
    await deleteTeam(id, { notifyMembers: true });
    ok(res, { deleted: true, id });
  }),
);

r.delete(
  '/invitations/:id',
  requireAuth,
  wrap(async (req, res) => {
    const inv = await Invitation.findById(oid(req.params.id));
    if (!inv) throw notFound('Invitation not found');
    const team = await Team.findById(inv.teamId);
    const allowed = String(inv.inviteeId) === req.user!.id || (!!team && String(team.leaderId) === req.user!.id) || isStaff(req.user);
    if (!allowed) throw forbidden();
    await inv.deleteOne();
    ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------ competition entries & scores
r.delete(
  '/entries/:id',
  requireAuth,
  wrap(async (req, res) => {
    const entry = await Entry.findById(oid(req.params.id));
    if (!entry) throw notFound('Entry not found');
    const owns =
      (!!entry.ownerUserId && String(entry.ownerUserId) === req.user!.id) || (!!entry.teamId && !!(await TeamMember.exists({ teamId: entry.teamId, userId: req.user!.id })));
    if (!owns && !isStaff(req.user)) throw forbidden('This is not your entry');
    if (await Result.exists({ activityId: entry.activityId, status: 'official' })) throw conflict('Results are official; delete the results before removing entries');
    if (!isStaff(req.user)) {
      const a = await Activity.findById(entry.activityId);
      if (a?.submissionDeadline && new Date() > a.submissionDeadline) throw unprocessable('The submission deadline has passed; ask an organiser to remove the entry');
    }
    await deleteEntry(entry._id);
    ok(res, { deleted: true });
  }),
);

r.delete(
  '/entries/:id/score',
  requireAuth,
  requireRole('judge'),
  wrap(async (req, res) => {
    const entry = await Entry.findById(oid(req.params.id));
    if (!entry) throw notFound('Entry not found');
    if (await Result.exists({ activityId: entry.activityId, status: 'official' })) throw conflict('Results are official; scoring is closed');
    const d = await Score.deleteOne({ entryId: entry._id, judgeId: req.user!.id });
    if (!d.deletedCount) throw notFound('You have not scored this entry');
    ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------ problems, editorials, contests, submissions
async function ownProblem(id: string, user: { id: string; roles: string[] }) {
  const p = await Problem.findById(id);
  if (!p) throw notFound('Problem not found');
  if (!user.roles.includes('organiser') && String(p.authorId) !== user.id) throw forbidden('Only the problem author or an organiser can do this');
  return p;
}

r.delete(
  '/problems/:id',
  requireAuth,
  setter,
  wrap(async (req, res) => {
    const p = await ownProblem(oid(req.params.id), req.user!);
    const used = await Contest.findOne({ 'problems.problemId': p._id }).select('title');
    if (used) throw conflict(`This problem is part of the contest "${used.title}". Delete that contest first.`);
    await deleteProblem(p._id);
    await audit(req.user!.id, 'problem.delete', 'Problem', p.id, { title: p.title });
    ok(res, { deleted: true, id: p.id });
  }),
);

r.delete(
  '/problems/:id/editorial',
  requireAuth,
  setter,
  wrap(async (req, res) => {
    const p = await ownProblem(oid(req.params.id), req.user!);
    const d = await Editorial.deleteOne({ problemId: p._id });
    if (!d.deletedCount) throw notFound('This problem has no editorial');
    ok(res, { deleted: true });
  }),
);

r.delete(
  '/contests/:id',
  requireAuth,
  organiser,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    await deleteContest(c._id);
    await audit(req.user!.id, 'contest.delete', 'Contest', c.id, { title: c.title });
    ok(res, { deleted: true, id: c.id });
  }),
);

r.delete(
  '/submissions/:id',
  requireAuth,
  wrap(async (req, res) => {
    const s = await Submission.findById(oid(req.params.id)).select('userId mode');
    if (!s) throw notFound('Submission not found');
    const mine = String(s.userId) === req.user!.id;
    // contest submissions are evidence: only an organiser may remove them, never the contestant
    if (!(hasRole(req.user, 'organiser') || (mine && s.mode === 'practice'))) throw forbidden(mine ? 'Contest submissions can only be removed by an organiser' : undefined);
    await Submission.deleteOne({ _id: s._id });
    ok(res, { deleted: true });
  }),
);

// Not here: DELETE /entries/:id/judges/:judgeId (routes/judging.ts), DELETE /registrations/:id (cancel, routes/registrations.ts),
// DELETE /notifications* (routes/registrations.ts) and DELETE /users/:id (routes/users.ts) live next to their siblings.
export default r;
