/**
 * v7: presentation extras for the leaderboard, layered on top of `buildLeaderboard` (which is untouched):
 *  - `members`      team rows: member names, leader first (empty for individuals)
 *  - `isMine`       the row is the signed-in user's own (their own person row, or their team's row)
 *  - `certificate`  best VALID certificate of this row for the event (winner > runner-up > participation > ...), or null.
 *                   Staff (organiser / coordinator / admin) get it for every row; everyone else only for their own row, because
 *                   `GET /certificates/:id/download` allows exactly those two groups.
 */
import { CERTIFICATE_TYPE_LABELS, type CertificateType } from '@festhub/shared';
import { Certificate, Team, TeamMember, User } from '../models';
import type { LeaderboardEntryRow } from './leaderboard';

export interface RowCertificate { id: string; type: string; typeLabel: string; positionLabel: string | null }
export interface LeaderboardViewRow extends LeaderboardEntryRow {
  members: string[];
  isMine: boolean;
  certificate: RowCertificate | null;
}

const TYPE_PRIORITY: Record<string, number> = { winner: 0, runner_up: 1, participation: 2 };
const prio = (t: string) => TYPE_PRIORITY[t] ?? 9;

export async function enrichLeaderboardRows(rows: LeaderboardEntryRow[], eventId: string, viewerId: string, staff: boolean): Promise<LeaderboardViewRow[]> {
  const teamIds = rows.filter((r) => r.key.startsWith('t:')).map((r) => r.key.slice(2));
  const [teams, tms, mine, certs] = await Promise.all([
    teamIds.length ? Team.find({ _id: { $in: teamIds } }).select('leaderId').lean() : [],
    teamIds.length ? TeamMember.find({ teamId: { $in: teamIds } }).select('teamId userId').lean() : [],
    TeamMember.findOne({ eventId, userId: viewerId }).select('teamId').lean(),
    Certificate.find({ eventId, status: 'valid' }).select('certId type kind teamId userId recipients positionLabel issuedAt').lean(),
  ]);
  const users = tms.length ? await User.find({ _id: { $in: [...new Set(tms.map((m) => String(m.userId)))] } }).select('name').lean() : [];
  const nameOfUser = (id: string) => users.find((u) => String(u._id) === id)?.name ?? 'Member';
  const membersOf = (teamId: string) => {
    const leader = String(teams.find((t) => String(t._id) === teamId)?.leaderId ?? '');
    const ids = tms.filter((m) => String(m.teamId) === teamId).map((m) => String(m.userId));
    const ordered = [...ids.filter((i) => i === leader), ...ids.filter((i) => i !== leader)];
    return ordered.map(nameOfUser);
  };
  const myKeys = new Set([`u:${viewerId}`, ...(mine ? [`t:${mine.teamId}`] : [])]);

  return rows.map((r) => {
    const isTeam = r.key.startsWith('t:');
    const id = r.key.slice(2);
    const isMine = myKeys.has(r.key);
    let certificate: RowCertificate | null = null;
    if (staff || isMine) {
      const own = certs
        .filter((c) => (isTeam ? (c.kind ?? 'individual') === 'team' && String(c.teamId ?? '') === id : (c.kind ?? 'individual') === 'individual' && (String(c.userId) === id || (c.recipients ?? []).some((m) => String(m.userId) === id))))
        .sort((a, b) => prio(a.type) - prio(b.type) || +new Date(b.issuedAt as Date) - +new Date(a.issuedAt as Date));
      const c = own[0];
      if (c) certificate = { id: c.certId, type: c.type, typeLabel: CERTIFICATE_TYPE_LABELS[c.type as CertificateType] ?? c.type, positionLabel: c.positionLabel ?? null };
    }
    return { ...r, members: isTeam ? membersOf(id) : [], isMine, certificate };
  });
}
