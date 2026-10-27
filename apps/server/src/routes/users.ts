import { Router } from 'express';
import { z } from 'zod';
import { ROLES } from '@festhub/shared';
import { User } from '../models';
import { hasRole, requireAuth, requireRole } from '../middleware/auth';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { oid, ok, parse, wrap } from '../utils/http';
import { audit, logAction } from '../utils/audit';
import { publicUser } from './auth';
import { purgeUser } from '../services/cascade';
import { notifyRolesChanged } from '../services/roleNotices';

const r = Router();
r.use(requireAuth);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

r.get(
  '/',
  requireRole('organiser', 'coordinator'),
  wrap(async (req, res) => {
    const q = String(req.query.q ?? '').trim();
    const f: Record<string, unknown> = {};
    if (q) f.$or = [{ name: { $regex: esc(q), $options: 'i' } }, { email: { $regex: esc(q), $options: 'i' } }];
    if (req.query.role) f.roles = String(req.query.role);
    const users = await User.find(f).sort({ name: 1 }).limit(200);
    ok(res, users.map(publicUser));
  }),
);

r.patch(
  '/:id/roles',
  requireRole('organiser'),
  wrap(async (req, res) => {
    const { roles: raw } = parse(z.object({ roles: z.array(z.enum(ROLES)).min(1).max(ROLES.length) }), req.body);
    const roles = [...new Set(raw)];
    const id = oid(req.params.id);
    if (id === req.user!.id && !roles.includes('organiser') && !roles.includes('admin')) throw badRequest('You cannot remove your own organiser role');
    const before = await User.findById(id).select('roles');
    if (!before) throw notFound('User not found');
    // Only an admin may grant or revoke the admin role (an organiser must not be able to escalate anyone, including themselves).
    if (roles.includes('admin') !== before.roles.includes('admin') && !hasRole(req.user, 'admin'))
      throw forbidden('Only an admin can grant or revoke the admin role');
    if (id === req.user!.id && before.roles.includes('admin') && !roles.includes('admin')) throw badRequest('You cannot remove your own admin role');
    await User.updateOne({ _id: id }, { roles });
    const u = await User.findById(id);
    await logAction(req.user, 'user.roles', { type: 'User', id }, { before: before.roles, after: roles }, req);
    await notifyRolesChanged(id, before.roles, roles);
    ok(res, publicUser(u!));
  }),
);

r.delete(
  '/:id',
  requireRole('organiser'),
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    if (id === req.user!.id) throw badRequest('You cannot delete your own account while signed in');
    const u = await User.findById(id);
    if (!u) throw notFound('User not found');
    if (u.roles.includes('admin') && !hasRole(req.user, 'admin')) throw forbidden('Only an admin can delete an admin account');
    if (
      (u.roles.includes('organiser') || u.roles.includes('admin')) &&
      (await User.countDocuments({ roles: { $in: ['organiser', 'admin'] }, _id: { $ne: id } })) === 0
    )
      throw badRequest('You cannot delete the last organiser');
    await purgeUser(id);
    await audit(req.user!.id, 'user.delete', 'User', id, { email: u.email });
    ok(res, { deleted: true, id });
  }),
);

export default r;
