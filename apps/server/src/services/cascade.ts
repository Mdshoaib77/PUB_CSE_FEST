/**
 * Cascade deletes. Every "delete X" in the API goes through here so a parent can never leave orphans behind
 * (seats, registrations, scores, submissions…). MongoDB has no FK cascades and the project avoids transactions
 * (see PROJECT_HANDOFF), so each helper deletes children first and the parent last: if something fails midway,
 * the parent still exists and the organiser can simply retry the delete.
 */
import {
  Activity,
  Announcement,
  Availability,
  CheckIn,
  CheckInToken,
  Contest,
  ContestRegistration,
  ContestTeam,
  ContestTeamInvitation,
  Editorial,
  Entry,
  EntryVersion,
  Event,
  Invitation,
  Issue,
  JudgeAssignment,
  Notification,
  Problem,
  RefreshToken,
  RoleRequest,
  Registration,
  ReplacementRequest,
  Result,
  Rubric,
  Score,
  Seat,
  Shift,
  ShiftAssignment,
  Submission,
  Task,
  Team,
  TeamMember,
  TestCase,
  User,
  Venue,
} from '../models';
import { removeEventImage } from './uploads';
import { cancelRegistration, ACTIVE_STATES } from './registration';
import { notifyTyped as notify } from './notify';

type Id = unknown;
const SYSTEM = { id: 'system', isStaff: true };

// ---------------------------------------------------------------- entries / judging
export async function deleteEntry(entryId: Id) {
  await Promise.all([EntryVersion.deleteMany({ entryId }), JudgeAssignment.deleteMany({ entryId }), Score.deleteMany({ entryId })]);
  await Entry.deleteOne({ _id: entryId });
}

export async function deleteActivity(activityId: Id) {
  for (const child of await Activity.find({ parentId: activityId }).select('_id')) await deleteActivity(child._id);
  const entries = await Entry.find({ activityId }).select('_id');
  for (const e of entries) await deleteEntry(e._id);
  await Promise.all([
    Rubric.deleteMany({ activityId }),
    Result.deleteMany({ activityId }),
    Score.deleteMany({ activityId }),
    JudgeAssignment.deleteMany({ activityId }),
    Shift.updateMany({ activityId }, { $unset: { activityId: 1 } }),
  ]);
  await Activity.deleteOne({ _id: activityId });
}

// ---------------------------------------------------------------- volunteers / ops
export async function deleteShift(shiftId: Id, opts: { notifyVolunteers?: boolean } = {}) {
  const shift = await Shift.findById(shiftId);
  const assigns = await ShiftAssignment.find({ shiftId });
  await ReplacementRequest.deleteMany({ assignmentId: { $in: assigns.map((a) => a._id) } });
  await Task.updateMany({ shiftId }, { $unset: { shiftId: 1 } });
  await ShiftAssignment.deleteMany({ shiftId });
  await Shift.deleteOne({ _id: shiftId });
  if (opts.notifyVolunteers && shift)
    await Promise.all(
      assigns.filter((a) => a.status === 'assigned').map((a) => notify(a.volunteerId, 'shift', `The shift "${shift.title}" was removed from the roster`, { eventId: String(shift.eventId) })),
    );
}

export async function deleteAssignment(assignmentId: Id) {
  await ReplacementRequest.deleteMany({ assignmentId });
  await ShiftAssignment.deleteOne({ _id: assignmentId });
}

// ---------------------------------------------------------------- teams
export async function deleteTeam(teamId: Id, opts: { notifyMembers?: boolean } = {}) {
  const team = await Team.findById(teamId);
  if (!team) return;
  const members = await TeamMember.find({ teamId });
  // cancel through the service so the seat is freed and the waiting list advances
  for (const g of await Registration.find({ teamId, status: { $in: ACTIVE_STATES } })) await cancelRegistration(g.id, SYSTEM);
  await Registration.deleteMany({ teamId });
  for (const e of await Entry.find({ teamId }).select('_id')) await deleteEntry(e._id);
  await Promise.all([TeamMember.deleteMany({ teamId }), Invitation.deleteMany({ teamId })]);
  await Team.deleteOne({ _id: teamId });
  if (opts.notifyMembers)
    await Promise.all(members.map((m) => notify(m.userId, 'team', `Team "${team.name}" was deleted`, { eventId: String(team.eventId) })));
}

// ---------------------------------------------------------------- events
export async function deleteEvent(eventId: Id) {
  const event = await Event.findById(eventId);
  if (!event) return;

  // 1. tell the people affected while we can still find them
  const regs = await Registration.find({ eventId, status: { $in: ACTIVE_STATES } });
  const people = new Set<string>();
  for (const g of regs) {
    if (g.userId) people.add(String(g.userId));
    else for (const m of await TeamMember.find({ teamId: g.teamId })) people.add(String(m.userId));
  }
  for (const a of await ShiftAssignment.find({ eventId, status: 'assigned' })) people.add(String(a.volunteerId));
  await Promise.all([...people].map((u) => notify(u, 'event', `"${event.title}" was deleted by an organiser`)));

  // 2. children
  for (const a of await Activity.find({ eventId }).select('_id')) await deleteActivity(a._id);
  for (const e of await Entry.find({ eventId }).select('_id')) await deleteEntry(e._id);
  await Promise.all([
    Seat.deleteMany({ eventId }),
    Registration.deleteMany({ eventId }),
    TeamMember.deleteMany({ eventId }),
    Invitation.deleteMany({ eventId }),
    Team.deleteMany({ eventId }),
    Announcement.deleteMany({ eventId }),
    Availability.deleteMany({ eventId }),
    ReplacementRequest.deleteMany({ eventId }),
    ShiftAssignment.deleteMany({ eventId }),
    Task.deleteMany({ eventId }),
    Shift.deleteMany({ eventId }),
    CheckInToken.deleteMany({ eventId }),
    CheckIn.deleteMany({ eventId }),
    Issue.deleteMany({ eventId }),
    Contest.updateMany({ eventId }, { $unset: { eventId: 1 } }), // a contest is its own resource: keep it, just unlink
  ]);

  // 3. parent + its cover image
  await Event.deleteOne({ _id: eventId });
  await removeEventImage(event.imageUrl);
}

export async function deleteVenue(venueId: Id) {
  const [ev, act] = await Promise.all([Event.updateMany({ venueId }, { $unset: { venueId: 1 } }), Activity.updateMany({ venueId }, { $unset: { venueId: 1 } })]);
  await Venue.deleteOne({ _id: venueId });
  return { unlinkedEvents: ev.modifiedCount, unlinkedActivities: act.modifiedCount };
}

// ---------------------------------------------------------------- problems / contests
export async function deleteProblem(problemId: Id) {
  await Promise.all([TestCase.deleteMany({ problemId }), Editorial.deleteMany({ problemId }), Submission.deleteMany({ problemId })]);
  await Problem.deleteOne({ _id: problemId });
}

export async function deleteContest(contestId: Id) {
  const banner = (await Contest.findById(contestId).select('bannerImage'))?.bannerImage;
  await Promise.all([ContestRegistration.deleteMany({ contestId }), ContestTeam.deleteMany({ contestId }), ContestTeamInvitation.deleteMany({ contestId }), Submission.deleteMany({ contestId })]);
  await Contest.deleteOne({ _id: contestId });
  await removeEventImage(banner); // uploaded banners are ours to clean up; external URLs are ignored
}

// ---------------------------------------------------------------- users
export async function purgeUser(userId: Id) {
  // contest teams: a leader's team is disbanded, a plain member just frees a seat
  for (const t of await ContestTeam.find({ leaderId: userId }).select('_id')) {
    await ContestRegistration.deleteMany({ teamId: t._id });
    await ContestTeam.deleteOne({ _id: t._id });
    await ContestTeamInvitation.deleteMany({ teamId: t._id });
  }
  for (const g of await ContestRegistration.find({ userId, teamId: { $exists: true } }).select('teamId')) {
    await ContestTeam.updateOne({ _id: g.teamId }, { $inc: { memberCount: -1 } });
  }
  for (const t of await Team.find({ leaderId: userId }).select('_id')) await deleteTeam(t._id, { notifyMembers: true });
  // remaining memberships (member, not leader)
  for (const m of await TeamMember.find({ userId })) {
    await TeamMember.deleteOne({ _id: m._id });
    await Team.updateOne({ _id: m.teamId }, { memberCount: await TeamMember.countDocuments({ teamId: m.teamId }) });
  }
  for (const g of await Registration.find({ userId, status: { $in: ACTIVE_STATES } })) await cancelRegistration(g.id, SYSTEM);
  await Registration.deleteMany({ userId });
  for (const e of await Entry.find({ ownerUserId: userId }).select('_id')) await deleteEntry(e._id);

  const assigns = await ShiftAssignment.find({ volunteerId: userId }).select('_id');
  await ReplacementRequest.deleteMany({ $or: [{ assignmentId: { $in: assigns.map((a) => a._id) } }, { requestedBy: userId }] });
  await Promise.all([
    ShiftAssignment.deleteMany({ volunteerId: userId }),
    Invitation.deleteMany({ $or: [{ inviteeId: userId }, { invitedBy: userId }] }),
    Notification.deleteMany({ userId }),
    RefreshToken.deleteMany({ userId }),
    RoleRequest.deleteMany({ userId }),
    Availability.deleteMany({ userId }),
    CheckInToken.deleteMany({ userId }),
    CheckIn.deleteMany({ userId }),
    ContestRegistration.deleteMany({ userId }),
    Submission.deleteMany({ userId }),
    JudgeAssignment.deleteMany({ judgeId: userId }),
    Task.updateMany({ assigneeId: userId }, { $unset: { assigneeId: 1 } }),
    Issue.updateMany({ ownerId: userId }, { $unset: { ownerId: 1 } }),
  ]);
  await User.deleteOne({ _id: userId });
}
