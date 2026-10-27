import { describe, expect, it } from 'vitest';
import { dailyCounts } from '../services/commandCenter';

const now = new Date('2026-10-25T12:00:00Z');
const h = (n: number) => new Date(now.getTime() + n * 3600_000);

describe('command center (pure)', () => {
  it('daily counts: oldest first, zeros included, outside the window ignored', () => {
    const d = dailyCounts([h(-1), h(-2), h(-100), new Date('2026-10-23T01:00:00Z')], 3, now);
    expect(d).toEqual([{ day: '2026-10-23', count: 1 }, { day: '2026-10-24', count: 0 }, { day: '2026-10-25', count: 2 }]);
  });
});
