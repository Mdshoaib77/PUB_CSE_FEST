/**
 * S16 "My Achievements": everything one signed-in user has earned, read from existing collections.
 *  - certificates: own VALID certificates
 *  - feedback: own PUBLISHED feedback only (drafts never leave the staff side, as in S13)
 *  - results: rank/score per event, but only for events whose leaderboard an organiser has published (S15); the rank is the user's
 *    own row (or their team's), computed by the same buildLeaderboard the leaderboard page uses.
 */
import { CERTIFICATE_TYPE_LABELS, type CertificateType } from '@festhub/shared';
import { Certificate, Entry, Event, Feedback, LeaderboardSetting, TeamMember } from '../models';
import { buildLeaderboard } from './leaderboard';
import { verifyUrlFor } from './certificates';

export async function buildAchievements(userId: string) {
  const [certs, fbs, tms, ownEntries] = await Promise.all([
    Certificate.find({ $or: [{ userId }, { 'recipients.userId': userId }], status: 'valid' }).sort({ issuedAt: -1 }).limit(200).lean(),
    Feedback.find({ userId, status: 'published' }).sort({ publishedAt: -1 }).limit(200).lean(),
    TeamMember.find({ userId }).select('teamId eventId').lean(),
    Entry.find({ ownerUserId: userId }).select('eventId').lean(),
  ]);
  const teamEntries = tms.length ? await Entry.find({ teamId: { $in: tms.map((t) => t.teamId) } }).select('eventId teamId').lean() : [];
  const candidate = new Set<string>([...ownEntries.map((e) => String(e.eventId)), ...teamEntries.map((e) => String(e.eventId)), ...fbs.map((f) => String(f.eventId ?? '')).filter(Boolean)]);
  const published = candidate.size ? await LeaderboardSetting.find({ eventId: { $in: [...candidate] }, published: true }).select('eventId').lean() : [];
  const teamIds = new Set(teamEntries.map((e) => String(e.teamId)));
  const myKeys = new Set([`u:${userId}`, ...[...teamIds].map((t) => `t:${t}`)]);

  const eventIds = [...new Set([...published.map((p) => String(p.eventId)), ...certs.map((c) => (c.eventId ? String(c.eventId) : '')).filter(Boolean), ...fbs.map((f) => String(f.eventId ?? '')).filter(Boolean)])];
  const events = eventIds.length ? await Event.find({ _id: { $in: eventIds } }).select('title startAt').lean() : [];
  const title = (id: unknown) => events.find((e) => String(e._id) === String(id))?.title ?? 'Event';

  const results = [];
  for (const p of published) {
    const lb = await buildLeaderboard(String(p.eventId));
    const row = lb.rows.find((r) => myKeys.has(r.key));
    if (!row) continue;
    results.push({
      eventId: String(p.eventId), eventTitle: title(p.eventId), participant: row.name, kind: row.kind,
      rank: row.rank, tied: row.tied, ranked: lb.rows.filter((r) => r.rank !== null).length,
      final: row.final, judgePercent: row.judgePercent, aiPercent: row.aiPercent, penalty: row.penalty,
    });
  }
  return {
    certificates: certs.map((c) => ({
      id: c.certId, type: c.type, typeLabel: CERTIFICATE_TYPE_LABELS[c.type as CertificateType], eventTitle: c.eventTitle, eventDate: c.eventDate, positionLabel: c.positionLabel ?? null, issuedAt: c.issuedAt, verifyUrl: verifyUrlFor(c.certId),
      // v7: who the certificate is for (team name + every member, leader first, or the individual)
      kind: (c.kind ?? 'individual') as 'individual' | 'team', recipientName: c.recipientName, teamName: c.kind === 'team' ? (c.teamName ?? c.recipientName) : null, members: c.kind === 'team' ? (c.recipients ?? []).map((m) => m.name) : [],
    })),
    feedback: fbs.map((f) => ({ id: String(f._id), eventId: f.eventId ? String(f.eventId) : null, eventTitle: f.eventId ? title(f.eventId) : null, percent: f.total?.percent ?? 0, points: f.total?.points ?? 0, maxPoints: f.total?.maxPoints ?? 0, rating: f.quality?.rating ?? null, summary: f.quality?.summary ?? '', publishedAt: f.publishedAt ?? null })),
    results,
    summary: { certificates: certs.length, feedback: fbs.length, events: results.length, bestRank: results.reduce<number | null>((m, r) => (r.rank !== null && (m === null || r.rank < m) ? r.rank : m), null) },
  };
}

export type Achievements = Awaited<ReturnType<typeof buildAchievements>>;
