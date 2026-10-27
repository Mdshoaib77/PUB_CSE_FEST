/**
 * Offline similarity engine (S11): MOSS-style winnowing k-gram fingerprints + token-shingle Jaccard.
 * Pure functions, no I/O. Renamed variables, changed literals, new comments and reformatting do not change the score,
 * because both sides are compared on the normalized token stream from `tokenize()`.
 */
import { tokenize, tokenizeWithLines, type PlagiarismLanguage } from './tokenize';

export interface EngineOptions {
  /** k-gram length in tokens (noise threshold: shared runs shorter than k are ignored). */
  k: number;
  /** winnowing window (a shared run of w+k-1 tokens is guaranteed to share a fingerprint). */
  w: number;
  /** token shingle length for the Jaccard part. */
  shingle: number;
}
export const DEFAULTS: EngineOptions = { k: 5, w: 4, shingle: 3 };
/** Blend: containment of fingerprints (MOSS-like, catches copy + padding) weighs more than raw shingle Jaccard. */
export const WEIGHT_WINNOW = 0.7;
export const WEIGHT_JACCARD = 0.3;

/** 32-bit FNV-1a over the joined tokens. Deterministic across runs (never use Math.random / Map order). */
function fnv(tokens: string[], from: number, len: number): number {
  let h = 0x811c9dc5;
  for (let i = from; i < from + len; i++) {
    const t = tokens[i]!;
    for (let j = 0; j < t.length; j++) {
      h ^= t.charCodeAt(j);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x1f; // separator, so ["ab","c"] != ["a","bc"]
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Hashes of every n-gram of `tokens`, in order. */
export function ngramHashes(tokens: string[], n: number): number[] {
  const r: number[] = [];
  for (let i = 0; i + n <= tokens.length; i++) r.push(fnv(tokens, i, n));
  return r;
}

/** Winnowing (Schleimer, Wilkerson, Aiken): from every window of w hashes keep the minimum (rightmost on ties). Returns the distinct kept hashes. */
export function winnow(hashes: number[], w: number): Set<number> {
  const out = new Set<number>();
  if (hashes.length === 0) return out;
  if (hashes.length <= w) {
    out.add(Math.min(...hashes));
    return out;
  }
  let lastPos = -1;
  for (let s = 0; s + w <= hashes.length; s++) {
    let min = Infinity;
    let pos = -1;
    for (let j = s + w - 1; j >= s; j--) {
      if (hashes[j]! < min) {
        min = hashes[j]!;
        pos = j;
      }
    }
    if (pos !== lastPos) {
      out.add(min);
      lastPos = pos;
    }
  }
  return out;
}

export interface Fingerprint {
  tokenCount: number;
  /** winnowed k-gram hashes */
  prints: Set<number>;
  /** token shingle hashes (for Jaccard) */
  shingles: Set<number>;
}

/** Hash sets of all k-grams / shingles of the starter (template) code: anything in them is not counted as similarity. */
export interface Exclusion {
  k: Set<number>;
  shingle: Set<number>;
}
export const emptyExclusion = (): Exclusion => ({ k: new Set(), shingle: new Set() });

export function buildExclusion(templates: { code: string }[], lang: PlagiarismLanguage, opt: EngineOptions = DEFAULTS): Exclusion {
  const ex = emptyExclusion();
  for (const t of templates) {
    const toks = tokenize(t.code, lang);
    for (const h of ngramHashes(toks, opt.k)) ex.k.add(h);
    for (const h of ngramHashes(toks, opt.shingle)) ex.shingle.add(h);
  }
  return ex;
}

export function fingerprint(code: string, lang: PlagiarismLanguage, exclude?: Exclusion, opt: EngineOptions = DEFAULTS): Fingerprint {
  const toks = tokenize(code, lang);
  let kh = ngramHashes(toks, opt.k);
  let sh = ngramHashes(toks, opt.shingle);
  if (exclude) {
    if (exclude.k.size) kh = kh.filter((h) => !exclude.k.has(h));
    if (exclude.shingle.size) sh = sh.filter((h) => !exclude.shingle.has(h));
  }
  return { tokenCount: toks.length, prints: winnow(kh, opt.w), shingles: new Set(sh) };
}

export interface Comparison {
  /** 0..100, one decimal */
  similarity: number;
  /** 0..1 containment of fingerprints: shared / min(|A|,|B|) */
  winnowScore: number;
  /** 0..1 Jaccard of token shingles */
  jaccardScore: number;
  sharedPrints: number;
  /** false when either side is too short (or empty after excluding the starter code) to say anything */
  comparable: boolean;
}

function inter(a: Set<number>, b: Set<number>): number {
  const [s, l] = a.size <= b.size ? [a, b] : [b, a];
  let n = 0;
  for (const h of s) if (l.has(h)) n++;
  return n;
}

export function compare(a: Fingerprint, b: Fingerprint): Comparison {
  if (a.prints.size === 0 || b.prints.size === 0) return { similarity: 0, winnowScore: 0, jaccardScore: 0, sharedPrints: 0, comparable: false };
  const shared = inter(a.prints, b.prints);
  const winnowScore = shared / Math.min(a.prints.size, b.prints.size);
  const si = inter(a.shingles, b.shingles);
  const union = a.shingles.size + b.shingles.size - si;
  const jaccardScore = union === 0 ? 0 : si / union;
  const similarity = Math.round((WEIGHT_WINNOW * winnowScore + WEIGHT_JACCARD * jaccardScore) * 1000) / 10;
  return { similarity: Math.min(100, similarity), winnowScore: round3(winnowScore), jaccardScore: round3(jaccardScore), sharedPrints: shared, comparable: true };
}
const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** Convenience for tests / one-off checks. */
export function similarityOf(codeA: string, codeB: string, lang: PlagiarismLanguage, templates: { code: string }[] = [], opt: EngineOptions = DEFAULTS): Comparison {
  const ex = templates.length ? buildExclusion(templates, lang, opt) : undefined;
  return compare(fingerprint(codeA, lang, ex, opt), fingerprint(codeB, lang, ex, opt));
}

// ------------------------------------------------------------------ matching blocks (side-by-side view)
export interface BlockLine {
  /** 1-based line number */
  n: number;
  text: string;
  /** id (1..blocks) of the matching block this line belongs to, or null */
  block: number | null;
}
export interface BlockView {
  a: BlockLine[];
  b: BlockLine[];
  blocks: number;
  matchedLinesA: number;
  matchedLinesB: number;
}

/** Token indices covered by a matching k-gram: coverage[i] = hash of a covering k-gram (or 0 when none; hash 0 is mapped to 1). */
function cover(kh: number[], other: Set<number>, excl: Set<number> | undefined, k: number, n: number): (number | null)[] {
  const cov: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < kh.length; i++) {
    const h = kh[i]!;
    if (!other.has(h) || excl?.has(h)) continue;
    for (let j = i; j < i + k; j++) if (cov[j] == null) cov[j] = h;
  }
  return cov;
}

function toLines(code: string, lines: number[], blockOf: (number | null)[]): BlockLine[] {
  const text = code.replace(/\r\n?/g, '\n').split('\n');
  const total = new Array<number>(text.length).fill(0);
  const hit = text.map(() => new Map<number, number>());
  lines.forEach((ln, t) => {
    total[ln]!++;
    const b = blockOf[t];
    if (b != null) hit[ln]!.set(b, (hit[ln]!.get(b) ?? 0) + 1);
  });
  return text.map((txt, i) => {
    let best: number | null = null;
    let bestN = 0;
    for (const [b, c] of hit[i]!) if (c > bestN) [best, bestN] = [b, c];
    // a line counts as matching when at least half of its tokens are inside a shared run
    const sum = [...hit[i]!.values()].reduce((x, y) => x + y, 0);
    return { n: i + 1, text: txt, block: total[i]! > 0 && sum * 2 >= total[i]! ? best : null };
  });
}

/**
 * Which parts of two sources match: every token run covered by a k-gram that occurs in both (starter code excluded) becomes a block.
 * Blocks are numbered in the order they appear in A; the same shared k-gram carries the same number on side B, so the two sides can be
 * coloured identically. Works on the normalized tokens, so renamed variables and changed literals still match.
 */
export function matchingBlocks(codeA: string, codeB: string, lang: PlagiarismLanguage, exclude?: Exclusion, opt: EngineOptions = DEFAULTS): BlockView {
  const A = tokenizeWithLines(codeA, lang);
  const B = tokenizeWithLines(codeB, lang);
  const ka = ngramHashes(A.tokens, opt.k);
  const kb = ngramHashes(B.tokens, opt.k);
  const covA = cover(ka, new Set(kb), exclude?.k, opt.k, A.tokens.length);
  const covB = cover(kb, new Set(ka), exclude?.k, opt.k, B.tokens.length);
  // number the runs of A, remember which block each shared hash first appeared in
  const blockA: (number | null)[] = new Array(A.tokens.length).fill(null);
  const byHash = new Map<number, number>();
  let blocks = 0;
  for (let i = 0; i < covA.length; i++) {
    if (covA[i] == null) continue;
    if (i === 0 || covA[i - 1] == null) blocks++;
    blockA[i] = blocks;
    if (!byHash.has(covA[i]!)) byHash.set(covA[i]!, blocks);
  }
  // B: same number as the A run holding the same k-gram; a run whose hashes are unknown to A (cannot happen) gets a fresh one
  const blockB: (number | null)[] = covB.map((h) => (h == null ? null : (byHash.get(h) ?? null)));
  const a = toLines(codeA, A.lines, blockA);
  const b = toLines(codeB, B.lines, blockB);
  return { a, b, blocks, matchedLinesA: a.filter((l) => l.block != null).length, matchedLinesB: b.filter((l) => l.block != null).length };
}
