import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, hours, makeUser } from './helpers';
import { Notification } from '../models';

beforeAll(connect);
afterAll(disconnect);

type U = Awaited<ReturnType<typeof makeUser>>;
const rubric = { criteria: [{ name: 'Idea', maxScore: 10, weight: 1 }] };
const notes = (u: U) => Notification.find({ userId: u.id, type: 'judging' }).sort({ createdAt: 1 });

async function setup() {
  const org = await makeUser(['organiser']);
  const ev = (
    await api('post', '/events', org, {
      title: 'Judge Fest',
      type: 'competition',
      description: 'd',
      startAt: hours(48),
      endAt: hours(52),
      registrationDeadline: hours(24),
      capacity: 5,
      participationType: 'team',
      teamSize: { min: 1, max: 2 },
      requiresApproval: false,
    })
  ).body.data._id as string;
  await api('post', `/events/${ev}/publish`, org);
  const venue = (await api('post', '/venues', org, { name: `JV ${Date.now()}${Math.random()}` })).body.data._id;
  const act = (await api('post', `/events/${ev}/activities`, org, { title: 'Hack Round', kind: 'competition', start: hours(50), end: hours(52), venueId: venue })).body.data._id as string;
  await api('put', `/activities/${act}/rubric`, org, rubric);
  const lead = await makeUser(['participant']);
  const team = (await api('post', `/events/${ev}/teams`, lead, { name: 'Byte Rangers' })).body.data._id as string;
  expect((await api('post', `/events/${ev}/register`, lead, { teamId: team })).status).toBe(201);
  const entry = (await api('post', `/activities/${act}/entries`, lead, { title: 'Alpha', content: 'x' })).body.data._id as string;
  return { org, ev, act, lead, entry, judge: await makeUser(['judge']) };
}

describe('judge assignment notifications', () => {
  it('notifies the judge on assign and unassign, and exposes event/team info on assigned entries', async () => {
    const c = await setup();
    expect((await api('post', `/entries/${c.entry}/judges`, c.org, { judgeId: c.judge.id })).status).toBe(201);

    let n = await notes(c.judge);
    expect(n).toHaveLength(1);
    expect(n[0].message).toBe('You were assigned to judge "Alpha" (Byte Rangers) in "Judge Fest"');
    expect(n[0].link).toBe(`/judging?event=${c.ev}`);

    const mine = await api('get', '/me/assigned-entries', c.judge);
    expect(mine.status).toBe(200);
    expect(mine.body.data[0]).toMatchObject({ eventId: c.ev, eventTitle: 'Judge Fest', activityTitle: 'Hack Round', teamName: 'Byte Rangers' });

    expect((await api('delete', `/entries/${c.entry}/judges/${c.judge.id}`, c.org)).body.data.removed).toBe(1);
    n = await notes(c.judge);
    expect(n).toHaveLength(2);
    expect(n[1].message).toBe('You were unassigned from judging "Alpha" (Byte Rangers) in "Judge Fest"');
    expect(n[1].link).toBe(`/judging?event=${c.ev}`);

    // removing a judge who is not assigned changes nothing and sends nothing
    expect((await api('delete', `/entries/${c.entry}/judges/${c.judge.id}`, c.org)).body.data.removed).toBe(0);
    expect(await notes(c.judge)).toHaveLength(2);
  });

  it('sends nothing when the assignment fails (duplicate, not a judge, own entry, no permission)', async () => {
    const c = await setup();
    expect((await api('post', `/entries/${c.entry}/judges`, c.org, { judgeId: c.judge.id })).status).toBe(201);
    expect(await notes(c.judge)).toHaveLength(1);

    expect((await api('post', `/entries/${c.entry}/judges`, c.org, { judgeId: c.judge.id })).status).toBe(409); // duplicate
    expect((await api('post', `/entries/${c.entry}/judges`, c.org, { judgeId: c.lead.id })).status).toBe(422); // not a judge
    expect((await api('post', `/entries/${c.entry}/judges`, c.judge, { judgeId: c.judge.id })).status).toBe(403); // judges cannot assign

    const ownJudge = await makeUser(['judge', 'participant']);
    const t2 = (await api('post', `/events/${c.ev}/teams`, ownJudge, { name: 'Own Team' })).body.data._id as string;
    expect((await api('post', `/events/${c.ev}/register`, ownJudge, { teamId: t2 })).status).toBe(201);
    const own = (await api('post', `/activities/${c.act}/entries`, ownJudge, { title: 'Mine', content: 'x' })).body.data._id as string;
    expect((await api('post', `/entries/${own}/judges`, c.org, { judgeId: ownJudge.id })).status).toBe(422); // conflict of interest

    expect(await notes(c.judge)).toHaveLength(1);
    expect(await notes(c.lead)).toHaveLength(0);
    expect(await notes(ownJudge)).toHaveLength(0);
  });
});
