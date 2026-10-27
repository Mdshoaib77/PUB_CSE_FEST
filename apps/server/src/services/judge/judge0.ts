import type { Language } from '@festhub/shared';
import { env } from '../../config/env';
import { mapJudge0Status } from '../verdict';
import { JudgeAdapter, JudgeCaseInput, JudgeCaseResult, JudgeUnavailableError } from './adapter';

/**
 * Default ids for Judge0 CE 1.13.x. Ids differ between Judge0 versions and hosts, so verify them against GET /languages of YOUR
 * instance (organisers: GET /api/v1/judge/languages does exactly that) and override with JUDGE0_LANGUAGE_IDS='{"cpp":54,"java":91}'.
 *   c 50 = C (GCC 9.2.0)            cpp 54 = C++ (G++ 9.2.0)      java 62 = Java (OpenJDK 13)   python 71 = Python 3.8.1
 *   javascript 63 = Node.js 12.14   typescript 74 = TypeScript 3.7  go 60 = Go 1.13.5          csharp 51 = C# (Mono 6.6)
 *   rust 73 = Rust 1.40             php 68 = PHP 7.4.1
 */
export const DEFAULT_LANGUAGE_IDS: Record<Language, number> = { c: 50, cpp: 54, java: 62, python: 71, javascript: 63, typescript: 74, go: 60, csharp: 51, rust: 73, php: 68 };
export function languageIds(): Record<Language, number> {
  try {
    return { ...DEFAULT_LANGUAGE_IDS, ...(process.env.JUDGE0_LANGUAGE_IDS ? JSON.parse(process.env.JUDGE0_LANGUAGE_IDS) : {}) };
  } catch {
    return DEFAULT_LANGUAGE_IDS;
  }
}
/** Asks the configured Judge0 which languages it really has, so a wrong id is found before a contest, not during it. */
export async function fetchJudge0Languages(): Promise<{ id: number; name: string }[]> {
  if (!env.judge0.baseUrl) throw new JudgeUnavailableError('Judge0 is not configured');
  const h: Record<string, string> = {};
  if (env.judge0.apiKey) h['X-RapidAPI-Key'] = env.judge0.apiKey;
  if (env.judge0.apiHost) h['X-RapidAPI-Host'] = env.judge0.apiHost;
  if (env.judge0.authToken) h['X-Auth-Token'] = env.judge0.authToken;
  let res: Response;
  try {
    res = await fetch(`${env.judge0.baseUrl.replace(/\/$/, '')}/languages`, { headers: h });
  } catch {
    throw new JudgeUnavailableError('Judge0 unreachable');
  }
  if (!res.ok) throw new JudgeUnavailableError(`Judge0 /languages failed (${res.status})`);
  return (await res.json()) as { id: number; name: string }[];
}
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Production adapter: talks to a Judge0 service (RapidAPI-hosted or self-hosted). Code never runs in this process.
 * The API key stays on the server; it is added to outgoing request headers only.
 */
export class Judge0Adapter implements JudgeAdapter {
  readonly name = 'judge0';
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.judge0.apiKey) h['X-RapidAPI-Key'] = env.judge0.apiKey;
    if (env.judge0.apiHost) h['X-RapidAPI-Host'] = env.judge0.apiHost;
    if (env.judge0.authToken) h['X-Auth-Token'] = env.judge0.authToken;
    return h;
  }
  async run(i: JudgeCaseInput): Promise<JudgeCaseResult> {
    if (!env.judge0.baseUrl) throw new JudgeUnavailableError('Judge0 is not configured');
    const base = env.judge0.baseUrl.replace(/\/$/, '');
    let token: string;
    try {
      const res = await fetch(`${base}/submissions?base64_encoded=true&wait=false`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          language_id: languageIds()[i.language],
          source_code: b64(i.code),
          stdin: b64(i.stdin),
          expected_output: b64(i.expectedOutput),
          cpu_time_limit: i.timeLimitMs / 1000,
          memory_limit: i.memoryLimitKb,
        }),
      });
      if (!res.ok) throw new JudgeUnavailableError(`Judge0 create failed (${res.status})`);
      token = ((await res.json()) as { token: string }).token;
    } catch (e) {
      if (e instanceof JudgeUnavailableError) throw e;
      throw new JudgeUnavailableError('Judge0 unreachable');
    }
    const deadline = Date.now() + env.judge0.pollTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(env.judge0.pollIntervalMs);
      let r: Response;
      try {
        r = await fetch(`${base}/submissions/${token}?base64_encoded=true&fields=status_id,time,memory`, { headers: this.headers() });
      } catch {
        throw new JudgeUnavailableError('Judge0 unreachable while polling');
      }
      if (!r.ok) throw new JudgeUnavailableError(`Judge0 poll failed (${r.status})`);
      const j = (await r.json()) as { status_id: number; time?: string | null; memory?: number | null };
      if (j.status_id > 2) {
        return { outcome: mapJudge0Status(j.status_id), timeMs: j.time ? Math.round(parseFloat(j.time) * 1000) : undefined, memoryKb: j.memory ?? undefined };
      }
    }
    throw new JudgeUnavailableError('Judge0 timed out');
  }
}
