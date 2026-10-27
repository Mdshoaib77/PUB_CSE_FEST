import { describe, expect, it } from 'vitest';
import {
  computeLeaderboard,
  generateCertificateId,
  verificationVerdict,
  verifyCertificateId,
} from '@festhub/shared';
import { similarityOf } from '../services/plagiarism';
import { buildFeedbackPrompt } from '../services/aiFeedback/prompt';
import { parseFeedbackResponse } from '../services/aiFeedback/parse';
import { normalizeCriteria } from '../services/aiFeedback/rubric';
import { AiError, backoffMs, callAnthropic } from '../services/aiFeedback/client';

/* S17C: one consolidated suite of pure, DB-free tests for the core algorithms (no network, no real AI calls). */

// ---------------------------------------------------------------- plagiarism engine
const ORIGINAL = `# sum of squares of even numbers
def solve(numbers):
    total = 0
    for value in numbers:
        if value % 2 == 0:
            total += value * value
    return total

if __name__ == "__main__":
    n = int(input())
    data = [int(x) for x in input().split()]
    print(solve(data[:n]))
`;
const RENAMED = ORIGINAL.replace(/numbers/g, 'items').replace(/total/g, 'acc').replace(/value/g, 'v').replace(/solve/g, 'run').replace(/data/g, 'arr');
const COMMENTS_WS = `# totally different comment text
def solve(numbers):



    total   =   0   # accumulator
    for value in numbers:   # loop


        if value % 2 == 0:
            total += value * value
    return total

if __name__ == "__main__":
    n = int(input())
    data = [int(x) for x in input().split()]
    print(solve(data[:n]))   `;
const DIFFERENT = `import sys
from collections import deque

def bfs(graph, start):
    seen = {start}
    queue = deque([start])
    order = []
    while queue:
        node = queue.popleft()
        order.append(node)
        for nxt in graph.get(node, []):
            if nxt not in seen:
                seen.add(nxt)
                queue.append(nxt)
    return order

g = {1: [2, 3], 2: [4], 3: [4], 4: []}
print(" ".join(map(str, bfs(g, 1))))
`;

describe('plagiarism engine (S17C)', () => {
  it('identical code is ~100%', () => {
    expect(similarityOf(ORIGINAL, ORIGINAL, 'python').similarity).toBeGreaterThanOrEqual(99);
  });
  it('renamed variables stay high', () => {
    expect(similarityOf(ORIGINAL, RENAMED, 'python').similarity).toBeGreaterThanOrEqual(80);
  });
  it('different programs are low', () => {
    expect(similarityOf(ORIGINAL, DIFFERENT, 'python').similarity).toBeLessThan(35);
  });
  it('comments and whitespace are ignored', () => {
    expect(similarityOf(ORIGINAL, COMMENTS_WS, 'python').similarity).toBeGreaterThanOrEqual(95);
  });
  it('is symmetric', () => {
    expect(similarityOf(ORIGINAL, DIFFERENT, 'python').similarity).toBe(similarityOf(DIFFERENT, ORIGINAL, 'python').similarity);
  });
});

// ---------------------------------------------------------------- certificate id + verification
const entropy = (seed: number) => Uint8Array.from({ length: 12 }, (_, i) => (i * 29 + seed * 13) & 255);

describe('certificate id / verification (S17C)', () => {
  const id = generateCertificateId(entropy(7));
  it('a generated id verifies and a stored valid certificate is "valid"', () => {
    expect(verifyCertificateId(id).ok).toBe(true);
    expect(verificationVerdict(id, { status: 'valid' })).toBe('valid');
  });
  it('a revoked certificate is "revoked"', () => {
    expect(verificationVerdict(id, { status: 'revoked' })).toBe('revoked');
  });
  it('an unknown id is "not_found"', () => {
    expect(verificationVerdict(id, null)).toBe('not_found');
  });
  it('a typo / bad checksum / junk is "not_found" even if a record were passed', () => {
    const last = id.slice(-1);
    const typo = id.slice(0, -1) + (last === '0' ? '1' : '0');
    expect(verifyCertificateId(typo)).toMatchObject({ ok: false, reason: 'checksum' });
    expect(verificationVerdict(typo, { status: 'valid' })).toBe('not_found');
    expect(verificationVerdict('hello', { status: 'valid' })).toBe('not_found');
    expect(verificationVerdict(undefined, { status: 'valid' })).toBe('not_found');
  });
  it('accepts lower case and spaces', () => {
    expect(verifyCertificateId(id.toLowerCase().replace(/-/g, ' ')).ok).toBe(true);
  });
});

// ---------------------------------------------------------------- leaderboard math
const p = (key: string, judge: number | null, ai: number | null, pairs = 0) => ({ key, name: key, judgePercent: judge, aiPercent: ai, confirmedPairs: pairs });

describe('leaderboard math (S17C)', () => {
  it('default weights are 70/30', () => {
    const [r] = computeLeaderboard([p('a', 80, 60)]);
    expect(r.base).toBe(74); // 80*0.7 + 60*0.3
    expect(r.final).toBe(74);
  });
  it('penalty is 10 per confirmed pair, capped at 50, final never below 0', () => {
    const rows = computeLeaderboard([p('one', 90, 90, 1), p('many', 90, 90, 9), p('low', 20, 20, 5)]);
    const by = Object.fromEntries(rows.map((r) => [r.key, r]));
    expect(by.one.final).toBe(80);
    expect(by.many.penalty).toBe(50);
    expect(by.many.final).toBe(40);
    expect(by.low.final).toBe(0);
  });
  it('a missing AI score is left out, not counted as 0', () => {
    const [r] = computeLeaderboard([p('a', 80, null)]);
    expect(r.final).toBe(80);
  });
  it('ties share a rank and the next rank is skipped (1,2,2,4)', () => {
    const rows = computeLeaderboard([p('a', 90, 90), p('b', 80, 80), p('c', 80, 80), p('d', 70, 70)]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 2, 4]);
    expect(rows[1].tied && rows[2].tied).toBe(true);
  });
  it('the judge tie-break separates equal finals (higher judge score first)', () => {
    // 50/50 weights: x = 60*.5 + 100*.5 = 80, y = 80*.5 + 80*.5 = 80 -> equal finals
    const rows = computeLeaderboard([p('x', 60, 100), p('y', 80, 80)], { judgeWeight: 50, aiWeight: 50, tieBreak: 'judge' });
    expect(rows.map((r) => r.key)).toEqual(['y', 'x']);
    expect(rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(rows[1].brokeTie).toBe(true);
  });
  it('the AI tie-break prefers the higher AI score; "none" shares the rank', () => {
    const cfg = { judgeWeight: 50, aiWeight: 50 };
    expect(computeLeaderboard([p('x', 60, 100), p('y', 80, 80)], { ...cfg, tieBreak: 'ai' }).map((r) => r.key)).toEqual(['x', 'y']);
    expect(computeLeaderboard([p('x', 60, 100), p('y', 80, 80)], { ...cfg, tieBreak: 'none' }).map((r) => r.rank)).toEqual([1, 1]);
  });
  it('unscored participants are listed last without a rank', () => {
    const rows = computeLeaderboard([p('none', null, null), p('a', 50, 50)]);
    expect(rows[1]).toMatchObject({ key: 'none', rank: null, final: null });
  });
  it('invalid config throws', () => {
    expect(() => computeLeaderboard([p('a', 1, 1)], { judgeWeight: 0, aiWeight: 0 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------- AI prompt builder + parser (mocked)
const criteria = normalizeCriteria([
  { name: 'Correctness', maxPoints: 10, weight: 3 },
  { name: 'Style', maxPoints: 5, weight: 1 },
]);

describe('AI prompt builder / parser (S17C, mocked)', () => {
  it('prompt contains the code, language and rubric keys, and fences the code as untrusted data', () => {
    const b = buildFeedbackPrompt({ language: 'python', code: 'print(1)', criteria });
    expect(b.user).toContain('print(1)');
    expect(b.user).toContain('Language: python');
    for (const c of criteria) expect(b.user).toContain(`key "${c.key}"`);
    expect(b.system).toMatch(/untrusted/i);
    expect(b.truncated).toBe(false);
  });
  it('long code is truncated with a marker', () => {
    const b = buildFeedbackPrompt({ language: 'c', code: 'x'.repeat(5000), criteria, maxChars: 1000 });
    expect(b.truncated).toBe(true);
    expect(b.sentChars).toBeLessThan(b.originalChars);
    expect(b.user).toContain('characters omitted');
  });
  it('parses a clean reply, also when wrapped in fences/prose', () => {
    const json = JSON.stringify({
      strengths: ['clear'], issues: ['slow'], suggestions: ['use a set'],
      quality: { rating: 8, summary: 'good' }, complexity: { time: 'O(n)', space: 'O(1)', notes: '' },
      criteria: [{ key: criteria[0].key, score: 9, comment: 'ok' }, { key: criteria[1].key, score: 4, comment: 'fine' }],
    });
    const r = parseFeedbackResponse('Here you go:\n```json\n' + json + '\n```\nHope it helps.', criteria);
    expect(r.ok).toBe(true);
    expect(r.quality.rating).toBe(8);
    expect(r.criterionScores.map((c) => c.score)).toEqual([9, 4]);
    expect(r.total.points).toBeGreaterThan(0);
  });
  it('clamps out-of-range scores and warns', () => {
    const r = parseFeedbackResponse(JSON.stringify({ strengths: ['a'], criteria: [{ key: criteria[0].key, score: 99 }] }), criteria);
    expect(r.criterionScores[0].score).toBe(10);
    expect(r.warnings.join(' ')).toMatch(/clamped/);
  });
  it('garbage never throws and yields an empty, not-ok draft', () => {
    for (const bad of ['', 'not json at all', '[1,2,3]', null, 42]) {
      const r = parseFeedbackResponse(bad, criteria);
      expect(r.ok).toBe(false);
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });
  it('client call is mocked: success, retry on 500 then success, no key = disabled, 401 not retried', async () => {
    const okRes = () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"strengths":["x"]}' }], model: 'm', usage: { input_tokens: 1, output_tokens: 2 } }), { status: 200 });
    const noSleep = async () => {};
    let calls = 0;
    const flaky = (async () => (++calls === 1 ? new Response('boom', { status: 500 }) : okRes())) as unknown as typeof fetch;
    const r = await callAnthropic('s', 'u', { apiKey: 'k', model: 'm', fetchImpl: flaky, sleep: noSleep, maxRetries: 2, random: () => 0 });
    expect(r.text).toContain('strengths');
    expect(r.attempts).toBe(2);
    await expect(callAnthropic('s', 'u', { apiKey: '', model: 'm' })).rejects.toMatchObject({ code: 'DISABLED' });
    let c2 = 0;
    const unauthorized = (async () => { c2++; return new Response('no', { status: 401 }); }) as unknown as typeof fetch;
    await expect(callAnthropic('s', 'u', { apiKey: 'k', model: 'm', fetchImpl: unauthorized, sleep: noSleep, maxRetries: 3 })).rejects.toBeInstanceOf(AiError);
    expect(c2).toBe(1);
  });
  it('backoff honours Retry-After and grows exponentially', () => {
    expect(backoffMs(0, '2')).toBe(2000);
    expect(backoffMs(0, null, 500, () => 0)).toBe(500);
    expect(backoffMs(2, null, 500, () => 0)).toBe(2000);
  });
});
