/** Venue display helpers. capacity is optional: never print "undefined", "null" or "NaN". */
export interface VenueLike {
  _id: string;
  name: string;
  building?: string | null;
  capacity?: number | null;
}
export const venueCapacity = (v: Pick<VenueLike, 'capacity'>): number | null => (typeof v.capacity === 'number' && Number.isFinite(v.capacity) && v.capacity > 0 ? v.capacity : null);
/** "Main Auditorium (capacity 300)" or just "Main Auditorium". */
export const venueLabel = (v: Pick<VenueLike, 'name' | 'capacity'>): string => {
  const c = venueCapacity(v);
  return c ? `${v.name} (capacity ${c})` : v.name;
};
