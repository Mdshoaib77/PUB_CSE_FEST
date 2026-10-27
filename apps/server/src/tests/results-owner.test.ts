import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, hours, makeUser } from './helpers';
import { Result, User } from '../models';

beforeAll(connect);
afterAll(disconnect);

const rubric = { criteria: [{ name: 'Idea', maxScore: 10, weight: 1 }] };
const score = (n: number) => ({ criterionScores: [{ name: 'Idea', score: n }] });

async function contest(participationType: 'individual' | 'team') {
  const org = await makeUser(['organiser']);
  const ev = (
    await api('post', '/events', org, {
      title: 'Owner Names',
      type: 'competition',
      description: 'd',
      startAt: hours(48),
      endAt: hours(52),
      registrationDeadline: hours(24),
      capacity: 5,
      participationType,
      ...(participationType === 'team' ? { teamSize: { min: 1, max: 2 } } : {}),
      requiresApproval: false,
    })
  ).body.data._id as string;
  await api('post', `/events/${ev}/publish`, org);
  const venue = (await api('post', '/venues', org, { name: `OV ${Date.now()}${Math.random()}` })).body.data._id;
  const act = (await api('post', `/events/${ev}/activities`, org, { title: 'Contest', kind: 'competition', start: hours(50), end: hours(52), venueId: venue })).body.data._id as string;
  await api('put', `/activities/${act}/rubric`, org, rubric);
  return { org, ev, act, judge: await makeUser(['judge']) };
}
async function enter(c: Awaited<ReturnType<typeof contest>>, who: { token: string }, title: string, pts: number, teamId?: string) {
  expect((await api('post', `/events/${c.ev}/register`, who, teamId ? { teamId } : undefined)).status).toBe(201);
  const e = (await api('post', `/activities/${c.act}/entries`, who, { title, content: 'x' })).body.data._id as string;
  expect((await api('post', `/entries/${e}/judges`, c.org, { judgeId: c.judge.id })).status).toBe(201);
  expect((await api('put', `/entries/${e}/score`, c.judge, score(pts))).status).toBe(200);
}

describe('GET /activities/:id/results ownerName', () => {
  it('returns the team name for team entries, stored at compute time', async () => {
    const c = await contest('team');
    const [lead1, lead2] = await Promise.all([makeUser(['participant']), makeUser(['participant'])]);
    const t1 = (await api('post', `/events/${c.ev}/teams`, lead1, { name: 'Byte Rangers' })).body.data._id;
    const t2 = (await api('post', `/events/${c.ev}/teams`, lead2, { name: 'Null Pointers' })).body.data._id;
    await enter(c, lead1, 'Alpha Build', 9, t1);
    await enter(c, lead2, 'Beta Build', 6, t2);
    const draft = await api('post', `/activities/${c.act}/results/compute`, c.org);
    expect(draft.body.data.rankings[0]).toMatchObject({ title: 'Alpha Build', ownerName: 'Byte Rangers' });
    expect((await api('post', `/activities/${c.act}/results/approve`, c.org)).status).toBe(200);
    const res = await api('get', `/activities/${c.act}/results`, lead2);
    expect(res.status).toBe(200);
    expect(res.body.data.rankings).toEqual([
      { rank: 1, title: 'Alpha Build', ownerName: 'Byte Rangers', percent: 90 },
      { rank: 2, title: 'Beta Build', ownerName: 'Null Pointers', percent: 60 },
    ]);
  });

  it("uses the user's name for individual entries and resolves it for results computed before ownerName existed", async () => {
    const c = await contest('individual');
    const p = await makeUser(['participant']);
    await enter(c, p, 'Solo Poster', 8);
    await api('post', `/activities/${c.act}/results/compute`, c.org);
    await Result.updateOne({ activityId: c.act }, { $unset: { 'rankings.0.ownerName': 1 } }); // simulate a legacy ranking row
    const res = await api('get', `/activities/${c.act}/results`, c.org);
    const name = (await User.findById(p.id))!.name;
    expect(res.body.data.rankings).toEqual([{ rank: 1, title: 'Solo Poster', ownerName: name, percent: 80 }]);
  });
});
