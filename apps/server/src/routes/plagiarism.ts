import { Router, type Request } from 'express';
import { z } from 'zod';
import { Event, PlagiarismPair, PlagiarismSetting, Problem, CodeSubmission, StarterCode, User } from '../models';
import { requireAuth, requireRole } from '../middleware/auth';
import { AppError, badRequest, notFound } from '../utils/errors';
import { ok, oid, parse, wrap } from '../utils/http';
import { log_action } from '../utils/audit';
import { buildExclusion, matchingBlocks } from '../services/plagiarism';
import { env } from '../config/env';
import { PLAGIARISM_LANGUAGES, type PlagiarismLanguage } from '../services/plagiarism';
import { codeUpload, mapCodeUploadError, readCodeFile, validatePasted, CODE_MAX_BYTES } from '../services/codeIntake';
import { DEFAULT_THRESHOLD, MIN_STORED_SIMILARITY, applyThreshold, queueState, resolveThreshold, scheduleCheck, scheduleScopeCheck, scopeKeyOf, sha256, statusFor } from '../services/plagiarismCheck';

/**
 * Plagiarism engine API (S11). Mounted at /api/v1; every route authenticates itself.
 * Submit: any signed-in user. Review: organiser, judge (admin counts as organiser). Settings + starter code: organiser/admin.
 *   POST   /plagiarism/submissions            multipart (file + fields) or JSON { eventId?, problemId?, language, code }  -> 201, check runs in the background
 *   GET    /plagiarism/submissions/mine       own submissions (no code)
 *   GET    /plagiarism/submissions            review: ?eventId&problemId&language&page&pageSize
 *   GET    /plagiarism/submissions/:id        owner or reviewer (with code)
 *   POST   /plagiarism/submissions/:id/recheck  review
 *   POST   /plagiarism/check                  review: { eventId? | problemId? } full all-pairs run of a scope (202)
 *   GET    /plagiarism/pairs                  review: ?eventId&problemId&status&min&page&pageSize
 *   GET    /plagiarism/pairs/:id              review: both sources + notes
 *   GET    /plagiarism/pairs/:id/diff         S12: both sources as lines with matching-block ids (side-by-side view)
 *   GET    /plagiarism/check/status           S12: ?eventId|problemId  submissions by check state, pairs, queue ("Run check" status line)
 *   PATCH  /plagiarism/pairs/:id              review: { status: clear|suspicious|confirmed|auto, note? }
 *   POST   /plagiarism/pairs/:id/notes        review: { text }
 *   GET    /plagiarism/settings               ?eventId|problemId -> effective threshold + source
 *   PUT    /plagiarism/settings               organiser: { scope: global|event|problem, refId?, suspiciousThreshold: 10..100 | null (remove override) }
 *   GET/POST/DELETE /plagiarism/starter-code  organiser (GET: review): template code excluded from comparison
 */
const r = Router();
const review = [requireAuth, requireRole('organiser', 'judge')];
const manage = [requireAuth, requireRole('organiser')];
const MAX_PER_SCOPE = 20; // submissions per user per scope

const langEnum = z.enum(PLAGIARISM_LANGUAGES);
const objId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const scopeIn = z.object({ eventId: objId.optional(), problemId: objId.optional() });
const submitSchema = scopeIn.extend({ language: langEnum, code: z.string().max(CODE_MAX_BYTES * 2).optional() });

async function resolveScope(b: { eventId?: string; problemId?: string }) {
  if (!b.eventId && !b.problemId) throw badRequest('Give an eventId or a problemId.');
  if (b.eventId && !(await Event.exists({ _id: b.eventId }))) throw notFound('Event not found');
  if (b.problemId && !(await Problem.exists({ _id: b.problemId }))) throw notFound('Problem not found');
  return { scopeKey: scopeKeyOf(b)!, eventId: b.eventId, problemId: b.problemId };
}

const subView = (s: { id: string; userId: unknown; eventId?: unknown; problemId?: unknown; language: string; source?: string; fileName?: string; sizeBytes?: number; checkStatus?: string; maxSimilarity?: number; submittedAt?: Date; checkedAt?: Date; code?: string }, withCode = false) => ({
  id: s.id, userId: String(s.userId), eventId: s.eventId ? String(s.eventId) : null, problemId: s.problemId ? String(s.problemId) : null,
  language: s.language, source: s.source, fileName: s.fileName ?? null, sizeBytes: s.sizeBytes, checkStatus: s.checkStatus, maxSimilarity: s.maxSimilarity ?? 0,
  submittedAt: s.submittedAt, checkedAt: s.checkedAt ?? null, ...(withCode ? { code: s.code } : {}),
});

r.post(
  '/plagiarism/submissions',
  requireAuth,
  (req, res, next) => {
    if (!req.is('multipart/form-data')) return next();
    codeUpload.single('file')(req, res, (err: unknown) => (err ? next(mapCodeUploadError(err)) : next()));
  },
  wrap(async (req, res) => {
    const b = parse(submitSchema, req.body ?? {});
    const scope = await resolveScope(b);
    let code: string;
    let source: 'paste' | 'upload' = 'paste';
    let fileName: string | undefined;
    if (req.file) {
      ({ code, fileName } = readCodeFile(req.file, b.language));
      source = 'upload';
    } else if (b.code != null) code = validatePasted(b.code);
    else throw badRequest('Paste code or upload a file.');
    const uid = req.user!.id;
    const [count, last] = await Promise.all([CodeSubmission.countDocuments({ userId: uid, scopeKey: scope.scopeKey }), CodeSubmission.findOne({ userId: uid }).sort({ submittedAt: -1 }).select('submittedAt')]);
    if (count >= MAX_PER_SCOPE) throw new AppError(429, 'LIMIT', `You can submit at most ${MAX_PER_SCOPE} times here.`);
    const cool = Math.min(env.submissionCooldownSec, 5) * 1000;
    if (last && cool > 0 && Date.now() - last.submittedAt.getTime() < cool) throw new AppError(429, 'COOLDOWN', 'You are submitting too quickly');
    const s = await CodeSubmission.create({ userId: uid, ...scope, language: b.language, code, source, fileName, sizeBytes: Buffer.byteLength(code, 'utf8'), codeHash: sha256(code), submittedAt: new Date() });
    await log_action(req.user, 'plagiarism.submit', { type: 'CodeSubmission', id: s.id }, { language: b.language, source, scope: scope.scopeKey, bytes: s.sizeBytes }, req);
    scheduleCheck(s.id); // auto-run in the background, after the response
    return ok(res, subView(s), 201);
  }),
);

r.get('/plagiarism/submissions/mine', requireAuth, wrap(async (req, res) => {
  const rows = await CodeSubmission.find({ userId: req.user!.id }).sort({ submittedAt: -1 }).limit(100);
  return ok(res, rows.map((s) => subView(s)));
}));

r.get('/plagiarism/submissions', ...review, wrap(async (req, res) => {
  const q = parse(scopeIn.extend({ language: langEnum.optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
  const f: Record<string, unknown> = {};
  if (q.eventId) f.eventId = q.eventId;
  if (q.problemId) f.problemId = q.problemId;
  if (q.language) f.language = q.language;
  const [items, total] = await Promise.all([CodeSubmission.find(f).sort({ submittedAt: -1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize), CodeSubmission.countDocuments(f)]);
  return ok(res, { items: items.map((s) => subView(s)), total, page: q.page, pages: Math.max(1, Math.ceil(total / q.pageSize)) });
}));

const canSee = (req: Request, ownerId: unknown) => String(ownerId) === req.user!.id || req.user!.roles.some((x) => x === 'organiser' || x === 'admin' || x === 'judge');

r.get('/plagiarism/submissions/:id', requireAuth, wrap(async (req, res) => {
  const s = await CodeSubmission.findById(oid(req.params.id)).select('+code');
  if (!s || !canSee(req, s.userId)) throw notFound('Submission not found');
  return ok(res, subView(s, true));
}));

r.post('/plagiarism/submissions/:id/recheck', ...review, wrap(async (req, res) => {
  const s = await CodeSubmission.findByIdAndUpdate(oid(req.params.id), { $set: { checkStatus: 'pending' } });
  if (!s) throw notFound('Submission not found');
  scheduleCheck(s.id);
  return ok(res, { queued: true }, 202);
}));

r.post('/plagiarism/check', ...review, wrap(async (req, res) => {
  const b = parse(scopeIn, req.body ?? {});
  const scope = await resolveScope(b);
  scheduleScopeCheck(scope.scopeKey);
  await log_action(req.user, 'plagiarism.check', { type: 'Scope', id: scope.scopeKey }, {}, req);
  return ok(res, { queued: true, scopeKey: scope.scopeKey }, 202);
}));

// ---- pairs
const names = async (ids: unknown[]) => new Map((await User.find({ _id: { $in: ids as string[] } }).select('name').lean()).map((u) => [String(u._id), u.name]));
type PairDoc = InstanceType<typeof PlagiarismPair>;
const pairView = (p: PairDoc, n: Map<string, string>) => ({
  id: p.id, scopeKey: p.scopeKey, eventId: p.eventId ? String(p.eventId) : null, problemId: p.problemId ? String(p.problemId) : null, language: p.language,
  aId: String(p.aId), bId: String(p.bId), aUser: { id: String(p.aUserId), name: n.get(String(p.aUserId)) ?? '?' }, bUser: { id: String(p.bUserId), name: n.get(String(p.bUserId)) ?? '?' },
  similarity: p.similarity, winnowScore: p.winnowScore, jaccardScore: p.jaccardScore, sharedPrints: p.sharedPrints,
  status: p.status, manual: p.manual, thresholdUsed: p.thresholdUsed ?? null, notes: p.notes ?? [], reviewedAt: p.reviewedAt ?? null, checkedAt: p.checkedAt,
});

r.get('/plagiarism/pairs', ...review, wrap(async (req, res) => {
  const q = parse(scopeIn.extend({ status: z.enum(['clear', 'suspicious', 'confirmed']).optional(), min: z.coerce.number().min(0).max(100).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
  const f: Record<string, unknown> = {};
  if (q.eventId) f.eventId = q.eventId;
  if (q.problemId) f.problemId = q.problemId;
  if (q.status) f.status = q.status;
  if (q.min != null) f.similarity = { $gte: q.min };
  const [items, total] = await Promise.all([PlagiarismPair.find(f).sort({ similarity: -1, _id: 1 }).skip((q.page - 1) * q.pageSize).limit(q.pageSize), PlagiarismPair.countDocuments(f)]);
  const n = await names(items.flatMap((p) => [p.aUserId, p.bUserId]));
  return ok(res, { items: items.map((p) => pairView(p, n)), total, page: q.page, pages: Math.max(1, Math.ceil(total / q.pageSize)) });
}));

r.get('/plagiarism/pairs/:id', ...review, wrap(async (req, res) => {
  const p = await PlagiarismPair.findById(oid(req.params.id));
  if (!p) throw notFound('Pair not found');
  const [subs, n] = await Promise.all([CodeSubmission.find({ _id: { $in: [p.aId, p.bId] } }).select('+code'), names([p.aUserId, p.bUserId])]);
  const by = (id: unknown) => subs.find((s) => String(s._id) === String(id));
  return ok(res, { ...pairView(p, n), a: by(p.aId) ? subView(by(p.aId)!, true) : null, b: by(p.bId) ? subView(by(p.bId)!, true) : null });
}));

const noteText = z.string().trim().min(1).max(2000);
r.patch('/plagiarism/pairs/:id', ...review, wrap(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['clear', 'suspicious', 'confirmed', 'auto']).optional(), note: noteText.optional() }).refine((x) => x.status || x.note, 'Give a status or a note'), req.body ?? {});
  const p = await PlagiarismPair.findById(oid(req.params.id));
  if (!p) throw notFound('Pair not found');
  const before = p.status;
  if (b.status === 'auto') {
    const { threshold } = await resolveThreshold(p);
    p.status = statusFor(p.similarity, threshold);
    p.manual = false;
    p.thresholdUsed = threshold;
  } else if (b.status) {
    p.status = b.status;
    p.manual = true;
  }
  if (b.status) {
    p.reviewedBy = req.user!.id as never;
    p.reviewedAt = new Date();
  }
  if (b.note) p.notes.push({ authorId: req.user!.id, authorName: req.user!.name, text: b.note, at: new Date() } as never);
  await p.save();
  const act = !b.status ? 'plagiarism.note' : b.status === 'auto' ? 'plagiarism.unflag' : b.status === 'confirmed' ? 'plagiarism.confirm' : b.status === 'suspicious' ? 'plagiarism.flag' : 'plagiarism.clear';
  await log_action(req.user, act, { type: 'PlagiarismPair', id: p.id }, { from: before, to: p.status, similarity: p.similarity, users: [String(p.aUserId), String(p.bUserId)], note: !!b.note, scope: p.scopeKey }, req);
  return ok(res, pairView(p, await names([p.aUserId, p.bUserId])));
}));

r.post('/plagiarism/pairs/:id/notes', ...review, wrap(async (req, res) => {
  const { text } = parse(z.object({ text: noteText }), req.body ?? {});
  const p = await PlagiarismPair.findById(oid(req.params.id));
  if (!p) throw notFound('Pair not found');
  p.notes.push({ authorId: req.user!.id, authorName: req.user!.name, text, at: new Date() } as never);
  await p.save();
  await log_action(req.user, 'plagiarism.note', { type: 'PlagiarismPair', id: p.id }, {}, req);
  return ok(res, pairView(p, await names([p.aUserId, p.bUserId])), 201);
}));

/** S12: side-by-side view. Both sources split into lines; `block` = matching block id (same id = same shared code), null = no match. */
r.get('/plagiarism/pairs/:id/diff', ...review, wrap(async (req, res) => {
  const p = await PlagiarismPair.findById(oid(req.params.id));
  if (!p) throw notFound('Pair not found');
  const [subs, n, tpl] = await Promise.all([
    CodeSubmission.find({ _id: { $in: [p.aId, p.bId] } }).select('+code language fileName submittedAt userId'),
    names([p.aUserId, p.bUserId]),
    StarterCode.find({ scopeKey: p.scopeKey, language: p.language }).select('code').lean(),
  ]);
  const a = subs.find((s) => String(s._id) === String(p.aId));
  const b = subs.find((s) => String(s._id) === String(p.bId));
  if (!a || !b) throw notFound('One of the submissions no longer exists');
  const v = matchingBlocks(a.code, b.code, p.language as PlagiarismLanguage, tpl.length ? buildExclusion(tpl, p.language as PlagiarismLanguage) : undefined);
  const side = (s: typeof a, lines: typeof v.a) => ({ submissionId: s.id, user: { id: String(s.userId), name: n.get(String(s.userId)) ?? '?' }, fileName: s.fileName ?? null, submittedAt: s.submittedAt, lines });
  return ok(res, { pair: pairView(p, n), blocks: v.blocks, matchedLinesA: v.matchedLinesA, matchedLinesB: v.matchedLinesB, a: side(a, v.a), b: side(b, v.b) });
}));

/** S12: "Run check" status line: submissions by check state, pairs found, background queue. */
r.get('/plagiarism/check/status', ...review, wrap(async (req, res) => {
  const q = parse(scopeIn, req.query);
  const f: Record<string, unknown> = {};
  if (q.eventId) f.eventId = q.eventId;
  if (q.problemId) f.problemId = q.problemId;
  const [bySt, pairs, last] = await Promise.all([
    CodeSubmission.aggregate([{ $match: f }, { $group: { _id: '$checkStatus', n: { $sum: 1 } } }]),
    PlagiarismPair.aggregate([{ $match: f }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    CodeSubmission.findOne({ ...f, checkedAt: { $ne: null } }).sort({ checkedAt: -1 }).select('checkedAt').lean(),
  ]);
  const c = (rows: { _id: string; n: number }[], k: string) => rows.find((x) => x._id === k)?.n ?? 0;
  const counts = { pending: c(bySt, 'pending'), running: c(bySt, 'running'), done: c(bySt, 'done'), failed: c(bySt, 'failed') };
  const queue = queueState();
  return ok(res, {
    submissions: counts.pending + counts.running + counts.done + counts.failed, ...counts,
    pairs: { total: pairs.reduce((x, y) => x + y.n, 0), suspicious: c(pairs, 'suspicious'), confirmed: c(pairs, 'confirmed'), clear: c(pairs, 'clear') },
    lastCheckedAt: last?.checkedAt ?? null, queue, running: queue.busy || queue.waiting > 0 || counts.running > 0,
  });
}));

// ---- threshold settings
r.get('/plagiarism/settings', ...review, wrap(async (req, res) => {
  const q = parse(scopeIn, req.query);
  const eff = await resolveThreshold(q);
  return ok(res, { ...eff, default: DEFAULT_THRESHOLD, min: MIN_STORED_SIMILARITY });
}));

r.put('/plagiarism/settings', ...manage, wrap(async (req, res) => {
  const b = parse(z.object({ scope: z.enum(['global', 'event', 'problem']), refId: objId.optional(), suspiciousThreshold: z.number().min(MIN_STORED_SIMILARITY).max(100).nullable() }), req.body ?? {});
  if (b.scope !== 'global' && !b.refId) throw badRequest('refId is required for event / problem settings.');
  const key = b.scope === 'global' ? { scope: 'global' } : { scope: b.scope, refId: b.refId };
  if (b.suspiciousThreshold == null) await PlagiarismSetting.deleteOne(key);
  else await PlagiarismSetting.updateOne(key, { $set: { suspiciousThreshold: b.suspiciousThreshold, updatedBy: req.user!.id } }, { upsert: true });
  // re-derive statuses of undecided pairs the setting covers (a narrower override still wins for pairs it covers)
  const filter = b.scope === 'problem' ? { problemId: b.refId } : b.scope === 'event' ? { eventId: b.refId } : {};
  const pairs = await PlagiarismPair.find(filter).select('eventId problemId').lean();
  const groups = new Map<string, { s: { eventId?: unknown; problemId?: unknown }; ids: unknown[] }>();
  for (const p of pairs) {
    const k = `${p.problemId ?? ''}|${p.eventId ?? ''}`;
    (groups.get(k) ?? groups.set(k, { s: p, ids: [] }).get(k)!).ids.push(p._id);
  }
  let changed = 0;
  for (const g of groups.values()) changed += await applyThreshold({ _id: { $in: g.ids } }, (await resolveThreshold(g.s)).threshold);
  await log_action(req.user, 'plagiarism.settings', { type: 'PlagiarismSetting', id: b.refId ?? 'global' }, { scope: b.scope, threshold: b.suspiciousThreshold, changed }, req);
  return ok(res, { ...(await resolveThreshold(b.scope === 'problem' ? { problemId: b.refId } : b.scope === 'event' ? { eventId: b.refId } : {})), changed });
}));

// ---- starter code (excluded from comparison)
r.get('/plagiarism/starter-code', ...review, wrap(async (req, res) => {
  const q = parse(scopeIn, req.query);
  const key = scopeKeyOf(q);
  if (!key) throw badRequest('Give an eventId or a problemId.');
  const rows = await StarterCode.find({ scopeKey: key }).sort({ createdAt: 1 });
  return ok(res, rows.map((x) => ({ id: x.id, name: x.name, language: x.language, bytes: Buffer.byteLength(x.code), createdAt: x.createdAt })));
}));

r.post('/plagiarism/starter-code', ...manage, wrap(async (req, res) => {
  const b = parse(scopeIn.extend({ language: langEnum, name: z.string().trim().max(120).optional(), code: z.string().min(1).max(CODE_MAX_BYTES) }), req.body ?? {});
  const scope = await resolveScope(b);
  const row = await StarterCode.create({ ...scope, language: b.language as PlagiarismLanguage, name: b.name || 'Starter code', code: validatePasted(b.code), createdBy: req.user!.id });
  scheduleScopeCheck(scope.scopeKey); // statuses must reflect the exclusion
  await log_action(req.user, 'plagiarism.starter_add', { type: 'StarterCode', id: row.id }, { scope: scope.scopeKey, language: b.language }, req);
  return ok(res, { id: row.id, name: row.name, language: row.language }, 201);
}));

r.delete('/plagiarism/starter-code/:id', ...manage, wrap(async (req, res) => {
  const row = await StarterCode.findByIdAndDelete(oid(req.params.id));
  if (!row) throw notFound('Starter code not found');
  scheduleScopeCheck(row.scopeKey);
  await log_action(req.user, 'plagiarism.starter_delete', { type: 'StarterCode', id: row.id }, { scope: row.scopeKey }, req);
  return ok(res, { deleted: true });
}));

export default r;
