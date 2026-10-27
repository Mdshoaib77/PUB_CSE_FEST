import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, connect, disconnect, makeUser } from './helpers';
import { CodeSubmission, Event, Feedback, Notification, AuditLog } from '../models';
import { generateDraft } from '../services/aiFeedback';
import { runMigrations } from '../services/migrations';

let org: Awaited<ReturnType<typeof makeUser>>, judge: typeof org, stu: typeof org, other: typeof org;
let eventId: string, subId: string, rubricId: string;

beforeAll(async () => {
  await connect();
  org = await makeUser(['organiser']); judge = await makeUser(['judge']); stu = await makeUser(['participant']); other = await makeUser(['participant']);
  const ev = await Event.create({ title: 'FB Event', type: 'competition', status: 'published', startAt: new Date(Date.now() + 864e5), endAt: new Date(Date.now() + 2 * 864e5), createdBy: org.id } as never);
  eventId = ev.id;
  subId = (await CodeSubmission.create({ userId: stu.id, eventId, scopeKey: `e:${eventId}`, language: 'python', code: 'print(1)' })).id;
});
afterAll(disconnect);

describe('S13 rubrics + feedback', () => {
  it('rubric CRUD with permissions and validation', async () => {
    expect((await api('post', '/feedback-rubrics', stu, { eventId, name: 'R', criteria: [] })).status).toBe(403);
    expect((await api('post', '/feedback-rubrics', org, { name: 'R', criteria: [] })).status).toBe(400);
    const c = await api('post', '/feedback-rubrics', org, { eventId, name: 'Code', criteria: [{ name: 'Correctness', maxPoints: 10, weight: 3 }, { name: 'Style', maxPoints: 5 }] });
    expect(c.status).toBe(201); rubricId = c.body.data.id;
    expect((await api('post', '/feedback-rubrics', org, { eventId, name: 'Code', criteria: [] })).status).toBe(409);
    const p = await api('patch', `/feedback-rubrics/${rubricId}`, judge, { criteria: [{ name: 'Only', maxPoints: 20 }] });
    expect(p.body.data.criteria.length).toBe(1);
    expect((await api('get', `/feedback-rubrics?eventId=${eventId}`, judge)).body.data.length).toBe(1);
  });
  it('status is disabled without key/model and generate answers 503; manual draft still works', async () => {
    expect((await api('get', '/ai-feedback/status', org)).body.data.enabled).toBe(false);
    expect((await api('post', '/ai-feedback/generate', org, { codeSubmissionId: subId })).status).toBe(503);
    const d = await api('post', '/ai-feedback', org, { codeSubmissionId: subId });
    expect(d.status).toBe(201); expect(d.body.data.status).toBe('draft');
    expect((await api('post', '/ai-feedback', org, { codeSubmissionId: subId })).status).toBe(409);
  });
  it('edit recomputes totals, validates ranges; participant sees nothing until published', async () => {
    const f = (await Feedback.findOne({ codeSubmissionId: subId }))!;
    const bad = await api('patch', `/ai-feedback/${f.id}`, judge, { criterionScores: [{ key: f.criterionScores[0].key, score: 999 }] });
    expect(bad.status).toBe(422);
    const e = await api('patch', `/ai-feedback/${f.id}`, judge, { strengths: ['Clear'], quality: { rating: 8 }, criterionScores: [{ key: f.criterionScores[0].key, score: 10 }] });
    expect(e.status).toBe(200); expect(e.body.data.total.percent).toBe(50);
    expect((await api('get', '/my-feedback', stu)).body.data.length).toBe(0);
    expect((await api('get', `/my-feedback/${f.id}`, stu)).status).toBe(404);
    expect((await api('post', `/ai-feedback/${f.id}/publish`, stu)).status).toBe(403);
  });
  it('publish notifies once, logs, is visible only to its owner, and blocks edits', async () => {
    const f = (await Feedback.findOne({ codeSubmissionId: subId }))!;
    expect((await api('post', `/ai-feedback/${f.id}/publish`, judge)).status).toBe(200);
    expect((await api('post', `/ai-feedback/${f.id}/publish`, judge)).status).toBe(409);
    expect(await Notification.countDocuments({ userId: stu.id, title: 'Feedback published' })).toBe(1);
    expect(await AuditLog.countDocuments({ action: 'feedback.publish' })).toBe(1);
    const mine = await api('get', '/my-feedback', stu);
    expect(mine.body.data.length).toBe(1); expect(mine.body.data[0].generation).toBeUndefined();
    expect((await api('get', `/my-feedback/${f.id}`, other)).status).toBe(404);
    expect((await api('patch', `/ai-feedback/${f.id}`, judge, { issues: ['x'] })).status).toBe(409);
    expect((await api('post', `/ai-feedback/${f.id}/unpublish`, judge)).status).toBe(200);
    expect((await api('get', '/my-feedback', stu)).body.data.length).toBe(0);
  });
  it('generateDraft with an injected model: stores a draft, sends only this submission, survives bad JSON', async () => {
    process.env.ANTHROPIC_API_KEY = 'k'; // read lazily below through env mutation
    const { env } = await import('../config/env');
    env.anthropic.apiKey = 'k'; env.anthropic.model = 'm';
    const sub2 = await CodeSubmission.create({ userId: other.id, eventId, scopeKey: `e:${eventId}`, language: 'python', code: 'SECRET_OTHER' });
    let seen = '';
    const bad = await generateDraft(sub2.id, org.id, async (_s, u) => { seen = u; return { text: 'not json', model: 'm', attempts: 1 }; });
    expect(seen.includes('SECRET_OTHER')).toBe(true); expect(seen.includes('print(1)')).toBe(false);
    expect(bad.generation?.ok).toBe(false); expect(bad.status).toBe('draft');
    env.anthropic.apiKey = ''; env.anthropic.model = '';
  });
  it('migration is idempotent', async () => {
    await runMigrations(); expect((await runMigrations()).length).toBe(0);
  });
});

describe('S14 demo seed', () => {
  it('creates one draft feedback, idempotent, hidden from the participant', async () => {
    const { seedDemo } = await import('../seed/demo');
    await seedDemo(() => {});
    await seedDemo(() => {});
    const { User } = await import('../models');
    const s3 = await User.findOne({ email: 'demo.student3@festhub.test' });
    expect(await Feedback.countDocuments({ userId: s3!._id })).toBe(1);
    expect((await Feedback.findOne({ userId: s3!._id }))!.status).toBe('draft');
  });
});
