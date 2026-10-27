/**
 * S15: gathers the raw inputs for one event's leaderboard and hands them to the pure `computeLeaderboard` (packages/shared).
 * Nothing is stored: every call recomputes from
 *   - judge scores        Score (per judge, percent) of the event's Entries; entry mean -> participant mean
 *   - AI-suggested score  Feedback.total.percent of the participant's code submissions in the event (draft or published; see `aiCount`)
 *   - plagiarism          PlagiarismPair rows of the event with status 'confirmed' (both people in a pair are penalised; 'suspicious' never counts)
 * A participant is a person (`u:<id>`) or, when they belong to a team that has an Entry in the event, that team (`t:<id>`):
 * team members' feedback is averaged and pairs involving any member count once for the team.
 */
import { computeLeaderboard, withDefaults, type LeaderboardConfig, type LeaderboardInput, type LeaderboardRow } from '@festhub/shared';
import { Entry, Feedback, LeaderboardSetting, PlagiarismPair, Score, Team, TeamMember, User } from '../models';

export interface LeaderboardSettings extends LeaderboardConfig {
  published: boolean;
}
export interface LeaderboardEntryRow extends LeaderboardRow {
  kind: 'team' | 'person';
  /** how many judge scores / entries / feedback items fed the averages (transparency) */
  judgeScores: number;
  entries: number;
  feedbackCount: number;
}
export interface LeaderboardResult {
  eventId: string;
  settings: LeaderboardSettings;
  rows: LeaderboardEntryRow[];
  generatedAt: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export async function getSettings(eventId: string): Promise<LeaderboardSettings> {
  const d = await LeaderboardSetting.findOne({ eventId }).lean();
  const c = withDefaults(d ? { judgeWeight: d.judgeWeight, aiWeight: d.aiWeight, penaltyPerPair: d.penaltyPerPair, maxPenalty: d.maxPenalty, tieBreak: d.tieBreak as LeaderboardConfig['tieBreak'] } : {});
  return { ...c, published: !!d?.published };
}

export async function buildLeaderboard(eventId: string): Promise<LeaderboardResult> {
  const settings = await getSettings(eventId);
  const [entries, feedbacks, pairs] = await Promise.all([
    Entry.find({ eventId }).select('ownerKey ownerUserId teamId title').lean(),
    Feedback.find({ eventId }).select('userId total.percent').lean(),
    PlagiarismPair.find({ eventId, status: 'confirmed' }).select('aUserId bUserId').lean(),
  ]);
  const scores = entries.length ? await Score.find({ entryId: { $in: entries.map((e) => e._id) } }).select('entryId percent').lean() : [];

  // judge: mean over each entry's judges, then mean over the owner's entries
  const entryMean = new Map<string, number>();
  const judgeCount = new Map<string, number>();
  for (const e of entries) {
    const ps = scores.filter((s) => String(s.entryId) === String(e._id) && typeof s.percent === 'number').map((s) => s.percent as number);
    judgeCount.set(e.ownerKey, (judgeCount.get(e.ownerKey) ?? 0) + ps.length);
    const m = mean(ps);
    if (m !== null) entryMean.set(String(e._id), m);
  }
  const judgeByOwner = new Map<string, number[]>();
  const entriesByOwner = new Map<string, number>();
  for (const e of entries) {
    entriesByOwner.set(e.ownerKey, (entriesByOwner.get(e.ownerKey) ?? 0) + 1);
    const m = entryMean.get(String(e._id));
    if (m !== undefined) judgeByOwner.set(e.ownerKey, [...(judgeByOwner.get(e.ownerKey) ?? []), m]);
  }

  // map a user to their participant key
  const teamsWithEntry = new Set(entries.map((e) => (e.teamId ? String(e.teamId) : '')).filter(Boolean));
  const userIds = [...new Set([...feedbacks.map((f) => String(f.userId)), ...pairs.flatMap((p) => [String(p.aUserId), String(p.bUserId)])])];
  const memberships = userIds.length ? await TeamMember.find({ eventId, userId: { $in: userIds } }).select('userId teamId').lean() : [];
  const keyOf = (userId: string) => {
    const tm = memberships.find((m) => String(m.userId) === userId);
    return tm && teamsWithEntry.has(String(tm.teamId)) ? `t:${tm.teamId}` : `u:${userId}`;
  };

  const aiByOwner = new Map<string, number[]>();
  for (const f of feedbacks) {
    const pct = f.total?.percent;
    if (typeof pct !== 'number') continue;
    const k = keyOf(String(f.userId));
    aiByOwner.set(k, [...(aiByOwner.get(k) ?? []), pct]);
  }
  const pairsByOwner = new Map<string, Set<string>>();
  for (const p of pairs) {
    for (const uid of [String(p.aUserId), String(p.bUserId)]) {
      const k = keyOf(uid);
      (pairsByOwner.get(k) ?? pairsByOwner.set(k, new Set()).get(k)!).add(String(p._id)); // a pair inside one team counts once
    }
  }

  const keys = [...new Set([...entriesByOwner.keys(), ...aiByOwner.keys(), ...pairsByOwner.keys()])];
  const userKeys = keys.filter((k) => k.startsWith('u:')).map((k) => k.slice(2));
  const teamKeys = keys.filter((k) => k.startsWith('t:')).map((k) => k.slice(2));
  const [users, teams] = await Promise.all([
    userKeys.length ? User.find({ _id: { $in: userKeys } }).select('name').lean() : [],
    teamKeys.length ? Team.find({ _id: { $in: teamKeys } }).select('name').lean() : [],
  ]);
  const nameOf = (k: string) => (k.startsWith('t:') ? teams.find((t) => String(t._id) === k.slice(2))?.name : users.find((u) => String(u._id) === k.slice(2))?.name) ?? 'Unknown participant';

  const inputs: LeaderboardInput[] = keys.map((k) => ({
    key: k,
    name: nameOf(k),
    judgePercent: mean(judgeByOwner.get(k) ?? []),
    aiPercent: mean(aiByOwner.get(k) ?? []),
    confirmedPairs: pairsByOwner.get(k)?.size ?? 0,
  }));
  const rows: LeaderboardEntryRow[] = computeLeaderboard(inputs, settings).map((r) => ({
    ...r,
    kind: r.key.startsWith('t:') ? 'team' : 'person',
    judgeScores: judgeCount.get(r.key) ?? 0,
    entries: entriesByOwner.get(r.key) ?? 0,
    feedbackCount: aiByOwner.get(r.key)?.length ?? 0,
  }));
  return { eventId, settings, rows, generatedAt: new Date().toISOString() };
}
