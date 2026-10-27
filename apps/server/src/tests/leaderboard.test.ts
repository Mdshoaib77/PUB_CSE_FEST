import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, hours, makeUser } from './helpers';
import { Activity, Entry, Event, Feedback, CodeSubmission, JudgeAssignment, PlagiarismPair, Score, Venue } from '../models';
import { buildLeaderboard } from '../services/leaderboard';

let org: Awaited<ReturnType<typeof makeUser>>, p1: typeof org, p2: typeof org, judge: typeof org, eventId: string;

beforeAll(async () => {
  await connect();
  [org, p1, p2, judge] = [await makeUser(['organiser']), await makeUser(['participant']), await makeUser(['participant']), await makeUser(['judge'])];
  const venue = await Venue.create({ name: 'LB Hall', building: 'B', capacity: 50 });
  const ev = await Event.create({ title: 'LB Event', type: 'competition', startAt: hours(10), endAt: hours(12), registrationDeadline: hours(5), capacity: 10, createdBy: org.id, status: 'published', venueId: venue._id });
  eventId = ev.id;
  const act = await Activity.create({ eventId: ev._id, title: 'LB Round', kind: 'competition', start: hours(10), end: hours(12) });
  for (const [u, pct] of [[p1, 80], [p2, 60]] as const) {
    const e = await Entry.create({ activityId: act._id, eventId: ev._id, ownerKey: `u:${u.id}`, ownerUserId: u.id, title: `E ${u.id}` });
    await JudgeAssignment.create({ entryId: e._id, activityId: act._id, judgeId: judge.id });
    await Score.create({ entryId: e._id, activityId: act._id, judgeId: judge.id, percent: pct, criterionScores: [] });
  }
  const sub = await CodeSubmission.create({ userId: p1.id, eventId: ev._id, scopeKey: `e:${ev.id}`, language: 'python', code: 'print(1)' });
  await Feedback.create({ codeSubmissionId: sub._id, userId: p1.id, eventId: ev._id, total: { points: 6, maxPoints: 10, percent: 60 } });
  const sub2 = await CodeSubmission.create({ userId: p2.id, eventId: ev._id, scopeKey: `e:${ev.id}`, language: 'python', code: 'print(2)' });
  const [a, b] = String(sub._id) < String(sub2._id) ? [sub, sub2] : [sub2, sub];
  await PlagiarismPair.create({ scopeKey: `e:${ev.id}`, eventId: ev._id, language: 'python', aId: a._id, bId: b._id, aUserId: a.userId, bUserId: b.userId, similarity: 95, status: 'confirmed' });
});
afterAll(disconnect);

describe('leaderboard', () => {
  it('computes judge + AI - confirmed-plagiarism penalty per participant', async () => {
    const lb = await buildLeaderboard(eventId);
    const x = lb.rows.find((r) => r.key === `u:${p1.id}`)!;
    expect([x.judgePercent, x.aiPercent, x.base, x.penalty, x.final]).toEqual([80, 60, 74, 10, 64]);
    const y = lb.rows.find((r) => r.key === `u:${p2.id}`)!;
    expect([y.judgePercent, y.aiPercent, y.final]).toEqual([60, null, 50]); // no AI score: weight re-normalised, then -10
    expect(lb.rows[0].key).toBe(`u:${p1.id}`);
  });
  it('staff see it; participants get 404 until published', async () => {
    expect((await api('get', `/events/${eventId}/leaderboard`, org)).status).toBe(200);
    expect((await api('get', `/events/${eventId}/leaderboard`, judge)).status).toBe(200);
    expect((await api('get', `/events/${eventId}/leaderboard`, p1)).status).toBe(404);
    expect((await api('get', `/events/${eventId}/leaderboard`)).status).toBe(401);
  });
  it('only organisers configure; invalid configs are rejected; publishing opens it to participants', async () => {
    const body = { judgeWeight: 50, aiWeight: 50, penaltyPerPair: 5, maxPenalty: 20, tieBreak: 'ai', published: true };
    expect((await api('put', `/events/${eventId}/leaderboard/config`, p1, body)).status).toBe(403);
    expect((await api('put', `/events/${eventId}/leaderboard/config`, org, { ...body, judgeWeight: 0, aiWeight: 0 })).status).toBe(422);
    expect((await api('put', `/events/${eventId}/leaderboard/config`, org, body)).status).toBe(200);
    const r = await api('get', `/events/${eventId}/leaderboard`, p1);
    expect(r.status).toBe(200);
    expect(r.body.data.rows.find((x: { key: string }) => x.key === `u:${p1.id}`).final).toBe(65); // 70 - 5
    expect(r.body.data.canConfigure).toBe(false);
  });
  it('exports CSV and PDF', async () => {
    const csv = await api('get', `/events/${eventId}/leaderboard.csv`, org);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Participant');
    const pdf = await api('get', `/events/${eventId}/leaderboard.pdf`, org).buffer(true).parse((res, cb) => {
      const c: Buffer[] = [];
      res.on('data', (d: Buffer) => c.push(d));
      res.on('end', () => cb(null, Buffer.concat(c)));
    });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });
});
