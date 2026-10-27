/**
 * S16 Organizer Command Center: read-only aggregates over existing collections (nothing is stored).
 * `dailyCounts` is pure (tested without a DB); `buildCommandCenter` loads the data.
 */
import { Certificate, CodeSubmission, Entry, Event, PlagiarismPair, Registration, Sponsor, SponsorPayment } from '../models';

/** Counts per UTC day for the last `days` days (oldest first, zeros included). */
export function dailyCounts(dates: readonly Date[], days: number, now: Date): { day: string; count: number }[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out = Array.from({ length: days }, (_, i) => ({ day: new Date(end - (days - 1 - i) * 86400_000).toISOString().slice(0, 10), count: 0 }));
  const idx = new Map(out.map((o, i) => [o.day, i]));
  for (const d of dates) {
    const i = idx.get(new Date(d).toISOString().slice(0, 10));
    if (i !== undefined) out[i].count++;
  }
  return out;
}

const group = <T>(xs: readonly T[], key: (x: T) => string) => xs.reduce<Record<string, number>>((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});

export async function buildCommandCenter(now = new Date()) {
  const since = new Date(now.getTime() - 14 * 86400_000);
  const [regs, sponsors, payments, subs, entries, pairs, certs, events] = await Promise.all([
    Registration.find().select('eventId status createdAt').lean(),
    Sponsor.find().select('status tier').lean(),
    SponsorPayment.find().select('pledged received dueDate').lean(),
    CodeSubmission.find().select('checkStatus').lean(),
    Entry.countDocuments(),
    PlagiarismPair.find({ status: { $in: ['suspicious', 'confirmed'] } }).select('status aId bId').lean(),
    Certificate.find().select('status type').lean(),
    Event.find().select('title startAt').sort({ startAt: -1 }).limit(60).lean(),
  ]);

  const regStatus = group(regs, (r) => r.status);
  const perEvent = new Map<string, number>();
  for (const r of regs) if (r.status === 'confirmed') perEvent.set(String(r.eventId), (perEvent.get(String(r.eventId)) ?? 0) + 1);
  const topEvents = events.map((e) => ({ eventId: String(e._id), title: e.title, confirmed: perEvent.get(String(e._id)) ?? 0 })).filter((e) => e.confirmed > 0).sort((a, b) => b.confirmed - a.confirmed).slice(0, 6);

  const pledged = payments.reduce((n, p) => n + (p.pledged ?? 0), 0);
  const received = payments.reduce((n, p) => n + (p.received ?? 0), 0);
  const overdue = payments.filter((p) => p.dueDate && p.dueDate < now && (p.received ?? 0) < (p.pledged ?? 0)).length;

  const flaggedSubmissions = new Set(pairs.flatMap((p) => [String(p.aId), String(p.bId)])).size;
  return {
    generatedAt: now.toISOString(),
    registrations: {
      total: regs.length,
      byStatus: regStatus,
      confirmed: regStatus.confirmed ?? 0,
      waitlisted: regStatus.waitlisted ?? 0,
      pending: regStatus.pending_approval ?? 0,
      trend: dailyCounts(regs.filter((r) => r.createdAt >= since).map((r) => r.createdAt), 14, now),
      topEvents,
    },
    sponsors: { total: sponsors.length, byStatus: group(sponsors, (s) => s.status), pledged, received, outstanding: Math.max(0, pledged - received), overduePayments: overdue },
    submissions: { codeSubmissions: subs.length, entries, flaggedPairs: pairs.length, confirmedPairs: pairs.filter((p) => p.status === 'confirmed').length, flaggedSubmissions, pendingChecks: subs.filter((s) => s.checkStatus === 'pending' || s.checkStatus === 'running').length },
    certificates: { issued: certs.filter((c) => c.status === 'valid').length, revoked: certs.filter((c) => c.status === 'revoked').length, byType: group(certs.filter((c) => c.status === 'valid'), (c) => c.type) },
  };
}
