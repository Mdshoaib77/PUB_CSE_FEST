import { describe, expect, it } from 'vitest';
import {
  buildVerification,
  certificateSlotKey,
  defaultPositionLabel,
  generateCertificateId,
  pickPlacings,
  positionLabelFor,
  snapshotRecipients,
  verificationVerdict,
} from '@festhub/shared';

const U = (id: string, name: string) => ({ userId: id, name });

describe('certificate slot keys (pure, no DB)', () => {
  it('keeps the S5 format for an individual event certificate (old rows stay valid)', () => {
    expect(certificateSlotKey({ eventId: 'E1', subjectId: 'U1', type: 'participation' })).toBe('E1:U1:participation:');
    expect(certificateSlotKey({ eventId: 'E1', subjectId: 'U1', type: 'winner', activityId: 'A1' })).toBe('E1:U1:winner:A1');
  });
  it('a TEAM slot is per team: the same team always maps to the same slot, whoever the leader is', () => {
    const a = certificateSlotKey({ eventId: 'E1', kind: 'team', subjectId: 'T1', type: 'participation' });
    expect(a).toBe(certificateSlotKey({ eventId: 'E1', kind: 'team', subjectId: 'T1', type: 'participation' }));
    expect(a).not.toBe(certificateSlotKey({ eventId: 'E1', kind: 'team', subjectId: 'T2', type: 'participation' }));
  });
  it('team vs individual never collide, even when the ids are equal', () => {
    expect(certificateSlotKey({ eventId: 'E1', kind: 'team', subjectId: 'X', type: 'winner' })).not.toBe(certificateSlotKey({ eventId: 'E1', kind: 'individual', subjectId: 'X', type: 'winner' }));
  });
  it('type and activity separate slots', () => {
    const k = (type: string, activityId?: string) => certificateSlotKey({ eventId: 'E', kind: 'team', subjectId: 'T', type, activityId });
    expect(new Set([k('participation'), k('winner'), k('winner', 'A1'), k('winner', 'A2')]).size).toBe(4);
  });
  it('contest slots are separate from event slots and per team / per user', () => {
    const base = { contestId: 'C1', type: 'participation' };
    const t = certificateSlotKey({ ...base, kind: 'team', subjectId: 'T1' });
    const u = certificateSlotKey({ ...base, kind: 'individual', subjectId: 'T1' });
    expect(t).toBe('c:C1:t:T1:participation');
    expect(u).toBe('c:C1:u:T1:participation');
    expect(t).not.toBe(certificateSlotKey({ eventId: 'C1', kind: 'team', subjectId: 'T1', type: 'participation' }));
    expect(t).not.toBe(certificateSlotKey({ ...base, contestId: 'C2', kind: 'team', subjectId: 'T1' }));
  });
});

describe('team member snapshot (pure)', () => {
  it('puts the leader first and keeps the rest in the given order', () => {
    const r = snapshotRecipients('L', [U('A', 'Ann'), U('L', 'Lee'), U('B', 'Bob')]);
    expect(r.map((x) => x.name)).toEqual(['Lee', 'Ann', 'Bob']);
  });
  it('drops duplicates and nameless entries, trims names', () => {
    const r = snapshotRecipients('L', [U('L', ' Lee '), U('A', 'Ann'), U('A', 'Ann again'), U('B', '  ')]);
    expect(r).toEqual([U('L', 'Lee'), U('A', 'Ann')]);
  });
  it('works when the leader is not among the members (account gone): members keep their order', () => {
    expect(snapshotRecipients('GONE', [U('A', 'Ann'), U('B', 'Bob')]).map((x) => x.userId)).toEqual(['A', 'B']);
  });
  it('supports 3 and 5 member teams', () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((i) => U(i, `P${i}`));
    expect(snapshotRecipients('C', five.slice(0, 3))).toHaveLength(3);
    const r = snapshotRecipients('C', five);
    expect(r).toHaveLength(5);
    expect(r[0].userId).toBe('C');
  });
  it('is a snapshot: later changes to the source array do not change the result', () => {
    const src = [U('L', 'Lee'), U('A', 'Ann')];
    const snap = snapshotRecipients('L', src);
    src[1].name = 'Renamed';
    src.push(U('Z', 'New member'));
    expect(snap.map((x) => x.name)).toEqual(['Lee', 'Ann']);
  });
});

describe('position labels (pure)', () => {
  it('formats ordinals', () => {
    expect(positionLabelFor(1, 'Poster Round')).toBe('1st Place - Poster Round');
    expect(positionLabelFor(2, 'CodeStorm')).toBe('2nd Place - CodeStorm');
    expect(positionLabelFor(3, 'X')).toBe('3rd Place - X');
  });
  it('is always filled for winner / runner-up (contest name included), even for a blank title', () => {
    expect(defaultPositionLabel('winner', 'PUB CodeStorm Programming Contest')).toBe('1st Place - PUB CodeStorm Programming Contest');
    expect(defaultPositionLabel('runner_up', 'PUB CodeStorm Programming Contest')).toBe('2nd Place - PUB CodeStorm Programming Contest');
    expect(defaultPositionLabel('winner', '  ')).toBe('1st Place - Event');
  });
  it('an explicit label wins; participation has none', () => {
    expect(defaultPositionLabel('winner', 'T', 1, 'Grand Champion')).toBe('Grand Champion');
    expect(defaultPositionLabel('participation', 'T')).toBeUndefined();
  });
});

describe('contest placings from the final scoreboard (pure)', () => {
  it('rank 1 = winner, rank 2 = runner-up', () => {
    const p = pickPlacings([{ id: 'a', rank: 1, solved: 4 }, { id: 'b', rank: 2, solved: 3 }, { id: 'c', rank: 3, solved: 1 }]);
    expect(p.winner.map((x) => x.id)).toEqual(['a']);
    expect(p.runner_up.map((x) => x.id)).toEqual(['b']);
  });
  it('a tie for 1st shares the title and leaves no rank 2', () => {
    const p = pickPlacings([{ id: 'a', rank: 1, solved: 2 }, { id: 'b', rank: 1, solved: 2 }, { id: 'c', rank: 3, solved: 1 }]);
    expect(p.winner.map((x) => x.id)).toEqual(['a', 'b']);
    expect(p.runner_up).toEqual([]);
  });
  it('rows that solved nothing never get a place', () => {
    const p = pickPlacings([{ id: 'a', rank: 1, solved: 0 }, { id: 'b', rank: 2, solved: 0 }]);
    expect(p.winner).toEqual([]);
    expect(p.runner_up).toEqual([]);
  });
});

describe('verify output (pure)', () => {
  const base = { certId: generateCertificateId(new Uint8Array(12).fill(7)), status: 'valid', type: 'participation', eventTitle: 'Hack', eventDate: new Date('2026-10-01T00:00:00Z'), issuedAt: new Date('2026-10-02T00:00:00Z') };
  it('team certificate: team name and ALL members, leader first', () => {
    const v = buildVerification({ ...base, kind: 'team', recipientName: 'Alpha', teamName: 'Alpha', recipients: [{ name: 'Lee' }, { name: 'Ann' }, { name: 'Bob' }] });
    expect(v.status).toBe('valid');
    expect(v.kind).toBe('team');
    expect(v.teamName).toBe('Alpha');
    expect(v.members).toEqual(['Lee', 'Ann', 'Bob']);
    expect(v.typeLabel).toBe('Participation');
  });
  it('individual certificate: recipient name, no team fields (old documents without kind work)', () => {
    const v = buildVerification({ ...base, recipientName: 'Ann' });
    expect(v.kind).toBe('individual');
    expect(v.recipientName).toBe('Ann');
    expect(v.teamName).toBeUndefined();
    expect(v.members).toBeUndefined();
  });
  it('contest certificate shows the contest and the position label', () => {
    const v = buildVerification({ ...base, type: 'runner_up', recipientName: 'Ann', contestTitle: 'CodeStorm', positionLabel: '2nd Place - CodeStorm' });
    expect(v.contestTitle).toBe('CodeStorm');
    expect(v.positionLabel).toBe('2nd Place - CodeStorm');
  });
  it('revoked team certificate keeps the members and points to its replacement', () => {
    const v = buildVerification({ ...base, status: 'revoked', kind: 'team', recipientName: 'Alpha', teamName: 'Alpha', recipients: [{ name: 'Lee' }], revokedAt: new Date('2026-10-03T00:00:00Z'), replacedById: 'FH-NEW' });
    expect(v.status).toBe('revoked');
    expect(v.members).toEqual(['Lee']);
    expect(v.replacedBy).toBe('FH-NEW');
    expect(v.revokedAt).toBe('2026-10-03T00:00:00.000Z');
  });
  it('unknown / mistyped ids stay not_found', () => {
    expect(verificationVerdict('nonsense', null)).toBe('not_found');
    expect(verificationVerdict(base.certId, null)).toBe('not_found');
    expect(verificationVerdict(base.certId, { status: 'valid' })).toBe('valid');
  });
});
