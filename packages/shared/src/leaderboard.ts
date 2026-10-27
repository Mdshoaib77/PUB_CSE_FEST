/**
 * S15 leaderboard scoring. Pure functions (no Node/DOM/DB), shared by server and web.
 *
 *   base    = judge% x wJ + ai% x wA                 (weights re-normalised over the components a participant actually has)
 *   penalty = min(maxPenalty, confirmedPairs x penaltyPerPair)   (confirmed plagiarism only; "suspicious" never counts)
 *   final   = clamp(base - penalty, 0, 100)           (rounded to 2 decimals)
 *
 * Ranking: highest final first; equal finals are split by the configured tie-break (judge | ai | none); anything still equal
 * SHARES a rank and the next rank is skipped (1, 2, 2, 4). Participants with no score at all are listed last, unranked.
 */

export const TIE_BREAKS = ['judge', 'ai', 'none'] as const;
export type TieBreak = (typeof TIE_BREAKS)[number];

export interface LeaderboardConfig {
  /** Relative weight of the judge score (0..100). Only the ratio to `aiWeight` matters. */
  judgeWeight: number;
  /** Relative weight of the AI-suggested score (0..100). */
  aiWeight: number;
  /** Points removed from the final score per confirmed plagiarism pair the participant is part of. */
  penaltyPerPair: number;
  /** Upper limit of the total penalty. */
  maxPenalty: number;
  tieBreak: TieBreak;
}

export const DEFAULT_LEADERBOARD_CONFIG: LeaderboardConfig = { judgeWeight: 70, aiWeight: 30, penaltyPerPair: 10, maxPenalty: 50, tieBreak: 'judge' };

export interface LeaderboardInput {
  /** Stable id: `u:<userId>` or `t:<teamId>`. */
  key: string;
  name: string;
  /** Mean judge score in percent (0..100), null when no judge has scored this participant. */
  judgePercent: number | null;
  /** Mean AI-suggested score in percent (0..100), null when there is none. */
  aiPercent: number | null;
  /** Number of CONFIRMED plagiarism pairs this participant is part of. */
  confirmedPairs: number;
}

export interface LeaderboardRow extends LeaderboardInput {
  /** Weight share actually used (0..1); 0 when that component is missing. */
  judgeShare: number;
  aiShare: number;
  /** Points each component adds to `base`. */
  judgePoints: number | null;
  aiPoints: number | null;
  /** Weighted score before the penalty (null = unscored). */
  base: number | null;
  /** Points removed (0 when none). */
  penalty: number;
  /** Final score (null = unscored). */
  final: number | null;
  /** Competition rank (ties share it); null for unscored participants. */
  rank: number | null;
  /** Another participant has the same rank. */
  tied: boolean;
  /** This participant was separated from the one above by the tie-break (same final score, different rank). */
  brokeTie: boolean;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const clampPct = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null);

/** Returns a list of human-readable problems (empty = valid). */
export function validateLeaderboardConfig(c: Partial<LeaderboardConfig>): string[] {
  const errs: string[] = [];
  const num = (k: keyof LeaderboardConfig, min: number, max: number, label: string) => {
    const v = c[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) errs.push(`${label} must be a number from ${min} to ${max}`);
  };
  num('judgeWeight', 0, 100, 'Judge weight');
  num('aiWeight', 0, 100, 'AI weight');
  num('penaltyPerPair', 0, 100, 'Penalty per confirmed pair');
  num('maxPenalty', 0, 100, 'Maximum penalty');
  if (!TIE_BREAKS.includes(c.tieBreak as TieBreak)) errs.push(`Tie-break must be one of ${TIE_BREAKS.join(', ')}`);
  if (!errs.length && c.judgeWeight === 0 && c.aiWeight === 0) errs.push('At least one of the judge weight and the AI weight must be above 0');
  return errs;
}

/** Fill gaps with the defaults; does not validate (use validateLeaderboardConfig). */
export const withDefaults = (c: Partial<LeaderboardConfig> = {}): LeaderboardConfig => ({ ...DEFAULT_LEADERBOARD_CONFIG, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) });

/** Score one participant (no ranking). Exported so the UI/tests can show the exact arithmetic. */
export function scoreParticipant(input: LeaderboardInput, cfg: LeaderboardConfig): Omit<LeaderboardRow, 'rank' | 'tied' | 'brokeTie'> {
  const judge = clampPct(input.judgePercent);
  const ai = clampPct(input.aiPercent);
  const wJ = judge === null ? 0 : cfg.judgeWeight;
  const wA = ai === null ? 0 : cfg.aiWeight;
  const sum = wJ + wA;
  const judgeShare = sum > 0 ? wJ / sum : 0;
  const aiShare = sum > 0 ? wA / sum : 0;
  // a participant who has components but whose only available one has weight 0 counts as unscored (nothing to base a rank on)
  const base = sum > 0 ? (judge !== null ? judge * judgeShare : 0) + (ai !== null ? ai * aiShare : 0) : null;
  const pairs = Math.max(0, Math.floor(Number.isFinite(input.confirmedPairs) ? input.confirmedPairs : 0));
  const penalty = base === null ? 0 : r2(Math.min(cfg.maxPenalty, pairs * cfg.penaltyPerPair));
  const final = base === null ? null : r2(Math.min(100, Math.max(0, r2(base) - penalty)));
  return {
    ...input,
    judgePercent: judge,
    aiPercent: ai,
    confirmedPairs: pairs,
    judgeShare: Math.round(judgeShare * 10000) / 10000,
    aiShare: Math.round(aiShare * 10000) / 10000,
    judgePoints: judge !== null && judgeShare > 0 ? r2(judge * judgeShare) : judge !== null ? 0 : null,
    aiPoints: ai !== null && aiShare > 0 ? r2(ai * aiShare) : ai !== null ? 0 : null,
    base: base === null ? null : r2(base),
    penalty,
    final,
  };
}

/**
 * Score and rank everyone. Deterministic: the output order never depends on the input order
 * (ties keep alphabetical order by name, then key). Throws RangeError for an invalid config.
 */
export function computeLeaderboard(inputs: readonly LeaderboardInput[], config: Partial<LeaderboardConfig> = {}): LeaderboardRow[] {
  const cfg = withDefaults(config);
  const errs = validateLeaderboardConfig(cfg);
  if (errs.length) throw new RangeError(errs.join('; '));
  const tb = (x: { judgePercent: number | null; aiPercent: number | null }): number => (cfg.tieBreak === 'judge' ? (x.judgePercent ?? -1) : cfg.tieBreak === 'ai' ? (x.aiPercent ?? -1) : 0);
  const scored = inputs.map((i) => scoreParticipant(i, cfg));
  const byName = (a: { name: string; key: string }, b: { name: string; key: string }) => a.name.localeCompare(b.name) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const ranked = scored.filter((s) => s.final !== null).sort((a, b) => b.final! - a.final! || r2(tb(b)) - r2(tb(a)) || byName(a, b));
  const unranked = scored.filter((s) => s.final === null).sort(byName);
  const rows: LeaderboardRow[] = [];
  let rank = 0;
  ranked.forEach((s, i) => {
    const prev = ranked[i - 1];
    const sameFinal = !!prev && prev.final === s.final;
    const sameAll = sameFinal && r2(tb(prev!)) === r2(tb(s));
    if (!sameAll) rank = i + 1;
    rows.push({ ...s, rank, tied: false, brokeTie: sameFinal && !sameAll });
  });
  const count = new Map<number, number>();
  rows.forEach((x) => count.set(x.rank!, (count.get(x.rank!) ?? 0) + 1));
  rows.forEach((x) => (x.tied = (count.get(x.rank!) ?? 0) > 1));
  for (const s of unranked) rows.push({ ...s, rank: null, tied: false, brokeTie: false });
  return rows;
}
