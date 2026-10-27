import { JudgeAdapter, JudgeCaseInput, JudgeCaseResult, JudgeUnavailableError } from './adapter';

/**
 * !!! TEST-ONLY MOCK ADAPTER — NOT a judge. It never executes code. !!!
 * It reads a marker comment in the source to decide the outcome, e.g. `//MOCK:WA@2` (WA on test 2),
 * `//MOCK:TLE`, `//MOCK:RE`, `//MOCK:CE`, `//MOCK:DOWN` (simulates judge outage), `//MOCK:FLAKY` (fails first call only).
 * Refused when NODE_ENV=production (see config/env.ts).
 */
const flakyCalls = new Map<string, number>();
export class MockJudgeAdapter implements JudgeAdapter {
  readonly name = 'mock-TEST-ONLY';
  private counter = 0;
  async run(i: JudgeCaseInput): Promise<JudgeCaseResult> {
    this.counter += 1;
    const m = /MOCK:(AC|WA|TLE|RE|CE|DOWN|FLAKY)(?:@(\d+))?/.exec(i.code);
    const kind = m?.[1] ?? 'AC';
    const at = m?.[2] ? Number(m[2]) : 1;
    // test index is derived from stdin marker "#<n>" written by tests; defaults to 1
    const idx = Number(/^#(\d+)/.exec(i.stdin)?.[1] ?? 1);
    if (kind === 'DOWN') throw new JudgeUnavailableError('mock outage');
    if (kind === 'FLAKY') {
      const n = (flakyCalls.get(i.code) ?? 0) + 1;
      flakyCalls.set(i.code, n);
      if (n === 1) throw new JudgeUnavailableError('mock transient failure');
      return { outcome: 'AC', timeMs: 10, memoryKb: 1000 };
    }
    if (kind === 'CE') return { outcome: 'CE' };
    if (kind !== 'AC' && idx >= at) return { outcome: kind as 'WA' | 'TLE' | 'RE', timeMs: 10, memoryKb: 1000 };
    return { outcome: 'AC', timeMs: 10, memoryKb: 1000 };
  }
}
