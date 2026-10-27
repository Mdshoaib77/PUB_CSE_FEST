import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  CERTIFICATE_TYPES,
  CERTIFICATE_TYPE_LABELS,
  verifyCertificateId,
  buildVerification,
  defaultPositionLabel,
  verificationVerdict,
  CERT_SAMPLE_KINDS,
  certTemplateInputSchema,
  type CertificateType,
  type CertificateVerification,
} from '@festhub/shared';
import { env } from '../config/env';
import { Certificate, Contest, Event, User, Venue } from '../models';
import { isStaff, requireAuth, requireRole } from '../middleware/auth';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { ok, oid, parse, wrap } from '../utils/http';
import { logAction } from '../utils/audit';
import { CONTEST_CERT_TYPES, bulkGenerate, bulkGenerateContest, contestContext, issueCertificate, memberIdsOf, notifyIssued, reissueCertificate, revokeCertificate, verifyUrlFor } from '../services/certificates';
import { renderCertificatePdf, renderCertificatePdfKit } from '../services/certificatePdf';
import { IMAGE_SLOTS, certImageUpload, clearTemplateImage, getTemplate, loadTemplateAssets, mapCertUploadError, mergeTemplateInput, prepareImage, removeCertImage, resetTemplate, sampleCertificate, saveCertImage, saveTemplateInput, setTemplateImage, templateToPdfInput, type ImageSlot, type TemplateAssets, type TemplateView } from '../services/certTemplate';
import { logger } from '../utils/logger';
import { sendCsv } from '../utils/exporters';
import { badRequest } from '../utils/errors';

/**
 * Certificates (S5). Mounted at /api/v1 BEFORE routers that call r.use(requireAuth) globally: /verify/:id is public.
 *   GET  /verify/:id                         public: { status: valid | revoked | not_found, ... }
 *   GET  /certificates/mine                  my certificates
 *   GET  /certificates/:id/download          PDF (owner, organiser or coordinator; revoked ones: staff only, stamped REVOKED)
 *   POST /certificates/:id/revoke            organiser/admin   { reason? }
 *   POST /certificates/:id/reissue           organiser/admin   { reason? }
 *   GET  /events/:eventId/certificates       organiser/coordinator  (?type=&status=&limit=)
 *   POST /events/:eventId/certificates/generate  organiser/admin   { types?, attendedOnly?, signatureText? }  (bulk, idempotent)
 *   POST /events/:eventId/certificates       organiser/admin   { userId, type, position?, positionLabel? }  (single / manual)
 * v4 (team + contest certificates):
 *   GET  /contests/:id/certificates          organiser/coordinator  (same filters as the event list)
 *   GET  /contests/:id/certificates/export.csv organiser/coordinator (same filters)
 *   POST /contests/:id/certificates/generate organiser/admin   { types?: participation|winner|runner_up, signatureText? }  (bulk, idempotent; contest must have ended)
 * A TEAM certificate is ONE document (kind 'team', teamName, recipients = every member, leader first). Every member sees it in /certificates/mine.
 */
const r = Router();
const manage = requireRole('organiser'); // admin satisfies organiser checks
const view = requireRole('organiser', 'coordinator');
const publicLimiter = env.isTest ? (_q: unknown, _s: unknown, n: () => void) => n() : rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

const brief = (c: InstanceType<typeof Certificate>) => ({
  id: c.certId,
  eventId: c.eventId ? String(c.eventId) : null,
  userId: String(c.userId),
  type: c.type,
  typeLabel: CERTIFICATE_TYPE_LABELS[c.type as CertificateType],
  status: c.status,
  recipientName: c.recipientName,
  kind: c.kind ?? 'individual',
  teamId: c.teamId ? String(c.teamId) : null,
  teamName: c.teamName ?? null,
  members: (c.recipients ?? []).map((m) => ({ userId: String(m.userId), name: m.name })),
  contestId: c.contestId ? String(c.contestId) : null,
  eventTitle: c.eventTitle,
  eventDate: c.eventDate,
  position: c.position ?? null,
  positionLabel: c.positionLabel ?? null,
  issuedAt: c.issuedAt,
  revokedAt: c.revokedAt ?? null,
  revokeReason: c.revokeReason ?? null,
  replacesId: c.replacesId ?? null,
  replacedById: c.replacedById ?? null,
  verifyUrl: verifyUrlFor(c.certId),
});

async function loadByCertId(raw: string) {
  const chk = verifyCertificateId(raw);
  if (!chk.ok) throw notFound('Certificate not found');
  const c = await Certificate.findOne({ certId: chk.id });
  if (!c) throw notFound('Certificate not found');
  return c;
}
/** Best-effort venue name for the {venue} placeholder / "held at" line. */
async function venueNameOf(eventId: unknown): Promise<string | undefined> {
  try {
    const ev = eventId ? await Event.findById(eventId).select('venueId') : null;
    const v = ev?.venueId ? await Venue.findById(ev.venueId).select('name') : null;
    return v?.name || undefined;
  } catch {
    return undefined;
  }
}
type PdfFacts = Parameters<typeof templateToPdfInput>[2];
const legacyPdf = (tpl: TemplateView, a: TemplateAssets, f: PdfFacts) =>
  renderCertificatePdf({
    brand: { primaryColor: tpl.primaryColor, accentColor: tpl.accentColor, logo: a.logoBuf ? prepareImage(a.logoBuf) : null, signatureImage: a.sigBufs[0] ? prepareImage(a.sigBufs[0]) : null, signatureName: tpl.signatureName, signatureTitle: tpl.signatureTitle },
    certId: f.certId,
    type: f.type,
    recipientName: f.recipientName,
    eventTitle: f.eventTitle,
    eventDate: f.eventDate,
    positionLabel: f.positionLabel,
    signatureText: f.signatureText ?? '',
    verifyUrl: f.verifyUrl,
    revoked: f.revoked,
  });
async function loadEvent(id: string) {
  const e = await Event.findById(oid(id, 'event id'));
  if (!e) throw notFound('Event not found');
  return e;
}

// ---------------------------------------------------------------- public verification
r.get(
  '/verify/:id',
  publicLimiter,
  wrap(async (req, res) => {
    const chk = verifyCertificateId(req.params.id);
    const c = chk.ok ? await Certificate.findOne({ certId: chk.id }) : null;
    let body: CertificateVerification;
    if (!c) body = { status: 'not_found' };
    else {
      const contest = c.contestId ? await Contest.findById(c.contestId).select('title') : null;
      body = buildVerification({ ...c.toObject(), contestTitle: c.contestId ? (contest?.title ?? c.eventTitle) : undefined, status: verificationVerdict(chk.id, c) });
    }
    res.setHeader('Cache-Control', 'no-store');
    ok(res, body); // 200 for every outcome: the verdict is in data.status
  }),
);

// ---------------------------------------------------------------- recipient
r.get(
  '/certificates/mine',
  requireAuth,
  wrap(async (req, res) => {
    const rows = await Certificate.find({ $or: [{ userId: req.user!.id }, { 'recipients.userId': req.user!.id }] }).sort({ issuedAt: -1 }).limit(200);
    ok(res, rows.map(brief));
  }),
);

r.get(
  '/certificates/:id/download',
  requireAuth,
  wrap(async (req, res) => {
    const c = await loadByCertId(req.params.id);
    const staff = isStaff(req.user);
    const own = memberIdsOf(c).includes(req.user!.id);
    if (!own && !staff) throw forbidden();
    if (c.status === 'revoked' && !staff) throw conflict('This certificate has been revoked');
    const tpl = await getTemplate(c.eventId ? String(c.eventId) : null); // contest certificates have no event: default template
    const assets = await loadTemplateAssets(tpl);
    const isTeam = (c.kind ?? 'individual') === 'team';
    const facts = {
      certId: c.certId,
      type: c.type as CertificateType,
      recipientName: c.recipientName,
      eventTitle: c.eventTitle,
      eventDate: c.eventDate,
      positionLabel: c.positionLabel ?? undefined,
      signatureText: c.signatureText ?? '',
      verifyUrl: verifyUrlFor(c.certId),
      revoked: c.status === 'revoked',
      teamName: isTeam ? (c.teamName ?? c.recipientName) : undefined,
      members: isTeam ? (c.recipients ?? []).map((m) => m.name) : undefined,
      venue: await venueNameOf(c.eventId),
    };
    let bytes: Uint8Array;
    try {
      bytes = await renderCertificatePdfKit(templateToPdfInput(tpl, assets, facts));
    } catch (e) {
      // never fail a download because of the new renderer: fall back to the dependency-free S5 renderer
      logger.error('certificate pdfkit render failed, using legacy renderer', { certId: c.certId, error: String((e as Error)?.message ?? e) });
      bytes = legacyPdf(tpl, assets, facts);
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="certificate-${c.certId}.pdf"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(bytes));
  }),
);

// ---------------------------------------------------------------- staff
const reasonSchema = z.object({ reason: z.string().trim().max(300).optional().default('') });

r.post(
  '/certificates/:id/revoke',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body ?? {});
    const c = await loadByCertId(req.params.id);
    const done = await revokeCertificate(c.certId, req.user!, reason);
    ok(res, brief(done));
  }),
);

r.post(
  '/certificates/:id/reissue',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const { reason } = parse(reasonSchema, req.body ?? {});
    const c = await loadByCertId(req.params.id);
    let ctx;
    if (c.contestId) {
      const contest = await Contest.findById(c.contestId);
      if (!contest) throw notFound('Contest not found');
      ctx = contestContext(contest);
    } else {
      const event = await loadEvent(String(c.eventId));
      ctx = { id: event.id, title: event.title, startAt: event.startAt, createdBy: event.createdBy };
    }
    const fresh = await reissueCertificate(c.certId, ctx, req.user!, reason);
    ok(res, brief(fresh), 201);
  }),
);

const listSchema = z.object({
  type: z.enum(CERTIFICATE_TYPES).optional().catch(undefined),
  status: z.enum(['valid', 'revoked']).optional().catch(undefined),
  q: z.string().trim().max(80).optional().catch(undefined),
  kind: z.enum(['individual', 'team']).optional().catch(undefined),
  limit: z.coerce.number().int().min(1).max(1000).catch(200), // legacy alias of pageSize
  pageSize: z.coerce.number().int().min(1).max(200).optional().catch(undefined),
  page: z.coerce.number().int().min(1).max(100000).catch(1),
});
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function certFilter(scope: { eventId: string } | { contestId: string }, q: z.infer<typeof listSchema>) {
  const f: Record<string, unknown> = { ...scope };
  if (q.type) f.type = q.type;
  if (q.kind) f.kind = q.kind === 'team' ? 'team' : { $ne: 'team' };
  if (q.status) f.status = q.status;
  if (q.q) {
    const rx = new RegExp(esc(q.q), 'i');
    f.$or = [{ recipientName: rx }, { certId: rx }, { teamName: rx }, { 'recipients.name': rx }];
  }
  return f;
}
r.get(
  '/events/:eventId/certificates',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const ev = await loadEvent(req.params.eventId);
    const q = listSchema.parse(req.query);
    const filter = certFilter({ eventId: ev.id }, q);
    const size = q.pageSize ?? q.limit;
    const total = await Certificate.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(q.page, pages);
    const rows = await Certificate.find(filter).sort({ type: 1, recipientName: 1, certId: 1 }).skip((page - 1) * size).limit(size);
    const meta = { total, page, pages, pageSize: size };
    // ?paged=1 -> { items, ...meta } in data (the web client does not see `meta`); default shape unchanged (array + meta)
    ok(res, req.query.paged ? { items: rows.map(brief), ...meta } : rows.map(brief), 200, meta);
  }),
);

r.get(
  '/events/:eventId/certificates/export.csv',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const ev = await loadEvent(req.params.eventId);
    const q = listSchema.parse(req.query);
    const rows = await Certificate.find(certFilter({ eventId: ev.id }, q)).sort({ type: 1, recipientName: 1, certId: 1 }).limit(10000);
    await logAction(req.user, 'certificate.export', { type: 'Event', id: ev.id }, { rows: rows.length });
    sendCsv(res, `certificates-${ev.title}`, rows.map(brief), [
      { header: 'Certificate ID', value: 'id' },
      { header: 'Recipient', value: 'recipientName' },
      { header: 'Team', value: (c) => c.teamName ?? '' },
      { header: 'Members', value: (c) => c.members.map((m) => m.name).join('; ') },
      { header: 'Type', value: 'typeLabel' },
      { header: 'Position', value: (c) => c.positionLabel ?? '' },
      { header: 'Event', value: 'eventTitle' },
      { header: 'Event date', value: (c) => new Date(c.eventDate).toISOString().slice(0, 10) },
      { header: 'Status', value: 'status' },
      { header: 'Issued at', value: (c) => new Date(c.issuedAt).toISOString() },
      { header: 'Revoked at', value: (c) => (c.revokedAt ? new Date(c.revokedAt).toISOString() : '') },
      { header: 'Revoke reason', value: (c) => c.revokeReason ?? '' },
      { header: 'Replaced by', value: (c) => c.replacedById ?? '' },
      { header: 'Verify URL', value: 'verifyUrl' },
    ]);
  }),
);

// ---------------------------------------------------------------- template (S6, extended in v6)
// One template per event. GET/PUT keep their S6 shape (legacy signatureName/signatureTitle/signatureImageUrl are still returned and accepted);
// v6 adds theme, borderStyle, fontStyle, sealEnabled, logo2Url, signatories[3], headlines, bodyText, customFields. Every text has a server-side limit.
const previewLimiter = env.isTest ? (_q: unknown, _s: unknown, n: () => void) => n() : rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: true, legacyHeaders: false });
r.get(
  '/events/:eventId/certificate-template',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const ev = await loadEvent(req.params.eventId);
    ok(res, await getTemplate(ev.id));
  }),
);
r.put(
  '/events/:eventId/certificate-template',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const ev = await loadEvent(req.params.eventId);
    const b = parse(certTemplateInputSchema, req.body ?? {});
    const saved = await saveTemplateInput(ev.id, b, req.user!.id);
    await logAction(req.user, 'certificate.template', { type: 'Event', id: ev.id }, b);
    ok(res, saved);
  }),
);
r.delete(
  '/events/:eventId/certificate-template',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const ev = await loadEvent(req.params.eventId);
    await resetTemplate(ev.id);
    await logAction(req.user, 'certificate.template_reset', { type: 'Event', id: ev.id });
    ok(res, await getTemplate(ev.id));
  }),
);
// Live preview: renders the REAL PDF with sample data. The body may carry unsaved edits (same shape as PUT); nothing is written.
const previewSchema = z.object({ sample: z.enum(CERT_SAMPLE_KINDS).optional().default('individual'), template: certTemplateInputSchema.optional().default({}) });
r.post(
  '/events/:eventId/certificate-template/preview',
  requireAuth,
  manage,
  previewLimiter,
  wrap(async (req, res) => {
    const ev = await loadEvent(req.params.eventId);
    const b = parse(previewSchema, req.body ?? {});
    const tpl = mergeTemplateInput(await getTemplate(ev.id), b.template);
    const facts = sampleCertificate(b.sample, { title: ev.title, date: ev.startAt, venue: await venueNameOf(ev.id) }, verifyUrlFor('FH-SAMPLE-PREVIEW'));
    const bytes = await renderCertificatePdfKit(templateToPdfInput(tpl, await loadTemplateAssets(tpl), facts));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="certificate-preview.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(Buffer.from(bytes));
  }),
);
const SLOT_PATHS: [string, ImageSlot][] = [['logo', 'logo'], ['logo2', 'logo2'], ['signature', 'sig1'], ['signatory-1', 'sig1'], ['signatory-2', 'sig2'], ['signatory-3', 'sig3']];
for (const [seg, slot] of SLOT_PATHS) {
  if (!IMAGE_SLOTS.includes(slot)) continue;
  r.post(
    `/events/:eventId/certificate-template/${seg}`,
    requireAuth,
    manage,
    (req, res, next) => {
      certImageUpload.single('file')(req, res, (err: unknown) => {
        if (err) return next(mapCertUploadError(err));
        if (!req.file) return next(badRequest('Choose an image to upload'));
        (async () => {
          const ev = await loadEvent(String(req.params.eventId));
          const url = await saveCertImage(req.file!.buffer); // magic bytes + size already enforced
          const prev = await setTemplateImage(ev.id, slot, url, req.user!.id);
          await removeCertImage(prev);
          await logAction(req.user, `certificate.template_${seg}`, { type: 'Event', id: ev.id });
          ok(res, await getTemplate(ev.id), 201);
        })().catch(next);
      });
    },
  );
  r.delete(
    `/events/:eventId/certificate-template/${seg}`,
    requireAuth,
    manage,
    wrap(async (req, res) => {
      const ev = await loadEvent(req.params.eventId);
      await removeCertImage(await clearTemplateImage(ev.id, slot));
      ok(res, await getTemplate(ev.id));
    }),
  );
}

const generateSchema = z.object({
  types: z.array(z.enum(CERTIFICATE_TYPES)).min(1).max(CERTIFICATE_TYPES.length).optional(),
  attendedOnly: z.boolean().optional().default(true),
  signatureText: z.string().trim().max(120).optional(),
});
r.post(
  '/events/:eventId/certificates/generate',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const ev = await loadEvent(req.params.eventId);
    if (ev.status === 'draft' || ev.status === 'cancelled') throw unprocessable(`Certificates cannot be generated for a ${ev.status} event`);
    const b = parse(generateSchema, req.body ?? {});
    const types = [...new Set(b.types ?? CERTIFICATE_TYPES)] as CertificateType[];
    const summary = await bulkGenerate({ id: ev.id, title: ev.title, startAt: ev.startAt, createdBy: ev.createdBy }, types, { attendedOnly: b.attendedOnly, signatureText: b.signatureText }, req.user!);
    ok(res, summary, 201);
  }),
);

const singleSchema = z.object({
  userId: z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid user id'),
  type: z.enum(CERTIFICATE_TYPES),
  position: z.number().int().min(1).max(20).optional(),
  positionLabel: z.string().trim().max(120).optional(),
  signatureText: z.string().trim().max(120).optional(),
});
r.post(
  '/events/:eventId/certificates',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const ev = await loadEvent(req.params.eventId);
    if (ev.status === 'cancelled') throw unprocessable('Certificates cannot be issued for a cancelled event');
    const b = parse(singleSchema, req.body);
    const user = await User.findById(b.userId).select('name');
    if (!user) throw notFound('User not found');
    const position = b.position ?? (b.type === 'winner' ? 1 : b.type === 'runner_up' ? 2 : undefined);
    const positionLabel = defaultPositionLabel(b.type, ev.title, position, b.positionLabel);
    const { cert, created } = await issueCertificate({
      event: { id: ev.id, title: ev.title, startAt: ev.startAt, createdBy: ev.createdBy },
      userId: user.id,
      type: b.type,
      position,
      positionLabel,
      recipientName: user.name,
      signatureText: b.signatureText,
      issuedBy: req.user!.id,
    });
    if (!created) throw conflict(`A valid ${b.type} certificate already exists for this person (ID ${cert.certId}). Revoke or reissue it instead.`);
    await logAction(req.user, 'certificate.issue', { type: 'Certificate', id: cert.certId }, { eventId: ev.id, userId: user.id, type: b.type });
    await notifyIssued(cert);
    ok(res, brief(cert), 201);
  }),
);

// ---------------------------------------------------------------- contests (v4)
async function loadContest(id: string) {
  const c = await Contest.findById(oid(id, 'contest id'));
  if (!c) throw notFound('Contest not found');
  return c;
}
r.get(
  '/contests/:id/certificates',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const c = await loadContest(req.params.id);
    const q = listSchema.parse(req.query);
    const filter = certFilter({ contestId: c.id }, q);
    const size = q.pageSize ?? q.limit;
    const total = await Certificate.countDocuments(filter);
    const pages = Math.max(1, Math.ceil(total / size));
    const page = Math.min(q.page, pages);
    const rows = await Certificate.find(filter).sort({ type: 1, recipientName: 1, certId: 1 }).skip((page - 1) * size).limit(size);
    const meta = { total, page, pages, pageSize: size };
    ok(res, req.query.paged ? { items: rows.map(brief), ...meta } : rows.map(brief), 200, meta);
  }),
);
r.get(
  '/contests/:id/certificates/export.csv',
  requireAuth,
  view,
  wrap(async (req, res) => {
    const c = await loadContest(req.params.id);
    const q = listSchema.parse(req.query);
    const rows = await Certificate.find(certFilter({ contestId: c.id }, q)).sort({ type: 1, recipientName: 1, certId: 1 }).limit(10000);
    await logAction(req.user, 'certificate.export', { type: 'Contest', id: c.id }, { rows: rows.length });
    sendCsv(res, `certificates-${c.title}`, rows.map(brief), [
      { header: 'Certificate ID', value: 'id' },
      { header: 'Recipient', value: 'recipientName' },
      { header: 'Team', value: (x) => x.teamName ?? '' },
      { header: 'Members', value: (x) => x.members.map((m) => m.name).join('; ') },
      { header: 'Type', value: 'typeLabel' },
      { header: 'Position', value: (x) => x.positionLabel ?? '' },
      { header: 'Contest', value: 'eventTitle' },
      { header: 'Contest date', value: (x) => new Date(x.eventDate).toISOString().slice(0, 10) },
      { header: 'Status', value: 'status' },
      { header: 'Issued at', value: (x) => new Date(x.issuedAt).toISOString() },
      { header: 'Revoked at', value: (x) => (x.revokedAt ? new Date(x.revokedAt).toISOString() : '') },
      { header: 'Revoke reason', value: (x) => x.revokeReason ?? '' },
      { header: 'Replaced by', value: (x) => x.replacedById ?? '' },
      { header: 'Verify URL', value: 'verifyUrl' },
    ]);
  }),
);
const contestGenerateSchema = z.object({
  types: z.array(z.enum(CONTEST_CERT_TYPES)).min(1).max(CONTEST_CERT_TYPES.length).optional(),
  signatureText: z.string().trim().max(120).optional(),
});
r.post(
  '/contests/:id/certificates/generate',
  requireAuth,
  manage,
  wrap(async (req, res) => {
    const c = await loadContest(req.params.id);
    const b = parse(contestGenerateSchema, req.body ?? {});
    const types = [...new Set(b.types ?? CONTEST_CERT_TYPES)] as CertificateType[];
    ok(res, await bulkGenerateContest(c, types, { signatureText: b.signatureText }, req.user!), 201);
  }),
);

export default r;
