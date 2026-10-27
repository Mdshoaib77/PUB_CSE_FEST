import { Contest, ContestRegistration, ContestTeam, Problem, Submission, User } from '../models';
import { computeStandings, problemStats, scoreboardCutoff } from './scoring';
import { registeredTeamIds } from './contest-registration';

type ContestDoc = InstanceType<typeof Contest>;

/**
 * `privileged=false` ALWAYS applies the freeze cutoff regardless of who is asking.
 * INDIVIDUAL contests rank people. TEAM contests (ICPC style) rank teams: every submission is credited to the submitter's team, so wrong
 * attempts and the first AC of a problem are counted once per team, no matter which teammate sent them.
 */
export async function buildScoreboard(contest: ContestDoc, opts: { privileged: boolean; now?: Date }) {
  const now = opts.now ?? new Date();
  const cutoff = opts.privileged ? null : scoreboardCutoff(contest, now);
  const problemIds = contest.problems.map((p) => String(p.problemId));
  const team = contest.mode === 'TEAM';
  // TEAM contests: only REGISTERED teams take part (a draft team has no standing); INDIVIDUAL: every registration row.
  const allRegs = await ContestRegistration.find({ contestId: contest._id });
  const liveTeams = team ? await registeredTeamIds(contest._id) : null;
  const regs = liveTeams ? allRegs.filter((r) => r.teamId && liveTeams.has(String(r.teamId))) : allRegs;
  // Submissions are fetched with the cutoff applied in the standings function; pending counts are only numbers.
  const subs = await Submission.find({ contestId: contest._id, mode: 'contest' }).select('userId problemId status submittedAt');
  const teamOfUser = new Map(regs.filter((r) => r.teamId).map((r) => [String(r.userId), String(r.teamId)]));
  // In TEAM mode the "subject" is the team; a submission from someone who is no longer on any team cannot count for anyone.
  const subjectOf = (userId: string) => (team ? teamOfUser.get(userId) : userId);
  const scored = subs.flatMap((s) => {
    const subject = subjectOf(String(s.userId));
    return subject ? [{ userId: subject, problemId: String(s.problemId), status: s.status, submittedAt: s.submittedAt }] : [];
  });
  const subjectIds = team ? [...new Set(teamOfUser.values())] : regs.map((r) => String(r.userId));
  const rows = computeStandings(scored, { startAt: contest.startAt, endAt: contest.endAt, penaltyMinutes: contest.penaltyMinutes, problemIds, userIds: subjectIds, cutoff });
  const labels = new Map(contest.problems.map((p) => [String(p.problemId), p.label]));

  let nameOf: Map<string, string>;
  const membersOf = new Map<string, string[]>();
  if (team) {
    const teams = await ContestTeam.find({ _id: { $in: rows.map((r) => r.userId) } }).select('name');
    nameOf = new Map(teams.map((t) => [t.id, t.name]));
    const people = await User.find({ _id: { $in: regs.filter((r) => r.teamId).map((r) => r.userId) } }).select('name');
    const personName = new Map(people.map((u) => [u.id, u.name]));
    for (const r of regs) if (r.teamId) (membersOf.get(String(r.teamId)) ?? membersOf.set(String(r.teamId), []).get(String(r.teamId))!).push(personName.get(String(r.userId)) ?? 'Unknown');
  } else {
    const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('name');
    nameOf = new Map(users.map((u) => [u.id, u.name]));
  }
  const stats = problemStats(rows, problemIds);
  const firstAt = new Map(stats.map((x) => [x.problemId, x.firstSolvedAtMin]));
  return {
    contestId: contest.id,
    mode: contest.mode ?? 'INDIVIDUAL',
    frozen: !!cutoff,
    freezeAt: contest.freezeAt ?? null,
    problems: contest.problems.map((p) => ({ problemId: String(p.problemId), label: p.label })),
    stats: stats.map((x) => ({ label: labels.get(x.problemId), solvedBy: x.solvedBy, attempts: x.attempts, firstSolvedAtMin: x.firstSolvedAtMin })),
    rows: rows.map((r) => ({
      rank: r.rank,
      // `userId` is kept for backward compatibility; in TEAM mode it is the team id and `teamId` is set as well.
      userId: r.userId,
      ...(team ? { teamId: r.userId, members: membersOf.get(r.userId) ?? [] } : {}),
      name: nameOf.get(r.userId) ?? 'Unknown',
      solved: r.solved,
      penalty: r.penalty,
      cells: r.cells.map((c) => ({
        label: labels.get(c.problemId),
        solved: c.solved,
        wrong: c.wrong,
        solvedAtMin: c.solvedAtMin,
        pending: c.pending,
        firstSolve: c.solved && c.solvedAtMin === firstAt.get(c.problemId),
      })),
    })),
  };
}

export async function problemIsReleased(problemId: unknown, now = new Date()) {
  // A problem is "released" (practice-eligible) when every contest containing it has ended.
  const open = await Contest.countDocuments({ 'problems.problemId': problemId, endAt: { $gt: now } });
  return open === 0;
}

/** Practice/problem-view rule shared by problem detail, practice submit and editorial. */
export async function canViewProblemStatement(problemId: unknown, user: { id: string; roles: string[] }, now = new Date()) {
  if (user.roles.some((r) => ['organiser', 'judge'].includes(r))) return true;
  const p = await Problem.findById(problemId).select('visibility authorId');
  if (!p) return false;
  // Registered contestants may read problems while their contest is running.
  const running = await Contest.find({ 'problems.problemId': problemId, startAt: { $lte: now }, endAt: { $gt: now } }).select('_id');
  if (running.length) {
    const regs = await ContestRegistration.find({ userId: user.id, contestId: { $in: running.map((c) => c._id) } }).select('teamId');
    if (regs.some((g) => !g.teamId)) return true;
    // a team member only counts once their team is registered
    const teamIds = regs.flatMap((g) => (g.teamId ? [g.teamId] : []));
    if (teamIds.length && (await ContestTeam.exists({ _id: { $in: teamIds }, registeredAt: { $exists: true, $ne: null } }))) return true;
  }
  return p.visibility === 'public' && (await problemIsReleased(problemId, now));
}

export interface ProgressSub {
  problemId: string;
  status: string;
  mode: string;
}
export function computeProgress(subs: ProgressSub[], problems: { id: string; tags: string[]; difficulty: string }[]) {
  const byId = new Map(problems.map((p) => [p.id, p]));
  const attempts = new Map<string, number>();
  const solved = new Set<string>();
  for (const s of subs) {
    if (!byId.has(s.problemId) || ['queued', 'running', 'JE'].includes(s.status)) continue;
    attempts.set(s.problemId, (attempts.get(s.problemId) ?? 0) + 1);
    if (s.status === 'AC') solved.add(s.problemId);
  }
  const topic: Record<string, { attempted: number; solved: number }> = {};
  const diff: Record<string, { attempted: number; solved: number }> = {
    easy: { attempted: 0, solved: 0 },
    medium: { attempted: 0, solved: 0 },
    hard: { attempted: 0, solved: 0 },
  };
  for (const pid of attempts.keys()) {
    const p = byId.get(pid)!;
    const ok = solved.has(pid);
    for (const t of p.tags.length ? p.tags : ['untagged']) {
      topic[t] ??= { attempted: 0, solved: 0 };
      topic[t].attempted++;
      if (ok) topic[t].solved++;
    }
    diff[p.difficulty].attempted++;
    if (ok) diff[p.difficulty].solved++;
  }
  return {
    totalAttempts: [...attempts.values()].reduce((a, b) => a + b, 0),
    problemsAttempted: attempts.size,
    problemsSolved: solved.size,
    topics: topic,
    difficulty: diff,
  };
}
