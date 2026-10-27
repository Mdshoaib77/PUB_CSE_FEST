import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, hours, makeUser } from './helpers';
import { Certificate, Entry, Event, Activity, Feedback, CodeSubmission, LeaderboardSetting, Registration, Score, JudgeAssignment, Venue } from '../models';

let org: Awaited<ReturnType<typeof makeUser>>, stu: typeof org, other: typeof org, judge: typeof org, eventId: string;

beforeAll(async () => {
  await connect();
  [org, stu, other, judge] = [await makeUser(['organiser']), await makeUser(['participant']), await makeUser(['participant']), await makeUser(['judge'])];
  const venue = await Venue.create({ name: 'S16 Hall', building: 'B', capacity: 50 });
  const ev = await Event.create({ title: 'S16 Event', type: 'competition', startAt: hours(10), endAt: hours(12), registrationDeadline: hours(5), capacity: 10, createdBy: org.id, status: 'published', venueId: venue._id });
  eventId = ev.id;
  await Registration.create({ eventId: ev._id, subjectKey: `u:${stu.id}`, userId: stu.id, status: 'confirmed' });
  const act = await Activity.create({ eventId: ev._id, title: 'S16 Round', kind: 'competition', start: hours(10), end: hours(12) });
  for (const [u, pct] of [[stu, 90], [other, 70]] as const) {
    const e = await Entry.create({ activityId: act._id, eventId: ev._id, ownerKey: `u:${u.id}`, ownerUserId: u.id, title: 'E' });
    await JudgeAssignment.create({ entryId: e._id, activityId: act._id, judgeId: judge.id });
    await Score.create({ entryId: e._id, activityId: act._id, judgeId: judge.id, percent: pct, criterionScores: [] });
  }
  await Certificate.create({ certId: 'FH-TEST-0001-0001-AA', eventId: ev._id, userId: stu.id, type: 'participation', recipientName: 'S', eventTitle: 'S16 Event', eventDate: new Date(), slotKey: 'k1' });
  await Certificate.create({ certId: 'FH-TEST-0002-0002-BB', eventId: ev._id, userId: stu.id, type: 'winner', status: 'revoked', recipientName: 'S', eventTitle: 'S16 Event', eventDate: new Date(), slotKey: 'x:2' });
  const sub = await CodeSubmission.create({ userId: stu.id, eventId: ev._id, scopeKey: `e:${ev.id}`, language: 'python', code: 'print(1)' });
  await Feedback.create({ codeSubmissionId: sub._id, userId: stu.id, eventId: ev._id, status: 'published', publishedAt: new Date(), total: { points: 8, maxPoints: 10, percent: 80 }, quality: { rating: 8, summary: 'Good' } });
  const sub2 = await CodeSubmission.create({ userId: other.id, eventId: ev._id, scopeKey: `e:${ev.id}`, language: 'python', code: 'print(2)' });
  await Feedback.create({ codeSubmissionId: sub2._id, userId: other.id, eventId: ev._id, status: 'draft', total: { points: 5, maxPoints: 10, percent: 50 } });
});
afterAll(disconnect);

describe('command center', () => {
  it('is organiser-only', async () => {
    expect((await api('get', '/command-center', org)).status).toBe(200);
    expect((await api('get', '/command-center', stu)).status).toBe(403);
    expect((await api('get', '/command-center')).status).toBe(401);
  });
  it('reports registrations, certificates and submissions', async () => {
    const d = (await api('get', '/command-center', org)).body.data;
    expect(d.registrations.confirmed).toBe(1);
    expect(d.certificates).toMatchObject({ issued: 1, revoked: 1 });
    expect(d.submissions.codeSubmissions).toBe(2);
    expect(d.sponsors.pledged).toBe(0);
  });
});

describe('my achievements', () => {
  it('shows own valid certificates and published feedback only; no rank until the leaderboard is published', async () => {
    const a = (await api('get', '/me/achievements', stu)).body.data;
    expect(a.certificates.map((c: { id: string }) => c.id)).toEqual(['FH-TEST-0001-0001-AA']);
    expect(a.feedback).toHaveLength(1);
    expect(a.results).toEqual([]);
    const o = (await api('get', '/me/achievements', other)).body.data;
    expect(o.feedback).toEqual([]); // drafts are never shown
    expect(o.certificates).toEqual([]);
  });
  it('adds rank/score once the organiser publishes the event leaderboard', async () => {
    await LeaderboardSetting.create({ eventId, published: true });
    const a = (await api('get', '/me/achievements', stu)).body.data;
    expect(a.results).toHaveLength(1);
    expect(a.results[0]).toMatchObject({ eventTitle: 'S16 Event', rank: 1, ranked: 2 });
    expect((await api('get', '/me/achievements', other)).body.data.results[0].rank).toBe(2);
  });
  it('portfolio PDF downloads for any signed-in user', async () => {
    const pdf = await api('get', '/me/achievements/portfolio.pdf', stu).buffer(true).parse((res, cb) => {
      const c: Buffer[] = [];
      res.on('data', (d: Buffer) => c.push(d));
      res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await api('get', '/me/achievements/portfolio.pdf')).status).toBe(401);
  });
});
