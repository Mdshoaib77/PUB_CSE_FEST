import { z } from 'zod';

/**
 * Pure venue input rules (no DB). name: required, trimmed, 2-80. building + capacity: OPTIONAL — empty string / null / undefined mean
 * "not set" (the key is dropped), so nothing is hard-coded and nothing is validated for a venue without them.
 */
const blankToUndef = (v: unknown) => (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v);

export const venueInputSchema = z.object({
  name: z.string({ required_error: 'Venue name is required' }).trim().min(2, 'Venue name must be at least 2 characters').max(80, 'Venue name must be at most 80 characters'),
  building: z.preprocess(blankToUndef, z.string().trim().min(1).max(80, 'Building must be at most 80 characters').optional()),
  capacity: z.preprocess(blankToUndef, z.coerce.number({ invalid_type_error: 'Capacity must be a number' }).int('Capacity must be a whole number').min(1, 'Capacity must be at least 1').max(100000, 'Capacity is too large').optional()),
});
export type VenueInput = z.infer<typeof venueInputSchema>;

/** Case-insensitive uniqueness key. */
export const venueNameKey = (name: string) => name.trim().toLowerCase();
export const isDuplicateVenueName = (name: string, existing: string[]) => existing.some((n) => venueNameKey(n) === venueNameKey(name));
