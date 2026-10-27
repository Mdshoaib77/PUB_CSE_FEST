import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { api, app, auth, connect, disconnect, hours, makeUser } from './helpers';
import { Activity, Announcement, Contest, Entry, Event, Notification, Registration, Seat, Shift, ShiftAssignment, Submission, Task, TestCase, User, Venue } from '../models';
import { env } from '../config/env';

beforeAll(connect);
afterAll(disconnect);

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const eventBody = (o: Record<string, unknown> = {}) => ({
  title: 'Feature Event',
  type: 'workshop',
  description: 'd',
  startAt: hours(48),
  endAt: hours(52),
  registrationDeadline: hours(24),
  capacity: 5,
  participationType: 'individual',
  ...o,
});
async function publishedEvent(org: { token: string }, o: Record<string, unknown> = {}) {
  const c = await api('post', '/events', org, eventBody(o));
  expect(c.status).toBe(201);
  expect((await api('post', `/events/${c.body.data._id}/publish`, org)).status).toBe(200);
  return c.body.data._id as string;
}
const upload = (who: { token: string }, buf: Buffer, name = 'cover.png') =>
  request(app).post('/api/v1/uploads/event-image').set(auth(who)).attach('file', buf, name);

describe('event cover images', () => {
  it('only organisers can upload; real images are accepted; fake ones are rejected by content, not by filename', async () => {
    const org = await makeUser(['organiser']);
    const part = await makeUser(['participant']);
    expect((await upload(part, PNG)).status).toBe(403);
    expect((await request(app).post('/api/v1/uploads/event-image').attach('file', PNG, 'a.png')).status).toBe(401);
    const good = await upload(org, PNG);
    expect(good.status).toBe(201);
    expect(good.body.data.url).toMatch(/^\/uploads\/events\/[a-f0-9]{24}\.png$/);
    const served = await request(app).get(good.body.data.url);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/image\/png/);
    // HTML/script disguised as .png is refused
    expect((await upload(org, Buffer.from('<script>alert(1)</script>'.padEnd(40, ' ')), 'evil.png')).status).toBe(400);
    // SVG is not accepted at all
    expect((await upload(org, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'x.svg')).status).toBe(400);
    // missing file
    expect((await request(app).post('/api/v1/uploads/event-image').set(auth(org))).status).toBe(400);
  });

  it('stores the cover on create/update, accepts external URLs, rejects javascript: URLs, and cleans up replaced files', async () => {
    const org = await makeUser(['organiser']);
    const a = (await upload(org, PNG)).body.data.url as string;
    const created = await api('post', '/events', org, eventBody({ imageUrl: a }));
    expect(created.status).toBe(201);
    expect(created.body.data.imageUrl).toBe(a);
    const file = path.join(env.uploadDir, 'events', path.basename(a));
    expect(fs.existsSync(file)).toBe(true);

    expect((await api('post', '/events', org, eventBody({ imageUrl: 'javascript:alert(1)' }))).status).toBe(400);
    const id = created.body.data._id;
    const ext = await api('patch', `/events/${id}`, org, { imageUrl: 'https://example.com/cover.jpg' });
    expect(ext.status).toBe(200);
    expect(ext.body.data.imageUrl).toBe('https://example.com/cover.jpg');
    expect(fs.existsSync(file)).toBe(false); // the replaced upload was removed from disk

    const b = (await upload(org, PNG)).body.data.url as string;
    await api('patch', `/events/${id}`, org, { imageUrl: b });
    const cleared = await api('patch', `/events/${id}`, org, { imageUrl: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.imageUrl).toBeUndefined();
    expect(fs.existsSync(path.join(env.uploadDir, 'events', path.basename(b)))).toBe(false);
  });
});

describe('notifications: bell badge & auto-clear', () => {
  it('counts unread in the database, marks read up to a timestamp, and never marks a newer one as seen', async () => {
    const u = await makeUser(['participant']);
    const other = await makeUser(['participant']);
    const mk = (userId: string, message: string, at?: Date) => Notification.create({ userId, message, type: 't', ...(at ? { createdAt: at } : {}) });
    for (let i = 0; i < 60; i++) await mk(u.id, `old ${i}`, new Date(Date.now() - 60_000 - i));
    await mk(other.id, 'not mine');
    // > 50 unread: the badge must still be exact (the list endpoint is capped at 50)
    expect((await api('get', '/notifications/unread-count', u)).body.data.count).toBe(60);
    expect((await api('get', '/notifications', u)).body.data).toHaveLength(50);

    const viewedUpTo = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 20));
    await mk(u.id, 'arrived after the list was rendered');
    const res = await api('post', '/notifications/read-all', u, { upTo: viewedUpTo });
    expect(res.status).toBe(200);
    expect(res.body.data.unread).toBe(1); // the late arrival stays unread
    expect((await api('get', '/notifications/unread-count', u)).body.data.count).toBe(1);
    // someone else's notifications are untouched
    expect((await api('get', '/notifications/unread-count', other)).body.data.count).toBe(1);

    expect((await api('post', '/notifications/read-all', u, {})).body.data.unread).toBe(0);
    expect((await api('get', '/notifications/unread-count', u)).body.data.count).toBe(0);
    expect((await api('get', '/notifications?unread=1', u)).body.data).toHaveLength(0);
  });

  it('lets people delete their own notifications only', async () => {
    const u = await makeUser(['participant']);
    const other = await makeUser(['participant']);
    const n = await Notification.create({ userId: u.id, message: 'hello', type: 't' });
    expect((await api('delete', `/notifications/${n.id}`, other)).status).toBe(404);
    expect((await api('delete', `/notifications/${n.id}`, u)).status).toBe(200);
    await Notification.create([{ userId: u.id, message: 'a', type: 't' }, { userId: u.id, message: 'b', type: 't' }]);
    expect((await api('delete', '/notifications', u)).body.data.deleted).toBe(2);
    expect((await api('get', '/notifications/unread-count', u)).body.data.count).toBe(0);
  });
});

describe('universal delete', () => {
  it('deleting an event removes every child, frees the cover file, notifies people, and is organiser-only', async () => {
    const org = await makeUser(['organiser']);
    const coord = await makeUser(['coordinator']);
    const part = await makeUser(['participant']);
    const vol = await makeUser(['volunteer']);
    const url = (await upload(org, PNG)).body.data.url as string;
    const id = await publishedEvent(org, { imageUrl: url });
    expect((await api('post', `/events/${id}/register`, part)).status).toBe(201);
    const act = await api('post', `/events/${id}/activities`, org, { title: 'Round 1', kind: 'competition', start: hours(49), end: hours(50) });
    expect(act.status).toBe(201);
    const shift = await api('post', `/events/${id}/shifts`, org, { title: 'Desk', start: hours(48), end: hours(50), requiredCount: 1 });
    await api('put', `/me/availability/${id}`, vol, { slots: [{ start: hours(47), end: hours(53) }] });
    expect((await api('post', `/shifts/${shift.body.data._id}/assign`, coord, { volunteerId: vol.id })).status).toBe(201);
    await api('post', `/events/${id}/announcements`, org, { title: 'Hello all', body: 'Welcome everyone' });
    await api('post', `/events/${id}/tasks`, org, { title: 'Set up', assigneeId: vol.id });
    await api('post', `/events/${id}/issues`, org, { title: 'Projector broken' });

    expect(await Seat.countDocuments({ eventId: id })).toBe(1);
    expect((await api('delete', `/events/${id}`, coord)).status).toBe(403);
    expect((await api('delete', `/events/${id}`, part)).status).toBe(403);
    expect((await api('delete', `/events/${id}`)).status).toBe(401);

    const del = await api('delete', `/events/${id}`, org);
    expect(del.status).toBe(200);
    expect(await Event.countDocuments({ _id: id })).toBe(0);
    for (const M of [Registration, Seat, Activity, Shift, ShiftAssignment, Announcement, Task]) expect(await (M as typeof Seat).countDocuments({ eventId: id })).toBe(0);
    expect((await api('get', `/events/${id}`, org)).status).toBe(404);
    expect(fs.existsSync(path.join(env.uploadDir, 'events', path.basename(url)))).toBe(false);
    for (const who of [part, vol]) expect(JSON.stringify((await api('get', '/notifications', who)).body.data)).toContain('was deleted by an organiser');
    // deleting twice is a clean 404, not a crash
    expect((await api('delete', `/events/${id}`, org)).status).toBe(404);
  });

  it('deleting a registered participant’s seat holder promotes the waiting list (cancel path) and deleting an activity cascades', async () => {
    const org = await makeUser(['organiser']);
    const [p1, p2] = await Promise.all([makeUser(['participant']), makeUser(['participant'])]);
    const id = await publishedEvent(org, { capacity: 1 });
    const r1 = await api('post', `/events/${id}/register`, p1);
    const r2 = await api('post', `/events/${id}/register`, p2);
    expect(r2.body.data.status).toBe('waitlisted');
    expect((await api('delete', `/registrations/${r1.body.data._id}`, p1)).status).toBe(200);
    expect((await Registration.findById(r2.body.data._id))!.status).toBe('confirmed');

    const a = await api('post', `/events/${id}/activities`, org, { title: 'Contest round', kind: 'competition', start: hours(49), end: hours(50) });
    const aid = a.body.data._id;
    await api('put', `/activities/${aid}/rubric`, org, { criteria: [{ name: 'Idea', maxScore: 10, weight: 1 }] });
    const en = await api('post', `/activities/${aid}/entries`, p2, { title: 'My entry', content: 'x' });
    expect(en.status).toBe(201);
    expect((await api('delete', `/activities/${aid}`, p2)).status).toBe(403);
    expect((await api('delete', `/activities/${aid}`, org)).status).toBe(200);
    expect(await Activity.countDocuments({ _id: aid })).toBe(0);
    expect(await Entry.countDocuments({ activityId: aid })).toBe(0);
  });

  it('venues (organiser only), announcements, tasks, shifts, issues and assignments can be deleted by staff only', async () => {
    const org = await makeUser(['organiser']);
    const coord = await makeUser(['coordinator']);
    const part = await makeUser(['participant']);
    const vol = await makeUser(['volunteer']);
    const venue = (await api('post', '/venues', org, { name: `Hall ${Date.now()}` })).body.data._id;
    const id = await publishedEvent(org, { venueId: venue });
    expect((await api('delete', `/venues/${venue}`, part)).status).toBe(403);
    expect((await api('delete', `/venues/${venue}`, coord)).status).toBe(403); // venues: organiser/admin only
    const dv = await api('delete', `/venues/${venue}`, org);
    expect(dv.status).toBe(200);
    expect(dv.body.data.unlinkedEvents).toBe(1);
    expect(await Venue.countDocuments({ _id: venue })).toBe(0);
    expect((await Event.findById(id))!.venueId).toBeUndefined();

    const ann = await api('post', `/events/${id}/announcements`, org, { title: 'Hi there', body: 'Body text' });
    expect((await api('delete', `/announcements/${ann.body.data._id}`, part)).status).toBe(403);
    expect((await api('delete', `/announcements/${ann.body.data._id}`, coord)).status).toBe(200);

    const task = await api('post', `/events/${id}/tasks`, org, { title: 'Carry chairs', assigneeId: vol.id });
    expect((await api('delete', `/tasks/${task.body.data._id}`, vol)).status).toBe(403);
    expect((await api('delete', `/tasks/${task.body.data._id}`, coord)).status).toBe(200);

    const shift = (await api('post', `/events/${id}/shifts`, org, { title: 'Gate', start: hours(48), end: hours(50), requiredCount: 2 })).body.data._id;
    await api('put', `/me/availability/${id}`, vol, { slots: [{ start: hours(47), end: hours(53) }] });
    const asg = await api('post', `/shifts/${shift}/assign`, coord, { volunteerId: vol.id });
    // un-assign is a real delete and frees the unique key, so the same volunteer can be re-assigned
    expect((await api('delete', `/assignments/${asg.body.data._id}`, coord)).status).toBe(200);
    expect(await ShiftAssignment.countDocuments({ shiftId: shift })).toBe(0);
    expect((await api('post', `/shifts/${shift}/assign`, coord, { volunteerId: vol.id })).status).toBe(201);
    expect((await api('delete', `/shifts/${shift}`, coord)).status).toBe(200);
    expect(await ShiftAssignment.countDocuments({ shiftId: shift })).toBe(0);
    expect(await Shift.countDocuments({ _id: shift })).toBe(0);

    const issue = await api('post', `/events/${id}/issues`, vol, { title: 'Broken mic' });
    const c = await api('post', `/issues/${issue.body.data._id}/comments`, vol, { text: 'looking now' });
    const cid = c.body.data.comments[0]._id;
    expect((await api('delete', `/issues/${issue.body.data._id}/comments/${cid}`, vol)).status).toBe(200);
    expect((await api('delete', `/issues/${issue.body.data._id}`, vol)).status).toBe(403);
    expect((await api('delete', `/issues/${issue.body.data._id}`, coord)).status).toBe(200);
  });

  it('problems and contests: guarded deletes with cascade', async () => {
    const org = await makeUser(['organiser']);
    const setter = await makeUser(['judge']);
    const other = await makeUser(['judge']);
    const pid = (await api('post', '/problems', setter, { title: 'Delete Me', statement: 'Print the number one please.', visibility: 'public' })).body.data.id;
    await api('put', `/problems/${pid}/testcases`, setter, { cases: [{ input: '1', expectedOutput: '1' }] });
    await api('put', `/problems/${pid}/editorial`, setter, { content: 'Just print one.' });
    expect((await api('delete', `/problems/${pid}`, other)).status).toBe(403);
    expect((await api('delete', `/problems/${pid}/editorial`, setter)).status).toBe(200);
    expect((await api('delete', `/problems/${pid}/editorial`, setter)).status).toBe(404);

    const cid = (await api('post', '/contests', org, { title: 'Doomed', startAt: hours(5), endAt: hours(9), registrationDeadline: hours(4), problems: [{ problemId: pid, label: 'A' }] })).body.data._id;
    const blocked = await api('delete', `/problems/${pid}`, setter);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Doomed');
    expect((await api('delete', `/contests/${cid}`, setter)).status).toBe(403);
    expect((await api('delete', `/contests/${cid}`, org)).status).toBe(200);
    expect(await Contest.countDocuments({ _id: cid })).toBe(0);
    expect((await api('delete', `/problems/${pid}`, setter)).status).toBe(200);
    expect(await TestCase.countDocuments({ problemId: pid })).toBe(0);
    expect(await Submission.countDocuments({ problemId: pid })).toBe(0);
  });

  it('users: organiser can delete others, never themselves or the last organiser, and the cascade frees seats', async () => {
    const org = await makeUser(['organiser']);
    const part = await makeUser(['participant']);
    const part2 = await makeUser(['participant']);
    const id = await publishedEvent(org, { capacity: 1 });
    await api('post', `/events/${id}/register`, part);
    const w = await api('post', `/events/${id}/register`, part2);
    expect(w.body.data.status).toBe('waitlisted');
    expect((await api('delete', `/users/${part.id}`, part2)).status).toBe(403);
    expect((await api('delete', `/users/${org.id}`, org)).status).toBe(400);
    expect((await api('delete', `/users/${part.id}`, org)).status).toBe(200);
    expect(await User.countDocuments({ _id: part.id })).toBe(0);
    expect((await Registration.findById(w.body.data._id))!.status).toBe('confirmed'); // seat freed → waitlist promoted
    // the deleted user's token no longer works
    expect((await api('get', '/auth/me', part)).status).toBe(401);
  });
});

describe('venue management (v5)', () => {
  it('optional capacity, case-insensitive duplicate -> 409, organiser only', async () => {
    const org = await makeUser(['organiser']);
    const coord = await makeUser(['coordinator']);
    const name = `Garden ${Date.now()}`;
    const a = await api('post', '/venues', org, { name: `  ${name} `, capacity: '', building: '' });
    expect(a.status).toBe(201);
    expect(a.body.data.name).toBe(name);
    expect(a.body.data.capacity).toBeUndefined();
    expect(a.body.data.building).toBeUndefined();
    expect((await api('post', '/venues', org, { name: name.toUpperCase() })).status).toBe(409);
    expect((await api('post', '/venues', coord, { name: `${name} 2` })).status).toBe(403);
    expect((await api('post', '/venues', org, { name: 'x' })).status).toBe(400);
    expect((await api('delete', `/venues/${a.body.data._id}`, org)).status).toBe(200);
  });
});
