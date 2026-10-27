import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { app, api, auth, connect, disconnect, hours, makeUser } from './helpers';
import { AuditLog, Event, Notification, Sponsor } from '../models';
import { MIGRATIONS, migrateSponsors } from '../services/migrations';
import { sendFollowUpReminders } from '../services/sponsorReminders';

beforeAll(connect);
afterAll(disconnect);

describe('sponsors (S7)', () => {
  it('CRUD, tier order, status/payment audit, event links, deliverables, permissions', async () => {
    const org = await makeUser(['organiser']);
    const co = await makeUser(['coordinator']);
    const part = await makeUser(['participant']);
    expect((await api('get', '/sponsors', part)).status).toBe(403);
    expect((await api('get', '/sponsors')).status).toBe(401);
    expect((await api('post', '/sponsors', co, { company: 'X' })).status).toBe(403);
    expect((await api('post', '/sponsors', org, { company: '' })).status).toBe(400);
    expect((await api('post', '/sponsors', org, { company: 'Bad', email: 'nope' })).status).toBe(400);

    const mk = async (company: string, tier: string) => (await api('post', '/sponsors', org, { company, tier, amount: 1000, contributionType: 'cash' })).body.data;
    const bronze = await mk('S7 Bronze Co', 'bronze');
    const title = await mk('S7 Title Co', 'title');
    const gold = await mk('S7 Gold Co', 'gold');
    const l = await api('get', '/sponsors?q=S7%20&pageSize=10', co);
    expect(l.body.data.map((s: { tier: string }) => s.tier)).toEqual(['title', 'gold', 'bronze']);
    expect(l.body.data[0].status).toBe('prospect');

    // status: change + audit, same status conflicts, bad value
    expect((await api('post', `/sponsors/${gold.id}/status`, org, { status: 'contacted' })).body.data.status).toBe('contacted');
    expect((await api('post', `/sponsors/${gold.id}/status`, org, { status: 'contacted' })).status).toBe(409);
    expect((await api('post', `/sponsors/${gold.id}/status`, org, { status: 'nope' })).status).toBe(400);
    expect((await api('post', `/sponsors/${gold.id}/status`, co, { status: 'confirmed' })).status).toBe(403);
    expect(await AuditLog.countDocuments({ action: 'sponsor.status', entityId: gold.id })).toBe(1);

    // patch
    const pt = await api('patch', `/sponsors/${gold.id}`, org, { tier: 'silver', phone: '+880 1700-000000' });
    expect(pt.body.data.tier).toBe('silver');
    expect((await Sponsor.findById(gold.id))!.tierRank).toBe(2);
    expect((await api('patch', `/sponsors/${gold.id}`, org, { status: 'received' })).status).toBe(400); // status only via /status

    // event link
    const ev = await Event.create({ title: 'S7 Fest', type: 'seminar', status: 'published', startAt: hours(5), endAt: hours(7), registrationDeadline: hours(1), capacity: 5, createdBy: org.id });
    expect((await api('post', `/sponsors/${title.id}/events`, org, { eventId: ev.id })).status).toBe(201);
    expect((await api('post', `/sponsors/${title.id}/events`, org, { eventId: ev.id })).status).toBe(409);
    expect((await api('get', `/events/${ev.id}/sponsors`, co)).body.data).toHaveLength(1);

    // deliverables
    const d = (await api('post', `/sponsors/${title.id}/deliverables`, org, { type: 'logo', title: 'Logo on banner' })).body.data;
    expect(d.status).toBe('pending');
    const d2 = (await api('patch', `/deliverables/${d.id}`, org, { status: 'done' })).body.data;
    expect(d2.status).toBe('done');
    expect(d2.doneAt).toBeTruthy();
    expect((await api('post', `/sponsors/${title.id}/deliverables`, org, { type: 'bogus' })).status).toBe(400);

    // payments + audit + totals
    const p = (await api('post', `/sponsors/${title.id}/payments`, org, { pledged: 500, received: 200 })).body.data;
    await api('post', `/sponsors/${title.id}/payments`, org, { pledged: 250.5, dueDate: '2030-01-01' });
    expect((await api('post', `/sponsors/${title.id}/payments`, org, { pledged: -5 })).status).toBe(400);
    await api('patch', `/payments/${p.id}`, org, { received: 500 });
    expect(await AuditLog.countDocuments({ action: { $in: ['sponsor.payment_create', 'sponsor.payment_update'] }, entityId: title.id })).toBe(3);
    const det = (await api('get', `/sponsors/${title.id}`, co)).body.data;
    expect(det.totals).toMatchObject({ pledged: 750.5, received: 500, outstanding: 250.5 });
    expect(det.events).toHaveLength(1);
    expect(det.deliverables).toHaveLength(1);
    const sum = (await api('get', '/sponsors/summary', co)).body.data;
    expect(sum.tiers.map((t: { tier: string }) => t.tier)[0]).toBe('title');
    expect(sum.totals.pledged).toBeGreaterThanOrEqual(750.5);

    // receipts: private, validated, authenticated
    const pdf = Buffer.from('%PDF-1.4\n%receipt test\n' + 'x'.repeat(40));
    const up = (buf: Buffer, name: string) => supertest(app).post(`/api/v1/payments/${p.id}/receipt`).set(auth(org)).attach('file', buf, name);
    expect((await up(Buffer.from('<script>alert(1)</script>'.padEnd(40)), 'r.pdf')).status).toBe(400);
    expect((await up(Buffer.concat([pdf, Buffer.alloc(6 * 1024 * 1024)]), 'big.pdf')).status).toBe(413);
    const good = await up(pdf, '../../evil name.pdf');
    expect(good.status).toBe(201);
    expect(good.body.data.hasReceipt).toBe(true);
    expect(JSON.stringify(good.body)).not.toContain('receiptFile');
    const dl = await supertest(app).get(`/api/v1/payments/${p.id}/receipt`).set(auth(co));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect((await supertest(app).get(`/api/v1/payments/${p.id}/receipt`)).status).toBe(401);
    expect((await supertest(app).get(`/api/v1/payments/${p.id}/receipt`).set(auth(part))).status).toBe(403);
    expect((await supertest(app).get('/uploads/.private/receipts/anything.pdf')).status).toBe(404);
    expect((await api('delete', `/payments/${p.id}/receipt`, org)).body.data.hasReceipt).toBe(false);

    // delete cascades
    expect((await api('delete', `/sponsors/${title.id}`, org)).status).toBe(200);
    expect((await api('get', `/sponsors/${title.id}`, org)).status).toBe(404);
    expect(await AuditLog.countDocuments({ action: 'sponsor.delete', entityId: title.id })).toBe(1);
    void bronze;
  });

  it('follow-up reminders: once per date, owner only, not for received, re-armed by a new date', async () => {
    const org = await makeUser(['organiser']);
    const mk = (company: string, extra: object) => Sponsor.create({ company, ownerId: org.id, createdBy: org.id, status: 'contacted', ...extra });
    const due = await mk('Rem Due', { nextFollowUpAt: new Date(Date.now() - 86400_000) });
    await mk('Rem Future', { nextFollowUpAt: new Date(Date.now() + 5 * 86400_000) });
    await mk('Rem Done', { nextFollowUpAt: new Date(Date.now() - 86400_000), status: 'received' });
    const before = await Notification.countDocuments({ userId: org.id });
    const r1 = await sendFollowUpReminders();
    expect(r1.sent).toBeGreaterThanOrEqual(1);
    const mine = await Notification.find({ userId: org.id });
    expect(mine.length - before).toBe(1);
    expect(mine[0].message).toContain('Rem Due');
    await sendFollowUpReminders();
    expect(await Notification.countDocuments({ userId: org.id })).toBe(before + 1);
    await api('patch', `/sponsors/${due.id}`, org, { nextFollowUpAt: new Date(Date.now() - 3600_000).toISOString() });
    await sendFollowUpReminders();
    expect(await Notification.countDocuments({ userId: org.id })).toBe(before + 2);
    // manual endpoint
    expect((await api('post', '/sponsors/reminders/run', org)).status).toBe(200);
  });

  it('migration is registered and idempotent; backfills tierRank', async () => {
    expect(MIGRATIONS.some((m) => m.name === '2026-10-s7-sponsors-collections-and-indexes')).toBe(true);
    await Sponsor.collection.insertOne({ company: 'Legacy', tier: 'gold' });
    await migrateSponsors();
    const s = await Sponsor.findOne({ company: 'Legacy' });
    expect(s!.tierRank).toBe(1);
    expect(s!.status).toBe('prospect');
    expect(await migrateSponsors()).toBe(0);
  });
});
