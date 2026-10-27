import { Router } from 'express';
import { z } from 'zod';
import { Event, Feedback, Problem, ReviewRubric } from '../models';
import { requireAuth, requireRole } from '../middleware/auth';
import { badRequest, conflict, notFound, unprocessable } from '../utils/errors';
import { ok, oid, parse, wrap } from '../utils/http';
import { log_action } from '../utils/audit';
import { notify } from '../services/notify';
import { logger } from '../utils/logger';
import { aiState, computeTotals, createBlankDraft, generateDraft, normalizeCriteria } from '../services/aiFeedback';

/**
 * S13 AI feedback + review rubrics. Mounted at /api/v1; every route authenticates itself.
 * Staff (organiser, judge; admin counts as organiser):
 *   GET    /ai-feedback/status                    { enabled, model | reason }  (never exposes the key)
 *   GET|POST /feedback-rubrics, GET|PATCH|DELETE /feedback-rubrics/:id     per event (eventId) or problem (problemId)
 *   POST   /ai-feedback/generate  { codeSubmissionId }   AI draft (503 AI_DISABLED when no key/model)
 *   POST   /ai-feedback           { codeSubmissionId }   blank manual draft
 *   GET    /ai-feedback ?eventId&problemId&status&codeSubmissionId&page&pageSize,   GET /ai-feedback/:id
 *   PATCH  /ai-feedback/:id       edit draft fields; totals recomputed server-side (published = 409)
 *   POST   /ai-feedback/:id/publish | /unpublish,   DELETE /ai-feedback/:id
 * Participants: GET /my-feedback, GET /my-feedback/:id  -> PUBLISHED only (a draft id answers 404).
 */
const r = Router();
const staff = [requireAuth, requireRole('organiser', 'judge')];
const objId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const txt = (n: number) => z.string().trim().max(n);

// ---------- rubrics ----------
const criterionIn = z.object({ key: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(), name: z.string().trim().min(1).max(80), description: txt(300).optional(), maxPoints: z.number().min(1).max(1000), weight: z.number().min(0).max(100).optional() });
const rubricBody = z.object({ name: z.string().trim().min(1).max(120), criteria: z.array(criterionIn).max(20), active: z.boolean().optional() });
const rubricCreate = rubricBody.extend({ eventId: objId.optional(), problemId: objId.optional() });
const view = (x: { toJSON(): unknown }) => { const o = x.toJSON() as Record<string, unknown>; delete o.__v; return o; };

async function scope(b: { eventId?: string; problemId?: string }) {
  if (!b.eventId && !b.problemId) throw badRequest('Give an eventId or a problemId.');
  if (b.eventId && b.problemId) throw badRequest('Give either an eventId or a problemId, not both.');
  if (b.eventId && !(await Event.exists({ _id: b.eventId }))) throw notFound('Event not found');
  if (b.problemId && !(await Problem.exists({ _id: b.problemId }))) throw notFound('Problem not found');
  return b.problemId ? `p:${b.problemId}` : `e:${b.eventId}`;
}
const dup = (e: unknown) => { if ((e as { code?: number }).code === 11000) throw conflict('A rubric with this name already exists for this event/problem.'); throw e; };

r.get('/ai-feedback/status', ...staff, wrap(async (_q, res) => { const s = aiState(); ok(res, s.enabled ? { enabled: true, model: s.model } : { enabled: false, reason: s.reason }); }));

r.get('/feedback-rubrics', ...staff, wrap(async (req, res) => {
  const q = parse(z.object({ eventId: objId.optional(), problemId: objId.optional() }), req.query);
  const filter: Record<string, unknown> = {};
  if (q.problemId) filter.scopeKey = `p:${q.problemId}`; else if (q.eventId) filter.scopeKey = `e:${q.eventId}`;
  ok(res, (await ReviewRubric.find(filter).sort({ createdAt: -1 }).limit(200)).map(view));
}));
r.post('/feedback-rubrics', ...staff, wrap(async (req, res) => {
  const b = parse(rubricCreate, req.body);
  const scopeKey = await scope(b);
  const doc = await ReviewRubric.create({ name: b.name, scopeKey, eventId: b.eventId, problemId: b.problemId, criteria: normalizeCriteria(b.criteria), active: b.active ?? true, createdBy: req.user!.id }).catch(dup);
  await log_action(req.user, 'feedback.rubric_create', { type: 'ReviewRubric', id: doc.id }, { name: doc.name, scopeKey, criteria: doc.criteria.length }, req);
  ok(res, view(doc), 201);
}));
r.get('/feedback-rubrics/:id', ...staff, wrap(async (req, res) => { const d = await ReviewRubric.findById(oid(req.params.id)); if (!d) throw notFound('Rubric not found'); ok(res, view(d)); }));
r.patch('/feedback-rubrics/:id', ...staff, wrap(async (req, res) => {
  const b = parse(rubricBody.partial(), req.body);
  const d = await ReviewRubric.findById(oid(req.params.id));
  if (!d) throw notFound('Rubric not found');
  if (b.name !== undefined) d.name = b.name;
  if (b.active !== undefined) d.active = b.active;
  if (b.criteria) d.set('criteria', normalizeCriteria(b.criteria));
  await d.save().catch(dup);
  await log_action(req.user, 'feedback.rubric_update', { type: 'ReviewRubric', id: d.id }, { fields: Object.keys(b) }, req);
  ok(res, view(d));
}));
r.delete('/feedback-rubrics/:id', ...staff, wrap(async (req, res) => {
  const d = await ReviewRubric.findById(oid(req.params.id));
  if (!d) throw notFound('Rubric not found');
  await d.deleteOne(); // existing feedback keeps its own criteria snapshot
  await log_action(req.user, 'feedback.rubric_delete', { type: 'ReviewRubric', id: d.id }, { name: d.name }, req);
  ok(res, { deleted: true });
}));

// ---------- feedback (staff) ----------
const staffView = (f: { toJSON(): unknown }) => view(f);
const participantView = (f: { id: string; eventId?: unknown; problemId?: unknown; strengths: string[]; issues: string[]; suggestions: string[]; quality?: unknown; complexity?: unknown; criterionScores: unknown[]; total?: unknown; publishedAt?: Date | null }) => ({
  id: f.id, eventId: f.eventId ? String(f.eventId) : null, problemId: f.problemId ? String(f.problemId) : null,
  strengths: f.strengths, issues: f.issues, suggestions: f.suggestions, quality: f.quality, complexity: f.complexity, criterionScores: f.criterionScores, total: f.total, publishedAt: f.publishedAt ?? null,
}); // no model name, warnings, editor ids or drafts

r.post('/ai-feedback/generate', ...staff, wrap(async (req, res) => {
  const { codeSubmissionId } = parse(z.object({ codeSubmissionId: objId }), req.body);
  const f = await generateDraft(codeSubmissionId, req.user!.id);
  await log_action(req.user, 'feedback.generate', { type: 'Feedback', id: f.id }, { codeSubmissionId, model: f.generation?.model, ok: f.generation?.ok, truncated: f.generation?.truncated }, req);
  ok(res, staffView(f), 201);
}));
r.post('/ai-feedback', ...staff, wrap(async (req, res) => {
  const { codeSubmissionId } = parse(z.object({ codeSubmissionId: objId }), req.body);
  const f = await createBlankDraft(codeSubmissionId, req.user!.id);
  await log_action(req.user, 'feedback.create', { type: 'Feedback', id: f.id }, { codeSubmissionId }, req);
  ok(res, staffView(f), 201);
}));
r.get('/ai-feedback', ...staff, wrap(async (req, res) => {
  const q = parse(z.object({ eventId: objId.optional(), problemId: objId.optional(), codeSubmissionId: objId.optional(), status: z.enum(['draft', 'published']).optional(), page: z.coerce.number().int().min(1).catch(1), pageSize: z.coerce.number().int().min(1).max(100).catch(20) }), req.query);
  const filter: Record<string, unknown> = {};
  for (const k of ['eventId', 'problemId', 'codeSubmissionId', 'status'] as const) if (q[k]) filter[k] = q[k];
  const [items, total] = await Promise.all([Feedback.find(filter).sort({ updatedAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize), Feedback.countDocuments(filter)]);
  ok(res, items.map(staffView), 200, { total, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)) });
}));

// participant routes are declared before '/ai-feedback/:id' only for readability; paths do not overlap
r.get('/my-feedback', requireAuth, wrap(async (req, res) => {
  const items = await Feedback.find({ userId: req.user!.id, status: 'published' }).sort({ publishedAt: -1 }).limit(100);
  ok(res, items.map(participantView));
}));
r.get('/my-feedback/:id', requireAuth, wrap(async (req, res) => {
  const f = await Feedback.findOne({ _id: oid(req.params.id), userId: req.user!.id, status: 'published' });
  if (!f) throw notFound('Feedback not found');
  ok(res, participantView(f));
}));

r.get('/ai-feedback/:id', ...staff, wrap(async (req, res) => { const f = await Feedback.findById(oid(req.params.id)); if (!f) throw notFound('Feedback not found'); ok(res, staffView(f)); }));

const editBody = z.object({
  strengths: z.array(txt(600)).max(12).optional(), issues: z.array(txt(600)).max(12).optional(), suggestions: z.array(txt(600)).max(12).optional(),
  quality: z.object({ rating: z.number().int().min(1).max(10).nullable().optional(), summary: txt(600).optional() }).optional(),
  complexity: z.object({ time: txt(120).optional(), space: txt(120).optional(), notes: txt(600).optional() }).optional(),
  criterionScores: z.array(z.object({ key: z.string().max(60), score: z.number().min(0), comment: txt(600).optional() })).max(20).optional(),
});
r.patch('/ai-feedback/:id', ...staff, wrap(async (req, res) => {
  const b = parse(editBody, req.body);
  const f = await Feedback.findById(oid(req.params.id));
  if (!f) throw notFound('Feedback not found');
  if (f.status === 'published') throw conflict('Published feedback cannot be edited. Unpublish it first.');
  for (const k of ['strengths', 'issues', 'suggestions'] as const) if (b[k]) f.set(k, b[k]!.filter(Boolean));
  if (b.quality) { if (b.quality.rating !== undefined) f.set('quality.rating', b.quality.rating ?? undefined); if (b.quality.summary !== undefined) f.set('quality.summary', b.quality.summary); }
  if (b.complexity) for (const k of ['time', 'space', 'notes'] as const) if (b.complexity[k] !== undefined) f.set(`complexity.${k}`, b.complexity[k]);
  if (b.criterionScores) {
    const rows = f.criterionScores.map((c) => c.toObject() as { key: string; name: string; maxPoints: number; weight: number; score: number; comment: string });
    for (const upd of b.criterionScores) {
      const row = rows.find((c) => c.key === upd.key);
      if (!row) throw unprocessable(`Unknown criterion "${upd.key}".`);
      if (upd.score > row.maxPoints) throw unprocessable(`Score for "${row.name}" cannot exceed ${row.maxPoints}.`);
      row.score = Math.round(upd.score * 10) / 10;
      if (upd.comment !== undefined) row.comment = upd.comment;
    }
    f.set('criterionScores', rows);
  }
  f.set('total', computeTotals(f.criterionScores.map((c) => ({ maxPoints: c.maxPoints ?? 0, weight: c.weight ?? 1, score: c.score ?? 0 }))));
  f.editedBy = req.user!.id as never; f.editedAt = new Date();
  await f.save();
  await log_action(req.user, 'feedback.edit', { type: 'Feedback', id: f.id }, { fields: Object.keys(b) }, req);
  ok(res, staffView(f));
}));

r.post('/ai-feedback/:id/publish', ...staff, wrap(async (req, res) => {
  const id = oid(req.params.id);
  const f = await Feedback.findOneAndUpdate({ _id: id, status: 'draft' }, { $set: { status: 'published', publishedAt: new Date(), publishedBy: req.user!.id } }, { new: true }); // atomic: double click publishes (and notifies) once
  if (!f) { if (await Feedback.exists({ _id: id })) throw conflict('Feedback is already published.'); throw notFound('Feedback not found'); }
  const ev = f.eventId ? await Event.findById(f.eventId).select('title') : null;
  try { await notify(f.userId, 'Feedback published', `Feedback on your code${ev ? ` for ${ev.title}` : ''} is ready.`, '/feedback'); }
  catch (e) { logger.warn('feedback notify failed', { message: (e as Error).message }); }
  await log_action(req.user, 'feedback.publish', { type: 'Feedback', id: f.id }, { userId: String(f.userId), total: f.total?.percent }, req);
  ok(res, staffView(f));
}));
r.post('/ai-feedback/:id/unpublish', ...staff, wrap(async (req, res) => {
  const id = oid(req.params.id);
  const f = await Feedback.findOneAndUpdate({ _id: id, status: 'published' }, { $set: { status: 'draft' }, $unset: { publishedAt: 1, publishedBy: 1 } }, { new: true });
  if (!f) { if (await Feedback.exists({ _id: id })) throw conflict('Feedback is not published.'); throw notFound('Feedback not found'); }
  await log_action(req.user, 'feedback.unpublish', { type: 'Feedback', id: f.id }, { userId: String(f.userId) }, req);
  ok(res, staffView(f));
}));
r.delete('/ai-feedback/:id', ...staff, wrap(async (req, res) => {
  const f = await Feedback.findById(oid(req.params.id));
  if (!f) throw notFound('Feedback not found');
  await f.deleteOne();
  await log_action(req.user, 'feedback.delete', { type: 'Feedback', id: f.id }, { status: f.status }, req);
  ok(res, { deleted: true });
}));

export default r;
