import type { Verdict } from '@festhub/shared';

/** Judge0 status ids: 1 queue, 2 processing, 3 accepted, 4 wrong answer, 5 TLE, 6 compile error, 7-12 runtime errors, 13 internal error, 14 exec format error. */
export type JudgeOutcome = Verdict | 'JE';
export function mapJudge0Status(id: number): JudgeOutcome {
  if (id === 3) return 'AC';
  if (id === 4) return 'WA';
  if (id === 5) return 'TLE';
  if (id === 6) return 'CE';
  if (id >= 7 && id <= 12) return 'RE';
  return 'JE'; // 13, 14 or anything unknown: our infrastructure problem, never the contestant's fault
}
export const isFinal = (s: string) => ['AC', 'WA', 'TLE', 'RE', 'CE', 'JE'].includes(s);
