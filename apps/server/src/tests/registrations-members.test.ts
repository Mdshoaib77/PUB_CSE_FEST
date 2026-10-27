import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, hours, makeUser } from './helpers';

beforeAll(connect);
afterAll(disconnect);

const eventBody = (o: Record<string, unknown> = {}) => ({
  title: 'Team Reg Event',
  type: 'workshop',
  description: 'd',
  startAt: hours(48),
  endAt: hours(52),
  registrationDeadline: hours(24),
  capacity: 5,
  participationType: 'team',
  teamSize: { min: 2, max: 3 },
  ...o,
});

describe('GET /events/:id/registrations team members', () => {
  it('returns every team member (leader first) with emails for organisers/admins only; individual rows unchanged', async () => {
    const org = await makeUser(['organiser']);
    const admin = await makeUser(['admin']);
    const coord = await makeUser(['coordinator']);
    const [lead, m1, m2, solo] = await Promise.all([makeUser(['participant']), makeUser(['participant']), makeUser(['participant']), makeUser(['participant'])]);

    const c = await api('post', '/events', org, eventBody());
    expect(c.status).toBe(201);
    const id = c.body.data._id as string;
    expect((await api('post', `/events/${id}/publish`, org)).status).toBe(200);

    const team = await api('post', `/events/${id}/teams`, lead, { name: 'Alpha' });
    expect(team.status).toBe(201);
    for (const m of [m1, m2]) {
      const inv = await api('post', `/teams/${team.body.data._id}/invitations`, lead, { email: m.email });
      expect(inv.status).toBe(201);
      expect((await api('post', `/invitations/${inv.body.data._id}/accept`, m)).status).toBe(200);
    }
    expect((await api('post', `/events/${id}/register`, lead, { teamId: team.body.data._id })).status).toBe(201);

    // organiser: full roster with emails, leader first
    const res = await api('get', `/events/${id}/registrations`, org);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const t = res.body.data[0].team;
    expect(t.name).toBe('Alpha');
    expect(t.memberCount).toBe(3);
    expect(t.members).toHaveLength(3);
    expect(t.members[0]).toMatchObject({ userId: lead.id, email: lead.email, isLeader: true });
    expect(t.members.slice(1).map((m: { email: string }) => m.email).sort()).toEqual([m1.email, m2.email].sort());
    expect(t.members.filter((m: { isLeader: boolean }) => m.isLeader)).toHaveLength(1);
    expect(t.members.every((m: { name: string }) => !!m.name)).toBe(true);

    // admin also receives emails
    const asAdmin = await api('get', `/events/${id}/registrations`, admin);
    expect(asAdmin.body.data[0].team.members.every((m: { email?: string }) => !!m.email)).toBe(true);

    // coordinator: roster visible, emails withheld
    const asCoord = await api('get', `/events/${id}/registrations`, coord);
    expect(asCoord.status).toBe(200);
    expect(asCoord.body.data[0].team.members).toHaveLength(3);
    expect(asCoord.body.data[0].team.members.some((m: { email?: string }) => 'email' in m)).toBe(false);
    expect(JSON.stringify(asCoord.body)).not.toContain(m1.email);

    // participants cannot read the list at all
    expect((await api('get', `/events/${id}/registrations`, m1)).status).toBe(403);

    // individual registration keeps its shape (no team)
    const ind = await api('post', '/events', org, eventBody({ participationType: 'individual', teamSize: undefined, title: 'Solo' }));
    const iid = ind.body.data._id as string;
    await api('post', `/events/${iid}/publish`, org);
    expect((await api('post', `/events/${iid}/register`, solo)).status).toBe(201);
    const list = await api('get', `/events/${iid}/registrations`, org);
    expect(list.body.data[0].team).toBeNull();
    expect(list.body.data[0].user.email).toBe(solo.email);
  });
});
