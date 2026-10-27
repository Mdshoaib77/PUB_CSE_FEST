import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { app, api, connect, disconnect, hours, makeUser, auth } from './helpers';
import { CertificateTemplate, Event } from '../models';
import { migrateCertTemplatesV6 } from '../services/migrations';
import { getTemplate } from '../services/certTemplate';

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(32)]);

beforeAll(connect);
afterAll(disconnect);

describe('certificate template v6 (API)', () => {
  it('extended fields round-trip, limits are enforced, legacy body still works, reset restores defaults', async () => {
    const org = await makeUser(['organiser']);
    const coord = await makeUser(['coordinator']);
    const ev = await Event.create({
      title: 'V6 Fest',
      type: 'seminar',
      status: 'published',
      startAt: hours(-5),
      endAt: hours(-3),
      registrationDeadline: hours(-10),
      capacity: 10,
      createdBy: org.id,
    });
    const url = `/events/${ev.id}/certificate-template`;

    const t0 = (await api('get', url, coord)).body.data;
    expect(t0).toMatchObject({ theme: 'custom', borderStyle: 'classic', fontStyle: 'serif', sealEnabled: true, bodyText: '', customFields: [] });
    expect(t0.signatories).toHaveLength(3);

    // permissions + limits
    expect((await api('put', url, coord, { theme: 'royal' })).status).toBe(403);
    expect((await api('put', url, org, { bodyText: 'x'.repeat(281) })).status).toBe(400);
    expect((await api('put', url, org, { bodyText: 'Hello {nope}' })).status).toBe(400);
    expect((await api('put', url, org, { signatories: [{ name: 'n'.repeat(41), title: '' }] })).status).toBe(400);
    expect((await api('put', url, org, { customFields: Array.from({ length: 5 }, () => ({ label: 'a', value: 'b' })) })).status).toBe(400);
    expect((await api('put', url, org, { theme: 'neon' })).status).toBe(400);

    const body = {
      theme: 'violet',
      borderStyle: 'modern',
      fontStyle: 'sans',
      sealEnabled: false,
      signatories: [
        { name: 'A. One', title: 'Convener' },
        { name: 'B. Two', title: 'Head' },
      ],
      headlines: { winner: 'Certificate of Excellence' },
      bodyText: 'Presented to {name} for {position} in {event}.',
      customFields: [
        { label: 'Motto', value: 'Build' },
        { label: '', value: '' },
      ],
    };
    const saved = (await api('put', url, org, body)).body.data;
    expect(saved).toMatchObject({ theme: 'violet', borderStyle: 'modern', fontStyle: 'sans', sealEnabled: false, signatureName: 'A. One' });
    expect(saved.headlines.winner).toBe('Certificate of Excellence');
    expect(saved.headlines.participation).toBe('');
    expect(saved.customFields).toEqual([{ label: 'Motto', value: 'Build' }]);
    expect(saved.signatories[1]).toMatchObject({ name: 'B. Two', title: 'Head' });

    // legacy S6 body edits signatory 1 only
    const legacy = (await api('put', url, org, { signatureName: 'Legacy', primaryColor: '#ff0000' })).body.data;
    expect(legacy.signatories[0].name).toBe('Legacy');
    expect(legacy.signatories[1].name).toBe('B. Two');
    expect(legacy.theme).toBe('violet');

    // uploads: second logo + 2nd signature image, magic bytes enforced
    const up = (seg: string, buf: Buffer, name: string) => supertest(app).post(`/api/v1${url}/${seg}`).set(auth(org)).attach('file', buf, name);
    expect((await up('logo2', Buffer.from('<svg onload="x"></svg>'.padEnd(40)), 'a.png')).status).toBe(400);
    expect((await up('logo2', pad(PNG), 'l.png')).status).toBe(201);
    const s2 = await up('signatory-2', pad(PNG), 's.png');
    expect(s2.status).toBe(201);
    expect(s2.body.data.logo2Url).toMatch(/^\/uploads\/certs\/[a-f0-9]{24}\.png$/);
    expect(s2.body.data.signatories[1].imageUrl).toMatch(/^\/uploads\/certs\//);
    expect(s2.body.data.signatories[1].name).toBe('B. Two'); // text untouched by the upload

    // live preview: the real PDF, unsaved edits applied, nothing written
    for (const sample of ['individual', 'team3', 'team8', 'winner']) {
      const r = await supertest(app)
        .post(`/api/v1${url}/preview`)
        .set(auth(org))
        .send({ sample, template: { theme: 'emerald', bodyText: 'Hi {name} {team}' } })
        .buffer(true)
        .parse((res, cb) => {
          const c: Buffer[] = [];
          res.on('data', (d: Buffer) => c.push(d));
          res.on('end', () => cb(null, Buffer.concat(c)));
        });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('application/pdf');
      expect((r.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect((await getTemplate(ev.id)).theme).toBe('violet'); // preview did not save
    expect((await api('post', `${url}/preview`, org, { template: { bodyText: 'x'.repeat(500) } })).status).toBe(400);
    expect((await api('post', `${url}/preview`, coord, {})).status).toBe(403);

    // reset
    expect((await api('delete', url, coord)).status).toBe(403);
    const reset = (await api('delete', url, org)).body.data;
    expect(reset).toMatchObject({ theme: 'custom', logo2Url: null, bodyText: '', customFields: [] });
    expect(await CertificateTemplate.countDocuments({ eventId: ev.id })).toBe(0);
  });

  it('migration is idempotent and keeps the legacy signatory', async () => {
    const org = await makeUser(['organiser']);
    const ev = await Event.create({
      title: 'V6 Migrate',
      type: 'seminar',
      status: 'published',
      startAt: hours(-5),
      endAt: hours(-3),
      registrationDeadline: hours(-10),
      capacity: 10,
      createdBy: org.id,
    });
    await CertificateTemplate.collection.insertOne({
      eventId: ev._id,
      signatureName: 'Old Name',
      signatureTitle: 'Old Title',
      primaryColor: '#123456',
      accentColor: '#654321',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(await migrateCertTemplatesV6()).toBeGreaterThan(0);
    const t = await getTemplate(ev.id);
    expect(t.signatories[0]).toMatchObject({ name: 'Old Name', title: 'Old Title' });
    expect(t).toMatchObject({ primaryColor: '#123456', theme: 'custom', sealEnabled: true });
    expect(await migrateCertTemplatesV6()).toBe(0);
    expect((await getTemplate(ev.id)).signatories[0].name).toBe('Old Name');
  });
});
