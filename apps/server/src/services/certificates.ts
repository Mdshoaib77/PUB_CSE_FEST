/** Certificate business logic (S5): eligibility, issuing, bulk generation, revoke, reissue. Routes in routes/certificates.ts. */
import crypto from 'crypto';
import {
  generateCertificateId,
  CERTIFICATE_TYPE_LABELS,
  certificateSlotKey,
  defaultPositionLabel,
  pickPlacings,
  snapshotRecipients,
  type CertificateKind,
  type CertificateRecipient,
  type CertificateType,
} from '@festhub/shared';
import { env } from '../config/env';
import { Activity, Certificate, CheckIn, Contest, ContestRegistration, ContestTeam, Registration, Result, ShiftAssignment, Team, TeamMember, User } from '../models';
import { buildScoreboard } from './scoreboard';
import { conflict, notFound, unprocessable } from '../utils/errors';
import { logAction } from '../utils/audit';
import { logger } from '../utils/logger';
import { notify } from './notify';

export const newCertId = () => generateCertificateId(crypto.randomBytes(12));
export const verifyUrlFor = (certId: string) => `${env.appUrl}/verify/${certId}`;
export const slotKeyOf = (eventId: unknown, userId: unknown, type: string, activityId?: unknown) => certificateSlotKey({ eventId, subjectId: userId, type, activityId });

export interface EventLike {
  id: string;
  title: string;
  startAt: Date;
  createdBy?: unknown;
}
/** What a certificate is issued for: an event, or a contest (then `id` is the contest's event, if it has one). */
export interface CertContext {
  id?: string;
  title: string;
  startAt: Date;
  createdBy?: unknown;
  /** Set for contest certificates: the contest id; `title` is then the contest title. */
  contestId?: string;
}
export interface Recipient {
  userId: string;
  position?: number;
  positionLabel?: string;
  activityId?: string;
}
interface IssueInput extends Recipient {
  event: CertContext;
  type: CertificateType;
  recipientName: string;
  signatureText?: string;
  issuedBy?: string;
  replacesId?: string;
  /** v4 TEAM certificate: ONE certificate for the team. `userId` = leader, `recipientName` = team name, `recipients` = snapshot (leader first). */
  kind?: CertificateKind;
  teamId?: string;
  teamName?: string;
  recipients?: CertificateRecipient[];
}

const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

/** Create one certificate. Returns the existing valid one (created=false) when the subject (person, or TEAM) already has it. Retries on the (astronomically unlikely) ID collision. */
export async function issueCertificate(i: IssueInput) {
  const kind: CertificateKind = i.kind === 'team' ? 'team' : 'individual';
  if (kind === 'team' && !i.teamId) throw new Error('A team certificate needs a teamId');
  const slotKey = certificateSlotKey({ eventId: i.event.id, contestId: i.event.contestId, kind, subjectId: kind === 'team' ? i.teamId : i.userId, type: i.type, activityId: i.activityId });
  const recipients = kind === 'team' ? snapshotRecipients(i.userId, i.recipients ?? []) : [{ userId: i.userId, name: i.recipientName }];
  const positionLabel = defaultPositionLabel(i.type, i.event.title, i.position, i.positionLabel);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const cert = await Certificate.create({
        certId: newCertId(),
        eventId: i.event.id || undefined,
        contestId: i.event.contestId,
        userId: i.userId,
        kind,
        teamId: kind === 'team' ? i.teamId : undefined,
        teamName: kind === 'team' ? (i.teamName ?? i.recipientName) : undefined,
        recipients,
        activityId: i.activityId,
        type: i.type,
        position: i.position,
        positionLabel,
        recipientName: i.recipientName,
        eventTitle: i.event.title,
        eventDate: i.event.startAt,
        signatureText: i.signatureText ?? env.certSignatureText,
        slotKey,
        issuedBy: i.issuedBy,
        replacesId: i.replacesId,
      });
      return { cert, created: true };
    } catch (e) {
      if (!isDup(e)) throw e;
      const existing = await Certificate.findOne({ slotKey });
      if (existing) return { cert: existing, created: false };
      // otherwise it was a certId collision: loop and draw a new ID
    }
  }
  throw new Error('Could not allocate a unique certificate ID');
}

/** Everyone who should be told about / may open a certificate: the snapshot members (team) or the single recipient. */
export const memberIdsOf = (c: { userId: unknown; recipients?: { userId: unknown }[] | null }): string[] => [...new Set([String(c.userId), ...(c.recipients ?? []).map((r) => String(r.userId))])];

const idsOf = (key: string) => (key.startsWith('u:') || key.startsWith('t:') ? [key.slice(2)] : []);

async function teamMembers(teamIds: string[]): Promise<string[]> {
  if (!teamIds.length) return [];
  return (await TeamMember.find({ teamId: { $in: teamIds } }).select('userId')).map((m) => String(m.userId));
}
/** Expand ownerKeys ('u:<id>' | 't:<id>') into user ids (team -> all its members). */
async function usersFromKeys(keys: string[]): Promise<string[]> {
  const users = keys.filter((k) => k.startsWith('u:')).flatMap(idsOf);
  const teams = keys.filter((k) => k.startsWith('t:')).flatMap(idsOf);
  return [...users, ...(await teamMembers(teams))];
}

async function attendedUserIds(eventId: string): Promise<Set<string>> {
  const rows = await CheckIn.find({ eventId }).select('subjectKey userId');
  const out = new Set<string>();
  for (const r of rows) if (r.userId) out.add(String(r.userId));
  for (const u of await usersFromKeys(rows.map((r) => String(r.subjectKey)))) out.add(u);
  return out;
}

export interface EligibilityOptions {
  /** participation/volunteer: only people who were checked in / marked present (default true). */
  attendedOnly: boolean;
}

/** Who is entitled to a certificate of `type` for this event (does not look at existing certificates). */
export async function recipientsFor(event: EventLike, type: CertificateType, o: EligibilityOptions): Promise<Recipient[]> {
  const uniq = (ids: string[]) => [...new Set(ids)].map((userId) => ({ userId }));
  switch (type) {
    case 'participation': {
      const regs = await Registration.find({ eventId: event.id, status: 'confirmed' }).select('userId teamId');
      const direct = regs.filter((r) => r.userId && !r.teamId).map((r) => String(r.userId));
      const viaTeam = await teamMembers(regs.filter((r) => r.teamId).map((r) => String(r.teamId)));
      let ids = [...direct, ...viaTeam];
      if (o.attendedOnly) {
        const here = await attendedUserIds(event.id);
        ids = ids.filter((u) => here.has(u));
      }
      return uniq(ids);
    }
    case 'winner':
    case 'runner_up': {
      const want = type === 'winner' ? 1 : 2;
      const acts = await Activity.find({ eventId: event.id, status: { $ne: 'cancelled' } }).select('title');
      const results = await Result.find({ activityId: { $in: acts.map((a) => a._id) }, status: 'official' });
      const out: Recipient[] = [];
      for (const res of results) {
        const act = acts.find((a) => String(a._id) === String(res.activityId));
        for (const rk of res.rankings.filter((x) => x.rank === want)) {
          for (const userId of new Set(await usersFromKeys([String(rk.ownerKey)])))
            out.push({ userId, position: want, activityId: String(res.activityId), positionLabel: defaultPositionLabel(type, act?.title ?? event.title, want) });
        }
      }
      return out;
    }
    case 'volunteer': {
      const rows = await ShiftAssignment.find({ eventId: event.id, status: 'assigned', ...(o.attendedOnly ? { attendance: 'present' } : {}) }).select('volunteerId');
      return uniq(rows.map((r) => String(r.volunteerId)));
    }
    case 'organizer':
      return event.createdBy ? uniq([String(event.createdBy)]) : [];
  }
}

/**
 * v4: who gets a certificate as ONE unit. `kind: 'individual'` -> `userId`; `kind: 'team'` -> one certificate for the team
 * (`memberIds` leader first, `userId` = leader). `recipientsFor` above is the old per-person view and is kept for compatibility.
 */
export interface Subject extends Recipient {
  kind: CertificateKind;
  teamId?: string;
  teamName?: string;
  memberIds?: string[];
}

/** Event teams -> { name, leader, members (leader first, then join order) }. */
async function eventTeamInfo(teamIds: string[]) {
  const out = new Map<string, { name: string; leaderId: string; memberIds: string[] }>();
  if (!teamIds.length) return out;
  const [teams, members] = await Promise.all([Team.find({ _id: { $in: teamIds } }).select('name leaderId'), TeamMember.find({ teamId: { $in: teamIds } }).sort({ _id: 1 }).select('teamId userId')]);
  for (const t of teams) {
    const ids = members.filter((m) => String(m.teamId) === t.id).map((m) => String(m.userId));
    const leaderId = String(t.leaderId);
    out.set(t.id, { name: t.name, leaderId, memberIds: [...new Set([leaderId, ...ids])] });
  }
  return out;
}
const asTeamSubject = (teamId: string, t: { name: string; leaderId: string; memberIds: string[] }, extra: Partial<Recipient> = {}): Subject => ({ kind: 'team', teamId, teamName: t.name, userId: t.leaderId, memberIds: t.memberIds, ...extra });

/** Event subjects: participation / winner / runner-up are team-aware (ONE certificate per team); volunteer / organizer stay individual. */
export async function subjectsFor(event: EventLike, type: CertificateType, o: EligibilityOptions): Promise<Subject[]> {
  if (type === 'volunteer' || type === 'organizer') return (await recipientsFor(event, type, o)).map((r) => ({ ...r, kind: 'individual' as const }));
  const out: Subject[] = [];
  if (type === 'participation') {
    const regs = await Registration.find({ eventId: event.id, status: 'confirmed' }).select('userId teamId');
    const here = o.attendedOnly ? await attendedUserIds(event.id) : null;
    const direct = [...new Set(regs.filter((r) => r.userId && !r.teamId).map((r) => String(r.userId)))].filter((u) => !here || here.has(u));
    for (const userId of direct) out.push({ userId, kind: 'individual' });
    const teamIds = [...new Set(regs.filter((r) => r.teamId).map((r) => String(r.teamId)))];
    const info = await eventTeamInfo(teamIds);
    for (const [teamId, t] of info) if (!here || t.memberIds.some((m) => here.has(m))) out.push(asTeamSubject(teamId, t)); // a team counts as present when any member checked in
    return out;
  }
  const want = type === 'winner' ? 1 : 2;
  const acts = await Activity.find({ eventId: event.id, status: { $ne: 'cancelled' } }).select('title');
  const results = await Result.find({ activityId: { $in: acts.map((a) => a._id) }, status: 'official' });
  const teamIds = results.flatMap((res) => res.rankings.filter((x) => x.rank === want && String(x.ownerKey).startsWith('t:')).map((x) => String(x.ownerKey).slice(2)));
  const info = await eventTeamInfo([...new Set(teamIds)]);
  for (const res of results) {
    const act = acts.find((a) => String(a._id) === String(res.activityId));
    const meta = { position: want, activityId: String(res.activityId), positionLabel: defaultPositionLabel(type, act?.title ?? event.title, want) };
    for (const rk of res.rankings.filter((x) => x.rank === want)) {
      const key = String(rk.ownerKey);
      if (key.startsWith('t:')) {
        const t = info.get(key.slice(2));
        if (t) out.push(asTeamSubject(key.slice(2), t, meta));
      } else if (key.startsWith('u:')) out.push({ userId: key.slice(2), kind: 'individual', ...meta });
    }
  }
  return out;
}

/** Contest subjects. participation: every registered person (INDIVIDUAL) / team (TEAM). winner / runner_up: rank 1 / 2 on the FINAL (unfrozen) scoreboard. */
export async function contestSubjectsFor(contest: InstanceType<typeof Contest>, type: CertificateType): Promise<Subject[]> {
  const regs = await ContestRegistration.find({ contestId: contest._id }).sort({ _id: 1 }).select('userId teamId');
  const allTeamIds = [...new Set(regs.filter((r) => r.teamId).map((r) => String(r.teamId)))];
  const allTeams = allTeamIds.length ? await ContestTeam.find({ _id: { $in: allTeamIds } }).select('name leaderId registeredAt') : [];
  // a draft team (never registered) took no part in the contest: no certificate
  const teams = allTeams.filter((t) => !!t.registeredAt);
  const teamIds = teams.map((t) => t.id);
  const asTeam = (teamId: string, extra: Partial<Recipient> = {}): Subject | null => {
    const t = teams.find((x) => x.id === teamId);
    if (!t) return null;
    const leaderId = String(t.leaderId);
    const members = regs.filter((r) => String(r.teamId) === teamId).map((r) => String(r.userId));
    return asTeamSubject(teamId, { name: t.name, leaderId, memberIds: [...new Set([leaderId, ...members])] }, extra);
  };
  const team = contest.mode === 'TEAM';
  if (type === 'participation') {
    const out: Subject[] = [];
    for (const r of regs.filter((x) => !team || !x.teamId)) out.push({ userId: String(r.userId), kind: 'individual' });
    if (team) for (const id of teamIds) { const t = asTeam(id); if (t) out.push(t); }
    return out;
  }
  if (type !== 'winner' && type !== 'runner_up') return [];
  const board = await buildScoreboard(contest, { privileged: true });
  const placed = pickPlacings(board.rows.map((r) => ({ id: r.userId, rank: r.rank, solved: r.solved }))); // TEAM mode: row.userId is the team id
  const position = type === 'winner' ? 1 : 2;
  const meta = { position, positionLabel: defaultPositionLabel(type, contest.title, position) };
  const out: Subject[] = [];
  for (const row of placed[type]) {
    if (team) { const t = asTeam(row.id, meta); if (t) out.push(t); }
    else out.push({ userId: row.id, kind: 'individual', ...meta });
  }
  return out;
}

type Actor = { id: string; name?: string };
/** Issue the missing certificates for a list of subjects (shared by event and contest bulk). Idempotent: an existing valid slot is skipped. */
async function issueSubjects(ctx: CertContext, type: CertificateType, subjects: Subject[], signatureText: string | undefined, actor: Actor, bucket: { created: number; skipped: number }, summary: BulkSummary) {
  const wanted = new Set<string>();
  for (const x of subjects) {
    wanted.add(x.userId);
    for (const m of x.memberIds ?? []) wanted.add(m);
  }
  const users = await User.find({ _id: { $in: [...wanted] } }).select('name');
  const names = new Map(users.map((u) => [u.id as string, u.name]));
  for (const x of subjects) {
    let r;
    if (x.kind === 'team') {
      const members = snapshotRecipients(x.userId, (x.memberIds ?? []).flatMap((id) => (names.get(id) ? [{ userId: id, name: names.get(id)! }] : [])));
      if (!members.length || !x.teamName) continue; // nobody left to certify
      r = await issueCertificate({ ...x, event: ctx, type, userId: members[0].userId /* leader, or first remaining member if the leader's account is gone */, recipientName: x.teamName, recipients: members, signatureText, issuedBy: actor.id });
    } else {
      const name = names.get(x.userId);
      if (!name) continue; // deleted account
      r = await issueCertificate({ ...x, event: ctx, type, recipientName: name, signatureText, issuedBy: actor.id });
    }
    if (!r.created) {
      bucket.skipped++;
      summary.skipped++;
      continue;
    }
    bucket.created++;
    summary.created++;
    await notifyIssued(r.cert);
  }
}

export interface BulkSummary {
  created: number;
  skipped: number;
  byType: Record<string, { created: number; skipped: number }>;
}

/** Issue every missing certificate of the requested types for an event. Idempotent: re-running only fills gaps. TEAM registrations/results get ONE certificate per team. */
export async function bulkGenerate(
  event: EventLike,
  types: CertificateType[],
  o: EligibilityOptions & { signatureText?: string },
  actor: Actor,
): Promise<BulkSummary> {
  const summary: BulkSummary = { created: 0, skipped: 0, byType: {} };
  for (const type of types) {
    const bucket = (summary.byType[type] = { created: 0, skipped: 0 });
    await issueSubjects(event, type, await subjectsFor(event, type, o), o.signatureText, actor, bucket, summary);
  }
  await logAction(actor, 'certificate.bulk_generate', { type: 'Event', id: event.id }, { types, attendedOnly: o.attendedOnly, created: summary.created, skipped: summary.skipped });
  return summary;
}

export const CONTEST_CERT_TYPES = ['participation', 'winner', 'runner_up'] as const;
export const contestContext = (c: InstanceType<typeof Contest>): CertContext => ({ id: c.eventId ? String(c.eventId) : undefined, title: c.title, startAt: c.startAt, createdBy: c.createdBy, contestId: c.id });

/** Bulk certificates for a programming contest (participation for every registered person/team; winner + runner-up from the final scoreboard). Idempotent. The contest must have ended. */
export async function bulkGenerateContest(contest: InstanceType<typeof Contest>, types: CertificateType[], o: { signatureText?: string }, actor: Actor): Promise<BulkSummary> {
  if (new Date() < contest.endAt) throw unprocessable('Contest certificates can only be generated after the contest has ended');
  const ctx = contestContext(contest);
  const summary: BulkSummary = { created: 0, skipped: 0, byType: {} };
  for (const type of types.filter((t) => (CONTEST_CERT_TYPES as readonly string[]).includes(t))) {
    const bucket = (summary.byType[type] = { created: 0, skipped: 0 });
    await issueSubjects(ctx, type, await contestSubjectsFor(contest, type), o.signatureText, actor, bucket, summary);
  }
  await logAction(actor, 'certificate.bulk_generate', { type: 'Contest', id: contest.id }, { types, created: summary.created, skipped: summary.skipped });
  return summary;
}

async function safeNotify(userId: unknown, title: string, message: string) {
  try {
    await notify(userId, title, message, '/certificates');
  } catch (e) {
    logger.warn('certificate notification failed', { message: (e as Error).message });
  }
}
type NotifiableCert = { userId: unknown; recipients?: { userId: unknown }[] | null; kind?: string | null; teamName?: string | null; type: string; eventTitle: string; certId: string };
/** Tell EVERY member (team certificate) or the single recipient. A failing notification never fails the operation. */
async function notifyMembers(c: NotifiableCert, title: string, message: (who: string) => string) {
  const who = c.kind === 'team' ? `team "${c.teamName ?? ''}"` : 'you';
  for (const id of memberIdsOf(c)) await safeNotify(id, title, message(who));
}
export const notifyIssued = (c: NotifiableCert) =>
  notifyMembers(c, 'Certificate issued', (who) => `${who === 'you' ? 'Your' : `The ${who}'s`} ${CERTIFICATE_TYPE_LABELS[c.type as CertificateType] ?? c.type} certificate for "${c.eventTitle}" is ready (ID ${c.certId}).`);

/** Atomic valid -> revoked transition (frees the unique slot). Throws 409 if it was not valid. No log, no notification. */
async function revokeCore(certId: string, actor: { id: string }, reason: string) {
  const cert = await Certificate.findOne({ certId });
  if (!cert) throw notFound('Certificate not found');
  const done = await Certificate.findOneAndUpdate(
    { _id: cert._id, status: 'valid' },
    { $set: { status: 'revoked', slotKey: `x:${cert.certId}`, revokedAt: new Date(), revokedBy: actor.id, revokeReason: reason } },
    { new: true },
  );
  if (!done) throw conflict('Certificate is already revoked');
  return done;
}

export async function revokeCertificate(certId: string, actor: { id: string; name?: string }, reason: string) {
  const done = await revokeCore(certId, actor, reason);
  await logAction(actor, 'certificate.revoke', { type: 'Certificate', id: certId }, { reason, userId: String(done.userId), eventId: done.eventId ? String(done.eventId) : undefined, contestId: done.contestId ? String(done.contestId) : undefined, members: memberIdsOf(done).length });
  await notifyMembers(done, 'Certificate revoked', (who) => `${who === 'you' ? 'Your' : `The ${who}'s`} certificate ${certId} for "${done.eventTitle}" was revoked${reason ? `: ${reason}` : '.'}`);
  return done;
}

/** Replace a certificate with a fresh one (new ID). Individual: current name/event details. TEAM: the member snapshot is KEPT as issued. The old ID stays on record as revoked and points to its replacement. */
export async function reissueCertificate(certId: string, event: CertContext, actor: { id: string; name?: string }, reason: string) {
  const old = await Certificate.findOne({ certId });
  if (!old) throw notFound('Certificate not found');
  if (old.replacedById) throw conflict(`Certificate was already reissued as ${old.replacedById}`);
  const team = old.kind === 'team';
  let name = old.recipientName;
  if (!team) {
    const user = await User.findById(old.userId).select('name');
    if (!user) throw conflict('The recipient account no longer exists');
    name = user.name;
  }
  const wasValid = old.status === 'valid';
  const oldSlot = old.slotKey;
  if (wasValid) await revokeCore(certId, actor, reason || 'Reissued');
  try {
    const { cert, created } = await issueCertificate({
      event,
      userId: String(old.userId),
      type: old.type as CertificateType,
      activityId: old.activityId ? String(old.activityId) : undefined,
      position: old.position ?? undefined,
      positionLabel: old.positionLabel ?? undefined,
      recipientName: name,
      kind: team ? 'team' : 'individual',
      teamId: old.teamId ? String(old.teamId) : undefined,
      teamName: old.teamName ?? undefined,
      recipients: (old.recipients ?? []).map((r) => ({ userId: String(r.userId), name: r.name })),
      signatureText: old.signatureText || undefined,
      issuedBy: actor.id,
      replacesId: certId,
    });
    if (!created) throw conflict(team ? 'A valid certificate already exists for this team' : 'A valid certificate already exists for this person');
    await Certificate.updateOne({ _id: old._id }, { $set: { replacedById: cert.certId } });
    await logAction(actor, 'certificate.reissue', { type: 'Certificate', id: cert.certId }, { replaces: certId, reason });
    await notifyMembers(cert, 'Certificate reissued', (who) => `A new certificate (ID ${cert.certId}) was issued for ${who === 'you' ? '' : `${who} - `}"${cert.eventTitle}". The previous ID ${certId} is no longer valid.`);
    return cert;
  } catch (e) {
    if (wasValid) await Certificate.updateOne({ _id: old._id }, { $set: { status: 'valid', slotKey: oldSlot }, $unset: { revokedAt: 1, revokedBy: 1, revokeReason: 1 } }); // roll back: never leave the person with nothing
    throw e;
  }
}
