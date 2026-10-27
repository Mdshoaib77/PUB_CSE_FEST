/** Synthetic demo data only. Run: npm run seed   (add --reset to wipe the database first). */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import {
  Activity,
  Availability,
  Contest,
  ContestRegistration,
  ContestTeam,
  Editorial,
  Event,
  Issue,
  Problem,
  Rubric,
  Shift,
  ShiftAssignment,
  TestCase,
  User,
  Venue,
  Announcement,
} from '../models';
import { registerIndividual } from '../services/registration';
import { seedDemo } from './demo';

const PASSWORD = 'Password123';
const h = (n: number) => new Date(Date.now() + n * 3600_000);

async function main() {
  await mongoose.connect(env.mongoUri);
  if (process.argv.includes('--reset')) await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
  if (await User.countDocuments()) {
    console.log('Database already has users. Re-run with --reset to wipe and re-seed.');
    await seedDemo(); // idempotent: only adds missing demo accounts/events
    await mongoose.disconnect();
    return process.exit(0);
  }

  const hash = await bcrypt.hash(PASSWORD, 12);
  const mk = (name: string, email: string, roles: string[], department = 'CSE', batch = '2022') =>
    User.create({ name, email, roles, department, batch, passwordHash: hash });
  const org = await mk('Olivia Organiser', 'organiser@festhub.test', ['organiser']);
  await mk('Ada Admin', 'admin@festhub.test', ['admin']);
  await mk('Sam Sponsor', 'sponsor@festhub.test', ['sponsor']);
  const coord = await mk('Carter Coordinator', 'coordinator@festhub.test', ['coordinator']);
  const judge = await mk('Jamal Judge', 'judge@festhub.test', ['judge']);
  await mk('Jahan Judge', 'judge2@festhub.test', ['judge']);
  const vols = await Promise.all([1, 2, 3].map((i) => mk(`Vera Volunteer ${i}`, `volunteer${i}@festhub.test`, ['volunteer'])));
  const parts = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => mk(`Parker Participant ${i}`, `participant${i}@festhub.test`, ['participant'])));

  const [hall, lab, room] = await Promise.all(
    [
      ['Main Auditorium', 300],
      ['Room NB-408', 60],
      ['Room NB-407', 60],
    ].map(([name, capacity]) => Venue.create({ name: name as string, building: 'NB Building', capacity: capacity as number })),
  );
  const base = { createdBy: org._id, status: 'published' as const, venueId: hall._id };

  const seminar = await Event.create({
    ...base,
    title: 'Intro to Applied AI (Seminar)',
    type: 'seminar',
    description: 'A one-hour seminar on practical machine learning for students.',
    startAt: h(72),
    endAt: h(74),
    registrationDeadline: h(48),
    capacity: 100,
  });
  const poster = await Event.create({
    ...base,
    title: 'Poster Design Competition',
    type: 'competition',
    description: 'Design a poster for PUB CSE Fest. Entries can be revised until the deadline; judges score with a rubric.',
    startAt: h(96),
    endAt: h(100),
    registrationDeadline: h(60),
    capacity: 30,
    venueId: lab._id,
  });
  const workshop = await Event.create({
    ...base,
    title: 'Git & GitHub Workshop (approval + waiting list demo)',
    type: 'workshop',
    description: 'Tiny capacity so you can see waiting lists. Registrations need approval.',
    startAt: h(80),
    endAt: h(83),
    registrationDeadline: h(50),
    capacity: 2,
    requiresApproval: true,
    venueId: room._id,
  });
  await Event.create({
    ...base,
    title: 'Mini Hackathon (teams of 2-3)',
    type: 'competition',
    description: 'Team event demonstrating invitations and team registration.',
    startAt: h(120),
    endAt: h(130),
    registrationDeadline: h(90),
    capacity: 10,
    participationType: 'team',
    teamSize: { min: 2, max: 3 },
    venueId: lab._id,
  });
  const code = await Event.create({
    ...base,
    title: 'PUB CodeStorm Programming Contest',
    type: 'contest',
    description: 'ICPC-style contest with automatic judging, freeze and practice mode.',
    startAt: h(-1),
    endAt: h(4),
    registrationDeadline: h(3),
    capacity: 200,
    venueId: lab._id,
  });

  const posterAct = await Activity.create({
    eventId: poster._id,
    title: 'Poster Judging Round',
    kind: 'competition',
    start: h(96),
    end: h(100),
    venueId: lab._id,
    submissionDeadline: h(94),
  });
  await Activity.create({ eventId: seminar._id, title: 'AI Seminar Talk', kind: 'seminar', start: h(72), end: h(74), venueId: hall._id });
  await Activity.create({ eventId: workshop._id, title: 'Hands-on Git Session', kind: 'workshop', start: h(80), end: h(83), venueId: room._id });
  await Rubric.create({
    activityId: posterAct._id,
    criteria: [
      { name: 'Creativity', maxScore: 10, weight: 2 },
      { name: 'Layout', maxScore: 10, weight: 1 },
      { name: 'Message clarity', maxScore: 10, weight: 1 },
    ],
  });

  const shiftA = await Shift.create({ eventId: seminar._id, title: 'Registration desk', start: h(71), end: h(75), requiredCount: 2 });
  await Shift.create({ eventId: seminar._id, title: 'Stage & AV support', start: h(71), end: h(75), requiredCount: 1 });
  for (const v of vols) await Availability.create({ userId: v._id, eventId: seminar._id, slots: [{ start: h(70), end: h(76) }] });
  await ShiftAssignment.create({ shiftId: shiftA._id, eventId: seminar._id, volunteerId: vols[0]._id });
  await Issue.create({ eventId: seminar._id, title: 'Projector adapter missing', priority: 'high', reportedBy: vols[0]._id, ownerId: coord._id });
  await Announcement.create({
    eventId: seminar._id,
    authorId: coord._id,
    title: 'Doors open 30 minutes early',
    body: 'Please bring your student ID for QR check-in.',
    pinned: true,
  });

  for (const p of parts.slice(0, 3)) await registerIndividual(seminar.id, p.id);
  for (const p of parts.slice(0, 3)) await registerIndividual(workshop.id, p.id); // 2 pending approval + 1 waitlisted
  for (const p of parts.slice(0, 2)) await registerIndividual(poster.id, p.id);
  for (const p of parts) await registerIndividual(code.id, p.id);

  // Problems with real test cases (usable with a real Judge0 instance).
  const mkProblem = async (
    title: string,
    statement: string,
    tags: string[],
    difficulty: string,
    cases: [string, string][],
    o: Record<string, unknown> = {},
  ) => {
    const p = await Problem.create({
      title,
      statement,
      constraints: 'See statement',
      inputDesc: 'See statement',
      outputDesc: 'Print the answer',
      samples: [{ input: cases[0][0], output: cases[0][1] }],
      tags,
      difficulty,
      visibility: 'public',
      authorId: judge._id,
      ...o,
    });
    await TestCase.insertMany(cases.map((c, i) => ({ problemId: p._id, order: i + 1, input: c[0], expectedOutput: c[1] })));
    return p;
  };
  const pSum = await mkProblem('A. Sum of Two', 'Given two integers a and b (0 ≤ a, b ≤ 10^9), print a + b.', ['math', 'implementation'], 'easy', [
    ['1 2\n', '3\n'],
    ['100 250\n', '350\n'],
    ['1000000000 1000000000\n', '2000000000\n'],
    ['0 0\n', '0\n'],
  ]);
  const pEven = await mkProblem(
    'B. Even or Odd',
    'Given an integer n (0 ≤ n ≤ 10^18), print "Even" if n is even, otherwise "Odd".',
    ['math', 'implementation'],
    'easy',
    [
      ['4\n', 'Even\n'],
      ['7\n', 'Odd\n'],
      ['0\n', 'Even\n'],
      ['999999999999999999\n', 'Odd\n'],
    ],
  );
  const pMax = await mkProblem('C. Largest of Three', 'Given three integers, print the largest.', ['implementation', 'sorting'], 'medium', [
    ['1 2 3\n', '3\n'],
    ['-5 -9 -1\n', '-1\n'],
    ['7 7 7\n', '7\n'],
  ]);
  await mkProblem('Practice: Count Digits', 'Given a non-negative integer, print how many digits it has.', ['math', 'strings'], 'easy', [
    ['0\n', '1\n'],
    ['12345\n', '5\n'],
    ['1000000\n', '7\n'],
  ]);
  await Editorial.create({
    problemId: pSum._id,
    authorId: judge._id,
    content: 'Read both numbers as 64-bit integers (the sum can exceed 32 bits) and print a + b.',
  });

  const contest = await Contest.create({
    eventId: code._id,
    title: 'PUB CodeStorm 2026',
    description: 'Individual ICPC-style contest. Solve more problems, with less penalty.',
    mode: 'INDIVIDUAL',
    startAt: h(-1),
    endAt: h(4),
    freezeAt: h(3),
    problems: [
      { problemId: pSum._id, label: 'A' },
      { problemId: pEven._id, label: 'B' },
      { problemId: pMax._id, label: 'C' },
    ],
    penaltyMinutes: 20,
    cooldownSec: 10,
    createdBy: org._id,
  });
  for (const p of parts.slice(0, 4)) await ContestRegistration.create({ contestId: contest._id, userId: p._id });

  // A TEAM (ICPC style) contest that has not started yet, so teams can still be formed from the UI. Banner: add one from Contest -> Admin.
  const teamContest = await Contest.create({
    title: 'PUB Team Cup 2026',
    description: 'Teams of 2-3 share one score. Create a team or join one with a code.',
    mode: 'TEAM',
    teamSize: { min: 2, max: 3 },
    startAt: h(24),
    endAt: h(28),
    freezeAt: h(27),
    problems: [
      { problemId: pSum._id, label: 'A' },
      { problemId: pEven._id, label: 'B' },
    ],
    penaltyMinutes: 20,
    cooldownSec: 10,
    createdBy: org._id,
  });
  const team = await ContestTeam.create({ contestId: teamContest._id, name: 'Null Pointers', leaderId: parts[4]._id, joinCode: 'DEMO2026', memberCount: 2, registeredAt: new Date() });
  for (const p of parts.slice(4, 6)) await ContestRegistration.create({ contestId: teamContest._id, userId: p._id, teamId: team._id });

  console.log('Seed complete. All accounts use password:', PASSWORD);
  console.log(
    'admin@festhub.test | sponsor@festhub.test | organiser@festhub.test | coordinator@festhub.test | judge@festhub.test | volunteer1@festhub.test | participant1@festhub.test',
  );
  await seedDemo();
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
