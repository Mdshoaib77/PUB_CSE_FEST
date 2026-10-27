/**
 * S4 demo data: one account per role (hashed passwords) + 3 demo events. Idempotent: safe to run many times
 * (accounts are matched by e-mail, events by title; existing rows are left as they are).
 * Called at the end of `npm run seed`, and standalone via `npm run seed:demo`.
 */
import bcrypt from 'bcryptjs';
import { ROLES, ROLE_LABELS, type Role } from '@festhub/shared';
import { Types } from 'mongoose';
import { Certificate, CertificateTemplate, Contest, Deliverable, Event, Sponsor, SponsorEvent, SponsorPayment, User, Venue } from '../models';
import { issueCertificate, notifyIssued, revokeCertificate } from '../services/certificates';
import { seedPlagiarism } from './plagiarism';
import { seedFeedback } from './feedback';
import { seedLeaderboard } from './leaderboard';

export const DEMO_PASSWORD = 'Demo@12345';
export const demoEmail = (role: Role) => `demo.${role}@festhub.test`;

const h = (n: number) => new Date(Date.now() + n * 3600_000);

export async function seedDemo(log: (m: string) => void = console.log): Promise<{ users: number; events: number; certificates?: number; sponsors?: number }> {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  let users = 0;
  const byRole = {} as Record<Role, string>;
  for (const role of ROLES) {
    const email = demoEmail(role);
    let u = await User.findOne({ email });
    if (!u) {
      u = await User.create({ name: `Demo ${ROLE_LABELS[role] ?? role}`, email, roles: [role], department: 'CSE', batch: '2022', passwordHash });
      users++;
    }
    byRole[role] = u.id;
  }

  const venueName = 'Main Auditorium';
  const venue = (await Venue.findOne({ name: venueName })) ?? (await Venue.create({ name: venueName, building: 'NB Building', capacity: 300 }));
  const common = { createdBy: byRole.organiser, status: 'published' as const, venueId: venue._id };
  const defs = [
    {
      title: 'Demo: Tech Talk — Building with APIs',
      type: 'seminar',
      description: 'Demo seminar. Register as demo.participant and check in with the QR code.',
      startAt: h(48),
      endAt: h(50),
      registrationDeadline: h(40),
      capacity: 80,
    },
    {
      title: 'Demo: Hack-a-thon Warm-up',
      type: 'competition',
      description: 'Demo competition with a small capacity, good for trying the waiting list.',
      startAt: h(72),
      endAt: h(78),
      registrationDeadline: h(60),
      capacity: 5,
    },
    {
      title: 'Demo: Git Workshop (approval required)',
      type: 'workshop',
      description: 'Demo workshop where registrations need organiser approval.',
      startAt: h(96),
      endAt: h(99),
      registrationDeadline: h(84),
      capacity: 20,
      requiresApproval: true,
    },
  ];
  let events = 0;
  for (const d of defs) {
    if (await Event.exists({ title: d.title })) continue;
    await Event.create({ ...common, ...d });
    events++;
  }
  const certificates = await seedDemoCertificates(byRole, log);
  const sponsors = await seedDemoSponsors(byRole, log);
  try {
    await seedPlagiarism(log); // S12: demo code submissions (original / copied / renamed) + computed pairs (idempotent)
  } catch (e) {
    log(`Plagiarism demo seed failed (continuing): ${(e as Error).message}`);
  }
  try {
    await seedFeedback(log); // S14: demo rubric + one hand-written DRAFT feedback (works without an AI key; idempotent)
  } catch (e) {
    log(`Feedback demo seed failed (continuing): ${(e as Error).message}`);
  }
  try {
    await seedLeaderboard(log); // S15: judged entries + AI-suggested drafts + one confirmed plagiarism pair for the demo leaderboard (idempotent)
  } catch (e) {
    log(`Leaderboard demo seed failed (continuing): ${(e as Error).message}`);
  }
  try {
    await seedTeamAndContestCertificates(byRole, passwordHash, log); // v4: team (3 + 5 members) + contest runner-up demo certificates (idempotent)
  } catch (e) {
    log(`Team/contest certificate demo seed failed (continuing): ${(e as Error).message}`);
  }
  log(`Demo seed: ${users} new account(s), ${events} new event(s). Password for all demo.<role>@festhub.test accounts: ${DEMO_PASSWORD}`);
  return { users, events, certificates, sponsors };
}

/** S6: a few demo certificates (valid, winner, volunteer, organizer, one revoked) + a template. Idempotent: existing valid ones are reused, the revoked sample is only made once. */
async function seedDemoCertificates(byRole: Record<Role, string>, log: (m: string) => void): Promise<number> {
  const talk = await Event.findOne({ title: 'Demo: Tech Talk — Building with APIs' });
  const hack = await Event.findOne({ title: 'Demo: Hack-a-thon Warm-up' });
  if (!talk || !hack) return 0;
  let n = 0;
  const actor = { id: byRole.organiser, name: 'Demo Organizer' };
  const ev = (e: typeof talk) => ({ id: e.id as string, title: e.title, startAt: e.startAt, createdBy: e.createdBy });
  for (const e of [talk, hack]) {
    await CertificateTemplate.updateOne({ eventId: e.id }, { $setOnInsert: { signatureName: 'Dr. A. Rahman', signatureTitle: 'Convener, PUB FestHub', primaryColor: '#4f46e5', accentColor: '#d94c33' } }, { upsert: true });
  }
  const names = new Map<string, string>();
  for (const role of ['participant', 'volunteer', 'organiser'] as Role[]) names.set(role, (await User.findById(byRole[role]).select('name'))?.name ?? 'Demo');
  const plan: { e: typeof talk; role: Role; type: 'participation' | 'winner' | 'volunteer' | 'organizer'; label?: string; pos?: number }[] = [
    { e: talk, role: 'participant', type: 'participation' },
    { e: talk, role: 'volunteer', type: 'volunteer' },
    { e: talk, role: 'organiser', type: 'organizer' },
    { e: hack, role: 'participant', type: 'winner', pos: 1, label: '1st Place - Demo Hack-a-thon' },
  ];
  for (const p of plan) {
    const r = await issueCertificate({ event: ev(p.e), userId: byRole[p.role], type: p.type, position: p.pos, positionLabel: p.label, recipientName: names.get(p.role)!, issuedBy: actor.id });
    if (r.created) n++;
  }
  // one revoked sample so the "revoked" state of /verify can be demonstrated
  const REASON = 'Demo: issued by mistake';
  const done = await Certificate.exists({ eventId: hack.id, userId: byRole.volunteer, type: 'participation', revokeReason: REASON });
  const sample = done ? null : await issueCertificate({ event: ev(hack), userId: byRole.volunteer, type: 'participation', recipientName: names.get('volunteer')!, issuedBy: actor.id });
  if (sample?.created) {
    await revokeCertificate(sample.cert.certId, actor, REASON);
    n++;
  }
  log(`Demo seed: ${n} new demo certificate(s). Verify them at /verify/<ID> (IDs are listed on the Certificates page).`);
  return n;
}

/** Stable ids so the demo team certificates keep the same slot on every run (the demo teams are snapshots only; no Team rows are needed). */
const DEMO_TEAM_ALPHA = new Types.ObjectId('6d656d6f7465616d616c7068');
const DEMO_TEAM_BRAVO = new Types.ObjectId('6d656d6f7465616d62726176');

/**
 * v4 demo: ONE team certificate with 3 members (participation, "Demo Team Alpha"), ONE with 5 members (runner-up, "Demo Team Bravo"),
 * and a contest runner-up certificate (individual). The individual winner already exists from seedDemoCertificates.
 * Members are demo.student1..5 (log in as any of them: the team certificate appears in My certificates). Idempotent (slotKey).
 */
async function seedTeamAndContestCertificates(byRole: Record<Role, string>, passwordHash: string, log: (m: string) => void): Promise<number> {
  const hack = await Event.findOne({ title: 'Demo: Hack-a-thon Warm-up' });
  if (!hack) return 0;
  const students = [];
  for (let i = 1; i <= 5; i++) {
    const email = `demo.student${i}@festhub.test`;
    students.push((await User.findOne({ email })) ?? (await User.create({ name: `Demo Student ${i}`, email, roles: ['participant'], department: 'CSE', batch: '2023', passwordHash })));
  }
  const actor = { id: byRole.organiser };
  const ev = { id: hack.id as string, title: hack.title, startAt: hack.startAt, createdBy: hack.createdBy };
  const people = (xs: typeof students) => xs.map((u) => ({ userId: u.id as string, name: u.name }));
  let n = 0;
  const a = await issueCertificate({ event: ev, kind: 'team', teamId: String(DEMO_TEAM_ALPHA), teamName: 'Demo Team Alpha', recipientName: 'Demo Team Alpha', userId: students[0].id, recipients: people(students.slice(0, 3)), type: 'participation', issuedBy: actor.id });
  const b = await issueCertificate({ event: ev, kind: 'team', teamId: String(DEMO_TEAM_BRAVO), teamName: 'Demo Team Bravo', recipientName: 'Demo Team Bravo', userId: students[0].id, recipients: people(students), type: 'runner_up', position: 2, issuedBy: actor.id });
  for (const r of [a, b]) if (r.created) { n++; await notifyIssued(r.cert); }

  const title = 'Demo: CodeStorm Mini Contest';
  const contest = (await Contest.findOne({ title })) ?? (await Contest.create({ title, startAt: new Date(Date.now() - 3 * 86400_000), endAt: new Date(Date.now() - 3 * 86400_000 + 3 * 3600_000), mode: 'INDIVIDUAL', description: 'Demo: finished contest used to show contest certificates.', createdBy: byRole.organiser }));
  const c = await issueCertificate({ event: { title: contest.title, startAt: contest.startAt, createdBy: contest.createdBy, contestId: contest.id }, userId: students[1].id, recipientName: students[1].name, type: 'runner_up', position: 2, issuedBy: actor.id });
  if (c.created) { n++; await notifyIssued(c.cert); }
  log(`Demo seed: ${n} new team/contest certificate(s) (Team Alpha 3 members, Team Bravo 5 members, contest runner-up for ${students[1].name}).`);
  return n;
}

/** S8: demo sponsors for the demo events (all tiers, mixed statuses, payments, deliverables). demo.sponsor is linked to "Demo Nova Bank" for the portal. Idempotent: matched by company name. */
async function seedDemoSponsors(byRole: Record<Role, string>, log: (m: string) => void): Promise<number> {
  const evs = await Event.find({ title: { $in: ['Demo: Tech Talk — Building with APIs', 'Demo: Hack-a-thon Warm-up', 'Demo: Git Workshop (approval required)'] } });
  const by = (t: string) => evs.find((e) => e.title === t);
  const talk = by('Demo: Tech Talk — Building with APIs');
  const hack = by('Demo: Hack-a-thon Warm-up');
  const git = by('Demo: Git Workshop (approval required)');
  if (!talk || !hack || !git) return 0;
  type P = { pledged: number; received: number; dueInDays?: number };
  const plan: { company: string; tier: string; status: string; type: 'cash' | 'in_kind' | 'service'; amount: number; events: (typeof talk)[]; pays: P[]; dels: { type: string; title: string; done?: boolean }[]; portal?: boolean }[] = [
    { company: 'Demo Nova Bank', tier: 'title', status: 'received', type: 'cash', amount: 100000, events: [talk, hack, git], pays: [{ pledged: 60000, received: 60000 }, { pledged: 40000, received: 25000, dueInDays: 10 }], dels: [{ type: 'logo', title: 'Logo on main banner', done: true }, { type: 'speaking_slot', title: '10 min opening talk' }, { type: 'social_post', title: 'Launch post', done: true }], portal: true },
    { company: 'Demo Orbit Cloud', tier: 'gold', status: 'confirmed', type: 'cash', amount: 50000, events: [talk, hack], pays: [{ pledged: 50000, received: 20000, dueInDays: 14 }], dels: [{ type: 'booth', title: 'Booth at Main Auditorium' }, { type: 'logo', title: 'Logo on stage backdrop', done: true }] },
    { company: 'Demo Pixel Labs', tier: 'silver', status: 'confirmed', type: 'service', amount: 20000, events: [hack], pays: [{ pledged: 20000, received: 0, dueInDays: 21 }], dels: [{ type: 'certificate_mention', title: 'Name on certificates' }] },
    { company: 'Demo Byte Snacks', tier: 'bronze', status: 'received', type: 'in_kind', amount: 8000, events: [talk, git], pays: [{ pledged: 8000, received: 8000 }], dels: [{ type: 'tickets', title: '10 free tickets', done: true }] },
    { company: 'Demo Campus Press', tier: 'partner', status: 'negotiating', type: 'service', amount: 3000, events: [talk], pays: [{ pledged: 3000, received: 0 }], dels: [{ type: 'social_post', title: 'Media partner post' }] },
    { company: 'Demo Green Cafe', tier: 'partner', status: 'prospect', type: 'cash', amount: 5000, events: [], pays: [], dels: [] },
  ];
  let n = 0;
  for (const p of plan) {
    if (await Sponsor.exists({ company: p.company })) continue;
    const s = await Sponsor.create({
      company: p.company,
      contactName: 'Demo Contact',
      email: `contact@${p.company.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
      tier: p.tier,
      contributionType: p.type,
      amount: p.amount,
      status: p.status,
      notes: 'Demo sponsor (seed data).',
      ownerId: byRole.organiser,
      createdBy: byRole.organiser,
      ...(p.portal ? { userId: byRole.sponsor } : {}),
      ...(p.status === 'negotiating' ? { nextFollowUpAt: new Date(Date.now() + 3 * 86400_000) } : {}),
    });
    for (const e of p.events) await SponsorEvent.create({ sponsorId: s._id, eventId: e._id, linkedBy: byRole.organiser });
    for (const x of p.pays) await SponsorPayment.create({ sponsorId: s._id, eventId: p.events[0]?._id, pledged: x.pledged, received: x.received, recordedBy: byRole.organiser, dueDate: x.dueInDays ? new Date(Date.now() + x.dueInDays * 86400_000) : undefined, ...(x.received > 0 ? { receivedAt: new Date() } : {}) });
    for (const d of p.dels) await Deliverable.create({ sponsorId: s._id, eventId: p.events[0]?._id, type: d.type, title: d.title, status: d.done ? 'done' : 'pending', ...(d.done ? { doneAt: new Date() } : {}) });
    n++;
  }
  log(`Demo seed: ${n} new demo sponsor(s). Log in as demo.sponsor@festhub.test for the sponsor portal.`);
  return n;
}
