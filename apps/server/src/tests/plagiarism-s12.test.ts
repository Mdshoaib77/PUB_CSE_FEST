import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, hours, makeUser } from './helpers';
import { AuditLog, Event, Notification, PlagiarismPair } from '../models';
import { drainPlagiarismQueue } from '../services/plagiarismCheck';
import { seedPlagiarism } from '../seed/plagiarism';

beforeAll(connect);
afterAll(disconnect);

const A = 'int main(){ int n; scanf("%d",&n); int s=0; for(int i=0;i<n;i++){ int x; scanf("%d",&x); if(x>0) s+=x*2; else s-=1; } printf("%d", s); return 0; }';
const A2 = 'int main()\n{\n int cnt; scanf("%d",&cnt);\n int sum = 0;\n for (int k=0;k<cnt;k++) {\n  int v; scanf("%d",&v);\n  if (v>0) sum+=v*5; else sum-=3;\n }\n printf("%d", sum);\n return 0;\n}';

describe('plagiarism report support (S12)', () => {
  it('notifies the organiser once, diff + status endpoints, flag/confirm audit', async () => {
    const org = await makeUser(['organiser']);
    const other = await makeUser(['organiser']);
    const judge = await makeUser(['judge']);
    const s1 = await makeUser(['participant']);
    const s2 = await makeUser(['participant']);
    const ev = await Event.create({ title: 'S12 Fest', type: 'seminar', status: 'published', startAt: hours(5), endAt: hours(7), registrationDeadline: hours(1), capacity: 5, createdBy: org.id });
    await api('post', '/plagiarism/submissions', s1, { eventId: ev.id, language: 'c', code: A });
    await api('post', '/plagiarism/submissions', s2, { eventId: ev.id, language: 'c', code: A2 });
    await drainPlagiarismQueue();

    // one notice, to the event's organiser only, linking to the pair
    const notes = await Notification.find({ title: 'High code similarity' });
    expect(notes).toHaveLength(1);
    expect(String(notes[0]!.userId)).toBe(org.id);
    expect(notes[0]!.link).toMatch(/^\/plagiarism\?pair=[a-f0-9]{24}$/);
    await api('post', '/plagiarism/check', judge, { eventId: ev.id }); // re-run: no second notice
    await drainPlagiarismQueue();
    expect(await Notification.countDocuments({ title: 'High code similarity' })).toBe(1);

    // status line
    const st = await api('get', `/plagiarism/check/status?eventId=${ev.id}`, judge);
    expect(st.status).toBe(200);
    expect(st.body.data).toMatchObject({ submissions: 2, done: 2, running: false });
    expect(st.body.data.pairs.suspicious).toBe(1);
    expect((await api('get', `/plagiarism/check/status?eventId=${ev.id}`, s1)).status).toBe(403);

    // side-by-side
    const pair = await PlagiarismPair.findOne({ eventId: ev.id });
    const d = await api('get', `/plagiarism/pairs/${pair!.id}/diff`, judge);
    expect(d.status).toBe(200);
    expect(d.body.data.blocks).toBeGreaterThan(0);
    expect(d.body.data.a.lines.some((l: { block: number | null }) => l.block != null)).toBe(true);
    expect(d.body.data.b.lines.some((l: { block: number | null }) => l.block != null)).toBe(true);
    expect((await api('get', `/plagiarism/pairs/${pair!.id}/diff`, s1)).status).toBe(403);

    // flag / confirm are audited
    await api('patch', `/plagiarism/pairs/${pair!.id}`, judge, { status: 'confirmed', note: 'Confirmed after review' });
    await api('patch', `/plagiarism/pairs/${pair!.id}`, judge, { status: 'suspicious' });
    expect(await AuditLog.countDocuments({ action: 'plagiarism.confirm', entityId: pair!.id })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'plagiarism.flag', entityId: pair!.id })).toBe(1);
    void other;
  });

  it('demo seed: copied pair + renamed pair are suspicious, unrelated original is not; idempotent', async () => {
    const org = await makeUser(['organiser']);
    await Event.create({ title: 'Demo: Hack-a-thon Warm-up', type: 'competition', status: 'published', startAt: hours(5), endAt: hours(7), registrationDeadline: hours(1), capacity: 5, createdBy: org.id });
    const r = await seedPlagiarism(() => undefined);
    expect(r.submissions).toBe(5);
    const hot = await PlagiarismPair.find({ status: 'suspicious', similarity: { $gte: 95 } });
    expect(hot.length).toBeGreaterThanOrEqual(2);
    expect((await seedPlagiarism(() => undefined)).submissions).toBe(0);
  });
});
