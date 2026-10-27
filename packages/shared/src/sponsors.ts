/** Sponsor domain constants + pure helpers (S7). No I/O. */

export const SPONSOR_TIERS = ['title', 'gold', 'silver', 'bronze', 'partner'] as const; // best first
export type SponsorTier = (typeof SPONSOR_TIERS)[number];
export const SPONSOR_TIER_LABELS: Record<SponsorTier, string> = { title: 'Title', gold: 'Gold', silver: 'Silver', bronze: 'Bronze', partner: 'Partner' };

export const CONTRIBUTION_TYPES = ['cash', 'in_kind', 'service'] as const;
export type ContributionType = (typeof CONTRIBUTION_TYPES)[number];
export const CONTRIBUTION_LABELS: Record<ContributionType, string> = { cash: 'Cash', in_kind: 'In-kind', service: 'Service' };

/** Pipeline order. */
export const SPONSOR_STATUSES = ['prospect', 'contacted', 'negotiating', 'confirmed', 'received'] as const;
export type SponsorStatus = (typeof SPONSOR_STATUSES)[number];
export const SPONSOR_STATUS_LABELS: Record<SponsorStatus, string> = { prospect: 'Prospect', contacted: 'Contacted', negotiating: 'Negotiating', confirmed: 'Confirmed', received: 'Received' };

export const DELIVERABLE_TYPES = ['logo', 'banner', 'social_post', 'booth', 'speaking_slot', 'tickets', 'certificate_mention', 'other'] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];
export const DELIVERABLE_STATUSES = ['pending', 'done'] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

/** 0 = best (Title) ... 4 = Partner; unknown tiers sort last. */
export const tierRank = (t: string | null | undefined): number => {
  const i = SPONSOR_TIERS.indexOf(t as SponsorTier);
  return i === -1 ? SPONSOR_TIERS.length : i;
};
/** Comparator: higher tier first, then company name (case-insensitive), so the order is stable and deterministic. */
export const compareSponsors = (a: { tier: string; company: string }, b: { tier: string; company: string }): number =>
  tierRank(a.tier) - tierRank(b.tier) || a.company.localeCompare(b.company, 'en', { sensitivity: 'base' });
/** New sorted array (input untouched). */
export const sortByTier = <T extends { tier: string; company: string }>(rows: readonly T[]): T[] => [...rows].sort(compareSponsors);

/** Is `to` a forward move in the pipeline? (Backward moves are allowed by the API but flagged in the audit log.) */
export const isForwardStatus = (from: SponsorStatus, to: SponsorStatus) => SPONSOR_STATUSES.indexOf(to) > SPONSOR_STATUSES.indexOf(from);

/** Round to cents, tolerate junk (NaN/negative/strings -> 0). */
export const money = (n: unknown): number => {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : 0;
};

export interface PaymentLike {
  pledged?: number | null;
  received?: number | null;
}
export interface SponsorTotals {
  pledged: number;
  received: number;
  /** Sum of max(0, pledged - received) per payment: an over-payment on one line never hides a shortfall on another. */
  outstanding: number;
  /** Sum of max(0, received - pledged) per payment. */
  overpaid: number;
}
/** Totals for a set of payments. Computed in integer cents, so 0.1 + 0.2 style drift cannot occur. */
export function sponsorTotals(payments: readonly PaymentLike[]): SponsorTotals {
  let p = 0, r = 0, o = 0, x = 0;
  for (const pay of payments) {
    const pc = Math.round(money(pay.pledged) * 100);
    const rc = Math.round(money(pay.received) * 100);
    p += pc;
    r += rc;
    o += Math.max(0, pc - rc);
    x += Math.max(0, rc - pc);
  }
  return { pledged: p / 100, received: r / 100, outstanding: o / 100, overpaid: x / 100 };
}

/** Totals per tier (all tiers present, best first) + grand total. `rows` = sponsors with their payments. */
export function totalsByTier<T extends { tier: string; payments: readonly PaymentLike[] }>(rows: readonly T[]): { tier: SponsorTier; count: number; totals: SponsorTotals }[] & { grand?: SponsorTotals } {
  const out = SPONSOR_TIERS.map((tier) => {
    const mine = rows.filter((r) => r.tier === tier);
    return { tier, count: mine.length, totals: sponsorTotals(mine.flatMap((r) => r.payments)) };
  }) as { tier: SponsorTier; count: number; totals: SponsorTotals }[] & { grand?: SponsorTotals };
  out.grand = sponsorTotals(rows.flatMap((r) => r.payments));
  return out;
}
