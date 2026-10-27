import { describe, expect, it } from 'vitest';
import { canResend, checkAnswer, checkContestInvite, inviteSlotKey, MAX_PENDING_PER_TEAM, planAttach } from '../services/contest-invite-rules';

const NOW = new Date(Date.UTC(2026, 10, 1, 12, 0, 0));
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const base = { contestEndAt: days(1), memberCount: 1, maxSize: 3, livePendingCount: 0, now: NOW };

describe('checkContestInvite (contest teams)', () => {
  it('allows a first invite and renews a declined, cancelled or expired one', () => {
    expect(checkContestInvite(base)).toEqual({ ok: true, action: 'create' });
    expect(checkContestInvite({ ...base, existing: { status: 'declined' } })).toEqual({ ok: true, action: 'renew' });
    expect(checkContestInvite({ ...base, existing: { status: 'cancelled' } })).toEqual({ ok: true, action: 'renew' });
    expect(checkContestInvite({ ...base, existing: { status: 'expired' } })).toEqual({ ok: true, action: 'renew' });
    expect(checkContestInvite({ ...base, existing: { status: 'pending', expiresAt: days(-1) } })).toEqual({ ok: true, action: 'renew' });
  });
  it('rejects once the contest has ended (also exactly at the end time)', () => {
    expect(checkContestInvite({ ...base, contestEndAt: days(-1) })).toMatchObject({ ok: false, code: 'CONTEST_ENDED', status: 422 });
    expect(checkContestInvite({ ...base, contestEndAt: NOW })).toMatchObject({ ok: false, code: 'CONTEST_ENDED' });
  });
  it('enforces the maximum team size (422) and one team per contest (409)', () => {
    expect(checkContestInvite({ ...base, memberCount: 3 })).toMatchObject({ ok: false, code: 'TEAM_FULL', status: 422 });
    expect(checkContestInvite({ ...base, memberCount: 2 }).ok).toBe(true);
    expect(checkContestInvite({ ...base, inviteeOnTeam: true })).toMatchObject({ ok: false, code: 'ALREADY_ON_TEAM', status: 409 });
  });
  it('rejects a duplicate live invite and caps pending invites per team', () => {
    expect(checkContestInvite({ ...base, existing: { status: 'pending', expiresAt: days(5) } })).toMatchObject({ ok: false, code: 'DUPLICATE', status: 409 });
    expect(checkContestInvite({ ...base, livePendingCount: MAX_PENDING_PER_TEAM })).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' });
  });
});

describe('contest invite answers, attach and resend', () => {
  const me = { id: 'u1', email: 'Mate@Example.com' };
  it('only the invitee can answer a live pending invitation', () => {
    const inv = { status: 'pending', inviteeId: 'u1', expiresAt: days(3) };
    expect(checkAnswer(inv, me, NOW).ok).toBe(true);
    expect(checkAnswer(inv, { id: 'u2', email: 'x@y.z' }, NOW)).toMatchObject({ code: 'NOT_YOURS' });
    expect(checkAnswer({ ...inv, status: 'declined' }, me, NOW)).toMatchObject({ code: 'NOT_PENDING' });
    expect(checkAnswer({ ...inv, expiresAt: days(-1) }, me, NOW)).toMatchObject({ code: 'EXPIRED' });
  });
  it('attaches an e-mail-only invite by address after registration, one per team', () => {
    const c = (id: string, teamId: string, extra = {}) => ({ id, teamId, status: 'pending', inviteeEmail: 'new@x.io', expiresAt: days(5), ...extra });
    expect(planAttach([c('a', 't1'), c('b', 't1'), c('c', 't2', { expiresAt: days(-1) })], [], NOW)).toEqual({ attach: ['a'], drop: ['b'], expired: ['c'] });
    expect(checkAnswer({ status: 'pending', inviteeEmail: 'mate@example.com', expiresAt: days(2) }, me, NOW).ok).toBe(true);
    expect(inviteSlotKey('t1', { email: 'New@X.io' })).toBe('t1:e:new@x.io');
  });
  it('limits resends with a cooldown', () => {
    expect(canResend(new Date(NOW.getTime() - 5_000), NOW)).toBe(false);
    expect(canResend(new Date(NOW.getTime() - 40_000), NOW)).toBe(true);
  });
});
