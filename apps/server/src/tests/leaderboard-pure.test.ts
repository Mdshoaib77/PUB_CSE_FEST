import { describe, expect, it } from 'vitest';
import { computeLeaderboard, DEFAULT_LEADERBOARD_CONFIG, scoreParticipant, validateLeaderboardConfig, type LeaderboardInput } from '@festhub/shared';

const P = (key: string, judgePercent: number | null, aiPercent: number | null, confirmedPairs = 0, name = key): LeaderboardInput => ({ key, name, judgePercent, aiPercent, confirmedPairs });

describe('leaderboard scoring (pure)', () => {
  it('combines judge and AI with the configured weights', () => {
    const [x] = computeLeaderboard([P('a', 80, 60)], { judgeWeight: 70, aiWeight: 30 });
    expect([x.judgePoints, x.aiPoints, x.base, x.final, x.rank]).toEqual([56, 18, 74, 74, 1]);
  });
  it('weights are relative: 7:3 equals 70:30', () => {
    expect(computeLeaderboard([P('a', 80, 60)], { judgeWeight: 7, aiWeight: 3 })[0].final).toBe(74);
  });
  it('re-normalises when a component is missing (no silent zero)', () => {
    const [x] = computeLeaderboard([P('a', 80, null)]);
    expect([x.judgeShare, x.aiShare, x.aiPoints, x.final]).toEqual([1, 0, null, 80]);
  });
  it('subtracts a per-pair penalty, capped, never below 0', () => {
    expect(scoreParticipant(P('a', 80, 60, 1), DEFAULT_LEADERBOARD_CONFIG).final).toBe(64);
    expect(scoreParticipant(P('a', 80, 60, 9), DEFAULT_LEADERBOARD_CONFIG).penalty).toBe(50);
    expect(scoreParticipant(P('a', 20, null, 9), { ...DEFAULT_LEADERBOARD_CONFIG, maxPenalty: 100 }).final).toBe(0);
    expect(scoreParticipant(P('a', 80, 60, 0), DEFAULT_LEADERBOARD_CONFIG).penalty).toBe(0);
  });
  it('unscored participants are listed last with no rank', () => {
    const rows = computeLeaderboard([P('z', null, null), P('a', 50, null)]);
    expect(rows.map((r) => [r.key, r.rank, r.final])).toEqual([['a', 1, 50], ['z', null, null]]);
  });
  it('ties: judge tie-break separates equal finals', () => {
    const rows = computeLeaderboard([P('b', 70, 70), P('a', 90, 50)], { judgeWeight: 50, aiWeight: 50, tieBreak: 'judge' });
    expect(rows.map((r) => [r.key, r.rank, r.tied, r.brokeTie])).toEqual([['a', 1, false, false], ['b', 2, false, true]]);
  });
  it('ties: ai tie-break prefers the higher AI score', () => {
    const rows = computeLeaderboard([P('a', 90, 50), P('b', 70, 70)], { judgeWeight: 50, aiWeight: 50, tieBreak: 'ai' });
    expect(rows[0].key).toBe('b');
  });
  it('ties: full ties share a rank and the next rank is skipped (1,2,2,4); output order ignores input order', () => {
    const inputs = [P('d', 10, null), P('b', 50, null, 0, 'Bea'), P('a', 50, null, 0, 'Ann'), P('top', 99, null)];
    const rows = computeLeaderboard(inputs, { tieBreak: 'none' });
    expect(rows.map((r) => [r.key, r.rank, r.tied])).toEqual([['top', 1, false], ['a', 2, true], ['b', 2, true], ['d', 4, false]]);
    expect(computeLeaderboard([...inputs].reverse(), { tieBreak: 'none' }).map((r) => r.key)).toEqual(rows.map((r) => r.key));
  });
  it('clamps out-of-range percents and ignores NaN', () => {
    const [x] = computeLeaderboard([P('a', 150, Number.NaN)]);
    expect([x.judgePercent, x.aiPercent]).toEqual([100, null]);
  });
  it('rejects invalid configs', () => {
    expect(validateLeaderboardConfig({ ...DEFAULT_LEADERBOARD_CONFIG, judgeWeight: 0, aiWeight: 0 })).not.toEqual([]);
    expect(validateLeaderboardConfig({ ...DEFAULT_LEADERBOARD_CONFIG, judgeWeight: -1 })).not.toEqual([]);
    expect(validateLeaderboardConfig({ ...DEFAULT_LEADERBOARD_CONFIG, tieBreak: 'x' as never })).not.toEqual([]);
    expect(validateLeaderboardConfig(DEFAULT_LEADERBOARD_CONFIG)).toEqual([]);
    expect(() => computeLeaderboard([P('a', 1, 1)], { judgeWeight: 0, aiWeight: 0 })).toThrow(RangeError);
  });
});
