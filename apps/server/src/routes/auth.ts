import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { attachEmailInvites } from '../services/invites';
import { attachContestInvites } from '../services/contest-invites';
import { loginSchema, registerSchema, type Role } from '@festhub/shared';
import { env } from '../config/env';
import { RefreshToken, RoleRequest, User } from '../models';
import { requireAuth, signAccess } from '../middleware/auth';
import { conflict, unauthorized } from '../utils/errors';
import { ok, parse, wrap } from '../utils/http';
import { logAction } from '../utils/audit';
import { notifyRoleRequested } from '../services/roleNotices';

const r = Router();
const COST = env.isTest ? 4 : 12;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', COST);
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const limiter = env.isTest
  ? (_q: unknown, _s: unknown, n: () => void) => n()
  : rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });

export const publicUser = (u: { id?: string; name: string; email: string; roles: string[]; department?: string | null; batch?: string | null }) => ({
  id: u.id as string,
  name: u.name,
  email: u.email,
  roles: u.roles,
  department: u.department ?? null,
  batch: u.batch ?? null,
});

async function issue(res: import('express').Response, u: { id?: string; roles: string[] }) {
  const raw = crypto.randomBytes(48).toString('hex');
  await RefreshToken.create({ userId: u.id, tokenHash: sha(raw), expiresAt: new Date(Date.now() + 7 * 864e5) });
  res.cookie('refresh_token', raw, { httpOnly: true, secure: env.cookie.secure, sameSite: env.cookie.sameSite, maxAge: 7 * 864e5, path: '/api/v1/auth' });
  return signAccess({ id: u.id as string, roles: u.roles as Role[] });
}

r.post(
  '/register',
  limiter,
  wrap(async (req, res) => {
    const b = parse(registerSchema, req.body);
    if (await User.exists({ email: b.email })) throw conflict('An account with this email already exists');
    const u = await User.create({
      name: b.name,
      email: b.email,
      passwordHash: await bcrypt.hash(b.password, COST),
      roles: [b.role],
      department: b.department,
      batch: b.batch,
    });
    // Staff roles are never granted at sign-up: the account keeps its self-assigned role and a pending request is filed for an organiser.
    if (b.requestedRole) {
      const rr = await RoleRequest.create({
        userId: u.id,
        role: b.requestedRole,
        ...(b.requestedRole === 'judge' ? { designation: b.designation, employeeId: b.employeeId } : {}),
      });
      await notifyRoleRequested({ id: rr.id, userId: u.id, role: rr.role }, u.name);
    }
    await attachEmailInvites({ id: u.id, email: u.email, name: u.name });
    await attachContestInvites({ id: u.id, email: u.email, name: u.name });
    await logAction({ id: u.id, name: u.name }, 'auth.register', { type: 'User', id: u.id }, { role: b.role, requestedRole: b.requestedRole }, req);
    ok(res, { user: publicUser(u), accessToken: await issue(res, u) }, 201);
  }),
);

r.post(
  '/login',
  limiter,
  wrap(async (req, res) => {
    const b = parse(loginSchema, req.body);
    const u = await User.findOne({ email: b.email }).select('+passwordHash');
    const good = await bcrypt.compare(b.password, u?.passwordHash ?? DUMMY_HASH); // constant-ish time, no user enumeration
    if (!u || !good || !u.active) {
      await logAction(
        u ? { id: u.id, name: u.name } : undefined,
        'auth.login_failed',
        { type: 'User', id: u?.id },
        { email: b.email, reason: !u ? 'unknown_email' : !u.active ? 'disabled' : 'bad_password' },
        req,
      );
      throw unauthorized('Invalid email or password');
    }
    await attachEmailInvites({ id: u.id, email: u.email, name: u.name });
    await attachContestInvites({ id: u.id, email: u.email, name: u.name });
    await logAction({ id: u.id, name: u.name }, 'auth.login', { type: 'User', id: u.id }, undefined, req);
    ok(res, { user: publicUser(u), accessToken: await issue(res, u) });
  }),
);

r.post(
  '/refresh',
  wrap(async (req, res) => {
    const raw = req.cookies?.refresh_token as string | undefined;
    if (!raw) throw unauthorized('No session');
    const t = await RefreshToken.findOneAndUpdate(
      { tokenHash: sha(raw), revokedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { revokedAt: new Date() } },
    );
    if (!t) throw unauthorized('Session expired');
    const u = await User.findById(t.userId);
    if (!u || !u.active) throw unauthorized('Account not found');
    ok(res, { user: publicUser(u), accessToken: await issue(res, u) });
  }),
);

r.post(
  '/logout',
  wrap(async (req, res) => {
    const raw = req.cookies?.refresh_token as string | undefined;
    if (raw) await RefreshToken.updateOne({ tokenHash: sha(raw) }, { $set: { revokedAt: new Date() } });
    res.clearCookie('refresh_token', { path: '/api/v1/auth', secure: env.cookie.secure, sameSite: env.cookie.sameSite, httpOnly: true });
    ok(res, { loggedOut: true });
  }),
);

r.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const u = await User.findById(req.user!.id);
    ok(res, publicUser(u!));
  }),
);

export default r;
