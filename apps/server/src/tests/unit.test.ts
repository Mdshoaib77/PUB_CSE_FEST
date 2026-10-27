import { describe, expect, it } from 'vitest';
import { coveredByAvailability, findOverlaps, overlaps, suggestNextSlot } from '../services/clash';
import { computeStandings, scoreboardCutoff } from '../services/scoring';
import { mapJudge0Status } from '../services/verdict';
import { computeProgress } from '../services/scoreboard';
import { percentFromScores, rankEntries } from '../routes/judging';

const d = (s: string) => new Date(`2026-11-01T${s}:00Z`);

describe('clash detection', () => {
  it('detects overlap and treats touching ends as free', () => {
    expect(overlaps({ start: d('10:00'), end: d('11:00') }, { start: d('10:30'), end: d('12:00') })).toBe(true);
    expect(overlaps({ start: d('10:00'), end: d('11:00') }, { start: d('11:00'), end: d('12:00') })).toBe(false);
    expect(overlaps({ start: d('10:00'), end: d('13:00') }, { start: d('11:00'), end: d('12:00') })).toBe(true);
  });
  it('filters overlaps and suggests next free slot', () => {
    const b = [
      { start: d('10:00'), end: d('11:00') },
      { start: d('11:00'), end: d('12:30') },
    ];
    expect(findOverlaps({ start: d('10:30'), end: d('11:30') }, b)).toHaveLength(2);
    expect(suggestNextSlot(b, 3600_000, d('10:30'))).toEqual(d('12:30'));
    expect(suggestNextSlot(b, 3600_000, d('13:00'))).toEqual(d('13:00'));
  });
  it('availability must fully cover the shift', () => {
    expect(coveredByAvailability({ start: d('10:00'), end: d('12:00') }, [{ start: d('09:00'), end: d('13:00') }])).toBe(true);
    expect(coveredByAvailability({ start: d('10:00'), end: d('14:00') }, [{ start: d('09:00'), end: d('13:00') }])).toBe(false);
  });
});

describe('ICPC scoring', () => {
  const start = d('10:00');
  const at = (m: number) => new Date(start.getTime() + m * 60000 + 5000);
  const base = { startAt: start, penaltyMinutes: 20, problemIds: ['A', 'B'] };
  it('penalty = minutes to first AC + 20 per wrong attempt before it', () => {
    const rows = computeStandings(
      [
        { userId: 'u1', problemId: 'A', status: 'WA', submittedAt: at(5) },
        { userId: 'u1', problemId: 'A', status: 'TLE', submittedAt: at(8) },
        { userId: 'u1', problemId: 'A', status: 'AC', submittedAt: at(30) },
        { userId: 'u1', problemId: 'A', status: 'WA', submittedAt: at(40) }, // ignored (after AC)
      ],
      base,
    );
    expect(rows[0]).toMatchObject({ solved: 1, penalty: 30 + 40, rank: 1 });
    expect(rows[0].cells[0]).toMatchObject({ solved: true, wrong: 2, solvedAtMin: 30 });
  });
  it('CE, JE, queued do not count as attempts; unsolved adds no penalty', () => {
    const rows = computeStandings(
      [
        { userId: 'u1', problemId: 'A', status: 'CE', submittedAt: at(1) },
        { userId: 'u1', problemId: 'A', status: 'JE', submittedAt: at(2) },
        { userId: 'u1', problemId: 'A', status: 'AC', submittedAt: at(10) },
        { userId: 'u1', problemId: 'B', status: 'WA', submittedAt: at(11) },
      ],
      base,
    );
    expect(rows[0]).toMatchObject({ solved: 1, penalty: 10 });
    expect(rows[0].cells[1]).toMatchObject({ solved: false, wrong: 1 });
  });
  it('ranks by solved, then penalty, then last accepted; equal rows share a rank', () => {
    const rows = computeStandings(
      [
        { userId: 'a', problemId: 'A', status: 'AC', submittedAt: at(10) },
        { userId: 'a', problemId: 'B', status: 'AC', submittedAt: at(20) },
        { userId: 'b', problemId: 'A', status: 'AC', submittedAt: at(5) },
        { userId: 'c', problemId: 'A', status: 'AC', submittedAt: at(5) },
        { userId: 'd', problemId: 'A', status: 'AC', submittedAt: at(6) },
      ],
      base,
    );
    expect(rows.map((r) => [r.userId, r.rank])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 2],
      ['d', 4],
    ]);
  });
  it('ignores submissions before the start or after the end', () => {
    const rows = computeStandings(
      [
        { userId: 'a', problemId: 'A', status: 'AC', submittedAt: new Date(start.getTime() - 1000) },
        { userId: 'a', problemId: 'B', status: 'AC', submittedAt: at(500) },
      ],
      { ...base, endAt: at(120) },
    );
    expect(rows[0].solved).toBe(0);
  });
  it('freeze cutoff hides post-freeze solves and only exposes pending counts', () => {
    const freezeAt = at(60);
    const subs = [
      { userId: 'a', problemId: 'A', status: 'AC', submittedAt: at(10) },
      { userId: 'a', problemId: 'B', status: 'AC', submittedAt: at(70) },
    ];
    const frozen = computeStandings(subs, { ...base, cutoff: freezeAt });
    expect(frozen[0].solved).toBe(1);
    expect(frozen[0].cells[1]).toMatchObject({ solved: false, pending: 1 });
    expect(computeStandings(subs, base)[0].solved).toBe(2);
  });
  it('scoreboardCutoff window: frozen from freezeAt until reveal/end, then open', () => {
    const c = { freezeAt: at(60), endAt: at(120) };
    expect(scoreboardCutoff(c, at(30))).toBeNull();
    expect(scoreboardCutoff(c, at(90))).toEqual(c.freezeAt);
    expect(scoreboardCutoff(c, at(121))).toBeNull();
    expect(scoreboardCutoff({ ...c, revealAt: at(180) }, at(150))).toEqual(c.freezeAt);
    expect(scoreboardCutoff({ ...c, revealed: true }, at(90))).toBeNull();
    expect(scoreboardCutoff({ endAt: c.endAt }, at(90))).toBeNull();
  });
});

describe('verdict mapping', () => {
  it('maps Judge0 status ids', () => {
    expect([3, 4, 5, 6, 7, 11, 12, 13, 14, 99].map(mapJudge0Status)).toEqual(['AC', 'WA', 'TLE', 'CE', 'RE', 'RE', 'RE', 'JE', 'JE', 'JE']);
  });
});

describe('progress & rubric maths', () => {
  it('computes topic/difficulty progress, ignoring queued and judge errors', () => {
    const p = computeProgress(
      [
        { problemId: '1', status: 'WA', mode: 'practice' },
        { problemId: '1', status: 'AC', mode: 'practice' },
        { problemId: '2', status: 'WA', mode: 'practice' },
        { problemId: '2', status: 'JE', mode: 'practice' },
      ],
      [
        { id: '1', tags: ['dp', 'math'], difficulty: 'easy' },
        { id: '2', tags: ['dp'], difficulty: 'hard' },
      ],
    );
    expect(p).toMatchObject({ problemsAttempted: 2, problemsSolved: 1, totalAttempts: 3 });
    expect(p.topics.dp).toEqual({ attempted: 2, solved: 1 });
    expect(p.difficulty.hard).toEqual({ attempted: 1, solved: 0 });
  });
  it('weights rubric scores and ranks ties equally', () => {
    const c = [
      { name: 'Idea', maxScore: 10, weight: 2 },
      { name: 'Demo', maxScore: 10, weight: 1 },
    ];
    expect(
      percentFromScores(c, [
        { name: 'Idea', score: 10 },
        { name: 'Demo', score: 0 },
      ]),
    ).toBeCloseTo(66.67, 1);
    expect(
      rankEntries([
        { entryId: 'a', percent: 80 },
        { entryId: 'b', percent: 90 },
        { entryId: 'c', percent: 80 },
      ]).map((r) => [r.entryId, r.rank]),
    ).toEqual([
      ['b', 1],
      ['a', 2],
      ['c', 2],
    ]);
  });
});
