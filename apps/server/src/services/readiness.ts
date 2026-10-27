import { Activity, Entry, Event, Issue, JudgeAssignment, Registration, ReplacementRequest, Rubric, Shift, ShiftAssignment } from '../models';
import { findOverlaps, fmtRange } from './clash';

export async function eventConflicts(eventId: string) {
  const acts = await Activity.find({ eventId, status: 'scheduled' });
  const out: { type: string; message: string }[] = [];
  for (const a of acts) {
    if (!a.venueId) continue;
    const others = await Activity.find({ venueId: a.venueId, status: 'scheduled', _id: { $gt: a._id } });
    for (const o of findOverlaps(a, others))
      out.push({
        type: 'venue',
        message: `"${a.title}" (${fmtRange(a)}) and "${o.title}" (${fmtRange(o)}) use the same venue at the same time. Move one of them to another slot or venue.`,
      });
  }
  const shifts = await Shift.find({ eventId });
  const assigns = await ShiftAssignment.find({ eventId, status: 'assigned' });
  const byVol = new Map<string, typeof shifts>();
  for (const a of assigns) {
    const s = shifts.find((x) => x.id === String(a.shiftId));
    if (s) (byVol.get(String(a.volunteerId)) ?? byVol.set(String(a.volunteerId), []).get(String(a.volunteerId))!).push(s);
  }
  for (const [vid, list] of byVol)
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++)
        if (findOverlaps(list[i], [list[j]]).length)
          out.push({ type: 'volunteer', message: `Volunteer ${vid} is double-booked: "${list[i].title}" and "${list[j].title}" overlap. Reassign one shift.` });
  return out;
}

export async function readiness(eventId: string) {
  const event = await Event.findById(eventId);
  if (!event) return null;
  const acts = await Activity.find({ eventId, status: 'scheduled' });
  const shifts = await Shift.find({ eventId });
  const counts = await ShiftAssignment.aggregate([{ $match: { eventId: event._id, status: 'assigned' } }, { $group: { _id: '$shiftId', n: { $sum: 1 } } }]);
  const countOf = new Map(counts.map((c) => [String(c._id), c.n as number]));
  const uncoveredShifts = shifts
    .filter((s) => (countOf.get(s.id) ?? 0) < s.requiredCount)
    .map((s) => ({ shiftId: s.id, title: s.title, needed: s.requiredCount, assigned: countOf.get(s.id) ?? 0 }));
  const competitions = acts.filter((a) => a.kind === 'competition');
  const missingJudges: { activityId: string; title: string; reason: string }[] = [];
  const missingRubrics: { activityId: string; title: string }[] = [];
  for (const c of competitions) {
    const judges = await JudgeAssignment.countDocuments({ activityId: c._id });
    const entries = await Entry.countDocuments({ activityId: c._id });
    if (judges === 0)
      missingJudges.push({ activityId: c.id, title: c.title, reason: entries ? `${entries} entries but no judge assigned` : 'no judge assigned yet' });
    if (!(await Rubric.countDocuments({ activityId: c._id }))) missingRubrics.push({ activityId: c.id, title: c.title });
  }
  const conflicts = await eventConflicts(eventId);
  const openIssues = await Issue.find({ eventId, status: { $ne: 'resolved' }, priority: { $in: ['high', 'critical'] } }).select('title priority');
  const pendingReplacements = await ReplacementRequest.countDocuments({ eventId, status: 'pending' });
  const pendingApprovals = await Registration.countDocuments({ eventId, status: 'pending_approval' });
  const setup = {
    published: event.status === 'published',
    hasVenue: !!event.venueId,
    hasActivities: acts.length > 0,
    activitiesHaveVenue: acts.every((a) => !!a.venueId),
  };
  const checks = [
    setup.published,
    setup.hasVenue,
    setup.hasActivities,
    setup.activitiesHaveVenue,
    uncoveredShifts.length === 0,
    missingJudges.length === 0,
    missingRubrics.length === 0,
    conflicts.length === 0,
    openIssues.length === 0,
    pendingReplacements === 0,
    pendingApprovals === 0,
  ];
  const score = Math.round((checks.filter(Boolean).length / checks.length) * 100);
  return {
    score,
    status: score === 100 ? 'ready' : score >= 70 ? 'attention' : 'not_ready',
    setup,
    uncoveredShifts,
    missingJudges,
    missingRubrics,
    conflicts,
    openIssues,
    pendingReplacements,
    pendingApprovals,
  };
}
