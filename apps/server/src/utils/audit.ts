import type { Request } from 'express';
import { AuditLog } from '../models';
import { logger } from './logger';

/** Who did it: a signed-in user (`req.user`), a bare id, or nothing (system / anonymous). */
export type AuditActor = { id?: string; name?: string } | string | null | undefined;
/** What it was done to: `{ type, id }`, `'Type:id'`, or just `'Type'`. */
export type AuditEntity = { type: string; id?: unknown } | string;

const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie|hash/i;
const MAX_DETAILS_CHARS = 4000;

/** Strip secrets and cap size so a log row can never leak credentials or bloat the collection. */
export function sanitizeDetails(d: unknown, depth = 0): unknown {
  if (d == null || typeof d === 'number' || typeof d === 'boolean') return d;
  if (typeof d === 'string') return d.length > 500 ? `${d.slice(0, 500)}…` : d;
  if (d instanceof Date) return d.toISOString();
  if (depth > 4) return '[truncated]';
  if (Array.isArray(d)) return d.slice(0, 50).map((x) => sanitizeDetails(x, depth + 1));
  if (typeof d === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d as Record<string, unknown>).slice(0, 50)) {
      out[k.replace(/[.$]/g, '_')] = SECRET_KEY.test(k) ? '[redacted]' : sanitizeDetails(v, depth + 1);
    }
    return out;
  }
  return String(d);
}

function splitEntity(e: AuditEntity): { type?: string; id?: string } {
  if (typeof e === 'string') {
    const i = e.indexOf(':');
    return i < 0 ? { type: e.slice(0, 40) } : { type: e.slice(0, i).slice(0, 40), id: e.slice(i + 1).slice(0, 80) };
  }
  return { type: e.type.slice(0, 40), id: e.id == null ? undefined : String(e.id).slice(0, 80) };
}

/**
 * Record an audit event. Never throws: a failing log write must not fail the user's request (it is logged instead).
 *   logAction(req.user, 'event.publish', { type: 'Event', id: ev.id }, { title: ev.title })
 * Pass `req` as the 5th argument to also store the client IP.
 */
export async function logAction(user: AuditActor, action: string, entity: AuditEntity, details?: Record<string, unknown>, req?: Pick<Request, 'ip'>) {
  try {
    const actor = typeof user === 'string' ? { id: user } : (user ?? {});
    const e = splitEntity(entity);
    let meta = details === undefined ? undefined : sanitizeDetails(details);
    if (meta !== undefined && JSON.stringify(meta).length > MAX_DETAILS_CHARS) meta = { truncated: true };
    await AuditLog.create({
      actorId: actor.id || undefined,
      actorName: actor.name,
      action: String(action).slice(0, 80),
      entityType: e.type,
      entityId: e.id,
      meta,
      ip: req?.ip,
      at: new Date(),
    });
  } catch (err) {
    logger.error('audit write failed', { action, message: (err as Error).message });
  }
}
/** snake_case alias requested by the spec: log_action(user, action, entity, details). */
export const log_action = logAction;

/** Legacy signature used across the code base (kept so existing call sites are unchanged). */
export async function audit(actorId: string | undefined, action: string, entityType: string, entityId: unknown, meta?: Record<string, unknown>) {
  await logAction(actorId, action, { type: entityType, id: entityId }, meta);
}
