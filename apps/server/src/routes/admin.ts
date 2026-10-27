import { Router } from 'express';
import { z } from 'zod';
import { AuditLog, User } from '../models';
import { requireAuth, requireRole } from '../middleware/auth';
import { ok, parse, wrap } from '../utils/http';
import { logAction } from '../utils/audit';

/**
 * Admin area. Mounted at /api/v1/admin.
 *   GET /admin/audit             filtered, paginated audit trail
 *   GET /admin/audit/facets      distinct actions / entity types for the filter dropdowns
 *   GET /admin/audit/export.csv  same filters, CSV download (max 10 000 rows)
 */
const r = Router();
r.use(requireAuth, requireRole('admin', 'organiser'));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');
const dateish = z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.date().optional());
const filterSchema = z.object({
  q: z.string().trim().max(100).optional(),
  actor: objectId.optional().or(z.literal('').transform(() => undefined)),
  action: z.string().trim().max(80).optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.string().trim().max(80).optional(),
  from: dateish,
  to: dateish,
  sort: z.enum(['asc', 'desc']).default('desc'),
});
const pageSchema = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) });

function buildFilter(f: z.infer<typeof filterSchema>) {
  const m: Record<string, unknown> = {};
  if (f.actor) m.actorId = f.actor;
  if (f.action) m.action = f.action.includes('*') || f.action.endsWith('.') ? { $regex: `^${esc(f.action.replace(/\*/g, ''))}` } : f.action;
  if (f.entityType) m.entityType = f.entityType;
  if (f.entityId) m.entityId = f.entityId;
  if (f.from || f.to) {
    const at: Record<string, Date> = {};
    if (f.from) at.$gte = f.from;
    if (f.to) {
      const t = new Date(f.to);
      if (t.getUTCHours() === 0 && t.getUTCMinutes() === 0) t.setUTCHours(23, 59, 59, 999); // a bare date means "through the end of that day"
      at.$lte = t;
    }
    m.at = at;
  }
  if (f.q) {
    const rx = { $regex: esc(f.q), $options: 'i' };
    m.$or = [{ action: rx }, { entityType: rx }, { entityId: rx }, { actorName: rx }];
  }
  return m;
}

async function withActors<T extends { actorId?: unknown; actorName?: string | null }>(rows: T[]) {
  const ids = [...new Set(rows.map((x) => (x.actorId ? String(x.actorId) : '')).filter(Boolean))];
  const users = ids.length ? await User.find({ _id: { $in: ids } }).select('name email roles') : [];
  const by = new Map(users.map((u) => [u.id as string, u]));
  return rows.map((x) => {
    const u = x.actorId ? by.get(String(x.actorId)) : undefined;
    return { ...x, actor: x.actorId ? { id: String(x.actorId), name: u?.name ?? x.actorName ?? '(deleted user)', email: u?.email ?? null } : null };
  });
}

r.get(
  '/audit',
  wrap(async (req, res) => {
    const f = parse(filterSchema, req.query);
    const { page, limit } = parse(pageSchema, req.query);
    const match = buildFilter(f);
    const [total, rows] = await Promise.all([
      AuditLog.countDocuments(match),
      AuditLog.find(match)
        .sort({ at: f.sort === 'asc' ? 1 : -1, _id: f.sort === 'asc' ? 1 : -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);
    const items = await withActors(rows.map((x) => ({ ...x, id: String(x._id) })));
    ok(res, { items, page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
  }),
);

r.get(
  '/audit/facets',
  wrap(async (_req, res) => {
    const [actions, entityTypes] = await Promise.all([AuditLog.distinct('action'), AuditLog.distinct('entityType')]);
    ok(res, { actions: actions.filter(Boolean).sort(), entityTypes: entityTypes.filter(Boolean).sort() });
  }),
);

/** CSV cells starting with = + - @ are prefixed with ' so spreadsheet apps never evaluate them as formulas. */
const cell = (v: unknown) => {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const EXPORT_MAX = 10_000;

r.get(
  '/audit/export.csv',
  wrap(async (req, res) => {
    const f = parse(filterSchema, req.query);
    const match = buildFilter(f);
    const rows = await AuditLog.find(match)
      .sort({ at: f.sort === 'asc' ? 1 : -1, _id: -1 })
      .limit(EXPORT_MAX)
      .lean();
    const items = await withActors(rows);
    const lines = [['time_utc', 'actor_id', 'actor_name', 'actor_email', 'action', 'entity_type', 'entity_id', 'ip', 'details'].join(',')];
    for (const x of items) {
      lines.push(
        [x.at instanceof Date ? x.at.toISOString() : x.at, x.actor?.id, x.actor?.name, x.actor?.email, x.action, x.entityType, x.entityId, x.ip, x.meta]
          .map(cell)
          .join(','),
      );
    }
    await logAction(req.user, 'audit.export', 'AuditLog', { filters: f, rows: items.length }, req);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(`\uFEFF${lines.join('\r\n')}\r\n`);
  }),
);

export default r;
