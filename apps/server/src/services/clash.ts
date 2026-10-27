/** Pure scheduling helpers. Intervals are half-open: [start, end). Touching ends do NOT clash. */
export interface Interval {
  start: Date;
  end: Date;
}

export const overlaps = (a: Interval, b: Interval) => a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();

export function findOverlaps<T extends Interval>(candidate: Interval, others: T[]): T[] {
  return others.filter((o) => overlaps(candidate, o));
}

/** Earliest start >= `after` where an interval of `durationMs` fits between bookings. */
export function suggestNextSlot(bookings: Interval[], durationMs: number, after: Date): Date {
  const sorted = [...bookings].sort((a, b) => a.start.getTime() - b.start.getTime());
  let t = after.getTime();
  for (const b of sorted) {
    if (b.end.getTime() <= t) continue;
    if (b.start.getTime() >= t + durationMs) break;
    t = b.end.getTime();
  }
  return new Date(t);
}

export const fmtRange = (i: Interval) => `${i.start.toISOString().slice(0, 16).replace('T', ' ')} – ${i.end.toISOString().slice(11, 16)} UTC`;

/** True when [start,end) lies completely inside one of the availability slots. */
export function coveredByAvailability(shift: Interval, slots: Interval[]): boolean {
  return slots.some((s) => s.start.getTime() <= shift.start.getTime() && s.end.getTime() >= shift.end.getTime());
}
