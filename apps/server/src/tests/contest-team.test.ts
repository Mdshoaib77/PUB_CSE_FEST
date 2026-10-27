import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LANGUAGES } from '@festhub/shared';
import { api, connect, disconnect, hours, makeUser } from './helpers';
import { drain } from '../services/judgeService';
import { Contest, Problem } from '../models';
import { migrateProblemLanguages } from '../services/migrations';

beforeAll(connect);
afterAll(disconnect);

type U = Awaited<ReturnType<typeof makeUser>>;

async function makeProblem(setter: U, title = 'Sum of Two') {
  const p = await api('post', '/problems', setter, {
    title,
    statement: 'Read two integers and print their sum.',
    samples: [{ input: '1 2', output: '3' }],
    tags: ['math'],
    visibility: 'public',
  });
  expect(p.status).toBe(201);
  const t = await api('put', `/problems/${p.body.data.id}/testcases`, setter, { cases: [{ input: '#1\n1 2', expectedOutput: '3' }, { input: '#2\n', expectedOutput: 'x' }] });
  expect(t.status).toBe(200);
  return p.body.data.id as string;
}
async function makeContest(org: U, problemIds: string[], o: Record<string, unknown> = {}) {
  const c = await api('post', '/contests', org, {
    title: 'Team Cup',
    startAt: hours(-2),
    endAt: hours(2),
    registrationDeadline: hours(-2), // required by the API; cleared below unless the test sets its own
    cooldownSec: 0,
    problems: problemIds.map((id, i) => ({ problemId: id, label: String.fromCharCode(65 + i) })),
    ...o,
  });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  // most tests use an already-running contest that people still register for: keep registration open unless the test set a deadline itself
  if (!('registrationDeadline' in o)) await Contest.updateOne({ _id: c.body.data._id }, { $unset: { registrationDeadline: 1 } });
  return c.body.data._id as string;
}
async function submit(cid: string, who: U, problemId: string, code: string, language = 'cpp') {
  const r = await api('post', `/contests/${cid}/submissions`, who, { problemId, language, code });
  await drain();
  return r;
}
async function world() {
  const org = await makeUser(['organiser']);
  const setter = await makeUser(['judge']);
  const p = await Promise.all(['Alpha', 'Beta', 'Gamma'].map((t) => makeProblem(setter, t)));
  return { org, setter, p };
}

describe('contest banner image', () => {
  it('stores, shows, replaces and clears a banner, and rejects unsafe values', async () => {
    const { org, p } = await world();
    const stu = await makeUser(['participant']);
    const url = 'https://example.com/banner.jpg';
    const id = await makeContest(org, [p[0]], { bannerImage: url, description: 'Welcome' });
    const list = (await api('get', '/contests', stu)).body.data as { id: string; bannerImage: string | null; description: string }[];
    expect(list.find((c) => c.id === id)).toMatchObject({ bannerImage: url, description: 'Welcome' });
    expect((await api('get', `/contests/${id}`, stu)).body.data.bannerImage).toBe(url);

    for (const bad of ['javascript:alert(1)', 'data:image/svg+xml;base64,AAAA', '/etc/passwd', 'ftp://x/y.png'])
      expect((await api('post', '/contests', org, { title: 'Bad banner', startAt: hours(1), endAt: hours(3), registrationDeadline: hours(0.5), bannerImage: bad, problems: [{ problemId: p[0], label: 'A' }] })).status, bad).toBe(400);

    expect((await api('patch', `/contests/${id}`, org, { bannerImage: 'https://example.com/2.png' })).status).toBe(200);
    expect((await api('get', `/contests/${id}`, stu)).body.data.bannerImage).toBe('https://example.com/2.png');
    expect((await api('patch', `/contests/${id}`, org, { bannerImage: '' })).status).toBe(200);
    expect((await api('get', `/contests/${id}`, stu)).body.data.bannerImage).toBeNull();
    expect((await api('patch', `/contests/${id}`, stu, { bannerImage: url })).status).toBe(403); // organisers only
  });
});

describe('TEAM contests (ICPC style)', () => {
  it('forms teams with a join code, enforces size, one team per person and the mode rules', async () => {
    const { org, p } = await world();
    const [a1, a2, a3, a4, b1] = await Promise.all([1, 2, 3, 4, 5].map(() => makeUser(['participant'])));
    const id = await makeContest(org, [p[0]], { mode: 'TEAM', teamSize: { min: 2, max: 3 }, startAt: hours(1), endAt: hours(4) });
    expect((await api('post', `/contests/${id}/register`, a1)).status).toBe(422); // solo registration is not allowed in TEAM mode

    const made = await api('post', `/contests/${id}/teams`, a1, { name: 'Alpha Squad' });
    expect(made.status).toBe(201);
    const code = made.body.data.joinCode as string;
    expect(code).toMatch(/^[A-Z2-9]{8}$/);
    expect(made.body.data.complete).toBe(false); // 1 of min 2
    expect(made.body.data.registered).toBe(false); // creating a team does NOT register it
    expect((await api('post', `/contests/${id}/teams/${made.body.data.id}/register`, a1)).status).toBe(422); // 1 of min 2
    expect((await api('post', `/contests/${id}/teams`, a1, { name: 'Again' })).status).toBe(409); // already on a team
    expect((await api('post', `/contests/${id}/teams`, b1, { name: 'alpha squad' })).status).toBe(409); // names are unique ignoring case
    expect((await api('post', `/contests/${id}/teams/join`, a2, { joinCode: 'NOPE2222' })).status).toBe(404);

    expect((await api('post', `/contests/${id}/teams/join`, a2, { joinCode: code.toLowerCase() })).status).toBe(201);
    expect((await api('post', `/contests/${id}/teams/join`, a2, { joinCode: code })).status).toBe(409);
    expect((await api('post', `/contests/${id}/teams/join`, a3, { joinCode: code })).status).toBe(201);
    const full = await api('post', `/contests/${id}/teams/join`, a4, { joinCode: code });
    expect(full.status).toBe(422); // max 3

    const mine = (await api('get', `/contests/${id}`, a2)).body.data;
    expect(mine.mode).toBe('TEAM');
    expect(mine.myTeam).toMatchObject({ name: 'Alpha Squad', isLeader: false, complete: true });
    expect(mine.myTeam.joinCode).toBeUndefined(); // only the leader sees the code
    expect(mine.myTeam.members).toHaveLength(3);
    const lead = (await api('get', `/contests/${id}`, a1)).body.data.myTeam;
    expect(lead.joinCode).toBe(code);

    // a draft team is hidden from everyone but the staff, and the members are not registered yet
    expect((await api('get', `/contests/${id}/teams`, b1)).body.data).toHaveLength(0);
    expect((await api('get', `/contests/${id}`, a1)).body.data.registered).toBe(false);
    expect((await api('post', `/contests/${id}/teams/${made.body.data.id}/register`, a2)).status).toBe(403); // only the leader registers
    expect((await api('post', `/contests/${id}/teams/${made.body.data.id}/register`, a1)).status).toBe(200);
    expect((await api('post', `/contests/${id}/teams/${made.body.data.id}/register`, a1)).status).toBe(409); // already registered
    expect((await api('get', `/contests/${id}`, a2)).body.data.registered).toBe(true);
    const teams = (await api('get', `/contests/${id}/teams`, b1)).body.data;
    expect(teams).toHaveLength(1);
    expect(JSON.stringify(teams)).not.toContain(code); // join codes are never listed publicly
    expect((await api('get', '/contests', a1)).body.data.find((c: { id: string }) => c.id === id)).toMatchObject({ participants: 1, registered: true });

    // an individual contest refuses team creation
    const solo = await makeContest(org, [p[1]]);
    expect((await api('post', `/contests/${solo}/teams`, a1, { name: 'Nope' })).status).toBe(422);
    // mode is locked once people have registered
    expect((await api('patch', `/contests/${id}`, org, { mode: 'INDIVIDUAL' })).status).toBe(422);
  });

  it('never lets concurrent joins overfill a team', async () => {
    const { org, p } = await world();
    const id = await makeContest(org, [p[0]], { mode: 'TEAM', teamSize: { min: 1, max: 3 }, startAt: hours(1), endAt: hours(4) });
    const lead = await makeUser(['participant']);
    const crowdTeam = (await api('post', `/contests/${id}/teams`, lead, { name: 'Crowd' })).body.data;
    const code = crowdTeam.joinCode as string;
    const crowd = await Promise.all(Array.from({ length: 8 }, () => makeUser(['participant'])));
    const res = await Promise.all(crowd.map((u) => api('post', `/contests/${id}/teams/join`, u, { joinCode: code })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(2); // leader + 2 = max 3
    expect((await api('post', `/contests/${id}/teams/${crowdTeam.id}/register`, lead)).status).toBe(200);
    expect((await api('get', `/contests/${id}/teams`, lead)).body.data[0].memberCount).toBe(3);
  });

  it('lets members leave and the leader disband before the start, and locks composition afterwards', async () => {
    const { org, p } = await world();
    const [l, m] = await Promise.all([makeUser(['participant']), makeUser(['participant'])]);
    const future = await makeContest(org, [p[0]], { mode: 'TEAM', startAt: hours(1), endAt: hours(4) });
    const t = (await api('post', `/contests/${future}/teams`, l, { name: 'Leavers' })).body.data;
    await api('post', `/contests/${future}/teams/join`, m, { joinCode: t.joinCode });
    expect((await api('delete', `/contests/${future}/teams/${t.id}/members/${l.id}`, l)).status).toBe(422); // leader cannot be removed
    expect((await api('delete', `/contests/${future}/teams/${t.id}/members/${l.id}`, m)).status).toBe(403);
    expect((await api('delete', `/contests/${future}/teams/${t.id}/members/${m.id}`, m)).status).toBe(200); // leave
    expect((await api('get', `/contests/${future}/teams`, org)).body.data[0].memberCount).toBe(1); // the organiser also sees draft teams
    expect((await api('delete', `/contests/${future}/teams/${t.id}`, m)).status).toBe(403);
    expect((await api('delete', `/contests/${future}/teams/${t.id}`, l)).status).toBe(200); // disband
    expect((await api('post', `/contests/${future}/teams`, m, { name: 'Fresh' })).status).toBe(201); // free to start another

    const running = await makeContest(org, [p[0]], { mode: 'TEAM', teamSize: { min: 1, max: 3 } });
    const [l2, m2] = await Promise.all([makeUser(['participant']), makeUser(['participant'])]);
    const t2 = (await api('post', `/contests/${running}/teams`, l2, { name: 'Locked' })).body.data;
    await api('post', `/contests/${running}/teams/join`, m2, { joinCode: t2.joinCode }); // late joining is still allowed while running
    expect((await api('delete', `/contests/${running}/teams/${t2.id}/members/${m2.id}`, m2)).status).toBe(422);
    expect((await api('delete', `/contests/${running}/teams/${t2.id}`, l2)).status).toBe(422);
  });

  it('scores a team as ONE ICPC entrant: solved first, then penalty, 20 min per wrong attempt before the first AC, shared across teammates', async () => {
    const { org, p } = await world();
    const [a1, a2, b1, b2, c1] = await Promise.all([1, 2, 3, 4, 5].map(() => makeUser(['participant'])));
    const id = await makeContest(org, p, { mode: 'TEAM', teamSize: { min: 1, max: 2 }, penaltyMinutes: 20 });
    const mk = async (u: U, name: string) => (await api('post', `/contests/${id}/teams`, u, { name })).body.data;
    const A = await mk(a1, 'Team A');
    const B = await mk(b1, 'Team B');
    const C = await mk(c1, 'Team C');
    await api('post', `/contests/${id}/teams/join`, a2, { joinCode: A.joinCode });
    await api('post', `/contests/${id}/teams/join`, b2, { joinCode: B.joinCode });
    // only registered teams compete: the leaders register their teams
    for (const [leader, t] of [[a1, A], [b1, B], [c1, C]] as const) expect((await api('post', `/contests/${id}/teams/${t.id}/register`, leader)).status).toBe(200);

    // Team A: member 1 fails problem A twice (WA, then TLE), member 2 then solves it -> 2 wrong counted for the TEAM
    await submit(id, a1, p[0], '//MOCK:WA');
    await submit(id, a1, p[0], '//MOCK:TLE');
    await submit(id, a2, p[0], '//MOCK:CE'); // compile errors never count
    const solveA = await submit(id, a2, p[0], 'ok');
    expect(solveA.status).toBe(202);
    await submit(id, a1, p[0], '//MOCK:WA'); // after the first AC: ignored
    // Team B solves A and B cleanly (members split the work)
    await submit(id, b1, p[0], 'ok');
    await submit(id, b2, p[1], 'ok');
    // Team C only gets wrong answers
    await submit(id, c1, p[2], '//MOCK:RE');

    const board = (await api('get', `/contests/${id}/scoreboard`)).body.data;
    expect(board.mode).toBe('TEAM');
    expect(board.rows.map((r: { name: string }) => r.name)).toEqual(['Team B', 'Team A', 'Team C']); // 2 solved > 1 solved > 0 solved
    const [rb, ra, rc] = board.rows;
    expect(rb).toMatchObject({ rank: 1, solved: 2 });
    expect(rb.members.sort()).toHaveLength(2);
    expect(ra).toMatchObject({ rank: 2, solved: 1 });
    expect(ra.cells[0]).toMatchObject({ solved: true, wrong: 2 });
    // the contest started 120 min ago: penalty = minutes to first AC (+20 per wrong attempt before it)
    const minutes = ra.cells[0].solvedAtMin as number;
    expect(minutes).toBeGreaterThanOrEqual(119);
    expect(ra.penalty).toBe(minutes + 2 * 20);
    expect(rc).toMatchObject({ rank: 3, solved: 0, penalty: 0 });
    expect(rc.cells[2].wrong).toBe(1);
    // CE did not count and the post-AC wrong submission did not either
    expect(ra.cells[0].wrong).toBe(2);
    // problem statistics + first-solve marker
    expect(board.stats[0]).toMatchObject({ label: 'A', solvedBy: 2 });
    expect(board.stats[1]).toMatchObject({ label: 'B', solvedBy: 1 });
    expect(board.stats[2]).toMatchObject({ label: 'C', solvedBy: 0, firstSolvedAtMin: null });
    expect(rb.cells[1].firstSolve).toBe(true);
    expect(rc.cells[2].firstSolve).toBe(false);
  });

  it('blocks submitting until the team reaches the minimum size, and shows the board freeze for teams too', async () => {
    const { org, p } = await world();
    const [u1, u2, u3] = await Promise.all([1, 2, 3].map(() => makeUser(['participant'])));
    const id = await makeContest(org, [p[0]], { mode: 'TEAM', teamSize: { min: 2, max: 3 }, freezeAt: hours(-1) });
    const T = (await api('post', `/contests/${id}/teams`, u1, { name: 'Short' })).body.data;
    const early = await submit(id, u1, p[0], 'ok');
    expect(early.status).toBe(403); // not registered yet
    const tooSoon = await api('post', `/contests/${id}/teams/${T.id}/register`, u1);
    expect(tooSoon.status).toBe(422);
    expect(tooSoon.body.error.message).toContain('at least 2');
    await api('post', `/contests/${id}/teams/join`, u2, { joinCode: T.joinCode });
    expect((await api('post', `/contests/${id}/teams/${T.id}/register`, u1)).status).toBe(200);
    expect((await submit(id, u2, p[0], 'ok')).status).toBe(202);
    // a user who is on no team cannot submit
    expect((await submit(id, u3, p[0], 'ok')).status).toBe(403);
    // frozen: the public board hides the AC and only shows it as pending; staff see the truth
    const pub = (await api('get', `/contests/${id}/scoreboard`)).body.data;
    expect(pub.frozen).toBe(true);
    expect(pub.rows[0]).toMatchObject({ name: 'Short', solved: 0 });
    expect(pub.rows[0].cells[0].pending).toBe(1);
    const full = (await api('get', `/contests/${id}/scoreboard/full`, org)).body.data;
    expect(full.rows[0]).toMatchObject({ name: 'Short', solved: 1 });
  });
});

describe('multi-language submissions', () => {
  it('accepts all ten languages in contest and practice mode', async () => {
    const { org, p } = await world();
    const stu = await makeUser(['participant']);
    const id = await makeContest(org, [p[0]]);
    expect((await api('post', `/contests/${id}/register`, stu)).status).toBe(201);
    const seen = (await api('get', `/contests/${id}/problems`, stu)).body.data[0].languages as string[];
    expect([...seen].sort()).toEqual([...LANGUAGES].sort());
    for (const language of LANGUAGES) {
      const r = await submit(id, stu, p[0], `// ${language} ok`, language);
      expect(r.status, language).toBe(202);
      expect(r.body.data.language).toBe(language);
    }
    expect((await api('post', `/contests/${id}/submissions`, stu, { problemId: p[0], language: 'brainfuck', code: '+' })).status).toBe(400);
  });

  it('widens legacy four-language problems once and leaves deliberate restrictions alone', async () => {
    const { setter, p } = await world();
    await Problem.updateOne({ _id: p[0] }, { $set: { languages: ['c', 'cpp', 'java', 'python'] } });
    await Problem.updateOne({ _id: p[1] }, { $set: { languages: ['python', 'go'] } });
    expect(await migrateProblemLanguages()).toBeGreaterThanOrEqual(1);
    expect(await migrateProblemLanguages()).toBe(0); // idempotent
    expect((await Problem.findById(p[0]))!.languages).toHaveLength(10);
    expect((await Problem.findById(p[1]))!.languages).toEqual(['python', 'go']);
    expect(setter.id).toBeTruthy();
  });

  it('lets only organisers read the Judge0 language check', async () => {
    const org = await makeUser(['organiser']);
    const stu = await makeUser(['participant']);
    expect((await api('get', '/judge/languages', stu)).status).toBe(403);
    const r = await api('get', '/judge/languages', org);
    expect(r.status).toBe(200);
    expect(r.body.data).toHaveLength(10);
    expect(r.body.meta.judge0Reachable).toBe(false); // no Judge0 is configured in tests
  });
});

describe('contest registration deadline, venue and organiser list', () => {
  it('stores a venue and a registration deadline, shows them to participants and closes registration after the deadline', async () => {
    const { org, p } = await world();
    const stu = await makeUser(['participant']);
    const other = await makeUser(['participant']);
    const venue = (await api('post', '/venues', org, { name: `Contest Lab ${Date.now()}` })).body.data;
    const id = await makeContest(org, [p[0]], { startAt: hours(3), endAt: hours(6), registrationDeadline: hours(1), venueId: venue._id });
    const seen = (await api('get', `/contests/${id}`, stu)).body.data;
    expect(seen.venue).toMatchObject({ id: venue._id, name: venue.name });
    expect(seen.registrationDeadline).toBeTruthy();
    expect(seen.registrationOpen).toBe(true);
    const listed = (await api('get', '/contests', stu)).body.data.find((c: { id: string }) => c.id === id);
    expect(listed.venue.name).toBe(venue.name);
    expect((await api('post', `/contests/${id}/register`, stu)).status).toBe(201); // individual contest: registered straight away
    expect((await api('get', `/contests/${id}`, stu)).body.data.registered).toBe(true);

    // bad values
    const body = { title: 'Late deadline', startAt: hours(1), endAt: hours(3), problems: [{ problemId: p[0], label: 'A' }] };
    expect((await api('post', '/contests', org, { ...body, registrationDeadline: hours(2) })).status).toBe(422); // after the start
    expect((await api('post', '/contests', org, { ...body, registrationDeadline: hours(0.5), venueId: '0123456789abcdef01234567' })).status).toBe(422); // no such venue
    expect((await api('post', '/contests', org, body)).status).toBe(400); // the registration deadline is required

    // closed registration
    const closed = await makeContest(org, [p[0]], { startAt: hours(1), endAt: hours(3), registrationDeadline: hours(-1) });
    expect((await api('get', `/contests/${closed}`, other)).body.data.registrationOpen).toBe(false);
    const refused = await api('post', `/contests/${closed}/register`, other);
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toContain('closed');
    // the organiser can move the deadline and clear the venue, but the deadline itself cannot be cleared
    expect((await api('patch', `/contests/${closed}`, org, { registrationDeadline: null })).status).toBe(400);
    expect((await api('patch', `/contests/${closed}`, org, { registrationDeadline: hours(0.5), venueId: null })).status).toBe(200);
    expect((await api('get', `/contests/${closed}`, other)).body.data).toMatchObject({ registrationOpen: true, venue: null });
    expect((await api('post', `/contests/${closed}/register`, other)).status).toBe(201);
  });

  it('keeps a team a draft until the leader registers it (no problems, no submissions, not on the scoreboard)', async () => {
    const { org, p } = await world();
    const [l, m] = await Promise.all([makeUser(['participant']), makeUser(['participant'])]);
    const id = await makeContest(org, [p[0]], { mode: 'TEAM', teamSize: { min: 2, max: 3 } });
    const T = (await api('post', `/contests/${id}/teams`, l, { name: 'Drafty' })).body.data;
    expect(T.registered).toBe(false);
    expect((await submit(id, l, p[0], 'ok')).status).toBe(403);
    expect((await api('get', `/contests/${id}/problems`, l)).status).toBe(403);
    expect((await api('post', `/contests/${id}/teams/${T.id}/register`, l)).status).toBe(422); // 1 of min 2
    await api('post', `/contests/${id}/teams/join`, m, { joinCode: T.joinCode });
    expect((await api('get', `/contests/${id}/scoreboard`)).body.data.rows).toHaveLength(0);
    expect((await api('post', `/contests/${id}/teams/${T.id}/register`, m)).status).toBe(403);

    // the organiser sees the draft team before it registers
    const before = (await api('get', `/contests/${id}/registrations`, org)).body.data;
    expect(before.summary).toMatchObject({ registered: 0, draftTeams: 1 });
    expect(before.rows[0]).toMatchObject({ name: 'Drafty', status: 'draft', memberCount: 2 });

    const done = await api('post', `/contests/${id}/teams/${T.id}/register`, l);
    expect(done.status).toBe(200);
    expect(done.body.data.registered).toBe(true);
    expect((await api('get', `/contests/${id}/problems`, m)).status).toBe(200);
    expect((await submit(id, m, p[0], 'ok')).status).toBe(202);
    expect((await api('get', `/contests/${id}/scoreboard`)).body.data.rows).toHaveLength(1);

    const after = (await api('get', `/contests/${id}/registrations`, org)).body.data;
    expect(after.summary).toMatchObject({ registered: 1, draftTeams: 0 });
    expect(after.rows[0].members.map((x: { email: string }) => x.email).sort()).toEqual([l.email, m.email].sort());
    expect((await api('get', `/contests/${id}/registrations`, l)).status).toBe(403); // staff only
  });

  it('keeps a registered team at the minimum size, lets the leader cancel the registration, and enforces the deadline', async () => {
    const { org, p } = await world();
    const [l, m] = await Promise.all([makeUser(['participant']), makeUser(['participant'])]);
    const id = await makeContest(org, [p[0]], { mode: 'TEAM', teamSize: { min: 2, max: 3 }, startAt: hours(3), endAt: hours(6), registrationDeadline: hours(1) });
    const T = (await api('post', `/contests/${id}/teams`, l, { name: 'Steady' })).body.data;
    await api('post', `/contests/${id}/teams/join`, m, { joinCode: T.joinCode });
    expect((await api('post', `/contests/${id}/teams/${T.id}/register`, l)).status).toBe(200);
    const tooFew = await api('delete', `/contests/${id}/teams/${T.id}/members/${m.id}`, m);
    expect(tooFew.status).toBe(422); // a registered team may not drop below the minimum
    expect((await api('delete', `/contests/${id}/teams/${T.id}/register`, m)).status).toBe(403); // only the leader
    expect((await api('delete', `/contests/${id}/teams/${T.id}/register`, l)).status).toBe(200);
    expect((await api('get', `/contests/${id}`, l)).body.data.registered).toBe(false);
    expect((await api('delete', `/contests/${id}/teams/${T.id}/members/${m.id}`, m)).status).toBe(200); // a draft team can change freely

    // after the deadline nobody can create, join or register
    const late = await makeContest(org, [p[0]], { mode: 'TEAM', teamSize: { min: 1, max: 2 }, startAt: hours(2), endAt: hours(5), registrationDeadline: hours(1) });
    const L = (await api('post', `/contests/${late}/teams`, l, { name: 'Early Bird' })).body.data;
    await api('patch', `/contests/${late}`, org, { registrationDeadline: new Date(Date.now() - 60_000).toISOString() });
    expect((await api('post', `/contests/${late}/teams/${L.id}/register`, l)).status).toBe(422);
    expect((await api('post', `/contests/${late}/teams/join`, m, { joinCode: L.joinCode })).status).toBe(422);
    expect((await api('post', `/contests/${late}/teams`, m, { name: 'Too late' })).status).toBe(422);
  });

  it('lists individual registrations for the organiser and labels submissions A, B, C', async () => {
    const { org, p } = await world();
    const stu = await makeUser(['participant']);
    const id = await makeContest(org, [p[0], p[1]]);
    expect((await api('post', `/contests/${id}/register`, stu)).status).toBe(201);
    const list = (await api('get', `/contests/${id}/registrations`, org)).body.data;
    expect(list.mode).toBe('INDIVIDUAL');
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ email: stu.email, status: 'registered' });
    expect((await api('get', `/contests/${id}/registrations`, stu)).status).toBe(403);

    expect((await submit(id, stu, p[1], 'ok')).status).toBe(202);
    const mine = (await api('get', `/contests/${id}/submissions/me`, stu)).body.data;
    expect(mine[0]).toMatchObject({ problemLabel: 'B', problemTitle: 'Beta' });
    const all = (await api('get', `/contests/${id}/submissions`, org)).body.data;
    expect(all[0]).toMatchObject({ problemLabel: 'B', userName: expect.any(String) });
  });
});
