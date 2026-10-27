import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { roleSatisfies, type Role } from '@festhub/shared';
import { env } from '../config/env';
import { forbidden, unauthorized } from '../utils/errors';
import { User } from '../models';

export interface AuthUser {
  id: string;
  roles: Role[];
  name: string;
}
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export const signAccess = (u: { id: string; roles: Role[] }) => jwt.sign({ sub: u.id, roles: u.roles }, env.jwtAccessSecret, { expiresIn: '15m' });

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw unauthorized();
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(h.slice(7), env.jwtAccessSecret) as jwt.JwtPayload;
    } catch {
      throw unauthorized('Invalid or expired token');
    }
    // Roles are re-read from the DB so a role change/revocation applies immediately.
    const u = await User.findById(payload.sub).select('roles name active');
    if (!u || !u.active) throw unauthorized('Account not found or disabled');
    req.user = { id: u.id, roles: u.roles as Role[], name: u.name };
    next();
  } catch (e) {
    next(e);
  }
}

/** Optional auth: sets req.user when a valid token is present, never fails. */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.headers.authorization) return next();
  return requireAuth(req, _res, (err?: unknown) => {
    if (err) req.user = undefined;
    next();
  });
}

/**
 * Reusable role guard: `router.post('/x', requireRole('organiser', 'judge'), handler)`.
 * 401 when signed out, 403 when none of the roles match. `admin` always passes wherever `organiser` is allowed;
 * to restrict a route to admins only, pass 'admin' alone. Must run after `requireAuth`.
 */
export const requireRole =
  (...allowed: Role[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roleSatisfies(req.user.roles, allowed)) return next(forbidden());
    next();
  };
/** Shortcut: authenticate, then require one of the roles (for routers that do not call `r.use(requireAuth)`). */
export const protect = (...allowed: Role[]) => [requireAuth, requireRole(...allowed)];
export const requireAdmin = protect('admin');

export const hasRole = (u: AuthUser | undefined, ...roles: Role[]) => !!u && roleSatisfies(u.roles, roles);
export const isAdmin = (u?: AuthUser) => hasRole(u, 'admin');
export const isStaff = (u?: AuthUser) => hasRole(u, 'organiser', 'coordinator');
