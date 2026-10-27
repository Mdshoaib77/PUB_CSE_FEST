import { describe, expect, it } from 'vitest';
import { compareSponsors, isForwardStatus, money, sortByTier, sponsorTotals, tierRank, totalsByTier } from '@festhub/shared';
import { detectReceipt } from '../services/receipts';

describe('sponsor pure helpers (S7)', () => {
  it('orders tiers Title > Gold > Silver > Bronze > Partner, then by company', () => {
    expect(['title', 'gold', 'silver', 'bronze', 'partner', 'weird'].map(tierRank)).toEqual([0, 1, 2, 3, 4, 5]);
    const sorted = sortByTier([
      { tier: 'gold', company: 'beta' },
      { tier: 'title', company: 'Zed' },
      { tier: 'gold', company: 'Alpha' },
      { tier: 'partner', company: 'P' },
    ]);
    expect(sorted.map((s) => s.company)).toEqual(['Zed', 'Alpha', 'beta', 'P']);
    expect(compareSponsors({ tier: 'gold', company: 'a' }, { tier: 'gold', company: 'a' })).toBe(0);
  });
  it('totals: pledged / received / outstanding without float drift; overpayment does not hide a shortfall', () => {
    expect(sponsorTotals([])).toEqual({ pledged: 0, received: 0, outstanding: 0, overpaid: 0 });
    expect(sponsorTotals([{ pledged: 0.1, received: 0.2 }, { pledged: 100, received: 40.5 }])).toEqual({ pledged: 100.1, received: 40.7, outstanding: 59.5, overpaid: 0.1 });
    expect(sponsorTotals([{ pledged: 'x' as unknown as number, received: -3 }])).toEqual({ pledged: 0, received: 0, outstanding: 0, overpaid: 0 });
    expect(money(1.005 * 100)).toBeGreaterThan(0);
  });
  it('totals per tier include every tier and a grand total', () => {
    const t = totalsByTier([{ tier: 'gold', payments: [{ pledged: 10, received: 4 }] }, { tier: 'gold', payments: [{ pledged: 5, received: 5 }] }]);
    expect(t.map((x) => x.tier)).toEqual(['title', 'gold', 'silver', 'bronze', 'partner']);
    expect(t[1]).toMatchObject({ count: 2, totals: { pledged: 15, received: 9, outstanding: 6 } });
    expect(t.grand).toMatchObject({ pledged: 15, outstanding: 6 });
  });
  it('status direction + receipt sniffing', () => {
    expect(isForwardStatus('prospect', 'confirmed')).toBe(true);
    expect(isForwardStatus('received', 'contacted')).toBe(false);
    expect(detectReceipt(Buffer.from('%PDF-1.4\n' + 'x'.repeat(20)))).toBe('pdf');
    expect(detectReceipt(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
  });
});
