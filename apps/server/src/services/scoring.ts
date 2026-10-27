/**
 * ICPC-style scoring (documented rule)
 * - Only AC, WA, TLE, RE count. CE, JE (judge error), queued and running never count as attempts.
 * - For each problem, only submissions up to and including the FIRST AC matter; later ones are ignored.
 * - Penalty for a solved problem = floor(minutes from contest start to the first AC) + penaltyMinutes * (counted wrong attempts before it).
 * - Unsolved problems add no penalty.
 * - Rank: more solved first, then lower total penalty, then earlier time of last accepted solution.
 *   Teams equal on all three share the same rank.
 */
export type CountedStatus = 'AC' | 'WA' | 'TLE' | 'RE';
export interface ScoreSub {
  userId: string;
  problemId: string;
  status: string;
  submittedAt: Date;
}
export interface ProblemCell {
  problemId: string;
  solved: boolean;
  wrong: number;
  solvedAtMin?: number;
  pending: number;
}
export interface StandingRow {
  userId: string;
  rank: number;
  solved: number;
  penalty: number;
  lastAcceptedMin: number;
  cells: ProblemCell[];
}
const COUNTED = new Set(['AC', 'WA', 'TLE', 'RE']);

export interface StandingsOptions {
  startAt: Date;
  penaltyMinutes: number;
  problemIds: string[];
  userIds?: string[];
  /** Submissions at or after this instant are hidden from solved/penalty and shown only as `pending` counts. */
  cutoff?: Date | null;
  endAt?: Date;
}

export function computeStandings(subs: ScoreSub[], o: StandingsOptions): StandingRow[] {
  const users = new Set<string>(o.userIds ?? []);
  for (const s of subs) users.add(s.userId);
  const byUser = new Map<string, ScoreSub[]>();
  for (const s of subs) {
    if (o.endAt && s.submittedAt.getTime() > o.endAt.getTime()) continue; // after contest end never counts
    if (s.submittedAt.getTime() < o.startAt.getTime()) continue; // before start never counts
    (byUser.get(s.userId) ?? byUser.set(s.userId, []).get(s.userId)!).push(s);
  }
  const rows: Omit<StandingRow, 'rank'>[] = [];
  for (const userId of users) {
    const mine = (byUser.get(userId) ?? []).sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
    let solved = 0,
      penalty = 0,
      last = 0;
    const cells: ProblemCell[] = o.problemIds.map((pid) => {
      const ps = mine.filter((s) => s.problemId === pid);
      const visible = o.cutoff ? ps.filter((s) => s.submittedAt.getTime() < o.cutoff!.getTime()) : ps;
      const hidden = o.cutoff ? ps.filter((s) => s.submittedAt.getTime() >= o.cutoff!.getTime()) : [];
      let wrong = 0;
      for (const s of visible) {
        if (!COUNTED.has(s.status)) continue;
        if (s.status === 'AC') {
          const min = Math.floor((s.submittedAt.getTime() - o.startAt.getTime()) / 60000);
          solved += 1;
          penalty += min + o.penaltyMinutes * wrong;
          last = Math.max(last, min);
          return { problemId: pid, solved: true, wrong, solvedAtMin: min, pending: hidden.length };
        }
        wrong += 1;
      }
      return { problemId: pid, solved: false, wrong, pending: hidden.length };
    });
    rows.push({ userId, solved, penalty, lastAcceptedMin: last, cells });
  }
  rows.sort((a, b) => b.solved - a.solved || a.penalty - b.penalty || a.lastAcceptedMin - b.lastAcceptedMin);
  const out: StandingRow[] = [];
  rows.forEach((r, i) => {
    const p = out[i - 1];
    const tie = p && p.solved === r.solved && p.penalty === r.penalty && p.lastAcceptedMin === r.lastAcceptedMin;
    out.push({ ...r, rank: tie ? p.rank : i + 1 });
  });
  return out;
}

export interface ProblemStat {
  problemId: string;
  solvedBy: number;
  /** Counted attempts (AC, WA, TLE, RE) by everybody, up to and including each subject's first AC. */
  attempts: number;
  /** Earliest accepted minute across all subjects, or null when nobody solved it yet. */
  firstSolvedAtMin: number | null;
}
/** Per-problem totals for the scoreboard footer and the "first to solve" marker. Computed from rows that already honour the freeze. */
export function problemStats(rows: StandingRow[], problemIds: string[]): ProblemStat[] {
  return problemIds.map((pid) => {
    let solvedBy = 0,
      attempts = 0,
      first: number | null = null;
    for (const r of rows) {
      const c = r.cells.find((x) => x.problemId === pid);
      if (!c) continue;
      attempts += c.wrong + (c.solved ? 1 : 0);
      if (c.solved) {
        solvedBy += 1;
        first = first === null ? c.solvedAtMin! : Math.min(first, c.solvedAtMin!);
      }
    }
    return { problemId: pid, solvedBy, attempts, firstSolvedAtMin: first };
  });
}

export interface FreezeConfig {
  freezeAt?: Date | null;
  endAt: Date;
  revealAt?: Date | null;
  revealed?: boolean;
}
/** Returns the cutoff instant that applies to non-privileged viewers, or null when the board is fully visible. */
export function scoreboardCutoff(c: FreezeConfig, now: Date): Date | null {
  if (!c.freezeAt || c.revealed) return null;
  const unfreezeAt = c.revealAt ?? c.endAt;
  if (now.getTime() >= c.freezeAt.getTime() && now.getTime() < unfreezeAt.getTime()) return c.freezeAt;
  return null;
}
