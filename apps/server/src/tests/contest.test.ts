import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, hours, makeUser } from './helpers';
import { drain } from '../services/judgeService';
import { Contest, Submission } from '../models';

beforeAll(connect);
afterAll(disconnect);

const SECRET_IN = 'SECRET_HIDDEN_INPUT_42';
const SECRET_OUT = 'SECRET_HIDDEN_OUTPUT_99';
const probBody = (o: Record<string, unknown> = {}) => ({
  title: 'Sum of Two',
  statement: 'Read two integers and print their sum.',
  constraints: '1<=a,b<=1e9',
  inputDesc: 'a b',
  outputDesc: 'a+b',
  samples: [{ input: '1 2', output: '3' }],
  tags: ['math', 'implementation'],
  difficulty: 'easy',
  visibility: 'public',
  ...o,
});
async function makeProblem(setter: { token: string }, o: Record<string, unknown> = {}) {
  const p = await api('post', '/problems', setter, probBody(o));
  expect(p.status).toBe(201);
  const t = await api('put', `/problems/${p.body.data.id}/testcases`, setter, {
    cases: [
      { input: `#1\n${SECRET_IN}`, expectedOutput: SECRET_OUT },
      { input: '#2\n', expectedOutput: 'x' },
      { input: '#3\n', expectedOutput: 'y' },
    ],
  });
  expect(t.status).toBe(200);
  return p.body.data.id as string;
}
async function makeContest(org: { token: string }, problemIds: string[], o: Record<string, unknown> = {}) {
  const c = await api('post', '/contests', org, {
    title: 'Test Contest',
    startAt: hours(-2),
    endAt: hours(2),
    registrationDeadline: hours(-2), // required by the API; cleared below unless the test sets its own
    freezeAt: hours(-1),
    cooldownSec: 0,
    problems: problemIds.map((id, i) => ({ problemId: id, label: String.fromCharCode(65 + i) })),
    ...o,
  });
  expect(c.status).toBe(201);
  if (!('registrationDeadline' in o)) await Contest.updateOne({ _id: c.body.data._id }, { $unset: { registrationDeadline: 1 } });
  return c.body.data._id as string;
}
async function submit(cid: string, who: { token: string }, problemId: string, code: string, extra: Record<string, unknown> = {}) {
  const r = await api('post', `/contests/${cid}/submissions`, who, { problemId, language: 'cpp', code, ...extra });
  await drain();
  return r;
}
const verdict = async (id: string, who: { token: string }) => (await api('get', `/submissions/${id}`, who)).body.data;

async function world() {
  const org = await makeUser(['organiser']);
  const setter = await makeUser(['judge']);
  const [a, b, c] = await Promise.all([makeUser(['participant']), makeUser(['participant']), makeUser(['participant'])]);
  const pA = await makeProblem(setter);
  const pB = await makeProblem(setter, { title: 'Second Problem' });
  const cid = await makeContest(org, [pA, pB]);
  for (const u of [a, b, c]) expect((await api('post', `/contests/${cid}/register`, u)).status).toBe(201);
  return { org, setter, a, b, c, pA, pB, cid };
}

describe('hidden test-case protection', () => {
  it('never exposes hidden inputs/outputs to participants through any endpoint', async () => {
    const w = await world();
    const surfaces = [
      await api('get', `/problems/${w.pA}`, w.a),
      await api('get', `/contests/${w.cid}/problems`, w.a),
      await api('get', '/problems', w.a),
      await api('get', `/contests/${w.cid}/scoreboard`),
      await api('get', `/contests/${w.cid}/scoreboard/full`, w.a),
    ];
    const sub = await submit(w.cid, w.a, w.pA, '//MOCK:WA@1');
    surfaces.push(
      sub,
      await api('get', `/submissions/${sub.body.data.id}`, w.a),
      await api('get', `/contests/${w.cid}/submissions/me`, w.a),
      await api('get', '/me/submissions', w.a),
    );
    for (const s of surfaces) expect(JSON.stringify(s.body)).not.toMatch(new RegExp(`${SECRET_IN}|${SECRET_OUT}|expectedOutput`));
    expect((await api('get', `/problems/${w.pA}/testcases`, w.a)).status).toBe(403);
    expect((await api('put', `/problems/${w.pA}/testcases`, w.a, { cases: [{ input: 'x', expectedOutput: 'y' }] })).status).toBe(403);
    const other = await makeUser(['judge']);
    expect((await api('get', `/problems/${w.pA}/testcases`, other)).status).toBe(403); // another setter cannot read them either
    expect((await api('get', `/problems/${w.pA}/testcases`, w.setter)).body.data).toHaveLength(3);
    const bad = await api('post', `/contests/${w.cid}/submissions`, w.a, { problemId: w.pA, language: 'brainfuck', code: 'x' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain(SECRET_IN);
  });
  it('hides failed-test index and source from participants but not from setters', async () => {
    const w = await world();
    const s = await submit(w.cid, w.a, w.pA, '//MOCK:WA@2');
    const mine = await verdict(s.body.data.id, w.a);
    expect(mine.status).toBe('WA');
    expect(mine.failedTest).toBeUndefined();
    expect(mine.code).toBeUndefined();
    expect((await verdict(s.body.data.id, w.setter)).failedTest).toBe(2);
    expect((await api('get', `/submissions/${s.body.data.id}`, w.b)).status).toBe(404); // other contestant cannot read it
  });
});

describe('contest lifecycle enforced on the server', () => {
  it('enforces start/end, registration, problem membership and eligibility', async () => {
    const w = await world();
    const upcoming = await makeContest(w.org, [w.pA], { startAt: hours(1), endAt: hours(3), freezeAt: undefined });
    await api('post', `/contests/${upcoming}/register`, w.a);
    const early = await api('post', `/contests/${upcoming}/submissions`, w.a, { problemId: w.pA, language: 'cpp', code: '//MOCK:AC' });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('CONTEST_NOT_RUNNING');
    expect((await api('get', `/contests/${upcoming}/problems`, w.a)).status).toBe(403); // statements locked before start
    const over = await makeContest(w.org, [w.pA], { startAt: hours(-4), endAt: hours(-1), freezeAt: undefined });
    await api('post', `/contests/${over}/register`, w.a).then((r) => expect(r.status).toBe(422)); // cannot join an ended contest
    await Contest.updateOne({ _id: w.cid }, { endAt: new Date(Date.now() - 1000) });
    expect((await api('post', `/contests/${w.cid}/submissions`, w.a, { problemId: w.pA, language: 'cpp', code: '//MOCK:AC' })).status).toBe(422);
    await Contest.updateOne({ _id: w.cid }, { endAt: new Date(Date.now() + 3600_000) });
    const outsider = await makeUser(['participant']);
    expect((await api('post', `/contests/${w.cid}/submissions`, outsider, { problemId: w.pA, language: 'cpp', code: '//MOCK:AC' })).status).toBe(403);
    const stray = await makeProblem(w.setter);
    expect((await api('post', `/contests/${w.cid}/submissions`, w.a, { problemId: stray, language: 'cpp', code: '//MOCK:AC' })).status).toBe(422);
    expect((await api('post', `/contests/${w.cid}/register`, w.setter)).status).toBe(422); // setters cannot compete
    expect((await api('post', `/contests/${w.cid}/register`, w.a)).status).toBe(409);
    expect((await api('post', '/contests', w.a, {})).status).toBe(403);
    const noCases = (await api('post', '/problems', w.setter, probBody())).body.data.id;
    expect(
      (await api('post', '/contests', w.org, { title: 'Bad contest', startAt: hours(1), endAt: hours(2), registrationDeadline: hours(0.5), problems: [{ problemId: noCases, label: 'A' }] }))
        .status,
    ).toBe(422);
  });
  it('applies cooldown and returns the same submission for a retried idempotency key', async () => {
    const w = await world();
    await api('patch', `/contests/${w.cid}`, w.org, { cooldownSec: 30 });
    const first = await api('post', `/contests/${w.cid}/submissions`, w.a, { problemId: w.pA, language: 'cpp', code: '//MOCK:AC', idempotencyKey: 'k1' });
    expect(first.status).toBe(202);
    expect(
      (await api('post', `/contests/${w.cid}/submissions`, w.a, { problemId: w.pA, language: 'cpp', code: '//MOCK:AC', idempotencyKey: 'k2' })).status,
    ).toBe(429);
    await Contest.updateOne({ _id: w.cid }, { cooldownSec: 0 });
    const retry = await api('post', `/contests/${w.cid}/submissions`, w.a, { problemId: w.pA, language: 'cpp', code: '//MOCK:AC', idempotencyKey: 'k1' });
    expect(retry.status).toBe(200);
    expect(retry.body.data.id).toBe(first.body.data.id);
    await drain();
    expect(await Submission.countDocuments({ userId: w.a.id, contestId: w.cid })).toBe(1); // retry created no duplicate logical result
  });
});

describe('judge pipeline (MOCK adapter — see services/judge/mock.ts, test-only)', () => {
  it('maps AC / WA / TLE / RE / CE and records limits-related fields', async () => {
    const w = await world();
    const run = async (code: string) => verdict((await submit(w.cid, w.a, w.pA, code)).body.data.id, w.a);
    const ac = await run('//MOCK:AC');
    expect(ac.status).toBe('AC');
    expect(ac.timeMs).toBeGreaterThan(0);
    expect((await run('//MOCK:WA@3')).status).toBe('WA');
    expect((await run('//MOCK:TLE@1')).status).toBe('TLE');
    expect((await run('//MOCK:RE@2')).status).toBe('RE');
    expect((await run('//MOCK:CE')).status).toBe('CE');
  });
  it('judge outage becomes JE (never a penalty); transient failure is retried to a real verdict', async () => {
    const w = await world();
    const down = await verdict((await submit(w.cid, w.a, w.pA, '//MOCK:DOWN')).body.data.id, w.a);
    expect(down.status).toBe('JE');
    const flaky = await verdict((await submit(w.cid, w.b, w.pA, `//MOCK:FLAKY ${Math.random()}`)).body.data.id, w.b);
    expect(flaky.status).toBe('AC');
    const board = (await api('get', `/contests/${w.cid}/scoreboard/full`, w.setter)).body.data;
    expect(board.rows.find((r: { userId: string }) => r.userId === w.a.id).cells[0].wrong).toBe(0); // JE is not a wrong attempt
  });
  it('rejudge is limited to setters/organisers and audited', async () => {
    const w = await world();
    const s = await submit(w.cid, w.a, w.pA, '//MOCK:WA@1');
    expect((await api('post', `/submissions/${s.body.data.id}/rejudge`, w.a)).status).toBe(403);
    expect((await api('post', `/submissions/${s.body.data.id}/rejudge`, w.setter)).status).toBe(202);
    await drain();
    expect((await verdict(s.body.data.id, w.a)).status).toBe('WA');
    expect((await api('get', '/audit?entityType=Submission', w.org)).body.data.some((x: { action: string }) => x.action === 'submission.rejudge')).toBe(true);
  });
});

describe('ICPC scoring, live scoreboard and freeze', () => {
  it('freeze hides post-freeze results on every public endpoint; organiser reveal opens it', async () => {
    const w = await world();
    const start = new Date(Date.now() - 2 * 3600_000);
    const mk = (u: { id: string }, p: string, status: string, minsAfterStart: number) =>
      Submission.create({
        userId: u.id,
        problemId: p,
        contestId: w.cid,
        mode: 'contest',
        language: 'cpp',
        code: 'x',
        status,
        judgeJobKey: `${u.id}${p}${status}${minsAfterStart}`,
        submittedAt: new Date(start.getTime() + minsAfterStart * 60000 + 1000),
      });
    await mk(w.a, w.pA, 'WA', 5);
    await mk(w.a, w.pA, 'AC', 10); // before freeze (freeze = start+60min): penalty 10+20 = 30
    await mk(w.b, w.pA, 'AC', 90); // AFTER freeze
    await mk(w.c, w.pB, 'WA', 20);
    const pub = (await api('get', `/contests/${w.cid}/scoreboard`)).body.data;
    expect(pub.frozen).toBe(true);
    const rowA = pub.rows.find((r: { userId: string }) => r.userId === w.a.id);
    const rowB = pub.rows.find((r: { userId: string }) => r.userId === w.b.id);
    expect(rowA).toMatchObject({ solved: 1, penalty: 30, rank: 1 });
    expect(rowB).toMatchObject({ solved: 0 });
    expect(rowB.cells[0]).toMatchObject({ solved: false, pending: 1 });
    expect(JSON.stringify(pub)).not.toContain('"solvedAtMin":90');
    const asParticipant = (await api('get', `/contests/${w.cid}/scoreboard`, w.b)).body.data; // being logged in changes nothing
    expect(asParticipant.rows.find((r: { userId: string }) => r.userId === w.b.id).solved).toBe(0);
    expect((await api('get', `/contests/${w.cid}/scoreboard/full`, w.b)).status).toBe(403);
    const full = (await api('get', `/contests/${w.cid}/scoreboard/full`, w.setter)).body.data;
    expect(full.rows.find((r: { userId: string }) => r.userId === w.b.id).solved).toBe(1);
    expect((await api('post', `/contests/${w.cid}/reveal`, w.org)).status).toBe(422); // contest still running
    await Contest.updateOne({ _id: w.cid }, { endAt: new Date(Date.now() - 1000), revealAt: new Date(Date.now() + 3600_000) });
    expect((await api('get', `/contests/${w.cid}/scoreboard`)).body.data.frozen).toBe(true); // held until reveal time
    expect((await api('post', `/contests/${w.cid}/reveal`, w.a)).status).toBe(403);
    expect((await api('post', `/contests/${w.cid}/reveal`, w.org)).status).toBe(200);
    const after = (await api('get', `/contests/${w.cid}/scoreboard`)).body.data;
    expect(after.frozen).toBe(false);
    expect(after.rows.find((r: { userId: string }) => r.userId === w.b.id)).toMatchObject({ solved: 1, penalty: 90 });
  });
  it('unfreezes automatically when the contest ends (no reveal time set)', async () => {
    const w = await world();
    await Contest.updateOne({ _id: w.cid }, { endAt: new Date(Date.now() - 1000) });
    expect((await api('get', `/contests/${w.cid}/scoreboard`)).body.data.frozen).toBe(false);
  });
});

describe('practice mode, editorials and progress', () => {
  it('practice is separate from standings and blocked while the problem is in an unfinished contest', async () => {
    const w = await world();
    const solo = await makeProblem(w.setter, { title: 'Practice Only', tags: ['graphs'], difficulty: 'medium' });
    const priv = await makeProblem(w.setter, { title: 'Private One', visibility: 'private' });
    const prac = await api('post', `/problems/${solo}/practice-submissions`, w.a, { language: 'python', code: '//MOCK:AC' });
    expect(prac.status).toBe(202);
    await drain();
    expect((await verdict(prac.body.data.id, w.a)).status).toBe('AC');
    expect((await api('post', `/problems/${w.pA}/practice-submissions`, w.a, { language: 'cpp', code: '//MOCK:AC' })).status).toBe(404); // in a running contest
    expect((await api('post', `/problems/${priv}/practice-submissions`, w.a, { language: 'cpp', code: '//MOCK:AC' })).status).toBe(404);
    expect((await api('get', `/problems/${priv}`, w.a)).status).toBe(404);
    const listed = ((await api('get', '/problems', w.a)).body.data as { id: string }[]).map((x) => x.id);
    expect(listed).toContain(solo);
    expect(listed).not.toContain(w.pA);
    expect(listed).not.toContain(w.pB);
    expect(listed).not.toContain(priv); // contest/private problems not listed
    const board = (await api('get', `/contests/${w.cid}/scoreboard/full`, w.org)).body.data;
    expect(board.rows.every((r: { solved: number }) => r.solved === 0)).toBe(true);
    const prog = (await api('get', '/me/progress', w.a)).body.data;
    expect(prog).toMatchObject({ problemsSolved: 1, problemsAttempted: 1 });
    expect(prog.topics.graphs).toEqual({ attempted: 1, solved: 1 });
    expect(prog.difficulty.medium.solved).toBe(1);
    expect((await api('get', `/me/submissions?mode=practice`, w.a)).body.data).toHaveLength(1);
    expect((await api('get', `/me/submissions?mode=practice`, w.b)).body.data).toHaveLength(0);
    await Contest.updateOne({ _id: w.cid }, { endAt: new Date(Date.now() - 1000) });
    expect((await api('post', `/problems/${w.pA}/practice-submissions`, w.a, { language: 'cpp', code: '//MOCK:WA@1' })).status).toBe(202); // opens after the contest
    await drain();
  });
  it('editorials stay locked until the contest ends and any release time passes', async () => {
    const w = await world();
    const ed = { content: 'Use the formula a+b; watch for overflow.' };
    expect((await api('put', `/problems/${w.pA}/editorial`, w.a, ed)).status).toBe(403);
    expect((await api('put', `/problems/${w.pA}/editorial`, await makeUser(['judge']), ed)).status).toBe(403);
    expect((await api('put', `/problems/${w.pA}/editorial`, w.setter, ed)).status).toBe(200);
    const locked = await api('get', `/problems/${w.pA}/editorial`, w.a);
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('EDITORIAL_LOCKED');
    expect(JSON.stringify(locked.body)).not.toContain('formula');
    expect((await api('get', `/problems/${w.pA}/editorial`, w.setter)).status).toBe(200);
    await Contest.updateOne({ _id: w.cid }, { endAt: new Date(Date.now() - 1000) });
    expect((await api('get', `/problems/${w.pA}/editorial`, w.a)).status).toBe(200);
    await api('put', `/problems/${w.pA}/editorial`, w.setter, { ...ed, releaseAt: hours(5) });
    expect((await api('get', `/problems/${w.pA}/editorial`, w.a)).status).toBe(403);
    expect((await api('get', `/problems/${w.pB}/editorial`, w.a)).status).toBe(404); // no editorial written
  });
});
