import crypto from 'crypto';
import mongoose from 'mongoose';
import { CodeSubmission, Event, PlagiarismPair, PlagiarismSetting, StarterCode, User } from '../models';
import { notify } from './notify';
import { buildExclusion, compare, fingerprint, type Exclusion, type Fingerprint, type PlagiarismLanguage } from './plagiarism';
import { logger } from '../utils/logger';

/** Built-in "suspicious" threshold (percent) when nothing is configured. */
export const DEFAULT_THRESHOLD = 70;
/** Pairs below this similarity are not stored (keeps the pair table small); also the lowest allowed threshold. */
export const MIN_STORED_SIMILARITY = 10;
/** Upper bound on how many other students' code one check loads. */
const MAX_CANDIDATES = 2000;

export type Scope = { problemId?: unknown; eventId?: unknown };
export const scopeKeyOf = (s: Scope): string | null => (s.problemId ? `p:${String(s.problemId)}` : s.eventId ? `e:${String(s.eventId)}` : null);
export const statusFor = (similarity: number, threshold: number): 'clear' | 'suspicious' => (similarity >= threshold ? 'suspicious' : 'clear');

/** problem override -> event override -> global -> built-in default. */
export async function resolveThreshold(s: Scope): Promise<{ threshold: number; source: 'problem' | 'event' | 'global' | 'default' }> {
  const tries: ['problem' | 'event' | 'global', unknown][] = [
    ['problem', s.problemId],
    ['event', s.eventId],
    ['global', null],
  ];
  for (const [scope, ref] of tries) {
    if (scope !== 'global' && !ref) continue;
    const row = await PlagiarismSetting.findOne(scope === 'global' ? { scope } : { scope, refId: ref as string });
    if (row) return { threshold: row.suspiciousThreshold, source: scope };
  }
  return { threshold: DEFAULT_THRESHOLD, source: 'default' };
}

async function exclusionFor(scopeKey: string, language: PlagiarismLanguage): Promise<Exclusion | undefined> {
  const templates = await StarterCode.find({ scopeKey, language }).select('code').lean();
  return templates.length ? buildExclusion(templates, language) : undefined;
}

type Cand = { _id: mongoose.Types.ObjectId; userId: mongoose.Types.ObjectId; code: string; eventId?: mongoose.Types.ObjectId | null; problemId?: mongoose.Types.ObjectId | null; language: PlagiarismLanguage };

/** Newest submission of each user in the scope + language (a student who resubmits is compared by their latest code). */
async function latestPerUser(scopeKey: string, language: PlagiarismLanguage): Promise<Cand[]> {
  const rows = (await CodeSubmission.find({ scopeKey, language }).sort({ submittedAt: -1 }).limit(MAX_CANDIDATES * 3).select('+code userId eventId problemId language').lean()) as unknown as Cand[];
  const seen = new Set<string>();
  const out: Cand[] = [];
  for (const r of rows) {
    const u = String(r.userId);
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(r);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

async function upsertPair(x: Cand, y: Cand, scopeKey: string, c: ReturnType<typeof compare>, threshold: number): Promise<void> {
  const [a, b] = String(x._id) < String(y._id) ? [x, y] : [y, x];
  const auto = statusFor(c.similarity, threshold);
  const existing = await PlagiarismPair.findOne({ aId: a._id, bId: b._id }).select('manual');
  if (existing) {
    const set: Record<string, unknown> = { similarity: c.similarity, winnowScore: c.winnowScore, jaccardScore: c.jaccardScore, sharedPrints: c.sharedPrints, thresholdUsed: threshold, checkedAt: new Date() };
    if (!existing.manual) set.status = auto; // a reviewer's decision is never overwritten
    await PlagiarismPair.updateOne({ _id: existing._id }, { $set: set });
    if (!existing.manual && auto === 'suspicious') await notifyHighSimilarity(String(existing._id));
    return;
  }
  try {
    const made = await PlagiarismPair.create({
      scopeKey, eventId: a.eventId ?? b.eventId ?? undefined, problemId: a.problemId ?? b.problemId ?? undefined, language: a.language,
      aId: a._id, bId: b._id, aUserId: a.userId, bUserId: b.userId,
      similarity: c.similarity, winnowScore: c.winnowScore, jaccardScore: c.jaccardScore, sharedPrints: c.sharedPrints, status: auto, thresholdUsed: threshold,
    });
    if (auto === 'suspicious') await notifyHighSimilarity(made.id);
  } catch (e) {
    if ((e as { code?: number }).code !== 11000) throw e; // raced with a parallel run: the other row is just as good
  }
}

async function refreshMax(ids: mongoose.Types.ObjectId[]) {
  for (const id of ids) {
    const top = await PlagiarismPair.findOne({ $or: [{ aId: id }, { bId: id }] }).sort({ similarity: -1 }).select('similarity').lean();
    await CodeSubmission.updateOne({ _id: id }, { $set: { maxSimilarity: top?.similarity ?? 0, checkStatus: 'done', checkedAt: new Date(), checkError: null } });
  }
}

/** Compare one submission against the latest code of every other user in its scope. Returns the number of pairs written. */
export async function checkSubmission(id: string): Promise<number> {
  const sub = (await CodeSubmission.findById(id).select('+code').lean()) as unknown as (Cand & { scopeKey: string }) | null;
  if (!sub) return 0;
  await CodeSubmission.updateOne({ _id: id }, { $set: { checkStatus: 'running' } });
  try {
    const ex = await exclusionFor(sub.scopeKey, sub.language);
    const mine = fingerprint(sub.code, sub.language, ex);
    const { threshold } = await resolveThreshold(sub);
    const others = (await latestPerUser(sub.scopeKey, sub.language)).filter((o) => String(o.userId) !== String(sub.userId));
    let n = 0;
    let i = 0;
    for (const o of others) {
      if (++i % 25 === 0) await tick(); // yield: a big class must not block the event loop
      const c = compare(mine, fingerprint(o.code, o.language, ex));
      if (!c.comparable || c.similarity < MIN_STORED_SIMILARITY) continue;
      await upsertPair(sub, o, sub.scopeKey, c, threshold);
      n++;
    }
    await refreshMax([sub._id, ...others.map((o) => o._id)]);
    return n;
  } catch (e) {
    await CodeSubmission.updateOne({ _id: id }, { $set: { checkStatus: 'failed', checkError: String((e as Error).message).slice(0, 300) } });
    throw e;
  }
}

/** Full all-pairs check of one scope (every language), e.g. after starter code changed. Returns the number of pairs written. */
export async function checkScope(scopeKey: string): Promise<number> {
  const langs = (await CodeSubmission.distinct('language', { scopeKey })) as PlagiarismLanguage[];
  let written = 0;
  for (const lang of langs) {
    const subs = await latestPerUser(scopeKey, lang);
    if (subs.length < 2) {
      await refreshMax(subs.map((s) => s._id));
      continue;
    }
    const ex = await exclusionFor(scopeKey, lang);
    const { threshold } = await resolveThreshold(subs[0]!);
    const fps = new Map<string, Fingerprint>(subs.map((s) => [String(s._id), fingerprint(s.code, s.language, ex)]));
    let steps = 0;
    for (let i = 0; i < subs.length; i++)
      for (let j = i + 1; j < subs.length; j++) {
        if (++steps % 200 === 0) await tick();
        const c = compare(fps.get(String(subs[i]!._id))!, fps.get(String(subs[j]!._id))!);
        if (!c.comparable || c.similarity < MIN_STORED_SIMILARITY) continue;
        await upsertPair(subs[i]!, subs[j]!, scopeKey, c, threshold);
        written++;
      }
    await refreshMax(subs.map((s) => s._id));
  }
  return written;
}

/** After a threshold change: re-derive clear/suspicious for every pair in the filter that a reviewer has not decided. */
export async function applyThreshold(filter: Record<string, unknown>, threshold: number): Promise<number> {
  const a = await PlagiarismPair.updateMany({ ...filter, manual: false, similarity: { $gte: threshold } }, { $set: { status: 'suspicious', thresholdUsed: threshold } });
  const b = await PlagiarismPair.updateMany({ ...filter, manual: false, similarity: { $lt: threshold } }, { $set: { status: 'clear', thresholdUsed: threshold } });
  return a.modifiedCount + b.modifiedCount;
}


/**
 * S12: tell the organiser(s) once when a pair reaches the suspicious threshold. The claim (`notifiedAt`) is atomic, so parallel runs,
 * re-runs and threshold changes never send a second notice for the same pair. Recipient: the event's creator when known (and active),
 * otherwise every active organiser/admin. Never throws: a notification problem must not fail a check.
 */
export async function notifyHighSimilarity(pairId: string): Promise<number> {
  try {
    const p = await PlagiarismPair.findOneAndUpdate({ _id: pairId, status: 'suspicious', notifiedAt: null }, { $set: { notifiedAt: new Date() } }, { new: true });
    if (!p) return 0;
    const [users, ev] = await Promise.all([User.find({ _id: { $in: [p.aUserId, p.bUserId] } }).select('name').lean(), p.eventId ? Event.findById(p.eventId).select('title createdBy') : null]);
    const nm = (id: unknown) => users.find((u) => String(u._id) === String(id))?.name ?? 'a student';
    let to: string[] = [];
    if (ev?.createdBy) {
      const owner = await User.findOne({ _id: ev.createdBy, active: true, roles: { $in: ['organiser', 'admin'] } }).select('_id');
      if (owner) to = [String(owner._id)];
    }
    if (!to.length) to = (await User.find({ active: true, roles: { $in: ['organiser', 'admin'] } }).select('_id').limit(20).lean()).map((u) => String(u._id));
    const msg = `${nm(p.aUserId)} and ${nm(p.bUserId)}: ${p.similarity}% similar${ev ? ` in "${ev.title}"` : ''} (${p.language}). Review the pair.`;
    for (const id of to) await notify(id, 'High code similarity', msg, `/plagiarism?pair=${p.id}`);
    return to.length;
  } catch (e) {
    logger.warn('plagiarism notice failed', { message: (e as Error).message });
    return 0;
  }
}

/** For the "Run check" status line. */
export const queueState = () => ({ waiting: queue.length, busy: !!active });

// ------------------------------------------------------------------ background queue
type Job = { key: string; run: () => Promise<unknown> };
const queue: Job[] = [];
let active: Promise<void> | null = null;

async function pump() {
  while (queue.length) {
    const job = queue.shift()!;
    try {
      await job.run();
    } catch (e) {
      logger.error('plagiarism check failed', { job: job.key, error: (e as Error).message });
    }
  }
  active = null;
}
function enqueue(job: Job) {
  if (queue.some((j) => j.key === job.key)) return; // already waiting: one run covers it
  queue.push(job);
  if (!active) active = new Promise<void>((r) => setImmediate(r)).then(pump);
}

/** Fire-and-forget: runs after the HTTP response, one job at a time, yielding to the event loop inside heavy loops. */
export const scheduleCheck = (submissionId: string) => enqueue({ key: `s:${submissionId}`, run: () => checkSubmission(submissionId) });
export const scheduleScopeCheck = (scopeKey: string) => enqueue({ key: `k:${scopeKey}`, run: () => checkScope(scopeKey) });
/** Resolves when the queue is empty (tests, shutdown). */
export async function drainPlagiarismQueue(): Promise<void> {
  while (active || queue.length) await (active ?? new Promise((r) => setImmediate(r)));
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
