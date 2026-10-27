import type { Language } from '@festhub/shared';
import type { JudgeOutcome } from '../verdict';

export interface JudgeCaseInput {
  language: Language;
  code: string;
  stdin: string;
  expectedOutput: string;
  timeLimitMs: number;
  memoryLimitKb: number;
}
export interface JudgeCaseResult {
  outcome: JudgeOutcome;
  timeMs?: number;
  memoryKb?: number;
}

/** One adapter call = one program run against one test case inside an isolated sandbox. */
export interface JudgeAdapter {
  readonly name: string;
  run(input: JudgeCaseInput): Promise<JudgeCaseResult>;
}
export class JudgeUnavailableError extends Error {}
