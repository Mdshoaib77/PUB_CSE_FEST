import { describe, expect, it } from 'vitest';
import { isDuplicateVenueName, venueInputSchema, venueNameKey } from '../services/venue-rules';

describe('venue input rules (pure)', () => {
  it('capacity and building are optional', () => {
    const r = venueInputSchema.parse({ name: 'Open Lawn' });
    expect(r).toEqual({ name: 'Open Lawn' });
    expect('capacity' in r).toBe(false);
    expect('building' in r).toBe(false);
  });
  it('empty / null capacity and building mean "not set" and are not validated', () => {
    expect(venueInputSchema.parse({ name: 'Open Lawn', capacity: '', building: '  ' })).toEqual({ name: 'Open Lawn' });
    expect(venueInputSchema.parse({ name: 'Open Lawn', capacity: null, building: null })).toEqual({ name: 'Open Lawn' });
  });
  it('accepts a numeric capacity (number or string) and rejects bad ones', () => {
    expect(venueInputSchema.parse({ name: 'Hall B', capacity: '120' }).capacity).toBe(120);
    expect(venueInputSchema.parse({ name: 'Hall B', capacity: 40 }).capacity).toBe(40);
    for (const capacity of [0, -3, 2.5, 'abc', 1_000_000]) expect(venueInputSchema.safeParse({ name: 'Hall B', capacity }).success).toBe(false);
  });
  it('trims the name and building', () => {
    expect(venueInputSchema.parse({ name: '   Seminar Hall  ', building: '  Block C ' })).toEqual({ name: 'Seminar Hall', building: 'Block C' });
  });
  it('name is required, min 2, max 80', () => {
    expect(venueInputSchema.safeParse({}).success).toBe(false);
    expect(venueInputSchema.safeParse({ name: ' a ' }).success).toBe(false);
    expect(venueInputSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(venueInputSchema.safeParse({ name: 'x'.repeat(80) }).success).toBe(true);
    expect(venueInputSchema.safeParse({ name: 'x'.repeat(81) }).success).toBe(false);
  });
  it('duplicate names are detected ignoring case and surrounding spaces', () => {
    expect(venueNameKey('  Main AUDITORIUM ')).toBe('main auditorium');
    expect(isDuplicateVenueName(' room nb-408', ['Main Auditorium', 'Room NB-408'])).toBe(true);
    expect(isDuplicateVenueName('Room NB-409', ['Main Auditorium', 'Room NB-408'])).toBe(false);
  });
});
