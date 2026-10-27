import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, hours, makeUser } from './helpers';
import { Notification, User } from '../models';

beforeAll(connect);
afterAll(disconnect);

const rubric = { criteria: [{ name: 'Idea', maxScore: 10, weight: 1 }] };
const score = (n: number) => ({ criterionScores: [{ name: 'Idea', score: n }] });
type U = Awaited<ReturnType<typeof makeUser>>;

async function setup(participationType: 'individual' | 'team') {
  const org = await makeUser(['organiser']);
  const ev = (
    await api('post', '/events', org, {
      title: 'Notify Fest',
      type: 'competition',
      description: 'd',
      startAt: hours(48),
      endAt: hours(52),
      registrationDeadline: hours(24),
      capacity: 5,
      participationType,
      ...(participationType === 'team' ? { teamSize: { min: 1, max: 3 } } : {}),
      requiresApproval: false,
    })
  ).body.data._id as string;
  await api('post', `/events/${ev}/publish`, org);
  const venue = (await api('post', '/venues', org, { name: `NV ${Date.now()}${Math.random()}` })).body.data._id;
  const act = (await api('post', `/events/${ev}/activities`, org, { title: 'Hackathon', kind: 'competition', start: hours(50), end: hours(52), venueId: venue })).body.data._id as string;
  await api('put', `/activities/${act}/rubric`, org, rubric);
  return { org, ev, act, judge: await makeUser(['judge']) };
}
async function enter(c: Awaited<ReturnType<typeof setup>>, who: U, title: string, pts: number, teamId?: string) {
  expect((await api('post', `/events/${c.ev}/register`, who, teamId ? { teamId } : undefined)).status).toBe(201);
  const e = (await api('post', `/activities/${c.act}/entries`, who, { title, content: 'x' })).body.data._id as string;
  await api('post', `/entries/${e}/judges`, c.org, { judgeId: c.judge.id });
  expect((await api('put', `/entries/${e}/score`, c.judge, score(pts))).status).toBe(200);
}
const notes = (u: U) => Notification.find({ userId: u.id, type: 'result' });

describe('results approval notifications', () => {
  it('notifies every team member and the judges once, with the tab link', async () => {
    const c = await setup('team');
    const [lead, mate, other, outsider] = await Promise.all([makeUser(['participant']), makeUser(['participant']), makeUser(['participant']), makeUser(['participant'])]);
    const t1 = (await api('post', `/events/${c.ev}/teams`, lead, { name: 'Byte Rangers' })).body.data._id;
    const t2 = (await api('post', `/events/${c.ev}/teams`, other, { name: 'Null Pointers' })).body.data._id;
    const inv = await api('post', `/teams/${t1}/invitations`, lead, { email: mate.email });
    expect(inv.status).toBe(201);
    expect((await api('post', `/invitations/${inv.body.data._id}/accept`, mate)).status).toBe(200);
    await enter(c, lead, 'Alpha', 9, t1);
    await enter(c, other, 'Beta', 6, t2);
    await api('post', `/activities/${c.act}/results/compute`, c.org);
    expect((await api('post', `/activities/${c.act}/results/approve`, c.org)).status).toBe(200);

    for (const u of [lead, mate]) {
      const n = await notes(u);
      expect(n).toHaveLength(1);
      expect(n[0].message).toBe('Results published for "Hackathon": Byte Rangers ranked #1 (90%)');
      expect(n[0].link).toBe(`/events/${c.ev}?tab=results`);
    }
    expect((await notes(other))[0].message).toBe('Results published for "Hackathon": Null Pointers ranked #2 (60%)');
    const j = await notes(c.judge);
    expect(j).toHaveLength(1);
    expect(j[0].message).toBe('Results published for "Hackathon"');
    expect(j[0].link).toBe(`/events/${c.ev}?tab=results`);
    expect(await notes(outsider)).toHaveLength(0);
  });

  it('notifies an individual owner by name, and a judge assigned to several entries gets one notice', async () => {
    const c = await setup('individual');
    const [p, q] = await Promise.all([makeUser(['participant']), makeUser(['participant'])]);
    await enter(c, p, 'Solo', 8);
    await enter(c, q, 'Duo', 5);
    await api('post', `/activities/${c.act}/results/compute`, c.org);
    expect((await api('post', `/activities/${c.act}/results/approve`, c.org)).status).toBe(200);
    const n = await notes(p);
    expect(n).toHaveLength(1);
    expect(n[0].message).toBe(`Results published for "Hackathon": ${(await User.findById(p.id))!.name} ranked #1 (80%)`);
    expect(n[0].link).toBe(`/events/${c.ev}?tab=results`);
    expect(await notes(q)).toHaveLength(1);
    expect(await notes(c.judge)).toHaveLength(1);
  });
});

describe('GET /events/:id/results', () => {
  it('hides unpublished results, then lists rankings and marks the caller\'s team; outsiders are refused', async () => {
    const c = await setup('team');
    const [lead, other, outsider] = await Promise.all([makeUser(['participant']), makeUser(['participant']), makeUser(['participant'])]);
    const t1 = (await api('post', `/events/${c.ev}/teams`, lead, { name: 'Byte Rangers' })).body.data._id;
    const t2 = (await api('post', `/events/${c.ev}/teams`, other, { name: 'Null Pointers' })).body.data._id;
    await enter(c, lead, 'Alpha', 9, t1);
    await enter(c, other, 'Beta', 6, t2);
    await api('post', `/activities/${c.act}/results/compute`, c.org);
    expect((await api('get', `/events/${c.ev}/results`, lead)).body.data).toEqual({ published: false, activities: [] });
    await api('post', `/activities/${c.act}/results/approve`, c.org);
    const res = await api('get', `/events/${c.ev}/results`, other);
    expect(res.body.data.published).toBe(true);
    expect(res.body.data.activities[0].rankings).toEqual([
      { rank: 1, title: 'Alpha', ownerName: 'Byte Rangers', percent: 90, mine: false },
      { rank: 2, title: 'Beta', ownerName: 'Null Pointers', percent: 60, mine: true },
    ]);
    expect((await api('get', `/events/${c.ev}/results`, outsider)).status).toBe(403);
  });
});
