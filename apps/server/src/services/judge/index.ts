import { env } from '../../config/env';
import { JudgeAdapter } from './adapter';
import { Judge0Adapter } from './judge0';
import { MockJudgeAdapter } from './mock';

let adapter: JudgeAdapter | null = null;
export function getJudge(): JudgeAdapter {
  if (!adapter) adapter = env.judgeAdapter === 'mock' ? new MockJudgeAdapter() : new Judge0Adapter();
  return adapter;
}
export function setJudgeForTests(a: JudgeAdapter | null) {
  if (env.isProd) throw new Error('not allowed');
  adapter = a;
}
