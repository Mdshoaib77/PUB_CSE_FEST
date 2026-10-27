import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { app, api, auth, connect, disconnect, hours, makeUser } from './helpers';
import { Event, Migration } from '../models';
import { drainPlagiarismQueue } from '../services/plagiarismCheck';
import { runMigrations } from '../services/migrations';

beforeAll(connect);
afterAll(disconnect);

const A = 'int main(){ int n; scanf("%d",&n); int s=0; for(int i=0;i<n;i++){ int x; scanf("%d",&x); if(x>0) s+=x*2; else s-=1; } printf("%d", s); return 0; }';
const A2 = '// copy\nint main()\n{\n int cnt; scanf("%d",&cnt);\n int sum = 0;\n for (int k=0;k<cnt;k++) {\n  int v; scanf("%d",&v);\n  if (v>0) sum+=v*5; else sum-=3;\n }\n printf("%d", sum);\n return 0;\n}';
const B = 'int fib(int n){ return n<2?n:fib(n-1)+fib(n-2); } int main(){ int n; scanf("%d",&n); for(int i=0;i<n;i++) printf("%d ", fib(i)); return 0; }';

describe('plagiarism engine API (S11)', () => {
  it('submit (paste + upload), auto-run, pairs, review, threshold, starter code, migration', async () => {
    const org = await makeUser(['organiser']);
    const judge = await makeUser(['judge']);
    const s1 = await makeUser(['participant']);
    const s2 = await makeUser(['participant']);
    const s3 = await makeUser(['participant']);
    const ev = await Event.create({ title: 'Plag Fest', type: 'seminar', status: 'published', startAt: hours(5), endAt: hours(7), registrationDeadline: hours(1), capacity: 5, createdBy: org.id });
    const body = (language: string, code: string) => ({ eventId: ev.id, language, code });

    // validation
    expect((await api('post', '/plagiarism/submissions', undefined, body('c', A))).status).toBe(401);
    expect((await api('post', '/plagiarism/submissions', s1, { language: 'c', code: A })).status).toBe(400); // no scope
    expect((await api('post', '/plagiarism/submissions', s1, body('ruby', A))).status).toBe(400);
    expect((await api('post', '/plagiarism/submissions', s1, body('c', '   '))).status).toBe(400);

    // paste + upload
    const r1 = await api('post', '/plagiarism/submissions', s1, body('c', A));
    expect(r1.status).toBe(201);
    expect(r1.body.data.code).toBeUndefined();
    const up = await supertest(app).post('/api/v1/plagiarism/submissions').set(auth(s2)).field('eventId', ev.id).field('language', 'c').attach('file', Buffer.from(A2), 'sol.c');
    expect(up.status).toBe(201);
    expect(up.body.data.source).toBe('upload');
    await api('post', '/plagiarism/submissions', s3, body('c', B));
    await drainPlagiarismQueue();

    // upload safety
    const bad = (name: string, buf: Buffer) => supertest(app).post('/api/v1/plagiarism/submissions').set(auth(s3)).field('eventId', ev.id).field('language', 'c').attach('file', buf, name);
    expect((await bad('x.exe', Buffer.from(A))).status).toBe(400);
    expect((await bad('x.c', Buffer.from([0x4d, 0x5a, 0, 0, 1, 2]))).status).toBe(400);
    expect((await bad('x.c', Buffer.alloc(201 * 1024, 'a'))).status).toBe(413);

    // auto-run produced the pair: renamed copy is ~100% and suspicious, unrelated code is not stored as suspicious
    const pairs = await api('get', `/plagiarism/pairs?eventId=${ev.id}`, judge);
    expect(pairs.status).toBe(200);
    const top = pairs.body.data.items[0];
    expect(top.similarity).toBe(100);
    expect(top.status).toBe('suspicious');
    expect(pairs.body.data.items.filter((p: { status: string }) => p.status === 'suspicious')).toHaveLength(1);
    expect((await api('get', '/plagiarism/pairs', s1)).status).toBe(403);

    // review: confirm + note; manual decision survives a re-run
    const rv = await api('patch', `/plagiarism/pairs/${top.id}`, judge, { status: 'confirmed', note: 'Same structure' });
    expect(rv.body.data.status).toBe('confirmed');
    expect(rv.body.data.notes).toHaveLength(1);
    await api('post', '/plagiarism/check', judge, { eventId: ev.id });
    await drainPlagiarismQueue();
    expect((await api('get', `/plagiarism/pairs/${top.id}`, judge)).body.data.status).toBe('confirmed');
    expect((await api('get', `/plagiarism/pairs/${top.id}`, judge)).body.data.a.code).toBeTruthy();

    // threshold: raise above the score -> 'auto' goes to clear; a manual decision stays
    expect((await api('put', '/plagiarism/settings', judge, { scope: 'event', refId: ev.id, suspiciousThreshold: 90 })).status).toBe(403);
    expect((await api('put', '/plagiarism/settings', org, { scope: 'event', refId: ev.id, suspiciousThreshold: 5 })).status).toBe(400);
    await api('patch', `/plagiarism/pairs/${top.id}`, judge, { status: 'auto' });
    expect((await api('get', `/plagiarism/pairs/${top.id}`, judge)).body.data.status).toBe('suspicious');
    const set = await api('put', '/plagiarism/settings', org, { scope: 'event', refId: ev.id, suspiciousThreshold: 100 });
    expect(set.body.data.threshold).toBe(100);
    expect((await api('get', `/plagiarism/settings?eventId=${ev.id}`, judge)).body.data.source).toBe('event');
    await api('put', '/plagiarism/settings', org, { scope: 'event', refId: ev.id, suspiciousThreshold: null });
    expect((await api('get', `/plagiarism/settings?eventId=${ev.id}`, judge)).body.data.threshold).toBe(70);

    // starter code: only organiser; marking the whole copy as template makes the pair disappear from suspicious
    expect((await api('post', '/plagiarism/starter-code', judge, { eventId: ev.id, language: 'c', code: A })).status).toBe(403);
    expect((await api('post', '/plagiarism/starter-code', org, { eventId: ev.id, language: 'c', code: A })).status).toBe(201);
    await drainPlagiarismQueue();
    const after = await api('get', `/plagiarism/pairs?eventId=${ev.id}&min=50`, judge);
    expect(after.body.data.items.filter((p: { status: string }) => p.status === 'suspicious')).toHaveLength(0);

    // own submissions + access control
    const mine = await api('get', '/plagiarism/submissions/mine', s1);
    expect(mine.body.data).toHaveLength(1);
    expect((await api('get', `/plagiarism/submissions/${r1.body.data.id}`, s2)).status).toBe(404);
    expect((await api('get', `/plagiarism/submissions/${r1.body.data.id}`, s1)).body.data.code).toContain('scanf');

    // migration: idempotent, recorded
    await Migration.deleteOne({ name: '2026-10-s11-plagiarism-collections-and-indexes' });
    expect(await runMigrations()).toContain('2026-10-s11-plagiarism-collections-and-indexes');
    expect(await runMigrations()).toEqual([]);
  });
});
