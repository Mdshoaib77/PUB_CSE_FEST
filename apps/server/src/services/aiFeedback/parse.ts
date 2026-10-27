import { blankScores, clamp, computeTotals, type CriterionScore, type RubricCriterion, type Totals } from './rubric';

/** S13: safe parsing of the model's reply. Never throws; always returns a usable (possibly empty) structure plus warnings. */
export interface ParsedFeedback {
  ok: boolean; // false = nothing usable could be read (caller keeps an empty draft and shows the warnings)
  strengths: string[]; issues: string[]; suggestions: string[];
  quality: { rating: number | null; summary: string };
  complexity: { time: string; space: string; notes: string };
  criterionScores: CriterionScore[];
  total: Totals;
  warnings: string[];
}

const str = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : typeof v === 'number' ? String(v) : '');
const list = (v: unknown, max = 12, n = 600): string[] => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []).map((x) => str(x, n)).filter(Boolean).slice(0, max);

/** Finds the first balanced {...} (string/escape aware) so fences, prose before/after, or trailing text do not break parsing. */
export function extractJsonObject(text: string): string | null {
  const s = text.replace(/^\uFEFF/, '');
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        const cand = s.slice(start, i + 1);
        try { JSON.parse(cand); return cand; } catch { break; } // not valid JSON from this start: try the next '{'
      }
    }
  }
  return null;
}

export function parseFeedbackResponse(raw: unknown, criteria: RubricCriterion[]): ParsedFeedback {
  const warnings: string[] = [];
  const empty = (): ParsedFeedback => {
    const criterionScores = blankScores(criteria);
    return { ok: false, strengths: [], issues: [], suggestions: [], quality: { rating: null, summary: '' }, complexity: { time: '', space: '', notes: '' }, criterionScores, total: computeTotals(criterionScores), warnings };
  };
  if (typeof raw !== 'string' || !raw.trim()) { warnings.push('The AI returned an empty reply.'); return empty(); }
  const json = extractJsonObject(raw);
  if (!json) { warnings.push('The AI reply was not valid JSON.'); return empty(); }
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(json) as Record<string, unknown>; } catch { warnings.push('The AI reply was not valid JSON.'); return empty(); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { warnings.push('The AI reply had an unexpected shape.'); return empty(); }

  const q = (obj.quality && typeof obj.quality === 'object' ? obj.quality : {}) as Record<string, unknown>;
  const rawRating = typeof obj.quality === 'number' ? obj.quality : Number(q.rating);
  const rating = Number.isFinite(rawRating) ? Math.round(clamp(rawRating, 1, 10)) : null;
  if (rating === null) warnings.push('No quality rating in the reply.');
  const c = (obj.complexity && typeof obj.complexity === 'object' ? obj.complexity : {}) as Record<string, unknown>;
  const complexity = typeof obj.complexity === 'string' ? { time: '', space: '', notes: str(obj.complexity, 600) } : { time: str(c.time, 120), space: str(c.space, 120), notes: str(c.notes, 600) };

  const byKey = new Map<string, Record<string, unknown>>();
  const arr = Array.isArray(obj.criteria) ? obj.criteria : Array.isArray(obj.criterionScores) ? obj.criterionScores : [];
  for (const it of arr) if (it && typeof it === 'object') { const k = str((it as Record<string, unknown>).key, 60); if (k && !byKey.has(k)) byKey.set(k, it as Record<string, unknown>); }
  const criterionScores = criteria.map((cr) => {
    const it = byKey.get(cr.key);
    const sc = it ? Number(it.score) : NaN;
    if (!it || !Number.isFinite(sc)) { warnings.push(`No score for "${cr.name}": set to 0, please review.`); return { key: cr.key, name: cr.name, maxPoints: cr.maxPoints, weight: cr.weight, score: 0, comment: it ? str(it.comment, 600) : '' }; }
    if (sc < 0 || sc > cr.maxPoints) warnings.push(`Score for "${cr.name}" was out of range and was clamped.`);
    return { key: cr.key, name: cr.name, maxPoints: cr.maxPoints, weight: cr.weight, score: Math.round(clamp(sc, 0, cr.maxPoints) * 10) / 10, comment: str(it.comment, 600) };
  });
  const out = { strengths: list(obj.strengths), issues: list(obj.issues), suggestions: list(obj.suggestions) };
  const usable = out.strengths.length + out.issues.length + out.suggestions.length > 0 || rating !== null || byKey.size > 0;
  if (!usable) warnings.push('The AI reply had none of the expected fields.');
  return { ok: usable, ...out, quality: { rating, summary: str(q.summary, 600) }, complexity, criterionScores, total: computeTotals(criterionScores), warnings };
}
