import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import zlib from 'zlib';
import supertest from 'supertest';
import { app, api, connect, disconnect, hours, makeUser, auth } from './helpers';
import { Certificate, Event } from '../models';
import { issueCertificate } from '../services/certificates';
import { detectCertImage, prepareImage } from '../services/certTemplate';
import { renderCertificatePdf } from '../services/certificatePdf';

// tiny valid 2x2 RGBA PNG built in-test
function png(): Buffer {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 128]);
  const raw = Buffer.concat([row, row].map((r) => Buffer.concat([r, Buffer.from([0, 0, 255, 255])])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

describe('certificate images + branded PDF (no DB)', () => {
  it('detects only JPG/PNG by magic bytes', () => {
    expect(detectCertImage(png())).toBe('png');
    expect(detectCertImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x"></svg>'))).toBeNull();
    expect(detectCertImage(Buffer.from('GIF89a' + 'x'.repeat(30)))).toBeNull();
  });
  it('prepares a PNG and renders a PDF that embeds it', () => {
    const im = prepareImage(png());
    expect(im && im.w).toBe(2);
    const bytes = renderCertificatePdf({ certId: 'FH-AAAA-AAAA-AAAA-00', type: 'participation', recipientName: 'A B', eventTitle: 'E', eventDate: new Date(), signatureText: 's', verifyUrl: 'http://x/verify/1', brand: { primaryColor: '#112233', logo: im, signatureImage: im, signatureName: 'Dr X' } });
    const s = Buffer.from(bytes).toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s).toContain('/XObject');
    expect(s).toContain('/SMask');
  });
});

beforeAll(connect);
afterAll(disconnect);

describe('certificates S6 (list, csv, template, uploads)', () => {
  it('search/filter/pagination, csv export, template + upload limits', async () => {
    const org = await makeUser(['organiser']);
    const coord = await makeUser(['coordinator']);
    const part = await makeUser(['participant']);
    const ev = await Event.create({ title: 'S6 Fest', type: 'seminar', status: 'published', startAt: hours(-5), endAt: hours(-3), registrationDeadline: hours(-10), capacity: 10, createdBy: org.id });
    const E = { id: ev.id as string, title: ev.title, startAt: ev.startAt, createdBy: org.id };
    const names = ['Alice Zed', 'Bob Zed', 'Carol Only'];
    const users = [part, await makeUser(['participant']), await makeUser(['participant'])];
    for (let i = 0; i < 3; i++) await issueCertificate({ event: E, userId: users[i].id, type: 'participation', recipientName: names[i], issuedBy: org.id });

    const l1 = await api('get', `/events/${ev.id}/certificates?paged=1&pageSize=2&page=1`, org);
    expect(l1.body.data.items).toHaveLength(2);
    expect(l1.body.data.total).toBe(3);
    expect(l1.body.data.pages).toBe(2);
    const l2 = await api('get', `/events/${ev.id}/certificates?q=zed`, coord);
    expect(l2.body.data).toHaveLength(2);
    expect((await api('get', `/events/${ev.id}/certificates?q=.*`, org)).body.data).toHaveLength(0); // regex chars are escaped
    expect((await api('get', `/events/${ev.id}/certificates`, part)).status).toBe(403);

    const first = l1.body.data.items[0];
    await api('post', `/certificates/${first.id}/revoke`, org, { reason: 'x' });
    expect((await api('get', `/events/${ev.id}/certificates?status=revoked`, org)).body.data).toHaveLength(1);

    const csv = await api('get', `/events/${ev.id}/certificates/export.csv`, org);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('Certificate ID');
    expect(csv.text).toContain('Alice Zed');
    expect((await api('get', `/events/${ev.id}/certificates/export.csv`, part)).status).toBe(403);

    // template
    const t0 = await api('get', `/events/${ev.id}/certificate-template`, coord);
    expect(t0.body.data.primaryColor).toBe('#4f46e5');
    expect((await api('put', `/events/${ev.id}/certificate-template`, coord, { signatureName: 'x' })).status).toBe(403);
    expect((await api('put', `/events/${ev.id}/certificate-template`, org, { primaryColor: 'red' })).status).toBe(400);
    const t1 = await api('put', `/events/${ev.id}/certificate-template`, org, { signatureName: 'Dr Who', primaryColor: '#ff0000' });
    expect(t1.body.data.signatureName).toBe('Dr Who');

    const up = (buf: Buffer, name: string) => supertest(app).post(`/api/v1/events/${ev.id}/certificate-template/logo`).set(auth(org)).attach('file', buf, name);
    expect((await up(Buffer.from('<svg onload="alert(1)"></svg>'.padEnd(40)), 'a.png')).status).toBe(400); // wrong bytes, fake extension
    expect((await up(Buffer.concat([png(), Buffer.alloc(3 * 1024 * 1024)]), 'big.png')).status).toBe(413);
    const good = await up(png(), 'logo.png');
    expect(good.status).toBe(201);
    expect(good.body.data.logoUrl).toMatch(/^\/uploads\/certs\/[a-f0-9]{24}\.png$/);

    // download with template still returns a PDF
    const own = await Certificate.findOne({ eventId: ev.id, status: 'valid' });
    const dl = await supertest(app).get(`/api/v1/certificates/${own!.certId}/download`).set(auth(org));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect((await api('delete', `/events/${ev.id}/certificate-template/logo`, org)).body.data.logoUrl).toBeNull();
  });
});
