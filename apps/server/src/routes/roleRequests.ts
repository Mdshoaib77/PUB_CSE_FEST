import { Router } from 'express';
import { z } from 'zod';
import { ROLE_REQUEST_COOLDOWN_HOURS, ROLE_REQUEST_STATUSES, roleRequestSchema } from '@festhub/shared';
import { RoleRequest, User } from '../models';
import { hasRole, requireAuth, requireRole, type AuthUser } from '../middleware/auth';
import { conflict, notFound, unprocessable } from '../utils/errors';
import { oid, ok, parse, wrap } from '../utils/http';
import { logAction } from '../utils/audit';
import { notifyRoleDecision, notifyRoleRequested } from '../services/roleNotices';

const r = Router();
r.use(requireAuth);

type RR = InstanceType<typeof RoleRequest>;

/** employeeId is personal data: only organisers/admins and the person who filed the request may see it. */
const canSeeEmployeeId = (viewer: AuthUser | undefined, ownerId: string) => !!viewer && (viewer.id === ownerId || hasRole(viewer, 'organiser'));

const view = (rr: RR, viewer: AuthUser | undefined) => ({
  id: rr.id as string,
  userId: String(rr.userId),
  role: rr.role,
  status: rr.status,
  designation: rr.designation ?? null,
  ...(canSeeEmployeeId(viewer, String(rr.userId)) ? { employeeId: rr.employeeId ?? null } : {}),
  decidedBy: rr.decidedBy ? String(rr.decidedBy) : null,
  decidedAt: rr.decidedAt ?? null,
  rejectReason: rr.rejectReason ?? null,
  createdAt: (rr as unknown as { createdAt?: Date }).createdAt ?? null,
});

// POST /role-requests: ask for judge or coordinator
r.post(
  '/',
  wrap(async (req, res) => {
    const b = parse(roleRequestSchema, req.body);
    const me = req.user!;
    if (me.roles.includes(b.role)) throw conflict(`You already have the ${b.role} role`);
    if (await RoleRequest.exists({ userId: me.id, role: b.role, status: 'pending' })) throw conflict(`You already have a pending ${b.role} request`);
    const rejected = await RoleRequest.findOne({
      userId: me.id,
      role: b.role,
      status: 'rejected',
      decidedAt: { $gt: new Date(Date.now() - ROLE_REQUEST_COOLDOWN_HOURS * 3600_000) },
    }).sort({ decidedAt: -1 });
    if (rejected?.decidedAt) {
      const retryAt = new Date(rejected.decidedAt.getTime() + ROLE_REQUEST_COOLDOWN_HOURS * 3600_000);
      throw unprocessable(`Your last ${b.role} request was rejected. You can request again after ${retryAt.toISOString()}`, { retryAt });
    }
    let rr: RR;
    try {
      rr = await RoleRequest.create({
        userId: me.id,
        role: b.role,
        ...(b.role === 'judge' ? { designation: b.designation, employeeId: b.employeeId } : {}),
      });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw conflict(`You already have a pending ${b.role} request`); // lost a race with the unique partial index
      throw e;
    }
    await logAction(me, 'role_request.create', { type: 'RoleRequest', id: rr.id }, { role: b.role }, req);
    await notifyRoleRequested({ id: rr.id, userId: me.id, role: rr.role }, me.name);
    ok(res, view(rr, me), 201);
  }),
);

// GET /role-requests/me: my own requests
r.get(
  '/me',
  wrap(async (req, res) => {
    const rows = await RoleRequest.find({ userId: req.user!.id }).sort({ createdAt: -1 }).limit(100);
    ok(res, rows.map((x) => view(x, req.user)));
  }),
);

// GET /role-requests?status=pending|approved|rejected: organiser/admin inbox
r.get(
  '/',
  requireRole('organiser'),
  wrap(async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(ROLE_REQUEST_STATUSES).optional() }), req.query);
    const rows = await RoleRequest.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(200);
    const users = await User.find({ _id: { $in: rows.map((x) => x.userId) } }).select('name email');
    const byId = new Map(users.map((u) => [u.id as string, u]));
    ok(
      res,
      rows.map((x) => {
        const u = byId.get(String(x.userId));
        return { ...view(x, req.user), user: u ? { id: u.id as string, name: u.name, email: u.email } : null };
      }),
    );
  }),
);

/** Moves a pending request to its decided state in one atomic step, so two organisers can never decide the same request twice. */
async function decide(id: string, by: string, set: Record<string, unknown>) {
  const rr = await RoleRequest.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { ...set, decidedBy: by, decidedAt: new Date() } }, { new: true });
  if (rr) return rr;
  const existing = await RoleRequest.findById(id).select('status');
  if (!existing) throw notFound('Role request not found');
  throw conflict(`This request was already ${existing.status}`);
}

// POST /role-requests/:id/approve: adds the role, keeps every existing role
r.post(
  '/:id/approve',
  requireRole('organiser'),
  wrap(async (req, res) => {
    const id = oid(req.params.id, 'role request id');
    const pending = await RoleRequest.findById(id).select('userId status');
    if (pending?.status === 'pending' && !(await User.exists({ _id: pending.userId }))) throw notFound('The requesting user no longer exists');
    const rr = await decide(id, req.user!.id, { status: 'approved' });
    await User.updateOne({ _id: rr.userId }, { $addToSet: { roles: rr.role } });
    await logAction(req.user, 'role_request.approve', { type: 'RoleRequest', id: rr.id }, { userId: String(rr.userId), role: rr.role }, req);
    await notifyRoleDecision({ id: rr.id, userId: String(rr.userId), role: rr.role }, true);
    ok(res, view(rr, req.user));
  }),
);

// POST /role-requests/:id/reject: optional reason
r.post(
  '/:id/reject',
  requireRole('organiser'),
  wrap(async (req, res) => {
    const id = oid(req.params.id, 'role request id');
    const { rejectReason } = parse(z.object({ rejectReason: z.string().trim().max(500).optional() }), req.body ?? {});
    const rr = await decide(id, req.user!.id, { status: 'rejected', ...(rejectReason ? { rejectReason } : {}) });
    await logAction(req.user, 'role_request.reject', { type: 'RoleRequest', id: rr.id }, { userId: String(rr.userId), role: rr.role, rejectReason }, req);
    await notifyRoleDecision({ id: rr.id, userId: String(rr.userId), role: rr.role }, false, rejectReason);
    ok(res, view(rr, req.user));
  }),
);

export default r;
