import { Contest, ContestRegistration, ContestTeam } from '../models';

type ContestDoc = InstanceType<typeof Contest>;

// ---------------- pure rules (no DB) ----------------

/** Registration (solo register, create a team, join a team, accept an invite, register a team) is open until the deadline, and never after the contest ends. No deadline = open until the end. */
export const registrationOpen = (c: { endAt: Date; registrationDeadline?: Date | null }, now = new Date()): boolean => now < c.endAt && (!c.registrationDeadline || now < c.registrationDeadline);

/** Why registration is closed (for the error message). */
export const registrationClosedMessage = (c: { endAt: Date; registrationDeadline?: Date | null }, now = new Date()): string =>
  now >= c.endAt ? 'This contest has ended' : 'Registration for this contest is closed';

/** A team is registered once its leader registered it. Without that it is only a draft. */
export const teamIsRegistered = (t: { registeredAt?: Date | null } | null | undefined): boolean => !!t?.registeredAt;

/** Can the leader register this team now? null = yes. */
export function teamRegisterVerdict(t: { memberCount: number; registeredAt?: Date | null }, minSize: number): { status: 409 | 422; message: string } | null {
  if (t.registeredAt) return { status: 409, message: 'Your team is already registered for this contest' };
  if (t.memberCount < minSize) return { status: 422, message: `Your team needs at least ${minSize} member${minSize === 1 ? '' : 's'} before it can register (it has ${t.memberCount})` };
  return null;
}

/** A registered team may not drop below the minimum size: the leader must cancel the team registration first. */
export const removalKeepsMinimum = (t: { memberCount: number; registeredAt?: Date | null }, minSize: number): boolean => !t.registeredAt || t.memberCount - 1 >= minSize;

// ---------------- DB helpers ----------------

/** Ids (strings) of the teams of this contest that are registered. */
export async function registeredTeamIds(contestId: unknown): Promise<Set<string>> {
  const teams = await ContestTeam.find({ contestId, registeredAt: { $exists: true, $ne: null } }).select('_id');
  return new Set(teams.map((t) => String(t._id)));
}

/**
 * Is this person registered for the contest?
 * INDIVIDUAL: they have a registration row. TEAM: they are on a team and that team is registered (a draft team does not count).
 */
export async function isRegistered(c: ContestDoc, userId: string): Promise<boolean> {
  const reg = await ContestRegistration.findOne({ contestId: c._id, userId });
  if (!reg) return false;
  if ((c.mode ?? 'INDIVIDUAL') !== 'TEAM') return true;
  if (!reg.teamId) return false;
  return !!(await ContestTeam.exists({ _id: reg.teamId, registeredAt: { $exists: true, $ne: null } }));
}
