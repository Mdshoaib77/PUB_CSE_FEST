import { Router } from 'express';
import { z } from 'zod';
import {
  CONTRIBUTION_TYPES,
  DELIVERABLE_STATUSES,
  DELIVERABLE_TYPES,
  SPONSOR_STATUSES,
  SPONSOR_TIERS,
  isForwardStatus,
  money,
  sponsorTotals,
  totalsByTier,
  type SponsorStatus,
} from '@festhub/shared';
import { Deliverable, Event, Sponsor, SponsorEvent, SponsorPayment } from '../models';
import { requireAuth, requireRole } from '../middleware/auth';
import { badRequest, conflict, notFound } from '../utils/errors';
import { ok, oid, parse, wrap } from '../utils/http';
import { logAction } from '../utils/audit';
import { env } from '../config/env';
import { sendCsv } from '../utils/exporters';
import { mapReceiptError, readReceipt, receiptUpload, removeReceipt, saveReceipt } from '../services/receipts';
import { remindersOnPageLoad, sendFollowUpReminders } from '../services/sponsorReminders';

/**
 * Sponsors (S7). Mounted at /api/v1; every route authenticates itself.
 * Read: organiser, coordinator (admin counts as organiser). Write: organiser/admin.
 *   GET    /sponsors                        ?q=&status=&tier=&eventId=&followUp=due&page=&pageSize=   (tier order, then company)
 *   GET    /sponsors/summary                totals (pledged/received/outstanding) overall + per tier + per status counts
 *   GET    /sponsors/export.csv             (S8) same filters as the list, max 10 000 rows, audited
 *   POST   /sponsors/reminders/run          send due follow-up reminders now
 *   POST   /sponsors                        create
 *   GET    /sponsors/:id                    detail: events, deliverables, payments, totals
 *   PATCH  /sponsors/:id                    update (status has its own endpoint)
 *   POST   /sponsors/:id/status             { status }
 *   DELETE /sponsors/:id                    cascade (links, deliverables, payments, receipt files)
 *   POST|DELETE /sponsors/:id/events[/:eventId]     link / unlink an event;  GET /events/:eventId/sponsors
 *   GET|POST /sponsors/:id/deliverables;  PATCH|DELETE /deliverables/:id
 *   GET|POST /sponsors/:id/payments;      PATCH|DELETE /payments/:id
 *   POST|GET|DELETE /payments/:id/receipt   private receipt file (PDF/JPG/PNG)
 */
const r = Router();
const manage = requireRole('organiser');
const view = requireRole('organiser', 'coordinator');

// ------------------------------------------------------------------ helpers
const dateIn = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date')
  .transform((s) => new Date(s));
const amountIn = z.number().finite().min(0).max(1e12).transform((n) => money(n));
const idStr = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const sponsorBrief = (s: InstanceType<typeof Sponsor>, totals?: ReturnType<typeof sponsorTotals>) => ({
  id: s.id as string,
  company: s.company,
  contactName: s.contactName ?? '',
  email: s.email ?? null,
  phone: s.phone ?? null,
  tier: s.tier,
  contributionType: s.contributionType,
  amount: s.amount ?? 0,
  status: s.status,
  nextFollowUpAt: s.nextFollowUpAt ?? null,
  notes: s.notes ?? '',
  ownerId: s.ownerId ? String(s.ownerId) : null,
  userId: s.userId ? String(s.userId) : null,
  createdAt: (s as unknown as { createdAt?: Date }).createdAt,
  ...(totals ? { totals } : {}),
});
const deliverableBrief = (d: InstanceType<typeof Deliverable>) => ({
  id: d.id as string,
  sponsorId: String(d.sponsorId),
  eventId: d.eventId ? String(d.eventId) : null,
  type: d.type,
  title: d.title ?? '',
  status: d.status,
  dueAt: d.dueAt ?? null,
  doneAt: d.doneAt ?? null,
});
const paymentBrief = (p: InstanceType<typeof SponsorPayment>) => ({
  id: p.id as string,
  sponsorId: String(p.sponsorId),
  eventId: p.eventId ? String(p.eventId) : null,
  pledged: p.pledged ?? 0,
  received: p.received ?? 0,
  dueDate: p.dueDate ?? null,
  receivedAt: p.receivedAt ?? null,
  note: p.note ?? '',
  hasReceipt: !!p.receiptFile,
  receiptName: p.receiptName ?? null,
});

async function loadSponsor(id: string) {
  const s = await Sponsor.findById(oid(id, 'sponsor id'));
  if (!s) throw notFound('Sponsor not found');
  return s;
}
async function requireEvent(id: string) {
  const e = await Event.findById(oid(id, 'event id')).select('title startAt status');
  if (!e) throw notFound('Event not found');
  return e;
}
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ------------------------------------------------------------------ sponsors: list / summary / reminders
const listSchema = z.object({
  q: z.string().trim().max(80).optional().catch(undefined),
  status: z.enum(SPONSOR_STATUSES).optional().catch(undefined),
  tier: z.enum(SPONSOR_TIERS).optional().catch(undefined),
  eventId: idStr.optional().catch(undefined),
  followUp: z.literal('due').optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100000).catch(1),
  pageSize: z.coerce.number().int().min(1).max(200).catch(25),
});

r.get(
  '/sponsors',
  requireAuth,
  view,
  wrap(async (req, res) => {
    if (!env.isTest) remindersOnPageLoad();
    const q = listSchema.parse(req.query);
    const f: Record<string, unknown> = {};
    if (q.status) f.status = q.status;
    if (q.tier) f.tier = q.tier;
    if (q.q) {
      const rx = new RegExp(esc(q.q), 'i');
      f.$or = [{ company: rx }, { contactName: rx }, { email: rx }];
    }
    if (q.eventId) f._id = { $in: (await SponsorEvent.find({ eventId: q.eventId }).select('sponsorId')).map((l) => l.sponsorId) };
    if (q.followUp) {
      const t = new Date();
      f.status = { $ne: 'received' };
      f.nextFollowUpAt = { $lte: new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 23, 59, 59, 999)) };
    }
    const total = await Sponsor.countDocuments(f);
    const pages = Math.max(1, Math.ceil(total / q.pageSize));
    const page = Math.min(q.page, pages);
    const rows = await Sponsor.find(f).sort({ tierRank: 1, company: 1, _id: 1 }).skip((page - 1) * q.pageSize).limit(q.pageSize);
    const pays = await SponsorPayment.find({ sponsorId: { $in: rows.map((s) => s._id) } }).select('sponsorId pledged received');
    const by = new Map<string, typeof pays>();
    for (const p of pays) by.set(String(p.sponsorId), [...(by.get(String(p.sponsorId)) ?? []), p]);
    const meta = { total, page, pages, pageSize: q.pageSize };
    const items = rows.map((s) => sponsorBrief(s, sponsorTotals(by.get(s.id) ?? [])));
    // ?paged=1 -> { items, ...meta } in data (the web client does not see `meta`); default: array + meta
    ok(res, req.query.paged ? { items, ...meta } : items, 200, meta);
  }),
);

r.get(
  '/sponsors/summary',
  requireAuth,
  view,
  wrap(async (_req, res) => {
    const sponsors = await Sponsor.find().select('tier status').limit(5000);
    const pays = await SponsorPayment.find().select('sponsorId pledged received').limit(50000);
    const by = new Map<string, typeof pays>();
    for (const p of pays) by.set(String(p.sponsorId), [...(by.get(String(p.sponsorId)) ?? []), p]);
    const rows = sponsors.map((s) => ({ tier: s.tier as string, payments: by.get(s.id) ?? [] }));
    const tiers = totalsByTier(rows);
    const statuses = Object.fromEntries(SPONSOR_STATUSES.map((st) => [st, sponsors.filter((s) => s.status === st).length]));
    const dueFollowUps = await Sponsor.countDocuments({ status: { $ne: 'received' }, nextFollowUpAt: { $lte: new Date() } });
    ok(res, { totals: tiers.grand, tiers: [...tiers], statuses, sponsors: sponsors.length, dueFollowUps });
  }),
);

// S8: CSV export of the filtered list (same query params as GET /sponsors). Declared before /sponsors/:id.
r.get(
  '/sponsors/export.csv',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const q = listSchema.parse(req.query);
    const f: Record<string, unknown> = {};
    if (q.status) f.status = q.status;
    if (q.tier) f.tier = q.tier;
    if (q.q) {
      const rx = new RegExp(esc(q.q), 'i');
      f.$or = [{ company: rx }, { contactName: rx }, { email: rx }];
    }
    if (q.eventId) f._id = { $in: (await SponsorEvent.find({ eventId: q.eventId }).select('sponsorId')).map((l) => l.sponsorId) };
    if (q.followUp) {
      const t = new Date();
      f.status = { $ne: 'received' };
      f.nextFollowUpAt = { $lte: new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 23, 59, 59, 999)) };
    }
    const rows = await Sponsor.find(f).sort({ tierRank: 1, company: 1, _id: 1 }).limit(10000);
    const pays = await SponsorPayment.find({ sponsorId: { $in: rows.map((s) => s._id) } }).select('sponsorId pledged received');
    const by = new Map<string, typeof pays>();
    for (const p of pays) by.set(String(p.sponsorId), [...(by.get(String(p.sponsorId)) ?? []), p]);
    await logAction(req.user, 'sponsor.export', { type: 'Sponsor' }, { rows: rows.length });
    sendCsv(
      res,
      'sponsors',
      rows.map((s) => sponsorBrief(s, sponsorTotals(by.get(s.id) ?? []))),
      [
        { header: 'Company', value: 'company' },
        { header: 'Tier', value: 'tier' },
        { header: 'Status', value: 'status' },
        { header: 'Contribution', value: 'contributionType' },
        { header: 'Agreed amount', value: 'amount' },
        { header: 'Pledged', value: (r2) => r2.totals?.pledged ?? 0 },
        { header: 'Received', value: (r2) => r2.totals?.received ?? 0 },
        { header: 'Outstanding', value: (r2) => r2.totals?.outstanding ?? 0 },
        { header: 'Contact', value: 'contactName' },
        { header: 'Email', value: (r2) => r2.email ?? '' },
        { header: 'Phone', value: (r2) => r2.phone ?? '' },
        { header: 'Next follow-up', value: (r2) => (r2.nextFollowUpAt ? new Date(r2.nextFollowUpAt).toISOString().slice(0, 10) : '') },
      ],
    );
  }),
);

r.post(
  '/sponsors/reminders/run',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const out = await sendFollowUpReminders();
    await logAction(req.user, 'sponsor.reminders_run', { type: 'Sponsor' }, out as unknown as Record<string, unknown>);
    ok(res, out);
  }),
);

// ------------------------------------------------------------------ sponsors: create / read / update / status / delete
const baseFields = {
  company: z.string().trim().min(1, 'Company is required').max(120),
  contactName: z.string().trim().max(120),
  email: z.string().trim().toLowerCase().email().max(200).nullable(),
  phone: z.string().trim().regex(/^[0-9+()\-.\s]{5,40}$/, 'Invalid phone number').nullable(),
  tier: z.enum(SPONSOR_TIERS),
  contributionType: z.enum(CONTRIBUTION_TYPES),
  amount: amountIn,
  nextFollowUpAt: dateIn.nullable(),
  notes: z.string().trim().max(2000),
  ownerId: idStr.nullable(),
};
const createSchema = z.object({ ...baseFields, status: z.enum(SPONSOR_STATUSES).optional() }).partial().required({ company: true });
const patchSchema = z.object(baseFields).partial().strict();

r.post(
  '/sponsors',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const b = parse(createSchema, req.body);
    const s = await Sponsor.create({ ...b, createdBy: req.user!.id, ownerId: b.ownerId ?? req.user!.id });
    await logAction(req.user, 'sponsor.create', { type: 'Sponsor', id: s.id }, { company: s.company, tier: s.tier, status: s.status });
    ok(res, sponsorBrief(s, sponsorTotals([])), 201);
  }),
);

r.get(
  '/sponsors/:id',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const s = await loadSponsor(req.params.id);
    const [links, dels, pays] = await Promise.all([
      SponsorEvent.find({ sponsorId: s._id }),
      Deliverable.find({ sponsorId: s._id }).sort({ createdAt: 1 }),
      SponsorPayment.find({ sponsorId: s._id }).sort({ dueDate: 1, createdAt: 1 }),
    ]);
    const evs = await Event.find({ _id: { $in: links.map((l) => l.eventId) } }).select('title startAt');
    ok(res, {
      ...sponsorBrief(s, sponsorTotals(pays)),
      events: evs.map((e) => ({ id: e.id as string, title: e.title, startAt: e.startAt })),
      deliverables: dels.map(deliverableBrief),
      payments: pays.map(paymentBrief),
    });
  }),
);

r.patch(
  '/sponsors/:id',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const b = parse(patchSchema, req.body ?? {});
    const s = await loadSponsor(req.params.id);
    const before = { tier: s.tier, amount: s.amount, nextFollowUpAt: s.nextFollowUpAt };
    for (const [k, v] of Object.entries(b)) {
      if (v === null) s.set(k, undefined);
      else s.set(k, v);
    }
    await s.save();
    const changed = Object.keys(b);
    await logAction(req.user, 'sponsor.update', { type: 'Sponsor', id: s.id }, { fields: changed, before: Object.fromEntries(Object.entries(before).filter(([k]) => changed.includes(k))) });
    ok(res, sponsorBrief(s));
  }),
);

r.post(
  '/sponsors/:id/status',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(SPONSOR_STATUSES) }), req.body);
    const s = await loadSponsor(req.params.id);
    const from = s.status as SponsorStatus;
    if (from === status) throw conflict(`Sponsor is already ${status}`);
    // atomic: only moves if nobody changed the status in between
    const done = await Sponsor.findOneAndUpdate({ _id: s._id, status: from }, { $set: { status } }, { new: true });
    if (!done) throw conflict('Sponsor status changed meanwhile. Reload and try again.');
    await logAction(req.user, 'sponsor.status', { type: 'Sponsor', id: s.id }, { from, to: status, direction: isForwardStatus(from, status) ? 'forward' : 'backward' });
    ok(res, sponsorBrief(done));
  }),
);

r.delete(
  '/sponsors/:id',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const s = await loadSponsor(req.params.id);
    const pays = await SponsorPayment.find({ sponsorId: s._id }).select('receiptFile');
    await Promise.all(pays.map((p) => removeReceipt(p.receiptFile)));
    await Promise.all([SponsorPayment.deleteMany({ sponsorId: s._id }), Deliverable.deleteMany({ sponsorId: s._id }), SponsorEvent.deleteMany({ sponsorId: s._id })]);
    await s.deleteOne();
    await logAction(req.user, 'sponsor.delete', { type: 'Sponsor', id: s.id }, { company: s.company, payments: pays.length });
    ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------ event links
r.post(
  '/sponsors/:id/events',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const { eventId } = parse(z.object({ eventId: idStr }), req.body);
    const s = await loadSponsor(req.params.id);
    const ev = await requireEvent(eventId);
    try {
      await SponsorEvent.create({ sponsorId: s._id, eventId: ev._id, linkedBy: req.user!.id });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw conflict('This sponsor is already linked to that event');
      throw e;
    }
    await logAction(req.user, 'sponsor.event_link', { type: 'Sponsor', id: s.id }, { eventId: ev.id });
    ok(res, { sponsorId: s.id, eventId: ev.id, title: ev.title }, 201);
  }),
);
r.delete(
  '/sponsors/:id/events/:eventId',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const s = await loadSponsor(req.params.id);
    const del = await SponsorEvent.deleteOne({ sponsorId: s._id, eventId: oid(req.params.eventId, 'event id') });
    if (!del.deletedCount) throw notFound('That event is not linked to this sponsor');
    await logAction(req.user, 'sponsor.event_unlink', { type: 'Sponsor', id: s.id }, { eventId: req.params.eventId });
    ok(res, { unlinked: true });
  }),
);
r.get(
  '/events/:eventId/sponsors',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const ev = await requireEvent(req.params.eventId);
    const ids = (await SponsorEvent.find({ eventId: ev._id }).select('sponsorId')).map((l) => l.sponsorId);
    const rows = await Sponsor.find({ _id: { $in: ids } }).sort({ tierRank: 1, company: 1 });
    ok(res, rows.map((s) => sponsorBrief(s)));
  }),
);

// ------------------------------------------------------------------ deliverables
const delFields = {
  type: z.enum(DELIVERABLE_TYPES),
  title: z.string().trim().max(160),
  eventId: idStr.nullable(),
  dueAt: dateIn.nullable(),
  status: z.enum(DELIVERABLE_STATUSES),
};
r.get(
  '/sponsors/:id/deliverables',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const s = await loadSponsor(req.params.id);
    ok(res, (await Deliverable.find({ sponsorId: s._id }).sort({ createdAt: 1 })).map(deliverableBrief));
  }),
);
r.post(
  '/sponsors/:id/deliverables',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const b = parse(z.object(delFields).partial().required({ type: true }), req.body);
    const s = await loadSponsor(req.params.id);
    if (b.eventId) await requireEvent(b.eventId);
    const d = await Deliverable.create({ ...b, sponsorId: s._id, ...(b.status === 'done' ? { doneAt: new Date() } : {}) });
    await logAction(req.user, 'sponsor.deliverable_create', { type: 'Sponsor', id: s.id }, { deliverableId: d.id, type: d.type });
    ok(res, deliverableBrief(d), 201);
  }),
);
r.patch(
  '/deliverables/:id',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const b = parse(z.object(delFields).partial().strict(), req.body ?? {});
    const d = await Deliverable.findById(oid(req.params.id, 'deliverable id'));
    if (!d) throw notFound('Deliverable not found');
    if (b.eventId) await requireEvent(b.eventId);
    const was = d.status;
    for (const [k, v] of Object.entries(b)) d.set(k, v === null ? undefined : v);
    if (b.status === 'done' && was !== 'done') d.doneAt = new Date();
    if (b.status === 'pending') d.set('doneAt', undefined);
    await d.save();
    await logAction(req.user, 'sponsor.deliverable_update', { type: 'Sponsor', id: d.sponsorId }, { deliverableId: d.id, ...(b.status && b.status !== was ? { from: was, to: b.status } : {}) });
    ok(res, deliverableBrief(d));
  }),
);
r.delete(
  '/deliverables/:id',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const d = await Deliverable.findByIdAndDelete(oid(req.params.id, 'deliverable id'));
    if (!d) throw notFound('Deliverable not found');
    await logAction(req.user, 'sponsor.deliverable_delete', { type: 'Sponsor', id: d.sponsorId }, { deliverableId: d.id });
    ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------ payments
const payFields = {
  pledged: amountIn,
  received: amountIn,
  dueDate: dateIn.nullable(),
  receivedAt: dateIn.nullable(),
  note: z.string().trim().max(300),
  eventId: idStr.nullable(),
};
r.get(
  '/sponsors/:id/payments',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const s = await loadSponsor(req.params.id);
    const rows = await SponsorPayment.find({ sponsorId: s._id }).sort({ dueDate: 1, createdAt: 1 });
    ok(res, rows.map(paymentBrief), 200, { totals: sponsorTotals(rows) });
  }),
);
r.post(
  '/sponsors/:id/payments',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const b = parse(z.object(payFields).partial().refine((x) => x.pledged !== undefined || x.received !== undefined, 'Give a pledged or received amount'), req.body);
    const s = await loadSponsor(req.params.id);
    if (b.eventId) await requireEvent(b.eventId);
    const p = await SponsorPayment.create({ ...b, sponsorId: s._id, recordedBy: req.user!.id, ...((b.received ?? 0) > 0 && !b.receivedAt ? { receivedAt: new Date() } : {}) });
    await logAction(req.user, 'sponsor.payment_create', { type: 'Sponsor', id: s.id }, { paymentId: p.id, pledged: p.pledged, received: p.received });
    ok(res, paymentBrief(p), 201);
  }),
);
r.patch(
  '/payments/:id',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const b = parse(z.object(payFields).partial().strict(), req.body ?? {});
    const p = await SponsorPayment.findById(oid(req.params.id, 'payment id'));
    if (!p) throw notFound('Payment not found');
    if (b.eventId) await requireEvent(b.eventId);
    const before = { pledged: p.pledged, received: p.received, dueDate: p.dueDate };
    for (const [k, v] of Object.entries(b)) p.set(k, v === null ? undefined : v);
    if ((p.received ?? 0) > 0 && !p.receivedAt) p.receivedAt = new Date();
    if ((p.received ?? 0) === 0 && b.received === 0 && b.receivedAt === undefined) p.set('receivedAt', undefined);
    await p.save();
    await logAction(req.user, 'sponsor.payment_update', { type: 'Sponsor', id: p.sponsorId }, { paymentId: p.id, before, after: { pledged: p.pledged, received: p.received, dueDate: p.dueDate } });
    ok(res, paymentBrief(p));
  }),
);
r.delete(
  '/payments/:id',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const p = await SponsorPayment.findByIdAndDelete(oid(req.params.id, 'payment id'));
    if (!p) throw notFound('Payment not found');
    await removeReceipt(p.receiptFile);
    await logAction(req.user, 'sponsor.payment_delete', { type: 'Sponsor', id: p.sponsorId }, { paymentId: p.id, pledged: p.pledged, received: p.received });
    ok(res, { deleted: true });
  }),
);

// ------------------------------------------------------------------ receipts (private)
r.post(
  '/payments/:id/receipt',
  requireAuth,
  manage,
  (req, res, next) => {
    receiptUpload.single('file')(req, res, (err: unknown) => {
      if (err) return next(mapReceiptError(err));
      if (!req.file) return next(badRequest('Choose a receipt file to upload'));
      (async () => {
        const p = await SponsorPayment.findById(oid(req.params.id, 'payment id'));
        if (!p) throw notFound('Payment not found');
        const saved = await saveReceipt(req.file!.buffer);
        const old = p.receiptFile;
        p.receiptFile = saved.file;
        p.receiptMime = saved.mime;
        p.receiptName = String(req.file!.originalname ?? '').replace(/[^\w.\- ]+/g, '_').slice(0, 80) || `receipt.${saved.file.split('.')[1]}`;
        await p.save();
        await removeReceipt(old);
        await logAction(req.user, 'sponsor.receipt_upload', { type: 'Sponsor', id: p.sponsorId }, { paymentId: p.id, replaced: !!old });
        ok(res, paymentBrief(p), 201);
      })().catch(next);
    });
  },
);
r.get(
  '/payments/:id/receipt',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const p = await SponsorPayment.findById(oid(req.params.id, 'payment id'));
    if (!p?.receiptFile) throw notFound('No receipt on this payment');
    const buf = await readReceipt(p.receiptFile);
    if (!buf) throw notFound('Receipt file is missing');
    const ext = p.receiptFile.split('.')[1];
    res.setHeader('Content-Type', p.receiptMime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${p.id}.${ext}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buf);
  }),
);
r.delete(
  '/payments/:id/receipt',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const p = await SponsorPayment.findById(oid(req.params.id, 'payment id'));
    if (!p?.receiptFile) throw notFound('No receipt on this payment');
    const f = p.receiptFile;
    p.set('receiptFile', undefined);
    p.set('receiptName', undefined);
    p.set('receiptMime', undefined);
    await p.save();
    await removeReceipt(f);
    await logAction(req.user, 'sponsor.receipt_delete', { type: 'Sponsor', id: p.sponsorId }, { paymentId: p.id });
    ok(res, paymentBrief(p));
  }),
);

export default r;
