import { CodeSubmission, Feedback, Problem, ReviewRubric } from '../../models';
import { env } from '../../config/env';
import { AppError, conflict, notFound } from '../../utils/errors';
import { aiState, callAnthropic, AiError, type CallOptions } from './client';
import { buildFeedbackPrompt } from './prompt';
import { parseFeedbackResponse } from './parse';
import { blankScores, computeTotals, type RubricCriterion } from './rubric';

export * from './rubric';
export { buildFeedbackPrompt, truncateCode } from './prompt';
export { parseFeedbackResponse, extractJsonObject } from './parse';
export { aiState, callAnthropic, AiError, backoffMs } from './client';

/** The rubric that applies to a submission: an active problem rubric first, else an active event rubric (newest wins). */
export async function rubricFor(sub: { problemId?: unknown; eventId?: unknown }) {
  if (sub.problemId) { const r = await ReviewRubric.findOne({ scopeKey: `p:${sub.problemId}`, active: true }).sort({ createdAt: -1 }); if (r) return r; }
  if (sub.eventId) return ReviewRubric.findOne({ scopeKey: `e:${sub.eventId}`, active: true }).sort({ createdAt: -1 });
  return null;
}

const toCriteria = (r: { criteria: { key: string; name: string; description?: string | null; maxPoints: number; weight: number }[] } | null): RubricCriterion[] =>
  (r?.criteria ?? []).map((c) => ({ key: c.key, name: c.name, description: c.description ?? undefined, maxPoints: c.maxPoints, weight: c.weight }));

/** Creates an empty editable draft for a submission (works with AI disabled). 409 if feedback already exists. */
export async function createBlankDraft(codeSubmissionId: string, actorId?: string) {
  const sub = await CodeSubmission.findById(codeSubmissionId).select('userId eventId problemId');
  if (!sub) throw notFound('Submission not found');
  if (await Feedback.exists({ codeSubmissionId })) throw conflict('Feedback already exists for this submission.');
  const rubric = await rubricFor(sub);
  const criterionScores = blankScores(toCriteria(rubric));
  try {
    return await Feedback.create({ codeSubmissionId, userId: sub.userId, eventId: sub.eventId, problemId: sub.problemId, rubricId: rubric?._id, criterionScores, total: computeTotals(criterionScores), generation: { source: 'manual', ok: true, warnings: [] }, createdBy: actorId });
  } catch (e) {
    if ((e as { code?: number }).code === 11000) throw conflict('Feedback already exists for this submission.');
    throw e;
  }
}

/**
 * Generates (or regenerates) an AI DRAFT for one submission. Only that submission's code is sent. Disabled -> 503 AI_DISABLED.
 * A published feedback is never overwritten (409). `call` is injectable for tests.
 */
export async function generateDraft(codeSubmissionId: string, actorId?: string, call: (s: string, u: string, o?: CallOptions) => ReturnType<typeof callAnthropic> = callAnthropic) {
  const st = aiState();
  if (!st.enabled) throw new AppError(503, 'AI_DISABLED', `AI feedback is disabled (${st.reason}). You can still write feedback by hand.`);
  const sub = await CodeSubmission.findById(codeSubmissionId).select('+code userId eventId problemId language');
  if (!sub) throw notFound('Submission not found');
  const existing = await Feedback.findOne({ codeSubmissionId });
  if (existing?.status === 'published') throw conflict('This feedback is already published. Unpublish it before regenerating.');
  const rubric = await rubricFor(sub);
  const criteria = toCriteria(rubric);
  const problem = sub.problemId ? await Problem.findById(sub.problemId).select('title statement') : null;
  const prompt = buildFeedbackPrompt({ language: sub.language, code: sub.code, problemTitle: problem?.title, problemStatement: problem?.statement, rubricName: rubric?.name, criteria, maxChars: env.anthropic.maxInputChars });
  let reply;
  try { reply = await call(prompt.system, prompt.user); }
  catch (e) {
    if (e instanceof AiError) {
      const status = e.code === 'RATE_LIMITED' ? 429 : e.code === 'TIMEOUT' ? 504 : 502;
      throw new AppError(status, `AI_${e.code}`, e.message);
    }
    throw e;
  }
  const p = parseFeedbackResponse(reply.text, criteria);
  const doc = {
    userId: sub.userId, eventId: sub.eventId, problemId: sub.problemId, rubricId: rubric?._id, status: 'draft' as const,
    strengths: p.strengths, issues: p.issues, suggestions: p.suggestions,
    quality: { rating: p.quality.rating ?? undefined, summary: p.quality.summary }, complexity: p.complexity,
    criterionScores: p.criterionScores, total: p.total,
    generation: { source: 'ai' as const, model: reply.model, truncated: prompt.truncated, ok: p.ok, warnings: p.warnings.slice(0, 20), at: new Date() },
  };
  const saved = await Feedback.findOneAndUpdate({ codeSubmissionId, status: { $ne: 'published' } }, { $set: doc, $setOnInsert: { createdBy: actorId } }, { upsert: true, new: true, setDefaultsOnInsert: true }).catch((e) => {
    if ((e as { code?: number }).code === 11000) throw conflict('Feedback was published or changed meanwhile.');
    throw e;
  });
  return saved;
}
