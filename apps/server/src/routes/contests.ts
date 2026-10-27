import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { CONTEST_MODES, DIFFICULTIES, LANGUAGES, bannerImageSchema } from '@festhub/shared';
import { env } from '../config/env';
import { Contest, ContestRegistration, ContestTeam, ContestTeamInvitation, Editorial, Problem, Registration, Submission, TestCase, User, Venue } from '../models';
import { hasRole, requireAuth, requireRole, type AuthUser } from '../middleware/auth';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { oid, ok, parse, wrap } from '../utils/http';
import { audit, logAction } from '../utils/audit';
import { notify } from '../services/notify';
import { canResend, checkAnswer, checkContestInvite, inviteExpiry, inviteSlotKey, normalizeEmail } from '../services/contest-invite-rules';
import { contestInviteLimiter, contestInviteLink, contestInvitePath, liveContestInviteFilter, onContestTeam, sendContestInviteEmail, sweepExpiredContestInvites } from '../services/contest-invites';
import { removeEventImage } from '../services/uploads';
import { fetchJudge0Languages, languageIds } from '../services/judge/judge0';
import { enqueue } from '../services/judgeService';
import { buildScoreboard, canViewProblemStatement, computeProgress, problemIsReleased } from '../services/scoreboard';
import { emitTo } from '../sockets/io';
import { isRegistered, registrationClosedMessage, registrationOpen, removalKeepsMinimum, teamRegisterVerdict } from '../services/contest-registration';

const r = Router();
const setter = requireRole('judge', 'organiser');
const organiser = requireRole('organiser');

/** Whitelist of fields a contestant may see. Test cases are NEVER part of this shape. */
const participantProblem = (p: InstanceType<typeof Problem>) => ({
  id: p.id,
  title: p.title,
  statement: p.statement,
  constraints: p.constraints,
  inputDesc: p.inputDesc,
  outputDesc: p.outputDesc,
  samples: p.samples,
  tags: p.tags,
  difficulty: p.difficulty,
  timeLimitMs: p.timeLimitMs,
  memoryLimitKb: p.memoryLimitKb,
  languages: p.languages,
});

const problemSchema = z.object({
  title: z.string().trim().min(3).max(150),
  statement: z.string().trim().min(10).max(20000),
  constraints: z.string().max(3000).optional(),
  inputDesc: z.string().max(3000).optional(),
  outputDesc: z.string().max(3000).optional(),
  samples: z
    .array(z.object({ input: z.string().max(5000), output: z.string().max(5000), explanation: z.string().max(2000).optional() }))
    .max(5)
    .default([]),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(30)).max(10).default([]),
  difficulty: z.enum(DIFFICULTIES).default('easy'),
  timeLimitMs: z.coerce.number().int().min(100).max(15000).default(2000),
  memoryLimitKb: z.coerce.number().int().min(16384).max(1048576).default(262144),
  languages: z
    .array(z.enum(LANGUAGES))
    .min(1)
    .default([...LANGUAGES]),
  visibility: z.enum(['private', 'public']).default('private'),
});

async function ownProblem(id: string, user: { id: string; roles: string[] }) {
  const p = await Problem.findById(id);
  if (!p) throw notFound('Problem not found');
  if (!user.roles.includes('organiser') && String(p.authorId) !== user.id) throw forbidden('Only the problem author or an organiser can do this');
  return p;
}

// ---------------- problem bank ----------------
r.get(
  '/problems',
  requireAuth,
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const tag = String(req.query.tag ?? '').toLowerCase();
    const diff = String(req.query.difficulty ?? '');
    const f: Record<string, unknown> = {};
    if (tag) f.tags = tag;
    if (diff) f.difficulty = diff;
    if (q) f.title = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const manage = hasRole(req.user, 'judge', 'organiser') && req.query.manage === '1';
    if (manage) {
      if (!hasRole(req.user, 'organiser')) f.authorId = req.user!.id;
    } else f.visibility = 'public';
    let problems = await Problem.find(f).sort({ createdAt: -1 }).limit(200);
    if (!manage) {
      const open = await Contest.find({ endAt: { $gt: new Date() } });
      const hidden = new Set(open.flatMap((c) => c.problems.map((p) => String(p.problemId))));
      problems = problems.filter((p) => !hidden.has(p.id));
    }
    const counts = manage ? await TestCase.aggregate([{ $group: { _id: '$problemId', n: { $sum: 1 } } }]) : [];
    ok(
      res,
      problems.map((p) => ({
        id: p.id,
        title: p.title,
        tags: p.tags,
        difficulty: p.difficulty,
        visibility: p.visibility,
        ...(manage ? { testCaseCount: counts.find((c) => String(c._id) === p.id)?.n ?? 0 } : {}),
      })),
    );
  }),
);

r.post(
  '/problems',
  requireAuth,
  setter,
  wrap(async (req, res) => {
    const p = await Problem.create({ ...parse(problemSchema, req.body), authorId: req.user!.id });
    await audit(req.user!.id, 'problem.create', 'Problem', p.id);
    ok(res, { id: p.id }, 201);
  }),
);

r.patch(
  '/problems/:id',
  requireAuth,
  setter,
  wrap(async (req, res) => {
    const p = await ownProblem(oid(req.params.id), req.user!);
    Object.assign(p, parse(problemSchema.partial(), req.body));
    await p.save();
    await audit(req.user!.id, 'problem.update', 'Problem', p.id);
    ok(res, { id: p.id });
  }),
);

r.put(
  '/problems/:id/testcases',
  requireAuth,
  setter,
  wrap(async (req, res) => {
    const p = await ownProblem(oid(req.params.id), req.user!);
    const { cases } = parse(
      z.object({
        cases: z
          .array(z.object({ input: z.string().max(1_000_000), expectedOutput: z.string().max(1_000_000) }))
          .min(1)
          .max(100),
      }),
      req.body,
    );
    await TestCase.bulkWrite([
      ...cases.map((c, i) => ({
        updateOne: { filter: { problemId: p._id, order: i + 1 }, update: { $set: { input: c.input, expectedOutput: c.expectedOutput } }, upsert: true },
      })),
      { deleteMany: { filter: { problemId: p._id, order: { $gt: cases.length } } } },
    ]);
    await audit(req.user!.id, 'problem.testcases', 'Problem', p.id, { count: cases.length });
    ok(res, { count: cases.length });
  }),
);
r.get(
  '/problems/:id/testcases',
  requireAuth,
  setter,
  wrap(async (req, res) => {
    const p = await ownProblem(oid(req.params.id), req.user!);
    ok(res, await TestCase.find({ problemId: p._id }).sort({ order: 1 }).select('+input +expectedOutput'));
  }),
);

r.get(
  '/problems/:id',
  requireAuth,
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const p = await Problem.findById(id);
    if (!p) throw notFound('Problem not found');
    const isOwner = String(p.authorId) === req.user!.id || hasRole(req.user, 'organiser');
    if (!isOwner && !(await canViewProblemStatement(id, req.user!))) throw notFound('Problem not found'); // 404, not 403: do not reveal existence
    ok(res, { ...participantProblem(p), ...(isOwner ? { visibility: p.visibility, testCaseCount: await TestCase.countDocuments({ problemId: p._id }) } : {}) });
  }),
);

// ---------------- contests ----------------
const contestSchema = z.object({
  title: z.string().trim().min(3).max(150),
  eventId: z.string().optional(),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  freezeAt: z.coerce.date().optional(),
  revealAt: z.coerce.date().optional(),
  /** Last moment to register (or create / join a team). Required, cannot be cleared, and must not be after the contest starts. */
  registrationDeadline: z.coerce.date({ errorMap: () => ({ message: 'A registration deadline is required' }) }),
  /** Venue id from /venues. null or '' clears it. */
  venueId: z.union([z.null(), z.string().trim()]).optional(),
  problems: z
    .array(z.object({ problemId: z.string(), label: z.string().trim().min(1).max(4) }))
    .min(1)
    .max(26),
  penaltyMinutes: z.coerce.number().int().min(0).max(120).default(20),
  cooldownSec: z.coerce.number().int().min(0).max(600).default(10),
  description: z.string().trim().max(2000).optional(),
  /** Banner image: uploaded through POST /uploads/event-image or an http(s) URL. '' clears it. */
  bannerImage: bannerImageSchema.optional(),
  mode: z.enum(CONTEST_MODES).default('INDIVIDUAL'),
  teamSize: z.object({ min: z.coerce.number().int().min(1).max(10), max: z.coerce.number().int().min(1).max(10) }).default({ min: 1, max: 3 }),
});
async function checkContest(b: z.infer<typeof contestSchema>) {
  if (b.endAt <= b.startAt) throw unprocessable('The contest must end after it starts');
  if (b.mode === 'TEAM' && b.teamSize.min > b.teamSize.max) throw unprocessable('The minimum team size cannot be larger than the maximum');
  if (b.registrationDeadline && b.registrationDeadline > b.startAt) throw unprocessable('The registration deadline must be before the contest starts');
  if (b.venueId) {
    if (!/^[a-f0-9]{24}$/i.test(b.venueId) || !(await Venue.exists({ _id: b.venueId }))) throw unprocessable('That venue does not exist');
  }
  if (b.freezeAt && (b.freezeAt < b.startAt || b.freezeAt >= b.endAt)) throw unprocessable('The freeze time must be inside the contest window');
  if (b.revealAt && b.revealAt < b.endAt) throw unprocessable('The reveal time cannot be before the contest ends');
  if (new Set(b.problems.map((p) => p.label)).size !== b.problems.length) throw unprocessable('Problem labels must be unique');
  const found = await Problem.countDocuments({ _id: { $in: b.problems.map((p) => p.problemId) } });
  if (found !== new Set(b.problems.map((p) => p.problemId)).size) throw unprocessable('One or more problems do not exist');
  const empty = [];
  for (const p of b.problems) if (!(await TestCase.exists({ problemId: p.problemId }))) empty.push(p.label);
  if (empty.length) throw unprocessable(`Problems ${empty.join(', ')} have no test cases yet`);
}

r.post(
  '/contests',
  requireAuth,
  organiser,
  wrap(async (req, res) => {
    const b = parse(contestSchema, req.body);
    await checkContest(b);
    const c = await Contest.create({ ...b, bannerImage: b.bannerImage || undefined, registrationDeadline: b.registrationDeadline, venueId: b.venueId || undefined, createdBy: req.user!.id });
    await audit(req.user!.id, 'contest.create', 'Contest', c.id);
    ok(res, c, 201);
  }),
);

r.patch(
  '/contests/:id',
  requireAuth,
  organiser,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    const b = parse(contestSchema.partial(), req.body);
    if (new Date() >= c.startAt && (b.startAt || b.problems)) throw unprocessable('Start time and problems cannot change after the contest has started');
    const merged = { ...c.toObject(), ...b } as unknown as z.infer<typeof contestSchema>;
    merged.problems = (b.problems ?? c.problems.map((p) => ({ problemId: String(p.problemId), label: p.label! }))) as never;
    // participation type is part of the contest's identity: it cannot flip once people (or teams) have signed up
    if (b.mode && b.mode !== (c.mode ?? 'INDIVIDUAL') && (await ContestRegistration.exists({ contestId: c._id })))
      throw unprocessable('The participation type cannot change after people have registered');
    if (b.teamSize && (c.mode ?? 'INDIVIDUAL') === 'TEAM' && (await ContestTeam.exists({ contestId: c._id, memberCount: { $gt: b.teamSize.max } })))
      throw unprocessable('A registered team is already larger than that maximum team size');
    await checkContest(merged);
    const { bannerImage, registrationDeadline, venueId, ...rest } = b;
    Object.assign(c, rest);
    if (registrationDeadline !== undefined) c.registrationDeadline = registrationDeadline;
    if (venueId !== undefined) c.venueId = (venueId || undefined) as never;
    if (bannerImage !== undefined) {
      const old = c.bannerImage;
      c.bannerImage = bannerImage || undefined;
      if (old && old !== c.bannerImage) await removeEventImage(old);
    }
    await c.save();
    await audit(
      req.user!.id,
      'contest.update',
      'Contest',
      c.id,
      Object.keys(b).reduce((a, k) => ({ ...a, [k]: true }), {}),
    );
    ok(res, c);
  }),
);

const statusOf = (c: { startAt: Date; endAt: Date }, now = new Date()) => (now < c.startAt ? 'upcoming' : now < c.endAt ? 'running' : 'ended');
type ContestDoc = InstanceType<typeof Contest>;
const modeOf = (c: ContestDoc) => c.mode ?? 'INDIVIDUAL';
/** Fields every contest card/page needs, including the banner. */
type VenueDoc = { id?: string; name: string; building?: string | null; capacity?: number | null };
const venueView = (v?: VenueDoc | null) => (v ? { id: v.id ?? '', name: v.name, building: v.building ?? null, capacity: v.capacity ?? null } : null);
const contestCard = (c: ContestDoc, venue?: VenueDoc | null) => ({
  id: c.id,
  title: c.title,
  description: c.description ?? '',
  bannerImage: c.bannerImage ?? null,
  mode: modeOf(c),
  teamSize: modeOf(c) === 'TEAM' ? { min: c.teamSize?.min ?? 1, max: c.teamSize?.max ?? 3 } : null,
  startAt: c.startAt,
  endAt: c.endAt,
  freezeAt: c.freezeAt,
  registrationDeadline: c.registrationDeadline ?? null,
  registrationOpen: registrationOpen(c),
  venue: venueView(venue),
  status: statusOf(c),
  problemCount: c.problems.length,
});

r.get(
  '/contests',
  requireAuth,
  wrap(async (req, res) => {
    const cs = await Contest.find().sort({ startAt: -1 }).limit(50);
    const ids = cs.map((c) => c._id);
    const regs = await ContestRegistration.find({ userId: req.user!.id, contestId: { $in: ids } });
    // a team member only counts as registered once the leader registered the team
    const myTeamIds = regs.flatMap((g) => (g.teamId ? [g.teamId] : []));
    const myRegisteredTeams = new Set((await ContestTeam.find({ _id: { $in: myTeamIds }, registeredAt: { $exists: true, $ne: null } }).select('_id')).map((t) => String(t._id)));
    const venues = await Venue.find({ _id: { $in: cs.flatMap((c) => (c.venueId ? [c.venueId] : [])) } });
    const [regCounts, teamCounts] = await Promise.all([
      ContestRegistration.aggregate([{ $match: { contestId: { $in: ids } } }, { $group: { _id: '$contestId', n: { $sum: 1 } } }]),
      ContestTeam.aggregate([{ $match: { contestId: { $in: ids }, registeredAt: { $exists: true, $ne: null } } }, { $group: { _id: '$contestId', n: { $sum: 1 } } }]),
    ]);
    const countOf = (rows: { _id: unknown; n: number }[], id: string) => rows.find((x) => String(x._id) === id)?.n ?? 0;
    ok(
      res,
      cs.map((c) => ({
        ...contestCard(c, venues.find((v) => String(v._id) === String(c.venueId))),
        registered: regs.some((g) => String(g.contestId) === c.id && (modeOf(c) !== 'TEAM' || (!!g.teamId && myRegisteredTeams.has(String(g.teamId))))),
        // people for INDIVIDUAL contests, registered teams for TEAM contests
        participants: modeOf(c) === 'TEAM' ? countOf(teamCounts, c.id) : countOf(regCounts, c.id),
      })),
    );
  }),
);

/** The caller's own team in a TEAM contest. Only the leader receives the join code. */
async function myTeamView(c: ContestDoc, userId: string) {
  const reg = await ContestRegistration.findOne({ contestId: c._id, userId, teamId: { $exists: true } });
  if (!reg?.teamId) return null;
  const team = await ContestTeam.findById(reg.teamId);
  if (!team) return null;
  const members = await ContestRegistration.find({ contestId: c._id, teamId: team._id }).select('userId');
  const people = await User.find({ _id: { $in: members.map((m) => m.userId) } }).select('name');
  const min = c.teamSize?.min ?? 1;
  const isLeader = String(team.leaderId) === userId;
  return {
    id: team.id,
    name: team.name,
    isLeader,
    ...(isLeader ? { joinCode: team.joinCode } : {}),
    members: members.map((m) => ({ id: String(m.userId), name: people.find((p) => p.id === String(m.userId))?.name ?? 'Unknown', isLeader: String(m.userId) === String(team.leaderId) })),
    minSize: min,
    maxSize: c.teamSize?.max ?? 3,
    complete: team.memberCount >= min,
    registered: !!team.registeredAt,
    registeredAt: team.registeredAt ?? null,
  };
}

r.get(
  '/contests/:id',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    const registered = await isRegistered(c, req.user!.id);
    const venue = c.venueId ? await Venue.findById(c.venueId) : null;
    ok(res, {
      ...contestCard(c, venue),
      revealAt: c.revealAt,
      revealed: c.revealed,
      penaltyMinutes: c.penaltyMinutes,
      cooldownSec: c.cooldownSec,
      registered,
      myTeam: modeOf(c) === 'TEAM' ? await myTeamView(c, req.user!.id) : null,
      serverTime: new Date(),
    });
  }),
);

/** Rules every way of joining a contest (solo registration, creating a team, joining a team) must pass. */
async function assertCanCompete(c: ContestDoc, user: AuthUser) {
  if (!registrationOpen(c)) throw unprocessable(registrationClosedMessage(c));
  const authored = await Problem.exists({ _id: { $in: c.problems.map((p) => p.problemId) }, authorId: user.id });
  if (authored) throw unprocessable('Problem setters cannot compete in a contest that uses their problems');
  if (hasRole(user, 'judge', 'organiser')) throw unprocessable('Judges and organisers cannot compete');
  if (c.eventId && !(await Registration.exists({ eventId: c.eventId, status: 'confirmed', userId: user.id })))
    throw unprocessable('You need a confirmed registration for the linked event to join this contest');
}
const requireMode = (c: ContestDoc, mode: 'INDIVIDUAL' | 'TEAM') => {
  if (modeOf(c) !== mode)
    throw unprocessable(mode === 'TEAM' ? 'This is an individual contest. Use Register instead of creating a team.' : 'This is a team contest. Create a team or join one with a join code.');
};

r.post(
  '/contests/:id/register',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    requireMode(c, 'INDIVIDUAL');
    await assertCanCompete(c, req.user!);
    try {
      ok(res, await ContestRegistration.create({ contestId: c._id, userId: req.user!.id }), 201);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw conflict('You are already registered for this contest');
      throw e;
    }
  }),
);

// ---------------- teams (TEAM contests, ICPC style) ----------------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newJoinCode = () => Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const isDup = (e: unknown) => (e as { code?: number }).code === 11000;
/** Team composition is frozen once the contest starts: removing a member afterwards would silently change standings. */
const compositionLocked = (c: ContestDoc, user: AuthUser) => new Date() >= c.startAt && !hasRole(user, 'organiser');

r.post(
  '/contests/:id/teams',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    requireMode(c, 'TEAM');
    const { name } = parse(z.object({ name: z.string().trim().min(2, 'Team name is too short').max(40) }), req.body);
    await assertCanCompete(c, req.user!);
    if (await ContestRegistration.exists({ contestId: c._id, userId: req.user!.id })) throw conflict('You are already on a team in this contest');
    // "Alpha" and "alpha" would be indistinguishable on a scoreboard: names are unique ignoring case (the DB index covers exact duplicates and races)
    const sameName = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (await ContestTeam.exists({ contestId: c._id, name: sameName })) throw conflict('Another team in this contest already uses that name');
    let team: InstanceType<typeof ContestTeam> | null = null;
    for (let attempt = 0; attempt < 5 && !team; attempt++) {
      try {
        team = await ContestTeam.create({ contestId: c._id, name, leaderId: req.user!.id, joinCode: newJoinCode(), memberCount: 1 });
      } catch (e) {
        if (!isDup(e)) throw e;
        if (await ContestTeam.exists({ contestId: c._id, name })) throw conflict('Another team in this contest already uses that name');
        // otherwise only the random join code collided: draw a new one
      }
    }
    if (!team) throw conflict('Could not create the team, please try again');
    try {
      await ContestRegistration.create({ contestId: c._id, userId: req.user!.id, teamId: team._id });
    } catch (e) {
      await ContestTeam.deleteOne({ _id: team._id });
      if (isDup(e)) throw conflict('You are already on a team in this contest');
      throw e;
    }
    await audit(req.user!.id, 'contest.team.create', 'ContestTeam', team.id);
    ok(res, await myTeamView(c, req.user!.id), 201);
  }),
);

r.post(
  '/contests/:id/teams/join',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    requireMode(c, 'TEAM');
    const { joinCode } = parse(z.object({ joinCode: z.string().trim().toUpperCase().min(4).max(20) }), req.body);
    await assertCanCompete(c, req.user!);
    const team = await ContestTeam.findOne({ contestId: c._id, joinCode });
    if (!team) throw notFound('No team in this contest uses that join code');
    if (await ContestRegistration.exists({ contestId: c._id, userId: req.user!.id })) throw conflict('You are already on a team in this contest');
    // The conditional update (not read-modify-write) is what makes an over-full team impossible under concurrent joins.
    const seat = await ContestTeam.findOneAndUpdate({ _id: team._id, memberCount: { $lt: c.teamSize?.max ?? 3 } }, { $inc: { memberCount: 1 } });
    if (!seat) throw unprocessable(`That team is full (maximum ${c.teamSize?.max ?? 3} members)`);
    try {
      await ContestRegistration.create({ contestId: c._id, userId: req.user!.id, teamId: team._id });
    } catch (e) {
      await ContestTeam.updateOne({ _id: team._id }, { $inc: { memberCount: -1 } });
      if (isDup(e)) throw conflict('You are already on a team in this contest');
      throw e;
    }
    emitTo(`contest:${c.id}`, 'scoreboard:update', { contestId: c.id });
    ok(res, await myTeamView(c, req.user!.id), 201);
  }),
);

/**
 * Creating a team does NOT register it. When the team has the minimum number of members, the LEADER registers it here.
 * Only registered teams can see the problems, submit, and appear on the scoreboard / organiser registration list.
 */
r.post(
  '/contests/:id/teams/:teamId/register',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    requireMode(c, 'TEAM');
    const team = await ContestTeam.findOne({ _id: oid(req.params.teamId), contestId: c._id });
    if (!team) throw notFound('Team not found');
    if (String(team.leaderId) !== req.user!.id) throw forbidden('Only the team leader can register the team');
    if (!registrationOpen(c)) throw unprocessable(registrationClosedMessage(c));
    const verdict = teamRegisterVerdict(team, c.teamSize?.min ?? 1);
    if (verdict) throw verdict.status === 409 ? conflict(verdict.message) : unprocessable(verdict.message);
    // conditional update: two quick clicks (or a member leaving at the same moment) cannot register an incomplete team
    const done = await ContestTeam.findOneAndUpdate(
      { _id: team._id, memberCount: { $gte: c.teamSize?.min ?? 1 }, registeredAt: { $exists: false } },
      { $set: { registeredAt: new Date() } },
      { new: true },
    );
    if (!done) throw conflict('The team changed while registering. Please check it and try again');
    const members = await ContestRegistration.find({ contestId: c._id, teamId: team._id }).select('userId');
    for (const m of members) {
      if (String(m.userId) === req.user!.id) continue;
      await notify(m.userId, 'Team registered', `Your team "${team.name}" is registered for ${c.title}.`, `/contests/${c.id}`).catch(() => undefined);
    }
    await audit(req.user!.id, 'contest.team.register', 'ContestTeam', team.id);
    emitTo(`contest:${c.id}`, 'scoreboard:update', { contestId: c.id });
    ok(res, await myTeamView(c, req.user!.id));
  }),
);

/** The leader (or an organiser) can take the team back to a draft until the contest starts. */
r.delete(
  '/contests/:id/teams/:teamId/register',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    requireMode(c, 'TEAM');
    const team = await ContestTeam.findOne({ _id: oid(req.params.teamId), contestId: c._id });
    if (!team) throw notFound('Team not found');
    if (String(team.leaderId) !== req.user!.id && !hasRole(req.user, 'organiser')) throw forbidden('Only the team leader can cancel the team registration');
    if (compositionLocked(c, req.user!)) throw unprocessable('Registration is locked once the contest has started');
    if (!team.registeredAt) throw conflict('This team is not registered');
    await ContestTeam.updateOne({ _id: team._id }, { $unset: { registeredAt: 1 } });
    await audit(req.user!.id, 'contest.team.unregister', 'ContestTeam', team.id);
    emitTo(`contest:${c.id}`, 'scoreboard:update', { contestId: c.id });
    ok(res, { registered: false });
  }),
);

// ---------------- team invitations (e-mail / in-app; the join code above keeps working) ----------------
const throwContestVerdict = (v: { status: 409 | 422; message: string }): never => {
  throw v.status === 409 ? conflict(v.message) : unprocessable(v.message);
};
async function openTeamContest(contestId: string) {
  const c = await Contest.findById(contestId);
  if (!c) throw notFound('Contest not found');
  requireMode(c, 'TEAM');
  return c;
}
async function leaderOf(c: ContestDoc, teamId: string, userId: string) {
  const team = await ContestTeam.findOne({ _id: oid(teamId), contestId: c._id });
  if (!team) throw notFound('Team not found');
  if (String(team.leaderId) !== userId) throw forbidden('Only the team leader can invite members');
  return team;
}

r.post(
  '/contests/:id/teams/:teamId/invitations',
  requireAuth,
  contestInviteLimiter,
  wrap(async (req, res) => {
    const c = await openTeamContest(oid(req.params.id));
    const team = await leaderOf(c, req.params.teamId, req.user!.id);
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email().max(254) }), req.body);
    const invitee = await User.findOne({ email });
    if (invitee && String(invitee._id) === req.user!.id) throw unprocessable('You cannot invite yourself');
    const slotKey = inviteSlotKey(team._id, { userId: invitee?._id, email });
    const now = new Date();
    const [existing, livePending, onTeam] = await Promise.all([
      ContestTeamInvitation.findOne({ slotKey }),
      ContestTeamInvitation.countDocuments({ teamId: team._id, ...liveContestInviteFilter(now) }),
      invitee ? onContestTeam(c._id, invitee._id) : null,
    ]);
    const v = checkContestInvite({ contestEndAt: c.endAt, memberCount: team.memberCount, maxSize: c.teamSize?.max ?? 3, inviteeOnTeam: !!onTeam, existing, livePendingCount: livePending, now });
    if (!v.ok) throwContestVerdict(v);
    if (invitee) await assertCanCompete(c, { id: invitee.id, roles: invitee.roles, name: invitee.name } as AuthUser); // judges, setters and linked-event rules
    const expiresAt = inviteExpiry(now);
    let inv;
    try {
      inv = await ContestTeamInvitation.findOneAndUpdate(
        { slotKey },
        { $set: { status: 'pending', contestId: c._id, invitedBy: req.user!.id, inviteeEmail: email, expiresAt, lastSentAt: now, ...(invitee ? { inviteeId: invitee._id } : {}) }, $setOnInsert: { teamId: team._id } },
        { upsert: true, new: true },
      );
    } catch (e) {
      throw isDup(e) ? conflict('That person already has a pending invitation to this team') : e;
    }
    if (invitee) await notify(invitee._id, 'Contest team invitation', `${req.user!.name} invited you to team "${team.name}" for ${c.title}`, contestInvitePath(c.id, inv.id));
    const emailSent = await sendContestInviteEmail({ to: email, teamName: team.name, contestTitle: c.title, inviterName: req.user!.name, contestId: c.id, invitationId: inv.id, expiresAt });
    await logAction(req.user, 'contest.invitation.send', { type: 'ContestTeamInvitation', id: inv.id }, { contestId: c.id, teamId: team.id, email, accountExists: !!invitee, emailSent }, req);
    ok(res, { ...inv.toJSON(), link: contestInviteLink(c.id, inv.id), emailSent, accountExists: !!invitee }, 201);
  }),
);

r.get(
  '/contests/:id/teams/:teamId/invitations',
  requireAuth,
  wrap(async (req, res) => {
    const c = await openTeamContest(oid(req.params.id));
    const team = await ContestTeam.findOne({ _id: oid(req.params.teamId), contestId: c._id });
    if (!team) throw notFound('Team not found');
    if (String(team.leaderId) !== req.user!.id && !hasRole(req.user, 'organiser')) throw forbidden('Only the team leader can see invitations');
    await sweepExpiredContestInvites({ teamId: team._id });
    const invs = await ContestTeamInvitation.find({ teamId: team._id, status: { $in: ['pending', 'expired'] } }).sort({ createdAt: -1 });
    const users = await User.find({ _id: { $in: invs.map((i) => i.inviteeId).filter(Boolean) } }).select('name email');
    ok(
      res,
      invs.map((i) => {
        const u = users.find((x) => x.id === String(i.inviteeId));
        return { _id: i.id, email: i.inviteeEmail ?? u?.email ?? '', name: u?.name, accountExists: !!i.inviteeId, status: i.status, expiresAt: i.expiresAt, lastSentAt: i.lastSentAt, expired: i.status === 'expired' };
      }),
    );
  }),
);

r.post(
  '/contests/:id/teams/:teamId/invitations/:invId/resend',
  requireAuth,
  contestInviteLimiter,
  wrap(async (req, res) => {
    const c = await openTeamContest(oid(req.params.id));
    const team = await leaderOf(c, req.params.teamId, req.user!.id);
    const inv = await ContestTeamInvitation.findOne({ _id: oid(req.params.invId), teamId: team._id, status: { $in: ['pending', 'expired'] } });
    if (!inv) throw notFound('Pending invitation not found');
    const now = new Date();
    if (now >= c.endAt) throw unprocessable('This contest has ended');
    if (!canResend(inv.lastSentAt, now)) throw conflict('This invitation was just sent. Wait a moment before resending.');
    if (team.memberCount >= (c.teamSize?.max ?? 3)) throw unprocessable(`The team is already full (maximum ${c.teamSize?.max ?? 3} members)`);
    inv.status = 'pending';
    inv.expiresAt = inviteExpiry(now);
    inv.lastSentAt = now;
    await inv.save();
    const to = inv.inviteeEmail ?? (inv.inviteeId ? (await User.findById(inv.inviteeId).select('email'))?.email : undefined) ?? '';
    if (inv.inviteeId) await notify(inv.inviteeId, 'Contest team invitation', `${req.user!.name} invited you to team "${team.name}" for ${c.title}`, contestInvitePath(c.id, inv.id));
    const emailSent = await sendContestInviteEmail({ to, teamName: team.name, contestTitle: c.title, inviterName: req.user!.name, contestId: c.id, invitationId: inv.id, expiresAt: inv.expiresAt });
    await logAction(req.user, 'contest.invitation.resend', { type: 'ContestTeamInvitation', id: inv.id }, { contestId: c.id, teamId: team.id, emailSent }, req);
    ok(res, { _id: inv.id, expiresAt: inv.expiresAt, emailSent });
  }),
);

r.delete(
  '/contests/:id/teams/:teamId/invitations/:invId',
  requireAuth,
  wrap(async (req, res) => {
    const c = await openTeamContest(oid(req.params.id));
    const team = await leaderOf(c, req.params.teamId, req.user!.id);
    const inv = await ContestTeamInvitation.findOneAndUpdate({ _id: oid(req.params.invId), teamId: team._id, status: { $in: ['pending', 'expired'] } }, { $set: { status: 'cancelled' } }, { new: true });
    if (!inv) throw notFound('Pending invitation not found');
    await logAction(req.user, 'contest.invitation.cancel', { type: 'ContestTeamInvitation', id: inv.id }, { contestId: c.id, teamId: team.id }, req);
    ok(res, { _id: inv.id, status: inv.status });
  }),
);

r.get(
  '/contests/:id/invitations/mine',
  requireAuth,
  wrap(async (req, res) => {
    const c = await openTeamContest(oid(req.params.id));
    const me = await User.findById(req.user!.id).select('email');
    const who = [{ inviteeId: req.user!.id }, ...(me?.email ? [{ inviteeId: { $exists: false }, inviteeEmail: normalizeEmail(me.email) }] : [])];
    await sweepExpiredContestInvites({ contestId: c._id, $or: who });
    const invs = await ContestTeamInvitation.find({ $and: [{ contestId: c._id }, liveContestInviteFilter(), { $or: who }] });
    const teams = await ContestTeam.find({ _id: { $in: invs.map((i) => i.teamId) } }).select('name');
    const inviters = await User.find({ _id: { $in: invs.map((i) => i.invitedBy) } }).select('name');
    ok(
      res,
      invs.map((i) => ({
        _id: i.id,
        teamName: teams.find((t) => t.id === String(i.teamId))?.name ?? 'a team',
        inviterName: inviters.find((u) => u.id === String(i.invitedBy))?.name ?? 'A participant',
        expiresAt: i.expiresAt,
      })),
    );
  }),
);

/** Load an invitation for the signed-in invitee; an e-mail-only invite for their address is attached to their account on the spot. */
async function answerableInvite(c: ContestDoc, invId: string, user: AuthUser) {
  const inv = await ContestTeamInvitation.findOne({ _id: invId, contestId: c._id });
  const me = await User.findById(user.id).select('email');
  if (!inv || !me) throw notFound('Invitation not found');
  const v = checkAnswer(inv as never, { id: user.id, email: me.email }, new Date());
  if (!v.ok) {
    if (v.code === 'EXPIRED') {
      inv.status = 'expired';
      await inv.save();
      throw unprocessable(v.message);
    }
    throw v.code === 'NOT_YOURS' ? notFound(v.message) : conflict(v.message);
  }
  if (!inv.inviteeId) {
    inv.inviteeId = user.id as never;
    inv.slotKey = `${String(inv.teamId)}:u:${user.id}`;
    try {
      await inv.save();
    } catch (e) {
      throw isDup(e) ? conflict('You already have an invitation to this team') : e;
    }
  }
  return inv;
}

r.post(
  '/contests/:id/invitations/:invId/accept',
  requireAuth,
  wrap(async (req, res) => {
    const c = await openTeamContest(oid(req.params.id));
    const inv = await answerableInvite(c, oid(req.params.invId), req.user!);
    await assertCanCompete(c, req.user!); // contest still open + eligibility
    const team = await ContestTeam.findOne({ _id: inv.teamId, contestId: c._id });
    if (!team) throw notFound('That team no longer exists');
    if (await ContestRegistration.exists({ contestId: c._id, userId: req.user!.id })) throw conflict('You are already on a team in this contest');
    // Same atomic seat guard as joining with the code: an over-full team is impossible under concurrent accepts.
    const seat = await ContestTeam.findOneAndUpdate({ _id: team._id, memberCount: { $lt: c.teamSize?.max ?? 3 } }, { $inc: { memberCount: 1 } });
    if (!seat) throw unprocessable(`That team is full (maximum ${c.teamSize?.max ?? 3} members)`);
    try {
      await ContestRegistration.create({ contestId: c._id, userId: req.user!.id, teamId: team._id });
    } catch (e) {
      await ContestTeam.updateOne({ _id: team._id }, { $inc: { memberCount: -1 } });
      throw isDup(e) ? conflict('You are already on a team in this contest') : e;
    }
    inv.status = 'accepted';
    await inv.save();
    await notify(team.leaderId, 'Contest team', `${req.user!.name} accepted your invitation and joined team "${team.name}"`, `/contests/${c.id}`);
    await notify(req.user!.id, 'Contest team', `You joined team "${team.name}" for ${c.title}`, `/contests/${c.id}`);
    await logAction(req.user, 'contest.invitation.accept', { type: 'ContestTeamInvitation', id: inv.id }, { contestId: c.id, teamId: team.id }, req);
    emitTo(`contest:${c.id}`, 'scoreboard:update', { contestId: c.id });
    ok(res, await myTeamView(c, req.user!.id), 201);
  }),
);

r.post(
  '/contests/:id/invitations/:invId/decline',
  requireAuth,
  wrap(async (req, res) => {
    const c = await openTeamContest(oid(req.params.id));
    const inv = await answerableInvite(c, oid(req.params.invId), req.user!);
    inv.status = 'declined';
    await inv.save();
    const team = await ContestTeam.findById(inv.teamId);
    if (team) {
      await notify(team.leaderId, 'Contest team', `${req.user!.name} declined your invitation to team "${team.name}"`, `/contests/${c.id}`);
      await notify(req.user!.id, 'Contest team', `You declined the invitation to team "${team.name}"`, `/contests/${c.id}`);
    }
    await logAction(req.user, 'contest.invitation.decline', { type: 'ContestTeamInvitation', id: inv.id }, { contestId: c.id, teamId: String(inv.teamId) }, req);
    ok(res, { _id: inv.id, status: inv.status });
  }),
);

r.get(
  '/contests/:id/teams',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    // everyone sees registered teams; organisers / coordinators also see drafts (flagged)
    const seeDrafts = hasRole(req.user, 'organiser', 'coordinator');
    const teams = await ContestTeam.find({ contestId: c._id, ...(seeDrafts ? {} : { registeredAt: { $exists: true, $ne: null } }) }).sort({ createdAt: 1 });
    const regs = await ContestRegistration.find({ contestId: c._id, teamId: { $in: teams.map((t) => t._id) } }).select('userId teamId');
    const people = await User.find({ _id: { $in: regs.map((g) => g.userId) } }).select('name');
    ok(
      res,
      teams.map((t) => ({
        id: t.id,
        name: t.name,
        memberCount: t.memberCount,
        complete: t.memberCount >= (c.teamSize?.min ?? 1),
        registered: !!t.registeredAt,
        members: regs.filter((g) => String(g.teamId) === t.id).map((g) => people.find((p) => p.id === String(g.userId))?.name ?? 'Unknown'),
      })),
    );
  }),
);

r.delete(
  '/contests/:id/teams/:teamId/members/:userId',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    const team = await ContestTeam.findOne({ _id: oid(req.params.teamId), contestId: c._id });
    if (!team) throw notFound('Team not found');
    const target = oid(req.params.userId);
    const self = target === req.user!.id;
    const isLeader = String(team.leaderId) === req.user!.id;
    if (!self && !isLeader && !hasRole(req.user, 'organiser')) throw forbidden('Only the team leader can remove a member');
    if (String(team.leaderId) === target) throw unprocessable('The team leader cannot be removed. Disband the team instead.');
    if (compositionLocked(c, req.user!)) throw unprocessable('Teams are locked once the contest has started');
    if (!hasRole(req.user, 'organiser') && !removalKeepsMinimum(team, c.teamSize?.min ?? 1))
      throw unprocessable(`Your team is registered and needs at least ${c.teamSize?.min ?? 1} members. Cancel the team registration first if you want to remove someone`);
    const del = await ContestRegistration.deleteOne({ contestId: c._id, teamId: team._id, userId: target });
    if (!del.deletedCount) throw notFound('That person is not on this team');
    await ContestTeam.updateOne({ _id: team._id }, { $inc: { memberCount: -1 } });
    await audit(req.user!.id, 'contest.team.remove', 'ContestTeam', team.id, { member: target });
    emitTo(`contest:${c.id}`, 'scoreboard:update', { contestId: c.id });
    ok(res, { removed: true });
  }),
);

r.delete(
  '/contests/:id/teams/:teamId',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    const team = await ContestTeam.findOne({ _id: oid(req.params.teamId), contestId: c._id });
    if (!team) throw notFound('Team not found');
    if (String(team.leaderId) !== req.user!.id && !hasRole(req.user, 'organiser')) throw forbidden('Only the team leader can disband the team');
    if (compositionLocked(c, req.user!)) throw unprocessable('Teams are locked once the contest has started');
    await ContestRegistration.deleteMany({ contestId: c._id, teamId: team._id });
    await ContestTeam.deleteOne({ _id: team._id });
    await ContestTeamInvitation.deleteMany({ teamId: team._id });
    await audit(req.user!.id, 'contest.team.disband', 'ContestTeam', team.id);
    emitTo(`contest:${c.id}`, 'scoreboard:update', { contestId: c.id });
    ok(res, { deleted: true });
  }),
);

r.get(
  '/contests/:id/problems',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    const priv =
      hasRole(req.user, 'organiser') ||
      (hasRole(req.user, 'judge') && !!(await Problem.exists({ _id: { $in: c.problems.map((p) => p.problemId) }, authorId: req.user!.id })));
    if (!priv) {
      if (new Date() < c.startAt) throw forbidden('The contest has not started yet');
      if (!(await isRegistered(c, req.user!.id)) && new Date() < c.endAt)
        throw forbidden(modeOf(c) === 'TEAM' ? 'Your team must be registered to see the problems' : 'Register for the contest to see its problems');
    }
    const ps = await Problem.find({ _id: { $in: c.problems.map((p) => p.problemId) } });
    ok(
      res,
      c.problems.map((cp) => ({ label: cp.label, ...participantProblem(ps.find((p) => p.id === String(cp.problemId))!) })),
    );
  }),
);

// ---------------- submissions ----------------
const submitSchema = z.object({
  problemId: z.string().optional(),
  language: z.enum(LANGUAGES),
  code: z.string().min(1).max(65536),
  idempotencyKey: z.string().max(100).optional(),
});

async function createSubmission(opts: {
  userId: string;
  problemId: string;
  contestId?: string;
  mode: 'contest' | 'practice';
  language: string;
  code: string;
  idempotencyKey?: string;
}) {
  const key = crypto
    .createHash('sha256')
    .update(`${opts.userId}:${opts.idempotencyKey ?? crypto.randomUUID()}`)
    .digest('hex');
  try {
    const s = await Submission.create({
      userId: opts.userId,
      problemId: opts.problemId,
      contestId: opts.contestId,
      mode: opts.mode,
      language: opts.language,
      code: opts.code,
      judgeJobKey: key,
      status: 'queued',
      submittedAt: new Date(),
    });
    enqueue(s.id);
    return { sub: s, duplicate: false };
  } catch (e) {
    if ((e as { code?: number }).code === 11000) {
      const existing = await Submission.findOne({ judgeJobKey: key });
      if (existing) return { sub: existing, duplicate: true };
    } // retry-safe: same key, same logical submission
    throw e;
  }
}
const subView = (s: InstanceType<typeof Submission>, staff: boolean) => ({
  id: s.id,
  problemId: s.problemId,
  contestId: s.contestId,
  mode: s.mode,
  language: s.language,
  status: s.status,
  submittedAt: s.submittedAt,
  timeMs: s.timeMs,
  memoryKb: s.memoryKb,
  ...(staff ? { failedTest: s.failedTest, userId: s.userId, attempts: s.attempts } : {}),
});

r.post(
  '/contests/:id/submissions',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    const b = parse(submitSchema, req.body);
    if (!b.problemId) throw unprocessable('problemId is required');
    const now = new Date(); // contest timing is always judged on the SERVER clock
    if (now < c.startAt) throw new AppError(422, 'CONTEST_NOT_RUNNING', 'The contest has not started yet');
    if (now >= c.endAt) throw new AppError(422, 'CONTEST_NOT_RUNNING', 'The contest has ended; use practice mode instead');
    const mine = await ContestRegistration.findOne({ contestId: c._id, userId: req.user!.id });
    if (!mine) throw forbidden('You are not registered for this contest');
    if (modeOf(c) === 'TEAM') {
      const team = mine.teamId ? await ContestTeam.findById(mine.teamId) : null;
      if (!team) throw forbidden('You are not on a team in this contest');
      if (!team.registeredAt) throw forbidden('Your team is not registered yet. The team leader must register it before you can submit');
      const min = c.teamSize?.min ?? 1;
      if (team.memberCount < min) throw unprocessable(`Your team needs at least ${min} members before it can submit (it has ${team.memberCount})`);
    }
    if (!c.problems.some((p) => String(p.problemId) === b.problemId)) throw unprocessable('That problem is not part of this contest');
    const problem = await Problem.findById(b.problemId);
    if (!problem || !problem.languages.includes(b.language)) throw unprocessable('That language is not allowed for this problem');
    const cooldown = c.cooldownSec ?? env.submissionCooldownSec;
    const last = await Submission.findOne({ userId: req.user!.id, contestId: c._id }).sort({ submittedAt: -1 }).select('submittedAt');
    if (last && cooldown > 0 && now.getTime() - last.submittedAt.getTime() < cooldown * 1000)
      throw new AppError(429, 'COOLDOWN', `Please wait ${Math.ceil(cooldown - (now.getTime() - last.submittedAt.getTime()) / 1000)}s before submitting again`);
    const { sub, duplicate } = await createSubmission({
      userId: req.user!.id,
      problemId: b.problemId,
      contestId: c.id,
      mode: 'contest',
      language: b.language,
      code: b.code,
      idempotencyKey: b.idempotencyKey,
    });
    ok(res, subView(sub, false), duplicate ? 200 : 202);
  }),
);

/** Contest problem label (A, B, C...) and title for each problem id, so submission lists never show a raw id. */
async function problemLabels(c: ContestDoc) {
  const ps = await Problem.find({ _id: { $in: c.problems.map((p) => p.problemId) } }).select('title');
  const title = new Map(ps.map((p) => [p.id, p.title]));
  return new Map(c.problems.map((p) => [String(p.problemId), { label: p.label ?? '', title: title.get(String(p.problemId)) ?? '' }]));
}

r.get(
  '/contests/:id/submissions/me',
  requireAuth,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    const labels = await problemLabels(c);
    const subs = await Submission.find({ contestId: c._id, userId: req.user!.id }).sort({ submittedAt: -1 }).limit(100);
    ok(
      res,
      subs.map((s) => ({ ...subView(s, false), problemLabel: labels.get(String(s.problemId))?.label ?? null, problemTitle: labels.get(String(s.problemId))?.title ?? null })),
    );
  }),
);
r.get(
  '/contests/:id/submissions',
  requireAuth,
  setter,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    const labels = await problemLabels(c);
    const subs = await Submission.find({ contestId: c._id }).sort({ submittedAt: -1 }).limit(500);
    const people = await User.find({ _id: { $in: [...new Set(subs.map((s) => String(s.userId)))] } }).select('name');
    const nameOf = new Map(people.map((u) => [u.id, u.name]));
    ok(
      res,
      subs.map((s) => ({
        ...subView(s, true),
        problemLabel: labels.get(String(s.problemId))?.label ?? null,
        problemTitle: labels.get(String(s.problemId))?.title ?? null,
        userName: nameOf.get(String(s.userId)) ?? null,
      })),
    );
  }),
);

/**
 * Organiser / coordinator: who registered for this contest (same idea as the event registration list).
 * INDIVIDUAL: one row per person. TEAM: one row per team with its members; draft teams (not registered yet) are listed but flagged.
 */
r.get(
  '/contests/:id/registrations',
  requireAuth,
  requireRole('organiser', 'coordinator'),
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    const regs = await ContestRegistration.find({ contestId: c._id }).sort({ createdAt: 1 });
    const people = await User.find({ _id: { $in: regs.map((g) => g.userId) } }).select('name email department batch');
    const person = new Map(people.map((u) => [u.id, u]));
    const who = (userId: unknown, leaderId?: unknown) => {
      const u = person.get(String(userId));
      return { userId: String(userId), name: u?.name ?? 'Unknown', email: u?.email ?? '', department: u?.department ?? '', batch: u?.batch ?? '', isLeader: leaderId ? String(userId) === String(leaderId) : false };
    };
    if (modeOf(c) !== 'TEAM') {
      const rows = regs.map((g) => ({ id: g.id, kind: 'individual' as const, status: 'registered' as const, registeredAt: (g as unknown as { createdAt: Date }).createdAt, ...who(g.userId) }));
      return ok(res, { mode: 'INDIVIDUAL', rows, summary: { registered: rows.length, draftTeams: 0 } });
    }
    const teams = await ContestTeam.find({ contestId: c._id }).sort({ createdAt: 1 });
    const min = c.teamSize?.min ?? 1;
    const rows = teams.map((t) => ({
      id: t.id,
      kind: 'team' as const,
      name: t.name,
      status: t.registeredAt ? ('registered' as const) : ('draft' as const),
      registeredAt: t.registeredAt ?? null,
      createdAt: (t as unknown as { createdAt: Date }).createdAt,
      memberCount: t.memberCount,
      minSize: min,
      maxSize: c.teamSize?.max ?? 3,
      members: regs.filter((g) => String(g.teamId) === t.id).map((g) => who(g.userId, t.leaderId)),
    }));
    ok(res, { mode: 'TEAM', rows, summary: { registered: rows.filter((x) => x.status === 'registered').length, draftTeams: rows.filter((x) => x.status === 'draft').length } });
  }),
);

r.get(
  '/submissions/:id',
  requireAuth,
  wrap(async (req, res) => {
    const s = await Submission.findById(oid(req.params.id));
    if (!s) throw notFound('Submission not found');
    const staff = hasRole(req.user, 'organiser', 'judge');
    if (String(s.userId) !== req.user!.id && !staff) throw notFound('Submission not found');
    ok(res, subView(s, staff && String(s.userId) !== req.user!.id));
  }),
);

r.post(
  '/submissions/:id/rejudge',
  requireAuth,
  setter,
  wrap(async (req, res) => {
    const sid = oid(req.params.id);
    const upd = await Submission.updateOne(
      { _id: sid, status: { $in: ['AC', 'WA', 'TLE', 'RE', 'CE', 'JE'] } },
      { $set: { status: 'queued', attempts: 0 }, $unset: { failedTest: 1, judgedAt: 1 } },
    );
    if (!upd.matchedCount) throw conflict('Only finished submissions can be rejudged');
    const s = (await Submission.findById(sid))!;
    await audit(req.user!.id, 'submission.rejudge', 'Submission', s.id);
    enqueue(s.id);
    ok(res, subView(s, true), 202);
  }),
);

// ---------------- judge language check ----------------
/** Organisers: compare the language ids FestHub will send with what the configured Judge0 really offers (catches wrong ids before a contest). */
r.get(
  '/judge/languages',
  requireAuth,
  organiser,
  wrap(async (_req, res) => {
    const ids = languageIds();
    let available: { id: number; name: string }[] | null = null;
    let problem: string | null = null;
    try {
      available = await fetchJudge0Languages();
    } catch (e) {
      problem = (e as Error).message;
    }
    ok(
      res,
      LANGUAGES.map((l) => {
        const hit = available?.find((a) => a.id === ids[l]);
        return { language: l, judge0Id: ids[l], judge0Name: hit?.name ?? null, verified: !!hit };
      }),
      200,
      { judge0Reachable: !problem, ...(problem ? { problem } : {}) },
    );
  }),
);

// ---------------- scoreboard ----------------
r.get(
  '/contests/:id/scoreboard',
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    ok(res, await buildScoreboard(c, { privileged: false })); // freeze ALWAYS applied here, for everyone
  }),
);
r.get(
  '/contests/:id/scoreboard/full',
  requireAuth,
  setter,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    ok(res, await buildScoreboard(c, { privileged: true }));
  }),
);
r.post(
  '/contests/:id/reveal',
  requireAuth,
  organiser,
  wrap(async (req, res) => {
    const c = await Contest.findById(oid(req.params.id));
    if (!c) throw notFound('Contest not found');
    if (new Date() < c.endAt) throw unprocessable('The scoreboard can only be revealed after the contest ends');
    c.revealed = true;
    await c.save();
    await audit(req.user!.id, 'contest.reveal', 'Contest', c.id);
    emitTo(`contest:${c.id}`, 'scoreboard:update', { contestId: c.id });
    ok(res, { revealed: true });
  }),
);

// ---------------- practice, editorials, progress ----------------
r.post(
  '/problems/:id/practice-submissions',
  requireAuth,
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const p = await Problem.findById(id);
    if (!p || p.visibility !== 'public' || !(await problemIsReleased(id))) throw notFound('Problem not available for practice'); // blocks practice during any unfinished contest
    const b = parse(submitSchema, req.body);
    if (!p.languages.includes(b.language)) throw unprocessable('That language is not allowed for this problem');
    const last = await Submission.findOne({ userId: req.user!.id, mode: 'practice' }).sort({ submittedAt: -1 }).select('submittedAt');
    if (last && Date.now() - last.submittedAt.getTime() < Math.min(env.submissionCooldownSec, 5) * 1000)
      throw new AppError(429, 'COOLDOWN', 'You are submitting too quickly');
    const { sub, duplicate } = await createSubmission({
      userId: req.user!.id,
      problemId: id,
      mode: 'practice',
      language: b.language,
      code: b.code,
      idempotencyKey: b.idempotencyKey,
    });
    ok(res, subView(sub, false), duplicate ? 200 : 202);
  }),
);

r.get(
  '/me/submissions',
  requireAuth,
  wrap(async (req, res) => {
    const f: Record<string, unknown> = { userId: req.user!.id };
    if (req.query.mode === 'practice' || req.query.mode === 'contest') f.mode = req.query.mode;
    if (req.query.problemId) f.problemId = oid(req.query.problemId);
    const subs = await Submission.find(f).sort({ submittedAt: -1 }).limit(100);
    const ps = await Problem.find({ _id: { $in: subs.map((s) => s.problemId) } }).select('title');
    ok(
      res,
      subs.map((s) => ({ ...subView(s, false), problemTitle: ps.find((p) => p.id === String(s.problemId))?.title })),
    );
  }),
);

r.get(
  '/me/progress',
  requireAuth,
  wrap(async (req, res) => {
    const subs = await Submission.find({ userId: req.user!.id }).select('problemId status mode');
    const ps = await Problem.find({ _id: { $in: [...new Set(subs.map((s) => String(s.problemId)))] } }).select('tags difficulty');
    ok(
      res,
      computeProgress(
        subs.map((s) => ({ problemId: String(s.problemId), status: s.status, mode: s.mode })),
        ps.map((p) => ({ id: p.id, tags: p.tags, difficulty: p.difficulty })),
      ),
    );
  }),
);

r.put(
  '/problems/:id/editorial',
  requireAuth,
  setter,
  wrap(async (req, res) => {
    const p = await ownProblem(oid(req.params.id), req.user!);
    const b = parse(z.object({ content: z.string().trim().min(10).max(30000), releaseAt: z.coerce.date().optional() }), req.body);
    const e = await Editorial.findOneAndUpdate({ problemId: p._id }, { $set: { ...b, authorId: req.user!.id } }, { upsert: true, new: true });
    await audit(req.user!.id, 'editorial.save', 'Problem', p.id);
    ok(res, e);
  }),
);

r.get(
  '/problems/:id/editorial',
  requireAuth,
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const p = await Problem.findById(id);
    if (!p) throw notFound('Problem not found');
    const e = await Editorial.findOne({ problemId: id });
    const isOwner = hasRole(req.user, 'organiser') || String(p.authorId) === req.user!.id;
    if (!e) throw notFound('No editorial has been published for this problem');
    if (!isOwner) {
      const released = (await problemIsReleased(id)) && (!e.releaseAt || new Date() >= e.releaseAt) && p.visibility === 'public';
      if (!released) throw new AppError(403, 'EDITORIAL_LOCKED', 'The editorial is released after the contest ends');
    }
    ok(res, { content: e.content, releaseAt: e.releaseAt });
  }),
);

export default r;
