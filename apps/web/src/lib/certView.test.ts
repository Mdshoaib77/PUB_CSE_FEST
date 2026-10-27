import { describe, expect, it } from 'vitest';
import { certBadge, certFileName, certHolder, certMembers, certTone } from './certView';

const base = { id: 'FH-1', type: 'participation', typeLabel: 'Participation', eventTitle: 'E', eventDate: '2026-10-01' };
describe('certView helpers', () => {
  it('file name: FestHub-Certificate-<event>-<name>.pdf, safe characters only', () => {
    expect(certFileName('Hack-a-thon 2026', 'Team Alpha')).toBe('FestHub-Certificate-Hack-a-thon-2026-Team-Alpha.pdf');
    expect(certFileName('Café / Contest: "Final"', 'Zoë O\'Neil')).toBe('FestHub-Certificate-Cafe-Contest-Final-Zoe-O-Neil.pdf');
    expect(certFileName('', '\u09AC\u09BE\u0982\u09B2\u09BE')).toBe('FestHub-Certificate-Event-Participant.pdf');
    expect(certFileName('x'.repeat(100), 'y'.repeat(100)).length).toBeLessThan(120);
  });
  it('holder / members / badge / tone', () => {
    const team = { ...base, type: 'winner', typeLabel: 'Winner', kind: 'team' as const, teamName: 'Alpha', recipientName: 'Alpha', members: [{ name: 'A' }, 'B'], positionLabel: '1st Place - Poster' };
    expect(certHolder(team)).toBe('Alpha');
    expect(certMembers(team)).toEqual(['A', 'B']);
    expect(certBadge(team)).toBe('1st Place');
    expect(certTone(team)).toBe('gold');
    expect(certHolder({ ...base, recipientName: 'Rahim' })).toBe('Rahim');
    expect(certTone({ type: 'runner_up', positionLabel: null })).toBe('silver');
    expect(certTone({ type: 'winner', positionLabel: '3rd Place - X' })).toBe('gold');
    expect(certTone({ type: 'participation', positionLabel: '3rd Place - X' })).toBe('bronze');
    expect(certTone({ type: 'volunteer', positionLabel: null })).toBe('brand');
    expect(certBadge({ ...base, positionLabel: null })).toBe('Participation');
  });
});
