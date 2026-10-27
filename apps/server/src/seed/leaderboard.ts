/**
 * S15 demo data (idempotent): makes the "Demo: Hack-a-thon Warm-up" leaderboard meaningful.
 *   - activity "Demo: Hack-a-thon Warm-up - Final Round" (competition) with a judging rubric (Idea, Implementation, Presentation)
 *   - six students (demo.student1..6) with one entry each, scored by demo.judge and demo.judge2 (demo.judge2 is created if missing)
 *   - draft code feedback ("AI-suggested" scores, flagged as demo data) for students 1, 2, 4, 5, 6; student3 keeps the S14 hand-written draft
 *   - the copied pair student1/student2 is CONFIRMED plagiarism (-10 each by default); the renamed pair student3/student4 stays "suspicious" and costs nothing
 *   - student4 and student6 end with identical scores, so the shared-rank tie handling is visible
 * Runs after seedPlagiarism + seedFeedback; does nothing when those left no data to build on, or when the demo entries already exist.
 */
import bcrypt from 'bcryptjs';
import { Activity, CodeSubmission, Entry, Event, Feedback, JudgeAssignment, PlagiarismPair, ReviewRubric, Rubric, Score, User } from '../models';
import { computeTotals } from '../services/aiFeedback/rubric';
import { percentFromScores } from '../routes/judging';
import { sha256 } from '../services/plagiarismCheck';
import { DEMO_PASSWORD } from './demo';

const CRITERIA = [
  { name: 'Idea', maxScore: 10, weight: 2 },
  { name: 'Implementation', maxScore: 10, weight: 3 },
  { name: 'Presentation', maxScore: 10, weight: 1 },
];
// [student index, entry title, judge1 [idea, impl, pres], judge2 [idea, impl, pres], AI feedback scores [correctness/10, readability/5, efficiency/5] | null = keep existing]
const PLAN: [number, string, number[], number[], number[] | null][] = [
  [1, 'Campus Lost & Found Board', [9, 9, 8], [9, 8, 9], [9, 4, 4]],
  [2, 'Campus Lost & Found Board v2', [9, 8, 8], [9, 8, 8], [8, 4, 4]],
  [3, 'Prime Explorer', [9, 9, 9], [10, 9, 9], null],
  [4, 'Study Group Matcher', [8, 8, 9], [9, 8, 8], [8, 3, 4]],
  [5, 'Canteen Queue Tracker', [8, 8, 7], [8, 7, 8], [8, 4, 5]],
  [6, 'Library Seat Finder', [8, 8, 9], [9, 8, 8], [8, 3, 4]],
];
const REVERSE = `s = input().strip()\nprint(s[::-1])\nprint(len(s))\n`;

export async function seedLeaderboard(log: (m: string) => void = console.log): Promise<{ entries: number; feedback: number; confirmed: number }> {
  const none = { entries: 0, feedback: 0, confirmed: 0 };
  const ev = await Event.findOne({ title: 'Demo: Hack-a-thon Warm-up' });
  const judge1 = await User.findOne({ email: 'demo.judge@festhub.test' });
  if (!ev || !judge1) return none;
  const title = 'Demo: Hack-a-thon Warm-up - Final Round';
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const mk = async (email: string, name: string, roles: string[]) => (await User.findOne({ email })) ?? (await User.create({ name, email, roles, department: 'CSE', batch: '2023', passwordHash }));
  const judge2 = await mk('demo.judge2@festhub.test', 'Demo Judge 2', ['judge']);
  const students: Record<number, InstanceType<typeof User>> = {};
  for (let i = 1; i <= 6; i++) students[i] = await mk(`demo.student${i}@festhub.test`, `Demo Student ${i}`, ['participant']);

  let act = await Activity.findOne({ eventId: ev._id, title });
  if (act && (await Entry.exists({ activityId: act._id }))) return none; // already seeded
  act ??= await Activity.create({ eventId: ev._id, title, kind: 'competition', start: ev.startAt, end: ev.endAt, status: 'scheduled', ...(ev.venueId ? { venueId: ev.venueId } : {}) });
  await Rubric.updateOne({ activityId: act._id }, { $setOnInsert: { activityId: act._id, criteria: CRITERIA } }, { upsert: true });

  let entries = 0;
  for (const [i, entryTitle, s1, s2] of PLAN) {
    const stu = students[i];
    const entry = await Entry.create({ activityId: act._id, eventId: ev._id, ownerKey: `u:${stu.id}`, ownerUserId: stu._id, title: entryTitle, currentVersion: 1 });
    for (const [judge, vals] of [[judge1, s1], [judge2, s2]] as const) {
      const criterionScores = CRITERIA.map((c, k) => ({ name: c.name, score: vals[k] }));
      await JudgeAssignment.create({ entryId: entry._id, activityId: act._id, judgeId: judge._id });
      await Score.create({ entryId: entry._id, activityId: act._id, judgeId: judge._id, versionScored: 1, criterionScores, feedback: 'Demo score.', percent: percentFromScores(CRITERIA, criterionScores) });
    }
    entries++;
  }

  // AI-suggested scores: flagged drafts using the demo rubric from S14
  const rubric = await ReviewRubric.findOne({ scopeKey: `e:${ev.id}`, name: 'Demo: Code quality' });
  let feedback = 0;
  if (rubric) {
    for (const [i, , , , ai] of PLAN) {
      if (!ai) continue;
      const stu = students[i];
      let sub = await CodeSubmission.findOne({ scopeKey: `e:${ev.id}`, userId: stu._id }).select('_id');
      if (!sub && i === 6) sub = await CodeSubmission.create({ userId: stu._id, eventId: ev._id, scopeKey: `e:${ev.id}`, language: 'python', code: REVERSE, source: 'paste', sizeBytes: REVERSE.length, codeHash: sha256(REVERSE) });
      if (!sub || (await Feedback.exists({ codeSubmissionId: sub._id }))) continue;
      const criterionScores = rubric.criteria.map((c, k) => ({ key: c.key, name: c.name, maxPoints: c.maxPoints, weight: c.weight, score: ai[k] ?? 0, comment: '' }));
      await Feedback.create({
        codeSubmissionId: sub._id, userId: stu._id, eventId: ev._id, rubricId: rubric._id, status: 'draft',
        strengths: ['Demo data.'], issues: [], suggestions: [], quality: { rating: 7, summary: 'Demo seed data.' },
        criterionScores, total: computeTotals(criterionScores),
        generation: { source: 'ai', model: 'demo-seed', ok: true, warnings: ['Demo seed data, not produced by a model.'], at: new Date() },
      });
      feedback++;
    }
  }

  // plagiarism: confirm the copied pair (student1 / student2); the renamed pair stays suspicious
  let confirmed = 0;
  const ids = [students[1].id, students[2].id];
  const pair = await PlagiarismPair.findOne({ eventId: ev._id, aUserId: { $in: ids }, bUserId: { $in: ids } });
  if (pair && pair.status !== 'confirmed') {
    pair.status = 'confirmed';
    pair.manual = true;
    pair.reviewedAt = new Date();
    await pair.save();
    confirmed++;
  }
  log(`Demo seed: leaderboard data for "${ev.title}" (${entries} scored entries, ${feedback} AI-suggested feedback drafts, ${confirmed} confirmed plagiarism pair). Open Leaderboard as demo.organiser.`);
  return { entries, feedback, confirmed };
}
