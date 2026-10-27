import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { api, app, connect, disconnect, hours, makeUser } from './helpers';
import { Registration, Seat, ShiftAssignment, User, CheckInToken } from '../models';
import { env } from '../config/env';

beforeAll(connect);
afterAll(disconnect);

const eventBody = (o: Record<string, unknown> = {}) => ({
  title: 'Test Event',
  type: 'competition',
  description: 'd',
  startAt: hours(48),
  endAt: hours(52),
  registrationDeadline: hours(24),
  capacity: 5,
  participationType: 'individual',
  requiresApproval: false,
  ...o,
});
async function publishedEvent(org: { token: string }, o: Record<string, unknown> = {}) {
  const c = await api('post', '/events', org, eventBody(o));
  expect(c.status).toBe(201);
  const p = await api('post', `/events/${c.body.data._id}/publish`, org);
  expect(p.status).toBe(200);
  return c.body.data._id as string;
}

describe('auth & RBAC', () => {
  it('registers, hashes the password, never returns secrets', async () => {
    const res = await request(app).post('/api/v1/auth/register').send({ name: 'Alice Test', email: 'Alice@Test.local', password: 'Password123' });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|Password123/);
    expect(res.body.data.user.roles).toEqual(['participant']);
    const u = await User.findOne({ email: 'alice@test.local' }).select('+passwordHash');
    expect(u!.passwordHash).not.toContain('Password123');
    expect(u!.passwordHash.startsWith('$2')).toBe(true);
  });
  it('rejects self-assigned staff roles and duplicate emails and weak passwords', async () => {
    expect(
      (await request(app).post('/api/v1/auth/register').send({ name: 'Eve Evil', email: 'eve@test.local', password: 'Password123', role: 'organiser' })).status,
    ).toBe(400);
    expect((await request(app).post('/api/v1/auth/register').send({ name: 'Alice Two', email: 'alice@test.local', password: 'Password123' })).status).toBe(409);
    expect((await request(app).post('/api/v1/auth/register').send({ name: 'Weak', email: 'weak@test.local', password: '123' })).status).toBe(400);
  });
  it('login failures are generic; /me needs a token; cookies refresh and logout works', async () => {
    const bad = await request(app).post('/api/v1/auth/login').send({ email: 'alice@test.local', password: 'wrong-pass' });
    const none = await request(app).post('/api/v1/auth/login').send({ email: 'nobody@test.local', password: 'wrong-pass' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe(none.body.error.message);
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
    const agent = request.agent(app);
    const login = await agent.post('/api/v1/auth/login').send({ email: 'alice@test.local', password: 'Password123' });
    expect((login.headers['set-cookie'] as unknown as string[]).join(';')).toMatch(/HttpOnly/i);
    const ref = await agent.post('/api/v1/auth/refresh');
    expect(ref.status).toBe(200);
    await agent.post('/api/v1/auth/logout');
    expect((await agent.post('/api/v1/auth/refresh')).status).toBe(401);
  });
  it('enforces roles on the server and applies role changes immediately', async () => {
    const org = await makeUser(['organiser']);
    const p = await makeUser(['participant']);
    expect((await api('post', '/events', p, eventBody())).status).toBe(403);
    expect((await api('get', '/users', p)).status).toBe(403);
    expect((await api('post', '/events', org, eventBody())).status).toBe(201);
    expect((await api('patch', `/users/${p.id}/roles`, p, { roles: ['organiser'] })).status).toBe(403);
    expect((await api('patch', `/users/${p.id}/roles`, org, { roles: ['coordinator'] })).status).toBe(200);
    expect((await api('get', '/users', p)).status).toBe(200); // old token, new role: re-read from DB
    expect((await api('post', '/events', p, eventBody())).status).toBe(403);
  });
  it('hides draft events from the public', async () => {
    const org = await makeUser(['organiser']);
    const p = await makeUser(['participant']);
    const c = await api('post', '/events', org, eventBody({ title: 'Secret Draft' }));
    expect((await api('get', `/events/${c.body.data._id}`, p)).status).toBe(404);
    expect(JSON.stringify((await api('get', '/events', p)).body)).not.toContain('Secret Draft');
  });
});

describe('registration, capacity and waiting list', () => {
  it('never exceeds capacity under concurrent registration; waitlist positions are unique', async () => {
    const org = await makeUser(['organiser']);
    const id = await publishedEvent(org, { capacity: 5 });
    const users = await Promise.all(Array.from({ length: 16 }, () => makeUser(['participant'])));
    const results = await Promise.all(users.map((u) => api('post', `/events/${id}/register`, u)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const regs = await Registration.find({ eventId: id });
    expect(regs.filter((r) => r.status === 'confirmed')).toHaveLength(5);
    const waiting = regs.filter((r) => r.status === 'waitlisted');
    expect(waiting).toHaveLength(11);
    expect(new Set(waiting.map((w) => w.waitlistPosition)).size).toBe(11);
    expect(await Seat.countDocuments({ eventId: id })).toBe(5);
  });
  it('blocks duplicates, closed deadlines and wrong eligibility', async () => {
    const org = await makeUser(['organiser']);
    const u = await makeUser(['participant'], { department: 'CSE' });
    const id = await publishedEvent(org);
    expect((await api('post', `/events/${id}/register`, u)).status).toBe(201);
    expect((await api('post', `/events/${id}/register`, u)).status).toBe(409);
    const closed = await publishedEvent(org, { registrationDeadline: hours(-1), startAt: hours(2), endAt: hours(4) });
    expect((await api('post', `/events/${closed}/register`, u)).status).toBe(422);
    const eee = await publishedEvent(org, { eligibility: { department: 'EEE' } });
    const r = await api('post', `/events/${eee}/register`, u);
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('EEE');
  });
  it('promotes the first waitlisted person (FIFO) when a seat opens; double-cancel is rejected', async () => {
    const org = await makeUser(['organiser']);
    const id = await publishedEvent(org, { capacity: 1 });
    const [a, b, c] = await Promise.all([makeUser(['participant']), makeUser(['participant']), makeUser(['participant'])]);
    const ra = await api('post', `/events/${id}/register`, a);
    const rb = await api('post', `/events/${id}/register`, b);
    const rc = await api('post', `/events/${id}/register`, c);
    expect([ra.body.data.status, rb.body.data.status, rc.body.data.status]).toEqual(['confirmed', 'waitlisted', 'waitlisted']);
    expect((await api('delete', `/registrations/${ra.body.data._id}`, b)).status).toBe(403); // not yours
    expect((await api('delete', `/registrations/${ra.body.data._id}`, a)).status).toBe(200);
    expect((await Registration.findById(rb.body.data._id))!.status).toBe('confirmed');
    expect((await Registration.findById(rc.body.data._id))!.status).toBe('waitlisted');
    expect(await Seat.countDocuments({ eventId: id })).toBe(1);
    expect((await api('delete', `/registrations/${ra.body.data._id}`, a)).status).toBe(409);
    expect((await api('post', `/events/${id}/register`, a)).status).toBe(201); // can re-register after cancelling
  });
  it('approval flow: pending holds a seat, rejection frees it, only staff decide', async () => {
    const org = await makeUser(['organiser']);
    const [a, b] = await Promise.all([makeUser(['participant']), makeUser(['participant'])]);
    const id = await publishedEvent(org, { capacity: 1, requiresApproval: true });
    const ra = await api('post', `/events/${id}/register`, a);
    const rb = await api('post', `/events/${id}/register`, b);
    expect([ra.body.data.status, rb.body.data.status]).toEqual(['pending_approval', 'waitlisted']);
    expect((await api('post', `/registrations/${ra.body.data._id}/approve`, a)).status).toBe(403);
    expect((await api('post', `/registrations/${ra.body.data._id}/reject`, org)).status).toBe(200);
    expect((await Registration.findById(rb.body.data._id))!.status).toBe('pending_approval'); // promoted, now awaiting approval
    expect((await api('post', `/registrations/${rb.body.data._id}/approve`, org)).status).toBe(200);
    expect((await api('post', `/registrations/${rb.body.data._id}/approve`, org)).status).toBe(409);
  });
  it('raising capacity promotes waitlisted people; lowering below taken seats is refused', async () => {
    const org = await makeUser(['organiser']);
    const us = await Promise.all([makeUser(['participant']), makeUser(['participant']), makeUser(['participant'])]);
    const id = await publishedEvent(org, { capacity: 1 });
    for (const u of us) await api('post', `/events/${id}/register`, u);
    expect((await api('patch', `/events/${id}`, org, { capacity: 3 })).status).toBe(200);
    expect(await Registration.countDocuments({ eventId: id, status: 'confirmed' })).toBe(3);
    expect((await api('patch', `/events/${id}`, org, { capacity: 2 })).status).toBe(422);
  });
  it('team events: invitations, size limits, one team per person, locked roster', async () => {
    const org = await makeUser(['organiser']);
    const id = await publishedEvent(org, { participationType: 'team', teamSize: { min: 2, max: 2 } });
    const [lead, mate, extra, other] = await Promise.all([
      makeUser(['participant']),
      makeUser(['participant']),
      makeUser(['participant']),
      makeUser(['participant']),
    ]);
    expect((await api('post', `/events/${id}/register`, lead)).status).toBe(422); // individual route blocked
    const team = await api('post', `/events/${id}/teams`, lead, { name: 'Alpha' });
    expect(team.status).toBe(201);
    expect((await api('post', `/events/${id}/register`, lead, { teamId: team.body.data._id })).status).toBe(422); // too small
    expect((await api('post', `/teams/${team.body.data._id}/invitations`, mate, { email: extra.email })).status).toBe(403); // not the leader
    const inv = await api('post', `/teams/${team.body.data._id}/invitations`, lead, { email: mate.email });
    expect(inv.status).toBe(201);
    expect((await api('post', `/invitations/${inv.body.data._id}/accept`, extra)).status).toBe(404); // not your invitation
    expect((await api('post', `/invitations/${inv.body.data._id}/accept`, mate)).status).toBe(200);
    expect((await api('post', `/teams/${team.body.data._id}/invitations`, lead, { email: extra.email })).status).toBe(422); // full
    const t2 = await api('post', `/events/${id}/teams`, other, { name: 'Beta' });
    expect((await api('post', `/teams/${t2.body.data._id}/invitations`, other, { email: mate.email })).status).toBe(409); // already in a team
    const reg = await api('post', `/events/${id}/register`, lead, { teamId: team.body.data._id });
    expect(reg.status).toBe(201);
    expect(reg.body.data.status).toBe('confirmed');
    expect((await api('post', `/events/${id}/register`, mate, { teamId: team.body.data._id })).status).toBe(403); // only the leader registers
    expect((await api('delete', `/teams/${team.body.data._id}/members/${mate.id}`, lead)).status).toBe(422); // roster locked
  });
});

describe('scheduling, volunteers and replacements', () => {
  it('rejects venue clashes with an actionable message; touching times are fine', async () => {
    const org = await makeUser(['organiser']);
    const id = await publishedEvent(org);
    const venue = (await api('post', '/venues', org, { name: `Hall ${Date.now()}` })).body.data._id;
    const mk = (title: string, s: number, e: number, v = venue) =>
      api('post', `/events/${id}/activities`, org, { title, kind: 'workshop', start: hours(s), end: hours(e), venueId: v });
    expect((await mk('Keynote', 50, 52)).status).toBe(201);
    const bad = await mk('Overlap Talk', 51, 53);
    expect(bad.status).toBe(409);
    expect(bad.body.error.message).toContain('Keynote');
    expect(bad.body.error.message).toMatch(/Pick another venue|move this activity/);
    expect(bad.body.error.details.conflicts).toHaveLength(1);
    expect((await mk('Right After', 52, 53)).status).toBe(201);
    const v2 = (await api('post', '/venues', org, { name: `Lab ${Date.now()}` })).body.data._id;
    expect((await mk('Other Venue', 51, 53, v2)).status).toBe(201);
    const act = (await mk('Movable', 60, 61)).body.data._id;
    expect((await api('patch', `/activities/${act}`, org, { start: hours(51), end: hours(52) })).status).toBe(409);
    expect((await api('post', `/events/${id}/activities`, await makeUser(['participant']), {})).status).toBe(403);
  });
  it('detects volunteer double-booking and missing availability; replacement needs coordinator approval', async () => {
    const org = await makeUser(['organiser']);
    const coord = await makeUser(['coordinator']);
    const id = await publishedEvent(org);
    const [v1, v2, p] = await Promise.all([makeUser(['volunteer']), makeUser(['volunteer']), makeUser(['participant'])]);
    const mkShift = async (title: string, s: number, e: number) =>
      (await api('post', `/events/${id}/shifts`, coord, { title, start: hours(s), end: hours(e), requiredCount: 1 })).body.data._id as string;
    const s1 = await mkShift('Registration desk', 50, 52);
    const s2 = await mkShift('Stage crew', 51, 53);
    for (const v of [v1, v2]) await api('put', `/me/availability/${id}`, v, { slots: [{ start: hours(40), end: hours(60) }] });
    const noAvail = await makeUser(['volunteer']);
    expect((await api('post', `/shifts/${s1}/assign`, coord, { volunteerId: noAvail.id })).status).toBe(422);
    expect((await api('post', `/shifts/${s1}/assign`, p, { volunteerId: v1.id })).status).toBe(403);
    const a1 = await api('post', `/shifts/${s1}/assign`, coord, { volunteerId: v1.id });
    expect(a1.status).toBe(201);
    const dbl = await api('post', `/shifts/${s2}/assign`, coord, { volunteerId: v1.id });
    expect(dbl.status).toBe(409);
    expect(dbl.body.error.message).toContain('Registration desk');
    expect((await api('post', `/shifts/${s1}/assign`, coord, { volunteerId: v2.id })).status).toBe(422); // shift already full
    // replacement
    expect((await api('post', `/assignments/${a1.body.data._id}/replacement`, v2, { reason: 'I am sick' })).status).toBe(403);
    const rr = await api('post', `/assignments/${a1.body.data._id}/replacement`, v1, { reason: 'I am sick' });
    expect(rr.status).toBe(201);
    expect((await api('post', `/assignments/${a1.body.data._id}/replacement`, v1, { reason: 'again' })).status).toBe(409);
    expect((await api('post', `/replacements/${rr.body.data._id}/approve`, v1, { volunteerId: v2.id })).status).toBe(403); // cannot self-approve
    // v2 busy at the same time -> approval blocked and request stays pending
    await api('post', `/shifts/${s2}/assign`, coord, { volunteerId: v2.id });
    expect((await api('post', `/replacements/${rr.body.data._id}/approve`, coord, { volunteerId: v2.id })).status).toBe(409);
    await ShiftAssignment.updateMany({ volunteerId: v2.id }, { status: 'cancelled' });
    expect((await api('post', `/replacements/${rr.body.data._id}/approve`, coord, { volunteerId: v2.id })).status).toBe(200);
    expect((await ShiftAssignment.findById(a1.body.data._id))!.status).toBe('replaced');
    expect(await ShiftAssignment.countDocuments({ shiftId: s1, volunteerId: v2.id, status: 'assigned' })).toBe(1);
    expect((await api('post', `/replacements/${rr.body.data._id}/approve`, coord, { volunteerId: v2.id })).status).toBe(409);
  });
  it('readiness dashboard reports uncovered shifts, missing judges, conflicts', async () => {
    const org = await makeUser(['organiser']);
    const id = await publishedEvent(org);
    const venue = (await api('post', '/venues', org, { name: `RH ${Date.now()}` })).body.data._id;
    await api('post', `/events/${id}/activities`, org, { title: 'Hack Comp', kind: 'competition', start: hours(50), end: hours(52), venueId: venue });
    await api('post', `/events/${id}/shifts`, org, { title: 'Gate', start: hours(50), end: hours(52), requiredCount: 2 });
    const rd = await api('get', `/events/${id}/readiness`, org);
    expect(rd.status).toBe(200);
    expect(rd.body.data.uncoveredShifts).toHaveLength(1);
    expect(rd.body.data.missingJudges).toHaveLength(1);
    expect(rd.body.data.missingRubrics).toHaveLength(1);
    expect(rd.body.data.status).not.toBe('ready');
    expect((await api('get', `/events/${id}/readiness`, await makeUser(['participant']))).status).toBe(403);
  });
});

describe('QR check-in, attendance, issues', () => {
  async function setup() {
    const org = await makeUser(['organiser']);
    const coord = await makeUser(['coordinator']);
    const id = await publishedEvent(org);
    const [part, vol, stranger] = await Promise.all([makeUser(['participant']), makeUser(['volunteer']), makeUser(['volunteer'])]);
    const reg = await api('post', `/events/${id}/register`, part);
    const shift = (await api('post', `/events/${id}/shifts`, coord, { title: 'Check-in desk', start: hours(-1), end: hours(2), requiredCount: 1 })).body.data
      ._id;
    await api('put', `/me/availability/${id}`, vol, { slots: [{ start: hours(-2), end: hours(3) }] });
    const as = await api('post', `/shifts/${shift}/assign`, coord, { volunteerId: vol.id });
    expect(as.status).toBe(201);
    return { org, coord, id, part, vol, stranger, reg: reg.body.data, assignment: as.body.data };
  }
  it('lets an operator check someone in by typing the registration code when the camera is unavailable', async () => {
    const s = await setup();
    const t = (await api('get', `/me/checkin-token/${s.id}`, s.part)).body.data;
    expect(t.manualCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    // the code is stable between refreshes: it is the person's registration code, the QR token is the short-lived part
    expect((await api('get', `/me/checkin-token/${s.id}`, s.part)).body.data.manualCode).toBe(t.manualCode);
    expect((await api('post', '/checkin/scan', s.part, { token: t.manualCode })).status).toBe(403); // participants cannot operate check-in
    expect((await api('post', '/checkin/scan', s.stranger, { token: t.manualCode })).status).toBe(403); // not rostered
    const bad = await api('post', '/checkin/scan', s.vol, { token: 'ZZZZ-ZZZZ' });
    expect(bad.status).toBe(400);
    expect((await api('post', '/checkin/scan', s.vol, { token: 'abc' })).status).toBe(400); // neither a token nor a code
    // forgiving input: lower case, spaces, no dash
    const typed = t.manualCode.toLowerCase().replace('-', '  ');
    const ok1 = await api('post', '/checkin/scan', s.vol, { token: typed });
    expect(ok1.status).toBe(201);
    expect(ok1.body.data.type).toBe('participant');
    const dup = await api('post', '/checkin/scan', s.vol, { token: t.manualCode });
    expect(dup.status).toBe(409); // same once-only rule as a camera scan
    // a pasted QR token with surrounding quotes/newlines still works for someone else
    const other = await makeUser(['participant']);
    await api('post', `/events/${s.id}/register`, other);
    const tok = (await api('get', `/me/checkin-token/${s.id}`, other)).body.data.token;
    expect((await api('post', '/checkin/scan', s.vol, { token: `"${tok}"\n` })).status).toBe(201);
  });
  it('issues tokens only to eligible people; scans once; blocks duplicates, tampering, revoked and un-rostered operators', async () => {
    const s = await setup();
    const waitlistedUser = await makeUser(['participant']);
    expect((await api('get', `/me/checkin-token/${s.id}`, waitlistedUser)).status).toBe(422);
    const tk = await api('get', `/me/checkin-token/${s.id}`, s.part);
    expect(tk.status).toBe(200);
    const token = tk.body.data.token as string;
    const claims = jwt.decode(token) as jwt.JwtPayload;
    expect(claims.exp! - claims.iat!).toBe(env.qrTokenTtlSec); // short-lived
    expect(tk.body.data.ttlSec).toBe(env.qrTokenTtlSec);
    const refreshed = (await api('get', `/me/checkin-token/${s.id}`, s.part)).body.data.token as string;
    expect((jwt.decode(refreshed) as jwt.JwtPayload).jti).toBe(claims.jti); // same identity, new lease
    expect((await api('post', '/checkin/scan', s.part, { token })).status).toBe(403); // participants cannot operate check-in
    expect((await api('post', '/checkin/scan', s.stranger, { token })).status).toBe(403); // volunteer not on the roster
    expect((await api('post', '/checkin/scan', s.vol, { token: token.slice(0, -3) + 'abc' })).status).toBe(400);
    expect((await api('post', '/checkin/scan', s.vol, { token: jwt.sign({ sub: 'x' }, 'wrong-secret') })).status).toBe(400);
    const ok1 = await api('post', '/checkin/scan', s.vol, { token });
    expect(ok1.status).toBe(201);
    expect(ok1.body.data.type).toBe('participant');
    const dup = await api('post', '/checkin/scan', s.vol, { token });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toContain('already checked in');
    const att = await api('get', `/events/${s.id}/attendance`, s.coord);
    expect(att.body.data.checkIns).toHaveLength(1);
    expect(att.body.data.checkIns[0].operator).toBeTruthy();
    // concurrent double scan -> exactly one success
    const other = await makeUser(['participant']);
    await api('post', `/events/${s.id}/register`, other);
    const t2 = (await api('get', `/me/checkin-token/${s.id}`, other)).body.data.token;
    const both = await Promise.all([api('post', '/checkin/scan', s.vol, { token: t2 }), api('post', '/checkin/scan', s.coord, { token: t2 })]);
    expect(both.map((x) => x.status).sort()).toEqual([201, 409]);
  });
  it('revoked and ineligible tokens are rejected; volunteer scan marks attendance', async () => {
    const s = await setup();
    const t = (await api('get', `/me/checkin-token/${s.id}`, s.part)).body.data.token;
    const rec = await CheckInToken.findOne({ userId: s.part.id });
    await api('post', `/checkin/tokens/${rec!.id}/revoke`, s.coord);
    expect((await api('post', '/checkin/scan', s.coord, { token: t })).status).toBe(403);
    expect((await api('get', `/me/checkin-token/${s.id}`, s.part)).status).toBe(403);
    const p2 = await makeUser(['participant']);
    const r2 = await api('post', `/events/${s.id}/register`, p2);
    const t2 = (await api('get', `/me/checkin-token/${s.id}`, p2)).body.data.token;
    await api('delete', `/registrations/${r2.body.data._id}`, p2);
    const ine = await api('post', '/checkin/scan', s.coord, { token: t2 });
    expect(ine.status).toBe(422);
    expect(ine.body.error.code).toBe('INELIGIBLE');
    const vt = (await api('get', `/me/checkin-token/${s.id}?as=volunteer`, s.vol)).body.data.token;
    expect((await api('post', '/checkin/scan', s.coord, { token: vt })).status).toBe(201);
    expect((await ShiftAssignment.findById(s.assignment._id))!.attendance).toBe('present');
  });
  it('tasks and issues: owner, resolution required, permissions', async () => {
    const s = await setup();
    const task = await api('post', `/events/${s.id}/tasks`, s.coord, { title: 'Set up banners', assigneeId: s.vol.id });
    expect((await api('patch', `/tasks/${task.body.data._id}/complete`, s.stranger)).status).toBe(403);
    expect((await api('patch', `/tasks/${task.body.data._id}/complete`, s.vol)).body.data.status).toBe('done');
    const iss = await api('post', `/events/${s.id}/issues`, s.vol, { title: 'Projector broken', priority: 'high' });
    expect(iss.status).toBe(201);
    expect((await api('post', `/events/${s.id}/issues`, s.part, { title: 'nope nope' })).status).toBe(403);
    expect((await api('patch', `/issues/${iss.body.data._id}`, s.vol, { status: 'resolved' })).status).toBe(403); // not owner
    expect((await api('patch', `/issues/${iss.body.data._id}`, s.coord, { ownerId: s.vol.id, status: 'in_progress' })).status).toBe(200);
    expect((await api('patch', `/issues/${iss.body.data._id}`, s.vol, { status: 'resolved' })).status).toBe(422); // needs resolution
    const done = await api('patch', `/issues/${iss.body.data._id}`, s.vol, { status: 'resolved', resolution: 'Swapped projector' });
    expect(done.status).toBe(200);
    expect(done.body.data.resolvedAt).toBeTruthy();
    expect((await api('post', `/issues/${iss.body.data._id}/comments`, s.coord, { text: 'Thanks' })).body.data.comments).toHaveLength(1);
  });
});

describe('competition entries, judging and approved results', () => {
  async function setup() {
    const org = await makeUser(['organiser']);
    const id = await publishedEvent(org);
    const venue = (await api('post', '/venues', org, { name: `JV ${Date.now()}${Math.random()}` })).body.data._id;
    const act = (
      await api('post', `/events/${id}/activities`, org, { title: 'Poster Contest', kind: 'competition', start: hours(50), end: hours(52), venueId: venue })
    ).body.data._id;
    const [p1, p2, j1, j2] = await Promise.all([makeUser(['participant']), makeUser(['participant']), makeUser(['judge']), makeUser(['judge'])]);
    await api('post', `/events/${id}/register`, p1);
    await api('post', `/events/${id}/register`, p2);
    await api('put', `/activities/${act}/rubric`, org, {
      criteria: [
        { name: 'Idea', maxScore: 10, weight: 2 },
        { name: 'Design', maxScore: 10, weight: 1 },
      ],
    });
    return { org, id, act, p1, p2, j1, j2 };
  }
  it('keeps entry version history; only owners and assigned judges can read it', async () => {
    const s = await setup();
    const e = await api('post', `/activities/${s.act}/entries`, s.p1, { title: 'My poster', content: 'v1 text' });
    expect(e.status).toBe(201);
    expect((await api('post', `/activities/${s.act}/entries`, s.p1, { title: 'again' })).status).toBe(409);
    const v2 = await api('put', `/entries/${e.body.data._id}`, s.p1, { content: 'v2 text' });
    expect(v2.body.data.version).toBe(2);
    const vs = (await api('get', `/entries/${e.body.data._id}/versions`, s.p1)).body.data;
    expect(vs.map((v: { content: string }) => v.content)).toEqual(['v1 text', 'v2 text']);
    expect((await api('put', `/entries/${e.body.data._id}`, s.p2, { content: 'hijack' })).status).toBe(403);
    expect((await api('get', `/entries/${e.body.data._id}/versions`, s.p2)).status).toBe(403);
    const par = await Promise.all([1, 2, 3].map((i) => api('put', `/entries/${e.body.data._id}`, s.p1, { content: `par ${i}` })));
    expect(par.every((x) => x.status === 201)).toBe(true);
    expect(new Set(par.map((x) => x.body.data.version)).size).toBe(3); // concurrent updates never collide or overwrite
    expect((await api('post', `/activities/${s.act}/entries`, await makeUser(['participant']), { title: 'x1' })).status).toBe(422); // not registered
  });
  it('restricts judges to assigned entries, validates scores, requires organiser approval', async () => {
    const s = await setup();
    const e1 = (await api('post', `/activities/${s.act}/entries`, s.p1, { title: 'Entry One', content: 'a' })).body.data._id;
    const e2 = (await api('post', `/activities/${s.act}/entries`, s.p2, { title: 'Entry Two', content: 'b' })).body.data._id;
    const scores = (a: number, b: number) => ({
      criterionScores: [
        { name: 'Idea', score: a },
        { name: 'Design', score: b },
      ],
      feedback: 'ok',
    });
    expect((await api('put', `/entries/${e1}/score`, s.j1, scores(5, 5))).status).toBe(403); // not assigned
    expect((await api('post', `/entries/${e1}/judges`, s.j1, { judgeId: s.j1.id })).status).toBe(403); // judge cannot assign
    for (const j of [s.j1, s.j2]) {
      expect((await api('post', `/entries/${e1}/judges`, s.org, { judgeId: j.id })).status).toBe(201);
    }
    expect((await api('post', `/entries/${e2}/judges`, s.org, { judgeId: s.j1.id })).status).toBe(201);
    expect((await api('post', `/entries/${e1}/judges`, s.org, { judgeId: s.j1.id })).status).toBe(409);
    expect((await api('post', `/entries/${e1}/judges`, s.org, { judgeId: s.p2.id })).status).toBe(422);
    expect((await api('put', `/entries/${e2}/score`, s.j2, scores(5, 5))).status).toBe(403); // j2 only has e1
    expect((await api('put', `/entries/${e1}/score`, s.j1, scores(11, 5))).status).toBe(422); // above max
    expect((await api('put', `/entries/${e1}/score`, s.j1, { criterionScores: [{ name: 'Idea', score: 5 }] })).status).toBe(422);
    expect((await api('put', `/entries/${e1}/score`, s.j1, scores(-1, 5))).status).toBe(400);
    expect((await api('put', `/entries/${e1}/score`, s.j1, scores(8, 6))).status).toBe(200);
    await api('put', `/entries/${e1}/score`, s.j2, scores(6, 6));
    await api('put', `/entries/${e2}/score`, s.j1, scores(9, 9));
    expect((await api('get', `/me/assigned-entries`, s.j2)).body.data).toHaveLength(1);
    expect((await api('post', `/activities/${s.act}/results/compute`, s.j1)).status).toBe(403);
    const c = await api('post', `/activities/${s.act}/results/compute`, s.org);
    expect(c.status).toBe(200);
    expect(c.body.data.status).toBe('draft');
    expect(c.body.data.rankings[0].title).toBe('Entry Two');
    expect((await api('get', `/activities/${s.act}/results`, s.p1)).status).toBe(404); // draft is not public
    expect((await api('post', `/activities/${s.act}/results/approve`, s.j1)).status).toBe(403);
    await new Promise((r) => setTimeout(r, 20));
    await api('put', `/entries/${e1}/score`, s.j1, scores(10, 10)); // score changes after compute
    expect((await api('post', `/activities/${s.act}/results/approve`, s.org)).status).toBe(409); // stale draft cannot be approved
    await api('post', `/activities/${s.act}/results/compute`, s.org);
    expect((await api('post', `/activities/${s.act}/results/approve`, s.org)).status).toBe(200);
    const pub = await api('get', `/activities/${s.act}/results`, s.p1);
    expect(pub.status).toBe(200);
    expect(pub.body.data.status).toBe('official');
    expect((await api('put', `/entries/${e1}/score`, s.j1, scores(1, 1))).status).toBe(409); // locked
    const audit = await api('get', '/audit?entityType=Activity', s.org);
    expect(audit.body.data.some((a: { action: string }) => a.action === 'result.approve')).toBe(true);
  });
});

describe('atomic clash detection under concurrency', () => {
  it('lets exactly one of many simultaneous bookings take a venue slot', async () => {
    const org = await makeUser(['organiser']);
    const id = await publishedEvent(org);
    const venue = (await api('post', '/venues', org, { name: `Race Hall ${Date.now()}` })).body.data._id;
    const res = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        api('post', `/events/${id}/activities`, org, { title: `Racer ${i}`, kind: 'workshop', start: hours(70), end: hours(72), venueId: venue }),
      ),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(7);
  });
  it('never double-books a volunteer or over-fills a shift when assigned simultaneously', async () => {
    const org = await makeUser(['organiser']);
    const coord = await makeUser(['coordinator']);
    const id = await publishedEvent(org);
    const [v1, v2] = await Promise.all([makeUser(['volunteer']), makeUser(['volunteer'])]);
    for (const v of [v1, v2]) await api('put', `/me/availability/${id}`, v, { slots: [{ start: hours(40), end: hours(80) }] });
    const mk = async (title: string, s: number, e: number) =>
      (await api('post', `/events/${id}/shifts`, coord, { title, start: hours(s), end: hours(e), requiredCount: 1 })).body.data._id as string;
    const [a, b] = [await mk('Overlap A', 60, 63), await mk('Overlap B', 61, 64)];
    const dbl = await Promise.all([api('post', `/shifts/${a}/assign`, coord, { volunteerId: v1.id }), api('post', `/shifts/${b}/assign`, coord, { volunteerId: v1.id })]);
    expect(dbl.map((r) => r.status).sort()).toEqual([201, 409]);
    const full = await Promise.all([v1, v2].map((v) => api('post', `/shifts/${a}/assign`, coord, { volunteerId: v.id })));
    expect(full.filter((r) => r.status === 201).length).toBeLessThanOrEqual(1);
    expect(await ShiftAssignment.countDocuments({ shiftId: a, status: 'assigned' })).toBe(1);
  });
});

describe('QR token expiry', () => {
  it('rejects an expired token with a clear code, but accepts a freshly issued one', async () => {
    const org = await makeUser(['organiser']);
    const coord = await makeUser(['coordinator']);
    const id = await publishedEvent(org);
    const part = await makeUser(['participant']);
    await api('post', `/events/${id}/register`, part);
    const fresh = (await api('get', `/me/checkin-token/${id}`, part)).body.data.token as string;
    const claims = jwt.decode(fresh) as jwt.JwtPayload;
    const stale = jwt.sign({ sub: claims.sub, eid: claims.eid, jti: claims.jti, uid: claims.uid, iat: Math.floor(Date.now() / 1000) - 600, exp: Math.floor(Date.now() / 1000) - 300 }, env.qrSecret);
    const expired = await api('post', '/checkin/scan', coord, { token: stale });
    expect(expired.status).toBe(400);
    expect(expired.body.error.code).toBe('TOKEN_EXPIRED');
    expect((await api('post', '/checkin/scan', coord, { token: fresh })).status).toBe(201);
  });
});

describe('event lifecycle, announcements and readiness views', () => {
  it('creates an event, registers a participant, assigns a volunteer, broadcasts an announcement and updates readiness', async () => {
    const org = await makeUser(['organiser']);
    const coord = await makeUser(['coordinator']);
    const [part, vol] = await Promise.all([makeUser(['participant']), makeUser(['volunteer'])]);
    const id = await publishedEvent(org, { title: 'Lifecycle Fest' });
    expect((await api('post', `/events/${id}/register`, part)).status).toBe(201);
    const shift = (await api('post', `/events/${id}/shifts`, coord, { title: 'Welcome desk', start: hours(50), end: hours(52), requiredCount: 1 })).body.data._id;
    const before = await api('get', `/events/${id}/readiness`, org);
    expect(before.body.data.uncoveredShifts.map((u: { title: string }) => u.title)).toContain('Welcome desk');
    await api('put', `/me/availability/${id}`, vol, { slots: [{ start: hours(40), end: hours(60) }] });
    expect((await api('post', `/shifts/${shift}/assign`, coord, { volunteerId: vol.id })).status).toBe(201);
    const after = await api('get', `/events/${id}/readiness`, org);
    expect(after.body.data.uncoveredShifts).toHaveLength(0);
    expect(after.body.data.score).toBeGreaterThan(before.body.data.score);

    const ann = await api('post', `/events/${id}/announcements`, org, { title: 'Doors open early', body: 'Doors open at 8am sharp.', pinned: true });
    expect(ann.status).toBe(201);
    expect((await api('post', `/events/${id}/announcements`, part, { title: 'Hello', body: 'Fake news' })).status).toBe(403);
    expect((await api('post', `/events/${id}/announcements`, org, { title: 'x', body: '' })).status).toBe(400);
    const list = await api('get', `/events/${id}/announcements`, part);
    expect(list.body.data[0].title).toBe('Doors open early');
    for (const who of [part, vol]) {
      const n = await api('get', '/notifications', who);
      expect(JSON.stringify(n.body.data)).toContain('Doors open early');
    }
  });
});
