/** S13: pure rubric helpers (no I/O). Criteria normalisation and score totals; used by routes, parser and tests. */
export interface RubricCriterion { key: string; name: string; description?: string; maxPoints: number; weight: number }
export interface CriterionScore { key: string; name: string; maxPoints: number; weight: number; score: number; comment: string }
export interface Totals { points: number; maxPoints: number; percent: number }

const round1 = (n: number) => Math.round(n * 10) / 10;
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const slugKey = (name: string, i: number) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'criterion'}_${i + 1}`;

/** Gives every criterion a stable unique key (kept when already present and unique) and clamps numbers. */
export function normalizeCriteria(input: { key?: string; name: string; description?: string; maxPoints: number; weight?: number }[]): RubricCriterion[] {
  const seen = new Set<string>();
  return input.map((c, i) => {
    let key = c.key && /^[a-z0-9_]{1,40}$/.test(c.key) && !seen.has(c.key) ? c.key : slugKey(c.name, i);
    while (seen.has(key)) key = `${key}x`;
    seen.add(key);
    const w = Number.isFinite(c.weight) ? (c.weight as number) : 1;
    return { key, name: c.name.trim().slice(0, 80), description: c.description?.trim().slice(0, 300) || undefined, maxPoints: clamp(Number(c.maxPoints) || 1, 1, 1000), weight: clamp(w, 0, 100) };
  });
}

/** raw points, raw max, and weighted percent (each criterion's share = score/max x weight; weights of 0 are ignored; no criteria -> 0). */
export function computeTotals(scores: Pick<CriterionScore, 'maxPoints' | 'weight' | 'score'>[]): Totals {
  let points = 0, max = 0, wSum = 0, wAcc = 0;
  for (const s of scores) {
    const m = s.maxPoints > 0 ? s.maxPoints : 0;
    const sc = clamp(Number.isFinite(s.score) ? s.score : 0, 0, m);
    points += sc; max += m;
    if (m > 0 && s.weight > 0) { wSum += s.weight; wAcc += (sc / m) * s.weight; }
  }
  return { points: round1(points), maxPoints: round1(max), percent: wSum > 0 ? round1((wAcc / wSum) * 100) : max > 0 ? round1((points / max) * 100) : 0 };
}

/** Blank per-criterion rows for a rubric (score 0). */
export const blankScores = (criteria: RubricCriterion[]): CriterionScore[] => criteria.map((c) => ({ key: c.key, name: c.name, maxPoints: c.maxPoints, weight: c.weight, score: 0, comment: '' }));
