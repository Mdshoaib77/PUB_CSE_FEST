import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { app, api, auth, connect, disconnect, hours, makeUser } from './helpers';
import { Event } from '../models';

beforeAll(connect);
afterAll(disconnect);

describe('sponsors UI support (S8)', () => {
  it('CSV export, public our-sponsors (tier order, confirmed only), read-only portal, portal link', async () => {
    const org = await makeUser(['organiser']);
    const co = await makeUser(['coordinator']);
    const sp = await makeUser(['sponsor']);
    const part = await makeUser(['participant']);
    const mk = async (company: string, tier: string, status: string) => {
      const s = (await api('post', '/sponsors', org, { company, tier, amount: 500 })).body.data;
      if (status !== 'prospect') await api('post', `/sponsors/${s.id}/status`, org, { status });
      return s;
    };
    const bronze = await mk('S8 Bronze', 'bronze', 'confirmed');
    const title = await mk('S8 Title', 'title', 'received');
    const hidden = await mk('S8 Prospect', 'gold', 'prospect');
    const ev = await Event.create({ title: 'S8 Fest', type: 'seminar', status: 'published', startAt: hours(5), endAt: hours(7), registrationDeadline: hours(1), capacity: 5, createdBy: org.id });
    const draft = await Event.create({ title: 'S8 Draft', type: 'seminar', status: 'draft', startAt: hours(5), endAt: hours(7), registrationDeadline: hours(1), capacity: 5, createdBy: org.id });
    for (const s of [bronze, title, hidden]) await api('post', `/sponsors/${s.id}/events`, org, { eventId: ev.id });
    await api('post', `/sponsors/${title.id}/events`, org, { eventId: draft.id });
    await api('post', `/sponsors/${title.id}/payments`, org, { pledged: 300, received: 100 });

    // public: no auth, confirmed/received only, tier order, no private fields; draft events are hidden
    const pub = await supertest(app).get(`/api/v1/events/${ev.id}/our-sponsors`);
    expect(pub.status).toBe(200);
    expect(pub.body.data.map((x: { company: string }) => x.company)).toEqual(['S8 Title', 'S8 Bronze']);
    expect(JSON.stringify(pub.body.data)).not.toMatch(/email|amount|phone/);
    expect((await supertest(app).get(`/api/v1/events/${draft.id}/our-sponsors`)).status).toBe(404);

    // CSV export: permissions, filter, header
    expect((await api('get', '/sponsors/export.csv', part)).status).toBe(403);
    const csv = await supertest(app).get('/api/v1/sponsors/export.csv?q=S8%20&tier=title').set(auth(co));
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('S8 Title');
    expect(csv.text).not.toContain('S8 Bronze');

    // portal: unlinked -> 404; link (organiser only) -> own data only, read-only
    expect((await api('get', '/sponsor-portal/me', sp)).status).toBe(404);
    expect((await api('get', '/sponsor-portal/me', part)).status).toBe(403);
    expect((await api('put', `/sponsors/${title.id}/portal-user`, co, { email: sp.email })).status).toBe(403);
    expect((await api('put', `/sponsors/${title.id}/portal-user`, org, { email: part.email })).status).toBe(404);
    expect((await api('put', `/sponsors/${title.id}/portal-user`, org, { email: sp.email })).status).toBe(200);
    expect((await api('put', `/sponsors/${bronze.id}/portal-user`, org, { email: sp.email })).status).toBe(409);
    const me = (await api('get', '/sponsor-portal/me', sp)).body.data;
    expect(me.company).toBe('S8 Title');
    expect(me.totals).toMatchObject({ pledged: 300, received: 100, outstanding: 200 });
    expect(me.visibility.events.find((e: { title: string }) => e.title === 'S8 Fest').visible).toBe(true);
    expect(me.visibility.events.find((e: { title: string }) => e.title === 'S8 Draft').visible).toBe(false);
    expect(JSON.stringify(me)).not.toMatch(/notes|email|receiptFile/);
    expect((await api('patch', `/sponsors/${title.id}`, sp, { tier: 'bronze' })).status).toBe(403);
    expect((await api('post', `/sponsors/${title.id}/payments`, sp, { received: 1 })).status).toBe(403);
  });
});
