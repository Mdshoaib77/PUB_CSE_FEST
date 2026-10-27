/**
 * S14 demo data (idempotent): a rubric "Demo: Code quality" for "Demo: Hack-a-thon Warm-up" and ONE hand-written DRAFT feedback on
 * demo.student3's prime-sieve submission, so the feedback UI works with no Anthropic key. It stays a draft (staff-only) so the
 * participant view starts empty; publish it from /feedback as demo.organiser to see the student side (log in as demo.student3).
 */
import { CodeSubmission, Event, Feedback, ReviewRubric, User } from '../models';
import { blankScores, computeTotals, normalizeCriteria } from '../services/aiFeedback/rubric';

export async function seedFeedback(log: (m: string) => void = console.log): Promise<{ rubric: boolean; feedback: boolean }> {
  const ev = await Event.findOne({ title: 'Demo: Hack-a-thon Warm-up' });
  const student = await User.findOne({ email: 'demo.student3@festhub.test' });
  if (!ev || !student) return { rubric: false, feedback: false };
  const scopeKey = `e:${ev.id}`;
  const organiser = await User.findOne({ email: 'demo.organiser@festhub.test' }).select('_id');
  let rubric = await ReviewRubric.findOne({ scopeKey, name: 'Demo: Code quality' });
  let madeRubric = false;
  if (!rubric) {
    rubric = await ReviewRubric.create({
      name: 'Demo: Code quality', scopeKey, eventId: ev._id, createdBy: organiser?._id,
      criteria: normalizeCriteria([
        { name: 'Correctness', description: 'Produces the right output for all valid inputs.', maxPoints: 10, weight: 3 },
        { name: 'Readability', description: 'Clear names, sensible structure.', maxPoints: 5, weight: 1 },
        { name: 'Efficiency', description: 'Suitable algorithm and complexity.', maxPoints: 5, weight: 2 },
      ]),
    });
    madeRubric = true;
  }
  const sub = await CodeSubmission.findOne({ scopeKey, userId: student._id }).sort({ submittedAt: -1 }).select('_id');
  if (!sub || (await Feedback.exists({ codeSubmissionId: sub._id }))) return { rubric: madeRubric, feedback: false };
  const given: Record<string, [number, string]> = { Correctness: [9, 'Handles limit 0 and 1 correctly; output format matches.'], Readability: [4, 'Short, clear loop; a docstring would help.'], Efficiency: [5, 'Sieve of Eratosthenes, O(n log log n).'] };
  const criterionScores = blankScores(rubric.criteria.map((c) => ({ key: c.key, name: c.name, maxPoints: c.maxPoints, weight: c.weight }))).map((c) => ({ ...c, score: given[c.name]?.[0] ?? 0, comment: given[c.name]?.[1] ?? '' }));
  await Feedback.create({
    codeSubmissionId: sub._id, userId: student._id, eventId: ev._id, rubricId: rubric._id, status: 'draft', createdBy: organiser?._id,
    strengths: ['Correct, textbook sieve that starts marking at i*i.', 'Edge cases (0 and 1) are handled explicitly.'],
    issues: ['Variable names such as `i` and `j` carry no meaning.', 'No input validation for negative numbers.'],
    suggestions: ['Add a one-line comment naming the algorithm.', 'Use a bytearray to cut memory for large limits.'],
    quality: { rating: 8, summary: 'Solid and efficient; small readability polish left.' },
    complexity: { time: 'O(n log log n)', space: 'O(n)', notes: 'Fine for limits up to a few million.' },
    criterionScores, total: computeTotals(criterionScores),
    generation: { source: 'manual', ok: true, warnings: [] },
  });
  log('Demo seed: feedback rubric + 1 hand-written DRAFT feedback (demo.student3). Open /feedback as demo.organiser.');
  return { rubric: madeRubric, feedback: true };
}
