import { Notification, User } from '../models';
import { emitTo } from '../sockets/io';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { mailEnabled, sendMail } from './mailer';

/** Headline used for notifications created with the legacy `(userId, type, message, refs)` signature (also by the S3 migration). */
export const NOTICE_TITLES: Record<string, string> = {
  registration: 'Registration update',
  waitlist: 'Waiting list update',
  shift: 'Volunteer shift',
  announcement: 'Announcement',
  result: 'Results published',
  invitation: 'Team invitation',
  team: 'Team update',
  task: 'New task',
  issue: 'Issue assigned',
  event: 'Event update',
  replacement: 'Shift replacement',
  judging: 'Judging assignment',
  role: 'Role update',
  general: 'Notification',
};

/** Only in-app paths are accepted ("/events/1"), never external or protocol-relative URLs. */
export const safeLink = (l?: unknown): string | undefined => (typeof l === 'string' && /^\/(?!\/)[^\s\\]{0,299}$/.test(l.trim()) ? l.trim() : undefined);

/** Accepts an id string, an ObjectId, a Mongoose document, or `{ id }`. */
export const userIdOf = (u: unknown): string => {
  if (u && typeof u === 'object' && typeof (u as { id?: unknown }).id === 'string') return (u as { id: string }).id;
  return String(u);
};

interface Draft {
  userId: string;
  type: string;
  title: string;
  message: string;
  link?: string;
  refs?: Record<string, unknown>;
}

async function emailCopy(d: Draft) {
  try {
    const u = await User.findById(d.userId).select('email name active');
    if (!u?.email || u.active === false) return;
    const url = d.link ? `${env.appUrl}${d.link}` : env.appUrl;
    await sendMail({
      to: u.email,
      subject: `[FestHub] ${d.title}`,
      text: `Hi ${u.name},\n\n${d.message}\n\nOpen FestHub: ${url}\n\n— FestHub\nYou are receiving this because you have a FestHub account.`,
    });
  } catch (e) {
    logger.warn('notification email failed', { message: (e as Error).message });
  }
}

async function create(d: Draft) {
  const title = d.title.trim().slice(0, 120) || NOTICE_TITLES.general;
  const message = d.message.trim().slice(0, 1000) || title;
  const link = safeLink(d.link);
  const n = await Notification.create({ userId: d.userId, type: d.type, title, message, link, refs: d.refs });
  emitTo(`user:${d.userId}`, 'notification:new', {
    id: n.id,
    type: d.type,
    title,
    message,
    link,
    createdAt: (n as { createdAt?: Date }).createdAt ?? new Date(),
  });
  if (mailEnabled()) void emailCopy({ ...d, title, message, link }); // fire-and-forget: e-mail never slows or fails the request
  return n;
}

/**
 * Create an in-app notification (+ live Socket.IO push, + e-mail when SMTP_* is configured).
 *   await notify(user, 'Shift assigned', 'You were assigned to Registration desk', '/volunteer')
 * `user` may be an id, ObjectId, document or `{ id }`; `link` must be an in-app path.
 */
export async function notify(user: unknown, title: string, message: string, link?: string) {
  return create({ userId: userIdOf(user), type: 'general', title, message, link });
}

/**
 * Legacy typed form used by the v1 features: `(userId, type, message, refs)`. Title and link are derived from the type/refs,
 * so existing call sites need no change (they import it as `notify`; see the import aliases).
 */
export async function notifyTyped(userId: unknown, type: string, message: string, refs?: Record<string, unknown>, linkOverride?: string) {
  const eventId = refs?.eventId ? String(refs.eventId) : undefined;
  const link = eventId && /^[a-f0-9]{24}$/i.test(eventId) ? `/events/${eventId}` : ['shift', 'task', 'replacement'].includes(type) ? '/volunteer' : undefined;
  return create({ userId: userIdOf(userId), type, title: NOTICE_TITLES[type] ?? NOTICE_TITLES.general, message, link: safeLink(linkOverride) ?? link, refs });
}
