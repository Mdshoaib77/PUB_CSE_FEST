import { describe, expect, it } from 'vitest';
import { canResend, checkAnswer, checkInvite, INVITE_TTL_MS, inviteExpiry, inviteSlotKey, isInviteExpired, MAX_PENDING_PER_TEAM, normalizeEmail, planAttach } from '../services/invite-rules';

const NOW = new Date(Date.UTC(2026, 10, 1, 12, 0, 0));
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const base = { memberCount: 1, maxSize: 3, livePendingCount: 0, now: NOW };

describe('invite expiry (14 days)', () => {
  it('expires 14 days after sending; boundary is expired', () => {
    expect(inviteExpiry(NOW).getTime() - NOW.getTime()).toBe(INVITE_TTL_MS);
    expect(isInviteExpired({ expiresAt: days(14) }, NOW)).toBe(false);
    expect(isInviteExpired({ expiresAt: days(-1) }, NOW)).toBe(true);
    expect(isInviteExpired({ expiresAt: NOW }, NOW)).toBe(true);
  });
  it('falls back to createdAt + 14 days for old rows, and never expires rows with no dates', () => {
    expect(isInviteExpired({ createdAt: days(-15) }, NOW)).toBe(true);
    expect(isInviteExpired({ createdAt: days(-13) }, NOW)).toBe(false);
    expect(isInviteExpired({}, NOW)).toBe(false);
  });
});

describe('checkInvite', () => {
  it('allows a first invite and renews an old one', () => {
    expect(checkInvite(base)).toEqual({ ok: true, action: 'create' });
    expect(checkInvite({ ...base, existing: { status: 'rejected' } })).toEqual({ ok: true, action: 'renew' });
    expect(checkInvite({ ...base, existing: { status: 'cancelled' } })).toEqual({ ok: true, action: 'renew' });
  });
  it('rejects a full team (422) and a person already in a team for the event (409)', () => {
    expect(checkInvite({ ...base, memberCount: 3 })).toMatchObject({ ok: false, code: 'TEAM_FULL', status: 422, message: 'The team is already full' });
    expect(checkInvite({ ...base, inviteeInEventTeam: true })).toMatchObject({ ok: false, code: 'ALREADY_IN_TEAM', status: 409 });
    expect(checkInvite({ ...base, inviteeInEventTeam: true, memberCount: 3 }).ok).toBe(false);
  });
  it('rejects a duplicate live invite, but an expired one can be renewed', () => {
    expect(checkInvite({ ...base, existing: { status: 'pending', expiresAt: days(5) } })).toMatchObject({ ok: false, code: 'DUPLICATE', status: 409 });
    expect(checkInvite({ ...base, existing: { status: 'pending', expiresAt: days(-1) } })).toEqual({ ok: true, action: 'renew' });
  });
  it('locks the roster once registered and caps pending invites per team', () => {
    expect(checkInvite({ ...base, rosterLocked: true })).toMatchObject({ ok: false, code: 'ROSTER_LOCKED', status: 422 });
    expect(checkInvite({ ...base, livePendingCount: MAX_PENDING_PER_TEAM })).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' });
    expect(checkInvite({ ...base, livePendingCount: MAX_PENDING_PER_TEAM - 1 }).ok).toBe(true);
  });
});

describe('checkAnswer', () => {
  const me = { id: 'u1', email: 'Mate@Example.com' };
  const pending = { status: 'pending', inviteeId: 'u1', expiresAt: days(3) };
  it('lets the invitee answer a live pending invite', () => expect(checkAnswer(pending, me, NOW)).toEqual({ ok: true }));
  it('refuses someone else, an answered invite and an expired invite', () => {
    expect(checkAnswer(pending, { id: 'u2', email: 'x@y.z' }, NOW)).toMatchObject({ ok: false, code: 'NOT_YOURS' });
    expect(checkAnswer({ ...pending, status: 'accepted' }, me, NOW)).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    expect(checkAnswer({ ...pending, expiresAt: days(-1) }, me, NOW)).toMatchObject({ ok: false, code: 'EXPIRED' });
  });
  it('matches an unattached e-mail invite by address (case-insensitive) only', () => {
    const byMail = { status: 'pending', inviteeEmail: 'mate@example.com', expiresAt: days(3) };
    expect(checkAnswer(byMail, me, NOW).ok).toBe(true);
    expect(checkAnswer(byMail, { id: 'u9', email: 'other@example.com' }, NOW)).toMatchObject({ ok: false, code: 'NOT_YOURS' });
  });
});

describe('unknown e-mail attach (planAttach)', () => {
  const c = (id: string, teamId: string, extra = {}) => ({ id, teamId, status: 'pending', inviteeEmail: 'new@x.io', expiresAt: days(5), ...extra });
  it('attaches live pending e-mail-only invites, one per team', () => {
    expect(planAttach([c('a', 't1'), c('b', 't2'), c('c', 't2')], [], NOW)).toEqual({ attach: ['a', 'b'], drop: ['c'], expired: [] });
  });
  it('skips expired, answered and already-attached rows; drops duplicates of teams the account already has', () => {
    const r = planAttach([c('a', 't1', { expiresAt: days(-2) }), c('b', 't2', { status: 'rejected' }), c('c', 't3', { inviteeId: 'u1' }), c('d', 't4')], ['t4'], NOW);
    expect(r).toEqual({ attach: [], drop: ['d'], expired: ['a'] });
  });
  it('normalises e-mails and builds distinct slot keys for accounts and e-mail-only invites', () => {
    expect(normalizeEmail('  New@X.io ')).toBe('new@x.io');
    expect(inviteSlotKey('t1', { email: 'New@X.io' })).toBe('t1:e:new@x.io');
    expect(inviteSlotKey('t1', { userId: 'u1', email: 'a@b.c' })).toBe('t1:u:u1');
  });
});

describe('canResend', () => {
  it('enforces a 30 second cooldown', () => {
    expect(canResend(undefined, NOW)).toBe(true);
    expect(canResend(new Date(NOW.getTime() - 5_000), NOW)).toBe(false);
    expect(canResend(new Date(NOW.getTime() - 31_000), NOW)).toBe(true);
  });
});
