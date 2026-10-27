import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, hours, makeUser } from './helpers';
import { Activity, AuditLog, Certificate, CheckIn, Event, Notification, Registration, Result } from '../models';
import { MIGRATIONS, migrateCertificates } from '../services/migrations';

beforeAll(connect);
afterAll(disconnect);

const pdf = (url: string, who: { token: string }) =>
  api('get', url, who)
    .buffer(true)
    .parse((res, cb) => {
      const d: Buffer[] = [];
      res.on('data', (c: Buffer) => d.push(c));
      res.on('end', () => cb(null, Buffer.concat(d)));
    });

describe('certificates (S5)', () => {
  it('bulk generate, verify, download, revoke, reissue, notify, audit', async () => {
    const org = await makeUser(['organiser']);
    const p1 = await makeUser(['participant']);
    const p2 = await makeUser(['participant']);
    const ev = await Event.create({
      title: 'Cert Fest',
      type: 'seminar',
      status: 'published',
      startAt: hours(-5),
      endAt: hours(-3),
      registrationDeadline: hours(-10),
      capacity: 10,
      createdBy: org.id,
    });
    for (const p of [p1, p2]) await Registration.create({ eventId: ev.id, subjectKey: `u:${p.id}`, userId: p.id, status: 'confirmed' });
    await CheckIn.create({ eventId: ev.id, subjectKey: `u:${p1.id}`, userId: p1.id, operatorId: org.id });

    // permissions
    expect((await api('post', `/events/${ev.id}/certificates/generate`, p1, {})).status).toBe(403);
    expect((await api('post', `/events/${ev.id}/certificates/generate`)).status).toBe(401);

    // bulk: only the checked-in participant + the event creator (organizer) ; idempotent
    const g1 = await api('post', `/events/${ev.id}/certificates/generate`, org, { types: ['participation', 'organizer'] });
    expect(g1.status).toBe(201);
    expect(g1.body.data.created).toBe(2);
    const g2 = await api('post', `/events/${ev.id}/certificates/generate`, org, { types: ['participation', 'organizer'] });
    expect(g2.body.data).toMatchObject({ created: 0, skipped: 2 });
    const g3 = await api('post', `/events/${ev.id}/certificates/generate`, org, { types: ['participation'], attendedOnly: false });
    expect(g3.body.data).toMatchObject({ created: 1, skipped: 1 });
    expect(await Certificate.countDocuments({ eventId: ev.id })).toBe(3);

    // recipient sees it, notification + audit exist
    const mine = await api('get', '/certificates/mine', p1);
    expect(mine.body.data).toHaveLength(1);
    const id: string = mine.body.data[0].id;
    expect(id).toMatch(/^FH-/);
    expect(await Notification.countDocuments({ userId: p1.id, title: 'Certificate issued' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'certificate.bulk_generate' })).toBe(3);

    // public verify (no auth): valid / not found / garbage
    const v = await api('get', `/verify/${id.toLowerCase()}`);
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ status: 'valid', id, recipientName: expect.any(String), eventTitle: 'Cert Fest' });
    expect(v.body.data.userId).toBeUndefined();
    expect((await api('get', '/verify/FH-0000-0000-0000-00')).body.data.status).toBe('not_found');
    expect((await api('get', '/verify/garbage')).body.data.status).toBe('not_found');

    // download: owner ok, other participant forbidden, staff ok
    const d = await pdf(`/certificates/${id}/download`, p1);
    expect(d.status).toBe(200);
    expect(d.headers['content-type']).toContain('application/pdf');
    expect((d.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await api('get', `/certificates/${id}/download`, p2)).status).toBe(403);
    expect((await pdf(`/certificates/${id}/download`, org)).status).toBe(200);

    // revoke
    expect((await api('post', `/certificates/${id}/revoke`, p1, {})).status).toBe(403);
    const rv = await api('post', `/certificates/${id}/revoke`, org, { reason: 'Name misspelt' });
    expect(rv.status).toBe(200);
    expect(rv.body.data.status).toBe('revoked');
    expect((await api('post', `/certificates/${id}/revoke`, org, {})).status).toBe(409);
    expect((await api('get', `/verify/${id}`)).body.data.status).toBe('revoked');
    expect((await api('get', `/certificates/${id}/download`, p1)).status).toBe(409);
    expect(await Notification.countDocuments({ userId: p1.id, title: 'Certificate revoked' })).toBe(1);

    // reissue: new id, old points to it, only one valid per person
    const ri = await api('post', `/certificates/${id}/reissue`, org, {});
    expect(ri.status).toBe(201);
    const newId: string = ri.body.data.id;
    expect(newId).not.toBe(id);
    expect(ri.body.data.status).toBe('valid');
    const old = await api('get', `/verify/${id}`);
    expect(old.body.data).toMatchObject({ status: 'revoked', replacedBy: newId });
    expect((await api('get', `/verify/${newId}`)).body.data.status).toBe('valid');
    expect((await api('post', `/certificates/${id}/reissue`, org, {})).status).toBe(409); // already reissued
    expect(await Certificate.countDocuments({ eventId: ev.id, userId: p1.id, status: 'valid' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: { $in: ['certificate.revoke', 'certificate.reissue'] } })).toBeGreaterThanOrEqual(2);

    // generate again must NOT recreate the revoked slot twice (a valid one exists)
    const g4 = await api('post', `/events/${ev.id}/certificates/generate`, org, { types: ['participation'] });
    expect(g4.body.data.created).toBe(0);

    // staff listing
    const list = await api('get', `/events/${ev.id}/certificates?status=valid`, org);
    expect(list.body.data.length).toBe(3);
    expect((await api('get', `/events/${ev.id}/certificates`, p1)).status).toBe(403);
  });

  it('winner / runner-up come from OFFICIAL results only; manual issue; draft events refused', async () => {
    const org = await makeUser(['organiser']);
    const a = await makeUser(['participant']);
    const b = await makeUser(['participant']);
    const ev = await Event.create({ title: 'Podium', type: 'competition', status: 'published', startAt: hours(-5), endAt: hours(-3), registrationDeadline: hours(-10), capacity: 10, createdBy: org.id });
    const act = await Activity.create({ eventId: ev.id, title: 'Poster Round', kind: 'competition', start: hours(-5), end: hours(-3) });
    const rankings = [
      { title: 'A', ownerKey: `u:${a.id}`, percent: 90, rank: 1 },
      { title: 'B', ownerKey: `u:${b.id}`, percent: 80, rank: 2 },
    ];
    await Result.create({ activityId: act.id, rankings, status: 'draft' });
    const none = await api('post', `/events/${ev.id}/certificates/generate`, org, { types: ['winner', 'runner_up'] });
    expect(none.body.data.created).toBe(0);
    await Result.updateOne({ activityId: act.id }, { status: 'official' });
    const some = await api('post', `/events/${ev.id}/certificates/generate`, org, { types: ['winner', 'runner_up'] });
    expect(some.body.data.created).toBe(2);
    const w = await api('get', '/certificates/mine', a);
    expect(w.body.data[0]).toMatchObject({ type: 'winner', position: 1, positionLabel: '1st Place - Poster Round' });
    const ru = await api('get', '/certificates/mine', b);
    expect(ru.body.data[0]).toMatchObject({ type: 'runner_up', position: 2 });

    // manual issue + duplicate protection
    const m = await api('post', `/events/${ev.id}/certificates`, org, { userId: a.id, type: 'volunteer' });
    expect(m.status).toBe(201);
    expect((await api('post', `/events/${ev.id}/certificates`, org, { userId: a.id, type: 'volunteer' })).status).toBe(409);
    expect((await api('post', `/events/${ev.id}/certificates`, org, { userId: 'nope', type: 'volunteer' })).status).toBe(400);

    const draft = await Event.create({ title: 'Draft', type: 'seminar', status: 'draft', startAt: hours(5), endAt: hours(6), registrationDeadline: hours(1), capacity: 5, createdBy: org.id });
    expect((await api('post', `/events/${draft.id}/certificates/generate`, org, {})).status).toBe(422);
  });

  it('migration is registered and idempotent', async () => {
    expect(MIGRATIONS.some((m) => m.name === '2026-10-s5-certificates-collection-and-indexes')).toBe(true);
    await migrateCertificates();
    expect(await migrateCertificates()).toBe(0);
  });
});
