import { LANGUAGES, tierRank } from '@festhub/shared';
import { Activity, AuditLog, ContestTeam, Event, Invitation, Venue, CodeSubmission, PlagiarismPair, PlagiarismSetting, StarterCode, Certificate, CertificateTemplate, Deliverable, Feedback, LeaderboardSetting, Migration, Notification, Problem, ReviewRubric, Sponsor, SponsorEvent, SponsorPayment, User } from '../models';
import { NOTICE_TITLES } from './notify';
import { logger } from '../utils/logger';

/** The language list a problem got by default before FestHub supported ten languages. */
const LEGACY_DEFAULT = ['c', 'cpp', 'java', 'python'];

/**
 * Idempotent start-up migration. Problems created while only four languages existed stored exactly those four as their allowed list,
 * which would silently hide JavaScript, TypeScript, Go, C#, Rust and PHP from the language picker. Those problems are widened to the
 * full list once; a problem whose setter chose any other combination is left alone.
 */
export async function migrateProblemLanguages(): Promise<number> {
  const r = await Problem.updateMany({ languages: { $size: LEGACY_DEFAULT.length, $all: LEGACY_DEFAULT } }, { $set: { languages: [...LANGUAGES] } });
  if (r.modifiedCount) logger.info('widened allowed languages on legacy problems', { count: r.modifiedCount });
  return r.modifiedCount;
}

// ------------------------------------------------------------------ run-once migrations (S2)

/** S2: make sure the audit indexes exist and copy actor names onto old log rows so history survives user deletion. */
export async function migrateAuditLog(): Promise<number> {
  await AuditLog.createIndexes();
  const ids = await AuditLog.distinct('actorId', { actorName: { $exists: false }, actorId: { $ne: null } });
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const users = await User.find({ _id: { $in: ids.slice(i, i + 200) } }).select('name');
    for (const u of users) n += (await AuditLog.updateMany({ actorId: u._id, actorName: { $exists: false } }, { $set: { actorName: u.name } })).modifiedCount;
  }
  return n;
}

/** S2: guarantee every user has at least one valid role (new roles `admin` and `sponsor` are additive; nothing is rewritten). */
export async function migrateUserRoles(): Promise<number> {
  const r = await User.updateMany({ $or: [{ roles: { $exists: false } }, { roles: { $size: 0 } }] }, { $set: { roles: ['participant'] } });
  return r.modifiedCount;
}

/** S3: give pre-existing notifications a title and, where they point at an event, an in-app link; make sure the list indexes exist. */
export async function migrateNotifications(): Promise<number> {
  await Notification.createIndexes();
  let n = 0;
  for (const [type, title] of Object.entries(NOTICE_TITLES))
    n += (await Notification.updateMany({ type, title: { $exists: false } }, { $set: { title } })).modifiedCount;
  n += (await Notification.updateMany({ title: { $exists: false } }, { $set: { title: NOTICE_TITLES.general } })).modifiedCount;
  const ops: Parameters<typeof Notification.bulkWrite>[0] = [];
  const flush = async () => {
    if (ops.length) n += (await Notification.bulkWrite(ops.splice(0))).modifiedCount;
  };
  for await (const d of Notification.find({ link: { $exists: false }, 'refs.eventId': { $exists: true } })
    .select('refs')
    .lean()) {
    const id = String((d.refs as { eventId?: unknown } | undefined)?.eventId ?? '');
    if (!/^[a-f0-9]{24}$/i.test(id)) continue;
    ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { link: `/events/${id}` } } } });
    if (ops.length >= 500) await flush();
  }
  await flush();
  return n;
}

/**
 * S5: create the Certificate collection and its unique indexes (certId, slotKey) up front, and repair rows that could never be
 * issued by the app (no slotKey: a revoked row gets `x:<certId>`, a valid row gets its natural slot). Idempotent; a no-op on a fresh install.
 */
export async function migrateCertificates(): Promise<number> {
  await Certificate.createIndexes();
  let n = 0;
  for await (const c of Certificate.find({ $or: [{ slotKey: { $exists: false } }, { slotKey: null }] })
    .select('certId status userId eventId type activityId')
    .lean()) {
    const slot = c.status === 'revoked' ? `x:${c.certId}` : `${c.eventId}:${c.userId}:${c.type}:${c.activityId ?? ''}`;
    n += (await Certificate.updateOne({ _id: c._id }, { $set: { slotKey: slot } })).modifiedCount;
  }
  return n;
}

/**
 * v4: certificates gain `kind` / `recipients` (snapshot, leader first) / `teamId` / `teamName` / `contestId`. Old documents become
 * individual certificates with a one-person snapshot (so "My certificates" and verify read them like new ones). slotKey is NOT touched
 * (old individual slots keep their format, so nothing can be issued twice). Idempotent: only rows still missing a field are written.
 */
export async function migrateCertificatesV4(): Promise<number> {
  await Certificate.createIndexes();
  let n = 0;
  n += (await Certificate.updateMany({ kind: { $exists: false } }, { $set: { kind: 'individual' } })).modifiedCount;
  for await (const c of Certificate.find({ $or: [{ recipients: { $exists: false } }, { recipients: { $size: 0 } }], kind: { $ne: 'team' } })
    .select('userId recipientName')
    .lean()) {
    n += (await Certificate.updateOne({ _id: c._id, kind: { $ne: 'team' } }, { $set: { recipients: [{ userId: c.userId, name: c.recipientName }] } })).modifiedCount;
  }
  return n;
}

/**
 * v6: certificate templates gain theme / border / font / seal / second logo / signatories[] / headlines / body text / custom fields.
 * Old templates keep working without this (reads fall back to defaults); the migration just materialises the new defaults and copies
 * the single legacy signatory into `signatories[0]`. The legacy signature* fields are NOT removed. Idempotent: only rows that still
 * lack `signatories` are written, and a second run changes nothing.
 */
export async function migrateCertTemplatesV6(): Promise<number> {
  await CertificateTemplate.createIndexes();
  let n = 0;
  for await (const t of CertificateTemplate.find({ signatories: { $exists: false } }).lean<{ _id: unknown; signatureName?: string; signatureTitle?: string; signatureImageUrl?: string }[]>()) {
    const sig = { name: (t.signatureName ?? '').slice(0, 40), title: (t.signatureTitle ?? '').slice(0, 80), ...(t.signatureImageUrl ? { imageUrl: t.signatureImageUrl } : {}) };
    const r = await CertificateTemplate.updateOne({ _id: t._id, signatories: { $exists: false } }, { $set: { signatories: [sig], theme: 'custom', borderStyle: 'classic', fontStyle: 'serif', sealEnabled: true, bodyText: '' } });
    n += r.modifiedCount;
  }
  return n;
}

/**
 * S7: create the sponsor collections + indexes up front (Sponsor, SponsorEvent unique pair, Deliverable, SponsorPayment) and repair
 * sponsor rows that lack `tierRank` / a valid status or tier. Idempotent; a no-op on a fresh install.
 */
export async function migrateSponsors(): Promise<number> {
  await Promise.all([Sponsor.createIndexes(), SponsorEvent.createIndexes(), Deliverable.createIndexes(), SponsorPayment.createIndexes()]);
  let n = 0;
  n += (await Sponsor.updateMany({ status: { $exists: false } }, { $set: { status: 'prospect' } })).modifiedCount;
  n += (await Sponsor.updateMany({ tier: { $exists: false } }, { $set: { tier: 'partner' } })).modifiedCount;
  for await (const s of Sponsor.find({ $or: [{ tierRank: { $exists: false } }, { tierRank: null }] }).select('tier').lean())
    n += (await Sponsor.updateOne({ _id: s._id }, { $set: { tierRank: tierRank(s.tier) } })).modifiedCount;
  return n;
}

/**
 * S11: create the plagiarism collections + indexes up front (CodeSubmission, PlagiarismPair unique pair, PlagiarismSetting unique
 * scope, StarterCode) and repair rows missing `scopeKey` / `checkStatus` / pair `status`. Idempotent; a no-op on a fresh install.
 */
export async function migratePlagiarism(): Promise<number> {
  await Promise.all([CodeSubmission.createIndexes(), PlagiarismPair.createIndexes(), PlagiarismSetting.createIndexes(), StarterCode.createIndexes()]);
  let n = 0;
  for await (const d of CodeSubmission.find({ $or: [{ scopeKey: { $exists: false } }, { scopeKey: null }] }).select('problemId eventId').lean()) {
    const key = d.problemId ? `p:${d.problemId}` : d.eventId ? `e:${d.eventId}` : null;
    if (key) n += (await CodeSubmission.updateOne({ _id: d._id }, { $set: { scopeKey: key } })).modifiedCount;
  }
  n += (await CodeSubmission.updateMany({ $or: [{ checkStatus: { $exists: false } }, { checkStatus: null }] }, { $set: { checkStatus: 'pending' } })).modifiedCount;
  n += (await PlagiarismPair.updateMany({ $or: [{ status: { $exists: false } }, { status: null }] }, { $set: { status: 'clear' } })).modifiedCount;
  return n;
}

/**
 * S13: create ReviewRubric + Feedback collections and indexes; repair rows missing `status`, `generation.source` or totals.
 * Idempotent; a no-op on a fresh install.
 */
export async function migrateFeedback(): Promise<number> {
  await Promise.all([ReviewRubric.createIndexes(), Feedback.createIndexes()]);
  let n = 0;
  n += (await Feedback.updateMany({ $or: [{ status: { $exists: false } }, { status: null }] }, { $set: { status: 'draft' } })).modifiedCount;
  n += (await Feedback.updateMany({ 'generation.source': { $exists: false } }, { $set: { 'generation.source': 'manual' } })).modifiedCount;
  n += (await ReviewRubric.updateMany({ active: { $exists: false } }, { $set: { active: true } })).modifiedCount;
  for await (const d of ReviewRubric.find({ $or: [{ scopeKey: { $exists: false } }, { scopeKey: null }] }).select('problemId eventId').lean()) {
    const key = d.problemId ? `p:${d.problemId}` : d.eventId ? `e:${d.eventId}` : null;
    if (key) n += (await ReviewRubric.updateOne({ _id: d._id }, { $set: { scopeKey: key } })).modifiedCount;
  }
  return n;
}

/** S15: create the LeaderboardSetting collection + its unique index. Idempotent; a no-op on a fresh install. */
export async function migrateLeaderboard(): Promise<number> {
  await LeaderboardSetting.createIndexes();
  return 0;
}

/**
 * Real venues: rename the old demo venues in place so events and activities keep their venueId. If the target name already
 * exists, events/activities are repointed to it and the old venue is deleted. Idempotent; a no-op once nothing old is left.
 */
export const VENUE_RENAMES: { from: string; to: string; capacity: number }[] = [
  { from: 'Demo Hall', to: 'Main Auditorium', capacity: 300 },
  { from: 'Computer Lab 1', to: 'Room NB-408', capacity: 60 },
  { from: 'Seminar Room 2', to: 'Room NB-407', capacity: 60 },
];
export async function migrateRealVenues(): Promise<number> {
  let n = 0;
  for (const { from, to, capacity } of VENUE_RENAMES) {
    const old = await Venue.findOne({ name: from });
    if (!old) continue;
    const target = await Venue.findOne({ name: to });
    if (target) {
      await Event.updateMany({ venueId: old._id }, { $set: { venueId: target._id } });
      await Activity.updateMany({ venueId: old._id }, { $set: { venueId: target._id } });
      await Venue.deleteOne({ _id: old._id });
    } else {
      await Venue.updateOne({ _id: old._id }, { $set: { name: to, building: 'NB Building', capacity } });
    }
    n++;
  }
  return n;
}

/**
 * Team invitations v2: drop the old unique (teamId, inviteeId) index (it blocks e-mail-only invites), give every old row a slotKey,
 * and give pending rows a fresh 14-day expiry so nothing expires the moment this ships. Idempotent.
 */
export async function migrateInvitations(): Promise<number> {
  try {
    await Invitation.collection.dropIndex('teamId_1_inviteeId_1');
  } catch {
    /* already gone (fresh install) */
  }
  let n = 0;
  for await (const inv of Invitation.find({ slotKey: { $exists: false } }).select('teamId inviteeId inviteeEmail status')) {
    const who = inv.inviteeId ? `u:${String(inv.inviteeId)}` : `e:${inv.inviteeEmail ?? inv.id}`;
    n += (await Invitation.updateOne({ _id: inv._id }, { $set: { slotKey: `${String(inv.teamId)}:${who}` } })).modifiedCount;
  }
  n += (await Invitation.updateMany({ status: 'pending', expiresAt: { $exists: false } }, { $set: { expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000) } })).modifiedCount;
  await Invitation.createIndexes();
  return n;
}

/**
 * Contest teams used to be registered the moment they were created. Teams now stay drafts until the leader registers them, so every
 * team that already exists is grandfathered in as registered (at its creation time) and nobody loses access to a running contest.
 */
export async function migrateContestTeamRegistration(): Promise<number> {
  let n = 0;
  for await (const t of ContestTeam.find({ registeredAt: { $exists: false } }).select('createdAt')) {
    n += (await ContestTeam.updateOne({ _id: t._id, registeredAt: { $exists: false } }, { $set: { registeredAt: (t as unknown as { createdAt?: Date }).createdAt ?? new Date() } })).modifiedCount;
  }
  return n;
}

/** Ordered list of run-once migrations. Append new ones at the END and never edit or reorder an applied one. */
export const MIGRATIONS: { name: string; up: () => Promise<unknown> }[] = [
  { name: '2026-10-s2-audit-log-indexes-and-actor-names', up: migrateAuditLog },
  { name: '2026-10-s2-user-role-defaults', up: migrateUserRoles },
  { name: '2026-10-s3-notification-title-link', up: migrateNotifications },
  { name: '2026-10-s5-certificates-collection-and-indexes', up: migrateCertificates },
  { name: '2026-10-v4-certificates-kind-team-contest', up: migrateCertificatesV4 },
  { name: '2026-10-s7-sponsors-collections-and-indexes', up: migrateSponsors },
  { name: '2026-10-s11-plagiarism-collections-and-indexes', up: migratePlagiarism },
  { name: '2026-10-s13-feedback-collections-and-indexes', up: migrateFeedback },
  { name: '2026-10-s15-leaderboard-settings-index', up: migrateLeaderboard },
  { name: '2026-10-real-venues-rename', up: migrateRealVenues },
  { name: '2026-10-team-invitations-v2', up: migrateInvitations },
  { name: '2026-10-v6-certificate-template-options', up: migrateCertTemplatesV6 },
  { name: '2026-10-contest-team-registration', up: migrateContestTeamRegistration },
];

/** Start-up entry point (also `npm run migrate`): idempotent legacy migration first, then each unapplied run-once migration. */
export async function runMigrations(): Promise<string[]> {
  await migrateProblemLanguages();
  const done = new Set((await Migration.find().select('name')).map((m) => m.name));
  const ran: string[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await m.up();
    await Migration.updateOne({ name: m.name }, { $setOnInsert: { name: m.name, appliedAt: new Date() } }, { upsert: true });
    logger.info('migration applied', { name: m.name });
    ran.push(m.name);
  }
  return ran;
}
