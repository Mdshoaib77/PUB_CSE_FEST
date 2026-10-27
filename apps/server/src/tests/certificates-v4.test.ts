import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, hours, makeUser } from './helpers';
import { Certificate, Contest, ContestRegistration, ContestTeam, Event, Notification, Registration, Submission, Problem, Team, TeamMember } from '../models';
import { migrateCertificatesV4 } from '../services/migrations';

beforeAll(connect);
afterAll(disconnect);

async function teamEvent(org: { id: string }, size: number) {
  const ev = await Event.create({ title: 'Team Fest', type: 'competition', status: 'published', startAt: hours(-5), endAt: hours(-3), registrationDeadline: hours(-10), capacity: 50, createdBy: org.id });
  const users = [];
  for (let i = 0; i < size; i++) users.push(await makeUser(['participant']));
  const team = await Team.create({ eventId: ev.id, name: 'Alpha', leaderId: users[0].id, memberCount: size });
  for (const u of users) await TeamMember.create({ teamId: team.id, eventId: ev.id, userId: u.id });
  await Registration.create({ eventId: ev.id, subjectKey: `t:${team.id}`, teamId: team.id, status: 'confirmed' });
  return { ev, users, team };
}

describe('team certificates (v4)', () => {
  it('ONE certificate per team with all members (leader first), idempotent, every member sees it', async () => {
    const org = await makeUser(['organiser']);
    const { ev, users, team } = await teamEvent(org, 3);
    const body = { types: ['participation'], attendedOnly: false };
    const first = await api('post', `/events/${ev.id}/certificates/generate`, org, body);
    expect(first.body.data.created).toBe(1); // one for the team, not three
    const again = await api('post', `/events/${ev.id}/certificates/generate`, org, body);
    expect(again.body.data.created).toBe(0);
    expect(await Certificate.countDocuments({ eventId: ev.id, type: 'participation' })).toBe(1);

    const cert = (await Certificate.findOne({ eventId: ev.id }))!;
    expect(cert.kind).toBe('team');
    expect(String(cert.teamId)).toBe(team.id);
    expect(cert.teamName).toBe('Alpha');
    expect(cert.recipients.map((r) => String(r.userId))).toEqual(users.map((u) => u.id)); // leader first
    for (const u of users) {
      const mine = await api('get', '/certificates/mine', u);
      expect(mine.body.data).toHaveLength(1);
      expect(mine.body.data[0].members).toHaveLength(3);
      expect(await Notification.countDocuments({ userId: u.id })).toBeGreaterThan(0);
    }
    const v = await api('get', `/verify/${cert.certId}`);
    expect(v.body.data).toMatchObject({ status: 'valid', kind: 'team', teamName: 'Alpha' });
    expect(v.body.data.members).toHaveLength(3);

    // snapshot: renaming a user or the team later changes nothing
    await Team.updateOne({ _id: team.id }, { name: 'Renamed' });
    const v2 = await api('get', `/verify/${cert.certId}`);
    expect(v2.body.data.teamName).toBe('Alpha');

    // revoke notifies every member; reissue keeps the snapshot
    await api('post', `/certificates/${cert.certId}/revoke`, org, { reason: 'test' });
    for (const u of users) expect(await Notification.countDocuments({ userId: u.id, title: 'Certificate revoked' })).toBe(1);
    const re = await api('post', `/certificates/${cert.certId}/reissue`, org, {});
    expect(re.status).toBe(201);
    expect(re.body.data.members).toHaveLength(3);
    expect(re.body.data.teamName).toBe('Alpha');
  });

  it('5-member team works and a non-member cannot download', async () => {
    const org = await makeUser(['organiser']);
    const { ev, users } = await teamEvent(org, 5);
    await api('post', `/events/${ev.id}/certificates/generate`, org, { types: ['participation'], attendedOnly: false });
    const cert = (await Certificate.findOne({ eventId: ev.id }))!;
    expect(cert.recipients).toHaveLength(5);
    expect((await api('get', `/certificates/${cert.certId}/download`, users[4])).status).toBe(200);
    const stranger = await makeUser(['participant']);
    expect((await api('get', `/certificates/${cert.certId}/download`, stranger)).status).toBe(403);
  });
});

describe('contest certificates (v4)', () => {
  it('participation for every registered team; winner + runner-up from the final scoreboard; idempotent', async () => {
    const org = await makeUser(['organiser']);
    const a = [await makeUser(['participant']), await makeUser(['participant'])];
    const b = [await makeUser(['participant'])];
    const prob = await Problem.create({ title: 'P', statement: 's', authorId: org.id, visibility: 'public' } as never);
    const c = await Contest.create({ title: 'CodeStorm', startAt: new Date(Date.now() - 4 * 3600_000), endAt: new Date(Date.now() - 3600_000), mode: 'TEAM', problems: [{ problemId: prob.id, label: 'A' }], createdBy: org.id });
    const ta = await ContestTeam.create({ contestId: c.id, name: 'Aces', leaderId: a[0].id, joinCode: 'JA1', memberCount: 2 });
    const tb = await ContestTeam.create({ contestId: c.id, name: 'Bees', leaderId: b[0].id, joinCode: 'JB1', memberCount: 1 });
    for (const u of a) await ContestRegistration.create({ contestId: c.id, userId: u.id, teamId: ta.id });
    await ContestRegistration.create({ contestId: c.id, userId: b[0].id, teamId: tb.id });
    await Submission.create({ userId: a[0].id, problemId: prob.id, contestId: c.id, mode: 'contest', status: 'AC', language: 'cpp', code: 'x', submittedAt: new Date(Date.now() - 3 * 3600_000) } as never);

    const run = () => api('post', `/contests/${c.id}/certificates/generate`, org, {});
    const first = await run();
    expect(first.status).toBe(201);
    expect(first.body.data.byType.participation.created).toBe(2); // 2 teams
    expect(first.body.data.byType.winner.created).toBe(1); // Aces solved 1
    expect(first.body.data.byType.runner_up.created).toBe(0); // Bees solved nothing -> no place
    expect((await run()).body.data.created).toBe(0);
    const win = (await Certificate.findOne({ contestId: c.id, type: 'winner' }))!;
    expect(win.positionLabel).toBe('1st Place - CodeStorm');
    expect(win.recipients).toHaveLength(2);
    expect((await api('get', '/certificates/mine', a[1])).body.data.length).toBe(2);
  });

  it('refuses before the contest has ended', async () => {
    const org = await makeUser(['organiser']);
    const c = await Contest.create({ title: 'Live', startAt: new Date(Date.now() - 3600_000), endAt: new Date(Date.now() + 3600_000), createdBy: org.id });
    expect((await api('post', `/contests/${c.id}/certificates/generate`, org, {})).status).toBe(422);
  });
});

describe('migration v4', () => {
  it('sets kind + one-person snapshot on old documents and is idempotent', async () => {
    const u = await makeUser(['participant']);
    const ev = await Event.create({ title: 'Old', type: 'seminar', status: 'published', startAt: hours(-5), endAt: hours(-3), registrationDeadline: hours(-10), capacity: 5, createdBy: u.id });
    await Certificate.collection.insertOne({ certId: 'FH-OLD0-0000-0000-AA', eventId: ev._id, userId: u._id, type: 'participation', status: 'valid', recipientName: 'Old Name', eventTitle: 'Old', eventDate: new Date(), slotKey: `${ev.id}:${u.id}:participation:` });
    expect(await migrateCertificatesV4()).toBeGreaterThan(0);
    const c = (await Certificate.findOne({ certId: 'FH-OLD0-0000-0000-AA' }))!;
    expect(c.kind).toBe('individual');
    expect(c.recipients[0].name).toBe('Old Name');
    expect(c.slotKey).toBe(`${ev.id}:${u.id}:participation:`);
    expect(await migrateCertificatesV4()).toBe(0);
  });
});
