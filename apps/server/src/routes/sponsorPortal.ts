import { Router } from 'express';
import { z } from 'zod';
import { SPONSOR_TIER_LABELS, sponsorTotals, type SponsorTier } from '@festhub/shared';
import { Deliverable, Event, Sponsor, SponsorEvent, SponsorPayment, User } from '../models';
import { requireAuth, requireRole } from '../middleware/auth';
import { conflict, notFound } from '../utils/errors';
import { ok, oid, parse, wrap } from '../utils/http';
import { logAction } from '../utils/audit';

/**
 * Sponsors, part 2 (S8). Mounted at /api/v1; every route authenticates itself (except the public one).
 *   GET /events/:eventId/our-sponsors   PUBLIC: confirmed/received sponsors linked to a non-draft event, tier order. No contact data, no amounts.
 *   GET /sponsor-portal/me              role `sponsor`, READ-ONLY: own profile, deliverables, payments, visibility
 *   PUT /sponsors/:id/portal-user       organiser/admin: { email | null } link/unlink the sponsor's login
 */
const r = Router();

/** A sponsor is shown publicly once the deal is confirmed (or money received). */
export const PUBLIC_STATUSES = ['confirmed', 'received'];

r.get(
  '/events/:eventId/our-sponsors',
  wrap(async (req, res) => {
    const ev = await Event.findById(oid(req.params.eventId, 'event id')).select('status');
    if (!ev || ev.status === 'draft') throw notFound('Event not found');
    const links = await SponsorEvent.find({ eventId: ev._id }).select('sponsorId');
    const rows = await Sponsor.find({ _id: { $in: links.map((l) => l.sponsorId) }, status: { $in: PUBLIC_STATUSES } })
      .select('company tier')
      .sort({ tierRank: 1, company: 1 });
    res.setHeader('Cache-Control', 'public, max-age=60');
    ok(res, rows.map((s) => ({ id: s.id as string, company: s.company, tier: s.tier, tierLabel: SPONSOR_TIER_LABELS[s.tier as SponsorTier] ?? s.tier })));
  }),
);

r.get(
  '/sponsor-portal/me',
  requireAuth,
  requireRole('sponsor'),
  wrap(async (req, res) => {
    const s = await Sponsor.findOne({ userId: req.user!.id });
    if (!s) throw notFound('No sponsor profile is linked to your account yet. Ask the organisers to link it.');
    const [links, dels, pays] = await Promise.all([
      SponsorEvent.find({ sponsorId: s._id }),
      Deliverable.find({ sponsorId: s._id }).sort({ createdAt: 1 }),
      SponsorPayment.find({ sponsorId: s._id }).sort({ dueDate: 1, createdAt: 1 }),
    ]);
    const evIds = [...links.map((l) => l.eventId), ...dels.map((d) => d.eventId), ...pays.map((p) => p.eventId)].filter(Boolean);
    const evs = await Event.find({ _id: { $in: evIds } }).select('title startAt status');
    const title = new Map(evs.map((e) => [e.id as string, e.title]));
    const t = (id: unknown) => (id ? (title.get(String(id)) ?? null) : null);
    const isPublic = PUBLIC_STATUSES.includes(s.status);
    ok(res, {
      company: s.company,
      tier: s.tier,
      tierLabel: SPONSOR_TIER_LABELS[s.tier as SponsorTier] ?? s.tier,
      contributionType: s.contributionType,
      amount: s.amount ?? 0,
      status: s.status,
      totals: sponsorTotals(pays),
      deliverables: dels.map((d) => ({ id: d.id as string, type: d.type, title: d.title ?? '', status: d.status, dueAt: d.dueAt ?? null, doneAt: d.doneAt ?? null, eventTitle: t(d.eventId) })),
      payments: pays.map((p) => ({ id: p.id as string, pledged: p.pledged ?? 0, received: p.received ?? 0, dueDate: p.dueDate ?? null, receivedAt: p.receivedAt ?? null, note: p.note ?? '', eventTitle: t(p.eventId) })),
      // where the logo/name appears: only on events they are linked to, and only once confirmed
      visibility: {
        publicStatus: isPublic,
        reason: isPublic ? 'Listed publicly on the events below, in the ' + (SPONSOR_TIER_LABELS[s.tier as SponsorTier] ?? s.tier) + ' group.' : 'Not shown publicly until the sponsorship is confirmed.',
        events: evs.filter((e) => links.some((l) => String(l.eventId) === e.id)).map((e) => ({ id: e.id as string, title: e.title, startAt: e.startAt, visible: isPublic && e.status !== 'draft' })),
      },
    });
  }),
);

r.put(
  '/sponsors/:id/portal-user',
  requireAuth,
  requireRole('organiser'),
  wrap(async (req, res) => {
    const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email().max(200).nullable() }), req.body);
    const s = await Sponsor.findById(oid(req.params.id, 'sponsor id'));
    if (!s) throw notFound('Sponsor not found');
    if (email === null) {
      s.set('userId', undefined);
      await s.save();
      await logAction(req.user, 'sponsor.portal_unlink', { type: 'Sponsor', id: s.id });
      return ok(res, { linked: false });
    }
    const u = await User.findOne({ email });
    if (!u || !(u.roles as string[]).includes('sponsor')) throw notFound('No user with the sponsor role has that e-mail');
    const other = await Sponsor.findOne({ userId: u._id, _id: { $ne: s._id } }).select('company');
    if (other) throw conflict(`That user is already linked to ${other.company}`);
    s.userId = u._id;
    await s.save();
    await logAction(req.user, 'sponsor.portal_link', { type: 'Sponsor', id: s.id }, { userId: u.id });
    ok(res, { linked: true, name: u.name, email: u.email });
  }),
);

export default r;
