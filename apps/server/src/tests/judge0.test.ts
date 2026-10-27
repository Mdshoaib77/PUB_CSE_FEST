import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { LANGUAGES } from '@festhub/shared';
import { DEFAULT_LANGUAGE_IDS, Judge0Adapter, languageIds } from '../services/judge/judge0';
import { JudgeUnavailableError } from '../services/judge/adapter';

/**
 * Protocol test for the PRODUCTION Judge0Adapter against a local stub that mimics Judge0's REST shape
 * (POST /submissions?base64_encoded=true&wait=false -> {token}; GET /submissions/:token -> {status_id,time,memory}).
 * This is NOT a test against a real Judge0 service; that needs JUDGE0_* credentials (see docs/JUDGE0.md).
 */
let server: http.Server;
let seen: { headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let mode = 'ok';
let polls = 0;
let statusId = 3;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (mode === 'down') {
        res.statusCode = 503;
        return res.end('{}');
      }
      if (req.method === 'POST') {
        seen.push({ headers: req.headers, body: JSON.parse(raw) });
        return res.end(JSON.stringify({ token: 'tok-1' }));
      }
      polls += 1;
      if (mode === 'stuck') return res.end(JSON.stringify({ status_id: 2 }));
      res.end(JSON.stringify(polls < 3 ? { status_id: 2 } : { status_id: statusId, time: '0.123', memory: 2048 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  Object.assign(env.judge0, {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    apiKey: 'SECRET-KEY',
    apiHost: 'judge0.example',
    pollIntervalMs: 5,
    pollTimeoutMs: 400,
  });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
const input = { language: 'cpp' as const, code: 'int main(){}', stdin: '1 2', expectedOutput: '3', timeLimitMs: 1500, memoryLimitKb: 65536 };

describe('Judge0Adapter (protocol, local stub)', () => {
  it('sends base64 payload with limits and server-side key; polls until finished; maps AC with time/memory', async () => {
    seen = [];
    polls = 0;
    mode = 'ok';
    statusId = 3;
    const r = await new Judge0Adapter().run(input);
    expect(r).toEqual({ outcome: 'AC', timeMs: 123, memoryKb: 2048 });
    const req = seen[0];
    expect(req.headers['x-rapidapi-key']).toBe('SECRET-KEY');
    expect(req.headers['x-rapidapi-host']).toBe('judge0.example');
    expect(req.body).toMatchObject({ language_id: 54, cpu_time_limit: 1.5, memory_limit: 65536 });
    expect(Buffer.from(req.body.source_code as string, 'base64').toString()).toBe('int main(){}');
    expect(Buffer.from(req.body.stdin as string, 'base64').toString()).toBe('1 2');
    expect(polls).toBeGreaterThanOrEqual(3);
  });
  it.each([
    [4, 'WA'],
    [5, 'TLE'],
    [6, 'CE'],
    [11, 'RE'],
    [13, 'JE'],
  ])('maps Judge0 status %i to %s', async (id, verdict) => {
    polls = 0;
    mode = 'ok';
    statusId = id as number;
    expect((await new Judge0Adapter().run(input)).outcome).toBe(verdict);
  });
  it('maps every supported language to its own Judge0 language id', async () => {
    expect(LANGUAGES).toHaveLength(10);
    expect(Object.keys(DEFAULT_LANGUAGE_IDS).sort()).toEqual([...LANGUAGES].sort());
    expect(new Set(Object.values(languageIds())).size).toBe(10); // no two languages share an id
    const expected = { c: 50, cpp: 54, java: 62, python: 71, javascript: 63, typescript: 74, go: 60, csharp: 51, rust: 73, php: 68 };
    for (const lang of LANGUAGES) {
      seen = [];
      polls = 0;
      mode = 'ok';
      statusId = 3;
      await new Judge0Adapter().run({ ...input, language: lang });
      expect(seen[0].body.language_id, lang).toBe(expected[lang]);
    }
  });
  it('lets JUDGE0_LANGUAGE_IDS override single ids for a Judge0 build with different numbering', () => {
    process.env.JUDGE0_LANGUAGE_IDS = '{"java":91,"python":100}';
    expect(languageIds()).toMatchObject({ java: 91, python: 100, cpp: 54 });
    process.env.JUDGE0_LANGUAGE_IDS = 'not json';
    expect(languageIds().java).toBe(62); // bad config never breaks judging
    delete process.env.JUDGE0_LANGUAGE_IDS;
  });
  it('reports service outage and poll timeout as JudgeUnavailableError (becomes JE, never a penalty)', async () => {
    mode = 'down';
    await expect(new Judge0Adapter().run(input)).rejects.toBeInstanceOf(JudgeUnavailableError);
    mode = 'stuck';
    await expect(new Judge0Adapter().run(input)).rejects.toBeInstanceOf(JudgeUnavailableError);
  });
  it('is unavailable when not configured', async () => {
    const saved = env.judge0.baseUrl;
    env.judge0.baseUrl = '';
    await expect(new Judge0Adapter().run(input)).rejects.toBeInstanceOf(JudgeUnavailableError);
    env.judge0.baseUrl = saved;
  });
});
