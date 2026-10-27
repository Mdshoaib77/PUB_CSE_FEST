import { env } from '../config/env';
import { Contest, Problem, Submission, TestCase } from '../models';
import { emitTo } from '../sockets/io';
import { logger } from '../utils/logger';
import { audit } from '../utils/audit';
import { getJudge } from './judge';
import { JudgeUnavailableError } from './judge/adapter';
import type { JudgeOutcome } from './verdict';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_PARALLEL = 3;
const queue: string[] = [];
const inFlight = new Set<Promise<void>>();
let active = 0;

/** In-process queue: submissions are persisted first (status=queued) so a restart can resume them via resumeQueued(). */
export function enqueue(submissionId: string) {
  queue.push(submissionId);
  pump();
}
function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const id = queue.shift()!;
    active += 1;
    const p = processSubmission(id)
      .catch((e) => {
        if (process.env.DEBUG_ERRORS) console.error(e);
        logger.error('judge job crashed', { name: (e as Error).name });
      })
      .finally(() => {
        active -= 1;
        inFlight.delete(p);
        pump();
      });
    inFlight.add(p);
  }
}
/** Test helper: wait until all queued/in-flight jobs finished. */
export async function drain() {
  while (queue.length || inFlight.size) await Promise.all([...inFlight, sleep(5)]);
}
export async function resumeQueued() {
  const stuck = await Submission.find({ status: { $in: ['queued', 'running'] } }).select('_id');
  stuck.forEach((s) => enqueue(String(s._id)));
}

export async function processSubmission(id: string) {
  // Atomically take the job so a duplicated enqueue/retry cannot judge it twice.
  const claimed = await Submission.updateOne({ _id: id, status: { $in: ['queued', 'running'] } }, { $set: { status: 'running' }, $inc: { attempts: 1 } });
  if (!claimed.matchedCount) return;
  const sub = await Submission.findById(id).select('+code');
  if (!sub) return;
  const problem = await Problem.findById(sub.problemId);
  if (!problem) return finalize(id, 'JE');
  const cases = await TestCase.find({ problemId: problem._id }).sort({ order: 1 }).select('+input +expectedOutput');
  if (!cases.length) return finalize(id, 'JE');
  const judge = getJudge();
  let maxTime = 0,
    maxMem = 0;
  for (const tc of cases) {
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await judge.run({
          language: sub.language,
          code: sub.code,
          stdin: tc.input,
          expectedOutput: tc.expectedOutput,
          timeLimitMs: problem.timeLimitMs,
          memoryLimitKb: problem.memoryLimitKb,
        });
        break;
      } catch (e) {
        if (!(e instanceof JudgeUnavailableError)) throw e;
        logger.warn('judge unavailable', { attempt }); // message intentionally not logged with test data
        if (attempt >= env.judge0.maxAttempts) return finalize(id, 'JE');
        await sleep(env.isTest ? 1 : 500 * 2 ** attempt);
      }
    }
    maxTime = Math.max(maxTime, res.timeMs ?? 0);
    maxMem = Math.max(maxMem, res.memoryKb ?? 0);
    if (res.outcome !== 'AC') return finalize(id, res.outcome, { failedTest: tc.order, timeMs: res.timeMs, memoryKb: res.memoryKb });
  }
  return finalize(id, 'AC', { timeMs: maxTime, memoryKb: maxMem });
}

async function finalize(id: string, status: JudgeOutcome, extra: { failedTest?: number; timeMs?: number; memoryKb?: number } = {}) {
  // Only a 'running' submission can be finalized: retries can never overwrite a final verdict.
  const upd = await Submission.updateOne({ _id: id, status: 'running' }, { $set: { status, judgedAt: new Date(), ...extra } });
  if (!upd.matchedCount) return;
  const done = await Submission.findById(id);
  if (!done) return;
  emitTo(`user:${done.userId}`, 'submission:verdict', { submissionId: id, status });
  // Public rooms only get a nudge (no data). Clients re-fetch through the freeze-aware endpoint.
  if (done.contestId) emitTo(`contest:${done.contestId}`, 'scoreboard:update', { contestId: String(done.contestId) });
  if (done.contestId) await audit(undefined, 'submission.judged', 'Submission', id, { status });
}

export async function activeContestsForProblem(problemId: unknown, now = new Date()) {
  return Contest.find({ 'problems.problemId': problemId, endAt: { $gt: now } });
}
