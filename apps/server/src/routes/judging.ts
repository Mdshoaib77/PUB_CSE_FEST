import { Router } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { Activity, AuditLog, Entry, Event, EntryVersion, JudgeAssignment, Registration, Result, Rubric, Score, Team, TeamMember, User } from '../models';
import { hasRole, isStaff, requireAuth, requireRole } from '../middleware/auth';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { oid, ok, parse, wrap } from '../utils/http';
import { audit } from '../utils/audit';
import { notifyTyped as notify } from '../services/notify';
import { logger } from '../utils/logger';

const r = Router();
r.use(requireAuth);
const organiser = requireRole('organiser');

export function percentFromScores(criteria: { name: string; maxScore: number; weight: number }[], scores: { name: string; score: number }[]) {
  const totalW = criteria.reduce((a, c) => a + c.weight, 0) || 1;
  return Math.round((criteria.reduce((a, c) => a + ((scores.find((s) => s.name === c.name)?.score ?? 0) / c.maxScore) * c.weight, 0) / totalW) * 10000) / 100;
}
export function rankEntries(items: { entryId: string; percent: number }[]) {
  const sorted = [...items].sort((x, y) => y.percent - x.percent);
  let rank = 0;
  return sorted.map((x, i) => {
    if (i === 0 || sorted[i - 1].percent !== x.percent) rank = i + 1;
    return { ...x, rank };
  });
}

/** Resolve display names for ownerKeys ('t:<teamId>' -> team name, 'u:<userId>' -> user name). */
export async function ownerNamesFor(ownerKeys: string[]) {
  const ids = (prefix: string) => [...new Set(ownerKeys.filter((k) => k?.startsWith(prefix)).map((k) => k.slice(prefix.length)))].filter((i) => Types.ObjectId.isValid(i));
  const [teams, users] = await Promise.all([Team.find({ _id: { $in: ids('t:') } }).select('name'), User.find({ _id: { $in: ids('u:') } }).select('name')]);
  const names = new Map<string, string>();
  for (const t of teams) names.set(`t:${t.id}`, t.name);
  for (const u of users) names.set(`u:${u.id}`, u.name);
  return names;
}

/**
 * Tell everyone affected that results are official: each member of a ranked team (or the individual owner) gets their own
 * ranking, then the assigned judges get a short notice. One notification per user per approval (a judge who also took part
 * keeps the participant message).
 */
export async function notifyResultsPublished(a: { _id: unknown; title: string; eventId: unknown }, result: { rankings: { entryId?: unknown; ownerName?: string | null; ownerKey?: string | null; percent?: number | null; rank?: number | null }[] }) {
  const eventId = String(a.eventId);
  const link = `/events/${eventId}?tab=results`;
  const activityId = String(a._id);
  const refs = { eventId, activityId };
  const seen = new Set<string>();
  const send = async (userId: string, message: string) => {
    if (seen.has(userId)) return;
    seen.add(userId);
    await notify(userId, 'result', message, refs, link);
  };
  const entries = await Entry.find({ _id: { $in: result.rankings.map((x) => x.entryId) } }).select('teamId ownerUserId');
  const entryById = new Map(entries.map((e) => [e.id as string, e]));
  const missing = result.rankings.filter((x) => !x.ownerName && x.ownerKey).map((x) => x.ownerKey as string);
  const names = missing.length ? await ownerNamesFor(missing) : new Map<string, string>();
  for (const rk of result.rankings) {
    const e = entryById.get(String(rk.entryId));
    if (!e) continue;
    const userIds = e.teamId ? (await TeamMember.find({ teamId: e.teamId }).select('userId')).map((m) => String(m.userId)) : e.ownerUserId ? [String(e.ownerUserId)] : [];
    const name = rk.ownerName || (rk.ownerKey ? names.get(rk.ownerKey) : undefined) || 'Your entry';
    const message = `Results published for "${a.title}": ${name} ranked #${rk.rank} (${rk.percent}%)`;
    for (const uid of userIds) await send(uid, message);
  }
  for (const j of await JudgeAssignment.distinct('judgeId', { activityId })) await send(String(j), `Results published for "${a.title}"`);
}

/** Best-effort judge notice for assign/unassign; never fails the request (the change is already committed). */
async function notifyJudge(entry: InstanceType<typeof Entry>, judgeId: string, verb: 'assigned' | 'unassigned') {
  try {
    const [ev, names] = await Promise.all([Event.findById(entry.eventId).select('title'), ownerNamesFor([entry.ownerKey])]);
    const who = names.get(entry.ownerKey);
    const what = `"${entry.title}"${who ? ` (${who})` : ''} in "${ev?.title ?? 'the event'}"`;
    const eventId = String(entry.eventId);
    await notify(judgeId, 'judging', verb === 'assigned' ? `You were assigned to judge ${what}` : `You were unassigned from judging ${what}`, { eventId, entryId: entry.id, activityId: String(entry.activityId) }, `/judging?event=${eventId}`);
  } catch (err) {
    logger.warn('judge notification failed', { entryId: entry.id, judgeId, message: (err as Error).message });
  }
}

async function loadActivity(id: string) {
  const a = await Activity.findById(id);
  if (!a || a.status !== 'scheduled') throw notFound('Activity not found');
  return a;
}
/** Does this user own the entry (individually or as a team member)? */
async function ownsEntry(entry: InstanceType<typeof Entry>, userId: string) {
  if (entry.ownerUserId && String(entry.ownerUserId) === userId) return true;
  return entry.teamId ? !!(await TeamMember.exists({ teamId: entry.teamId, userId })) : false;
}

r.put(
  '/activities/:id/rubric',
  organiser,
  wrap(async (req, res) => {
    const a = await loadActivity(oid(req.params.id));
    const { criteria } = parse(
      z.object({
        criteria: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(60),
              maxScore: z.coerce.number().min(1).max(1000),
              weight: z.coerce.number().min(0).max(100).default(1),
            }),
          )
          .min(1)
          .max(12),
      }),
      req.body,
    );
    if (new Set(criteria.map((c) => c.name.toLowerCase())).size !== criteria.length) throw unprocessable('Criterion names must be unique');
    if (await Result.exists({ activityId: a._id, status: 'official' })) throw conflict('Results are official; the rubric can no longer change');
    ok(res, await Rubric.findOneAndUpdate({ activityId: a._id }, { $set: { criteria } }, { upsert: true, new: true }));
  }),
);
r.get(
  '/activities/:id/rubric',
  wrap(async (req, res) => ok(res, await Rubric.findOne({ activityId: oid(req.params.id) }))),
);

// ---- entries & versions
r.post(
  '/activities/:id/entries',
  wrap(async (req, res) => {
    const a = await loadActivity(oid(req.params.id));
    if (!['competition', 'round'].includes(a.kind)) throw unprocessable('Entries can only be submitted to competitions');
    if (a.submissionDeadline && new Date() > a.submissionDeadline) throw unprocessable('The submission deadline has passed');
    const b = parse(
      z.object({
        title: z.string().trim().min(2).max(120),
        content: z.string().max(20000).default(''),
        link: z.string().url().optional(),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    const uid = req.user!.id;
    const tm = await TeamMember.findOne({ eventId: a.eventId, userId: uid });
    const reg = await Registration.findOne({ eventId: a.eventId, status: 'confirmed', $or: [{ userId: uid }, ...(tm ? [{ teamId: tm.teamId }] : [])] });
    if (!reg) throw unprocessable('You need a confirmed registration for this event to submit an entry');
    const ownerKey = reg.teamId ? `t:${reg.teamId}` : `u:${uid}`;
    let entry;
    try {
      entry = await Entry.create({
        activityId: a._id,
        eventId: a.eventId,
        ownerKey,
        ownerUserId: reg.teamId ? undefined : uid,
        teamId: reg.teamId ?? undefined,
        title: b.title,
        currentVersion: 1,
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw conflict('You already have an entry here. Submit a new version instead.');
      throw e;
    }
    await EntryVersion.create({ entryId: entry._id, version: 1, content: b.content, link: b.link, notes: b.notes, submittedBy: uid });
    await audit(uid, 'entry.create', 'Entry', entry.id);
    ok(res, entry, 201);
  }),
);

r.put(
  '/entries/:id',
  wrap(async (req, res) => {
    const entry = await Entry.findById(oid(req.params.id));
    if (!entry) throw notFound('Entry not found');
    if (!(await ownsEntry(entry, req.user!.id))) throw forbidden('This is not your entry');
    const a = await loadActivity(String(entry.activityId));
    if (a.submissionDeadline && new Date() > a.submissionDeadline) throw unprocessable('The submission deadline has passed');
    if (await Result.exists({ activityId: a._id, status: 'official' })) throw conflict('Results are official; entries are locked');
    const b = parse(
      z.object({
        title: z.string().trim().min(2).max(120).optional(),
        content: z.string().max(20000).default(''),
        link: z.string().url().optional(),
        notes: z.string().max(1000).optional(),
      }),
      req.body,
    );
    // Versions are append-only. We try version = latest+1; the unique (entryId, version) index makes concurrent updates retry instead of overwrite.
    let v;
    for (let i = 0; i < 10 && !v; i++) {
      const last = await EntryVersion.findOne({ entryId: entry._id }).sort({ version: -1 });
      try {
        v = await EntryVersion.create({
          entryId: entry._id,
          version: (last?.version ?? 0) + 1,
          content: b.content,
          link: b.link,
          notes: b.notes,
          submittedBy: req.user!.id,
        });
      } catch (e) {
        if ((e as { code?: number }).code !== 11000) throw e;
      }
    }
    if (!v) throw conflict('Could not save a new version; please retry');
    await Entry.updateOne({ _id: entry._id, currentVersion: { $lt: v.version } }, { currentVersion: v.version, ...(b.title ? { title: b.title } : {}) });
    await audit(req.user!.id, 'entry.version', 'Entry', entry.id, { version: v.version });
    ok(res, v, 201);
  }),
);

r.get(
  '/entries/:id/versions',
  wrap(async (req, res) => {
    const entry = await Entry.findById(oid(req.params.id));
    if (!entry) throw notFound('Entry not found');
    const allowed =
      isStaff(req.user) || (await ownsEntry(entry, req.user!.id)) || !!(await JudgeAssignment.exists({ entryId: entry._id, judgeId: req.user!.id }));
    if (!allowed) throw forbidden();
    ok(res, await EntryVersion.find({ entryId: entry._id }).sort({ version: 1 }));
  }),
);

r.get(
  '/activities/:id/entries',
  wrap(async (req, res) => {
    const aid = oid(req.params.id);
    let filter: Record<string, unknown> = { activityId: aid };
    if (!isStaff(req.user)) {
      if (hasRole(req.user, 'judge')) filter = { _id: { $in: (await JudgeAssignment.find({ activityId: aid, judgeId: req.user!.id })).map((j) => j.entryId) } };
      else {
        const tms = await TeamMember.find({ userId: req.user!.id });
        filter = { activityId: aid, $or: [{ ownerUserId: req.user!.id }, { teamId: { $in: tms.map((t) => t.teamId) } }] };
      }
    }
    const entries = await Entry.find(filter);
    const judges = await JudgeAssignment.find({ entryId: { $in: entries.map((e) => e._id) } });
    const names = await User.find({ _id: { $in: [...judges.map((j) => j.judgeId), ...entries.map((e) => e.ownerUserId).filter(Boolean)] } }).select('name');
    const teams = await Team.find({ _id: { $in: entries.map((e) => e.teamId).filter(Boolean) } }).select('name');
    ok(
      res,
      entries.map((e) => ({
        ...e.toJSON(),
        ownerName: e.teamId ? teams.find((t) => t.id === String(e.teamId))?.name : names.find((u) => u.id === String(e.ownerUserId))?.name,
        judges: isStaff(req.user)
          ? judges.filter((j) => String(j.entryId) === e.id).map((j) => ({ id: String(j.judgeId), name: names.find((u) => u.id === String(j.judgeId))?.name }))
          : undefined,
      })),
    );
  }),
);

// ---- judge assignment & scoring
r.post(
  '/entries/:id/judges',
  organiser,
  wrap(async (req, res) => {
    const entry = await Entry.findById(oid(req.params.id));
    if (!entry) throw notFound('Entry not found');
    const { judgeId } = parse(z.object({ judgeId: z.string() }), req.body);
    const judge = await User.findById(oid(judgeId, 'judge id'));
    if (!judge || !judge.roles.includes('judge')) throw unprocessable('That user does not have the judge role');
    if (await ownsEntry(entry, judgeId)) throw unprocessable("Conflict of interest: a judge cannot judge their own or their team's entry");
    let created;
    try {
      created = await JudgeAssignment.create({ entryId: entry._id, activityId: entry.activityId, judgeId });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw conflict('This judge is already assigned to the entry');
      throw e;
    }
    await notifyJudge(entry, judgeId, 'assigned'); // only reached when the assignment succeeded
    await audit(req.user!.id, 'judge.assign', 'Entry', entry.id, { judgeId });
    ok(res, created, 201);
  }),
);
r.delete(
  '/entries/:id/judges/:judgeId',
  organiser,
  wrap(async (req, res) => {
    const entryId = oid(req.params.id);
    const judgeId = oid(req.params.judgeId);
    const d = await JudgeAssignment.deleteOne({ entryId, judgeId });
    if (d.deletedCount) {
      const entry = await Entry.findById(entryId);
      if (entry) await notifyJudge(entry, String(judgeId), 'unassigned');
    }
    ok(res, { removed: d.deletedCount });
  }),
);

r.get(
  '/me/assigned-entries',
  requireRole('judge'),
  wrap(async (req, res) => {
    const as = await JudgeAssignment.find({ judgeId: req.user!.id });
    const entries = await Entry.find({ _id: { $in: as.map((a) => a.entryId) } });
    const [versions, scores, rubrics, acts, events, teams] = await Promise.all([
      Promise.all(entries.map((e) => EntryVersion.findOne({ entryId: e._id, version: e.currentVersion }))),
      Score.find({ judgeId: req.user!.id, entryId: { $in: entries.map((e) => e._id) } }),
      Rubric.find({ activityId: { $in: entries.map((e) => e.activityId) } }),
      Activity.find({ _id: { $in: entries.map((e) => e.activityId) } }).select('title'),
      Event.find({ _id: { $in: entries.map((e) => e.eventId) } }).select('title'),
      Team.find({ _id: { $in: entries.map((e) => e.teamId).filter(Boolean) } }).select('name'),
    ]);
    ok(
      res,
      entries.map((e, i) => ({
        ...e.toJSON(),
        latest: versions[i],
        myScore: scores.find((s) => String(s.entryId) === e.id) ?? null,
        rubric: rubrics.find((x) => String(x.activityId) === String(e.activityId)) ?? null,
        activityTitle: acts.find((a) => a.id === String(e.activityId))?.title,
        eventId: String(e.eventId),
        eventTitle: events.find((x) => x.id === String(e.eventId))?.title,
        teamName: e.teamId ? (teams.find((t) => t.id === String(e.teamId))?.name ?? null) : null,
      })),
    );
  }),
);

r.put(
  '/entries/:id/score',
  requireRole('judge'),
  wrap(async (req, res) => {
    const entry = await Entry.findById(oid(req.params.id));
    if (!entry) throw notFound('Entry not found');
    // Server-side restriction: a judge can score ONLY entries assigned to them.
    if (!(await JudgeAssignment.exists({ entryId: entry._id, judgeId: req.user!.id }))) throw forbidden('This entry is not assigned to you');
    if (await Result.exists({ activityId: entry.activityId, status: 'official' })) throw conflict('Results are official; scoring is closed');
    const rubric = await Rubric.findOne({ activityId: entry.activityId });
    if (!rubric) throw unprocessable('The organiser has not defined a rubric for this competition yet');
    const b = parse(
      z.object({ criterionScores: z.array(z.object({ name: z.string(), score: z.coerce.number().min(0) })), feedback: z.string().max(2000).optional() }),
      req.body,
    );
    const names = new Set(b.criterionScores.map((s) => s.name));
    if (b.criterionScores.length !== rubric.criteria.length || rubric.criteria.some((c) => !names.has(c.name)))
      throw unprocessable('Provide exactly one score for every rubric criterion');
    for (const c of rubric.criteria) {
      const s = b.criterionScores.find((x) => x.name === c.name)!;
      if (s.score > c.maxScore) throw unprocessable(`"${c.name}" is out of ${c.maxScore}; ${s.score} is too high`);
    }
    const percent = percentFromScores(rubric.criteria as never, b.criterionScores);
    const sc = await Score.findOneAndUpdate(
      { entryId: entry._id, judgeId: req.user!.id },
      { $set: { activityId: entry.activityId, criterionScores: b.criterionScores, feedback: b.feedback, percent, versionScored: entry.currentVersion } },
      { upsert: true, new: true },
    );
    await audit(req.user!.id, 'score.submit', 'Entry', entry.id, { percent });
    ok(res, sc);
  }),
);

// ---- results (organiser review/approval)
r.post(
  '/activities/:id/results/compute',
  organiser,
  wrap(async (req, res) => {
    const a = await loadActivity(oid(req.params.id));
    if (await Result.exists({ activityId: a._id, status: 'official' })) throw conflict('Results are already official');
    const scores = await Score.find({ activityId: a._id });
    if (!scores.length) throw unprocessable('No scores have been submitted yet');
    const entries = await Entry.find({ _id: { $in: [...new Set(scores.map((s) => String(s.entryId)))] } });
    const names = await ownerNamesFor(entries.map((e) => e.ownerKey));
    const items = entries.map((e) => {
      const ss = scores.filter((s) => String(s.entryId) === e.id);
      return {
        entryId: e.id,
        percent: Math.round((ss.reduce((x, s) => x + (s.percent ?? 0), 0) / ss.length) * 100) / 100,
        judgeCount: ss.length,
        title: e.title,
        ownerKey: e.ownerKey,
        ownerName: names.get(e.ownerKey),
      };
    });
    const ranked = rankEntries(items).map((x) => ({ ...items.find((i) => i.entryId === x.entryId)!, rank: x.rank }));
    const result = await Result.findOneAndUpdate(
      { activityId: a._id },
      { $set: { rankings: ranked, status: 'draft', computedAt: new Date() }, $unset: { approvedBy: 1, approvedAt: 1 } },
      { upsert: true, new: true },
    );
    await audit(req.user!.id, 'result.compute', 'Activity', a.id);
    ok(res, result);
  }),
);

r.post(
  '/activities/:id/results/approve',
  organiser,
  wrap(async (req, res) => {
    const a = await loadActivity(oid(req.params.id));
    const draft = await Result.findOne({ activityId: a._id });
    if (!draft) throw unprocessable('Compute the results first');
    if (draft.status === 'official') throw conflict('Results are already official');
    const changed = await Score.exists({ activityId: a._id, updatedAt: { $gt: draft.computedAt } });
    if (changed) throw conflict('Scores changed after the results were computed. Recompute and review again before approving.');
    const done = await Result.findOneAndUpdate(
      { _id: draft._id, status: 'draft' },
      { status: 'official', approvedBy: req.user!.id, approvedAt: new Date() },
      { new: true },
    );
    if (!done) throw conflict('Results are already official');
    await audit(req.user!.id, 'result.approve', 'Activity', a.id);
    try {
      await notifyResultsPublished({ _id: a._id, title: a.title, eventId: a.eventId }, done);
    } catch (err) {
      logger.warn('result notifications failed', { activityId: String(a._id), message: (err as Error).message }); // approval is already committed
    }
    ok(res, done);
  }),
);

r.get(
  '/activities/:id/results',
  wrap(async (req, res) => {
    const result = await Result.findOne({ activityId: oid(req.params.id) });
    if (!result) throw notFound('No results yet');
    if (result.status !== 'official' && !isStaff(req.user)) throw notFound('Results have not been published');
    // Results computed before ownerName was stored: resolve the name now.
    const missing = result.rankings.filter((x) => !x.ownerName && x.ownerKey).map((x) => x.ownerKey as string);
    const names = missing.length ? await ownerNamesFor(missing) : new Map<string, string>();
    const rankings = result.rankings.map((x) => ({
      rank: x.rank,
      title: x.title,
      ownerName: x.ownerName || (x.ownerKey ? names.get(x.ownerKey) : undefined) || null,
      percent: x.percent,
    }));
    ok(res, { status: result.status, approvedAt: result.approvedAt, rankings });
  }),
);

/** Official results for every activity of an event (participant "Results" tab). `mine` marks the caller's own team/entry. */
r.get(
  '/events/:id/results',
  wrap(async (req, res) => {
    const eventId = oid(req.params.id);
    const uid = req.user!.id;
    const [tm, regs] = await Promise.all([TeamMember.findOne({ eventId, userId: uid }), Registration.exists({ eventId, userId: uid, status: { $in: ['confirmed', 'waitlisted', 'pending_approval'] } })]);
    if (!isStaff(req.user) && !tm && !regs) throw forbidden('Only registered participants and team members can see results here');
    const activities = await Activity.find({ eventId, kind: 'competition', status: 'scheduled' }).sort({ start: 1 });
    const results = await Result.find({ activityId: { $in: activities.map((x) => x._id) }, status: 'official' });
    const byActivity = new Map(results.map((x) => [String(x.activityId), x]));
    const mineKeys = new Set([`u:${uid}`, ...(tm ? [`t:${tm.teamId}`] : [])]);
    const missing = results.flatMap((x) => x.rankings.filter((k) => !k.ownerName && k.ownerKey).map((k) => k.ownerKey as string));
    const names = missing.length ? await ownerNamesFor(missing) : new Map<string, string>();
    ok(res, {
      published: results.length > 0,
      activities: activities
        .filter((x) => byActivity.has(x.id))
        .map((x) => {
          const result = byActivity.get(x.id)!;
          return {
            activityId: x.id,
            title: x.title,
            approvedAt: result.approvedAt,
            rankings: result.rankings.map((k) => ({ rank: k.rank, title: k.title, ownerName: k.ownerName || (k.ownerKey ? names.get(k.ownerKey) : undefined) || null, percent: k.percent, mine: !!k.ownerKey && mineKeys.has(k.ownerKey) })),
          };
        }),
    });
  }),
);

r.get(
  '/audit',
  organiser,
  wrap(async (req, res) => {
    const f: Record<string, unknown> = {};
    if (req.query.entityType) f.entityType = String(req.query.entityType);
    ok(
      res,
      await AuditLog.find(f)
        .sort({ at: -1 })
        .limit(Math.min(Number(req.query.limit ?? 100), 500)),
    );
  }),
);

export default r;
