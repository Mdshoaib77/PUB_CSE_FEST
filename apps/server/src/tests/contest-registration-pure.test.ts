import { describe, expect, it } from 'vitest';
import { registrationClosedMessage, registrationOpen, removalKeepsMinimum, teamIsRegistered, teamRegisterVerdict } from '../services/contest-registration';

const now = new Date('2026-10-28T10:00:00Z');
const at = (h: number) => new Date(now.getTime() + h * 3600_000);

describe('contest registration rules (pure)', () => {
  it('is open until the deadline, and until the contest ends when there is no deadline', () => {
    expect(registrationOpen({ endAt: at(5), registrationDeadline: at(1) }, now)).toBe(true);
    expect(registrationOpen({ endAt: at(5), registrationDeadline: at(-1) }, now)).toBe(false);
    expect(registrationOpen({ endAt: at(5) }, now)).toBe(true);
    expect(registrationOpen({ endAt: at(5), registrationDeadline: null }, now)).toBe(true);
    expect(registrationOpen({ endAt: at(-1) }, now)).toBe(false);
    expect(registrationClosedMessage({ endAt: at(-1) }, now)).toContain('ended');
    expect(registrationClosedMessage({ endAt: at(5), registrationDeadline: at(-1) }, now)).toContain('closed');
  });

  it('a team is registered only once registeredAt is set', () => {
    expect(teamIsRegistered({ registeredAt: now })).toBe(true);
    expect(teamIsRegistered({})).toBe(false);
    expect(teamIsRegistered(null)).toBe(false);
  });

  it('the leader can register only a complete, not yet registered team', () => {
    expect(teamRegisterVerdict({ memberCount: 2 }, 2)).toBeNull();
    expect(teamRegisterVerdict({ memberCount: 3 }, 2)).toBeNull();
    expect(teamRegisterVerdict({ memberCount: 1 }, 2)).toMatchObject({ status: 422 });
    expect(teamRegisterVerdict({ memberCount: 1 }, 2)!.message).toContain('at least 2');
    expect(teamRegisterVerdict({ memberCount: 2, registeredAt: now }, 2)).toMatchObject({ status: 409 });
  });

  it('a registered team cannot drop below the minimum, a draft can', () => {
    expect(removalKeepsMinimum({ memberCount: 2, registeredAt: now }, 2)).toBe(false);
    expect(removalKeepsMinimum({ memberCount: 3, registeredAt: now }, 2)).toBe(true);
    expect(removalKeepsMinimum({ memberCount: 2 }, 2)).toBe(true);
  });
});
