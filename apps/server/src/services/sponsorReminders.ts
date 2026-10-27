/** Sponsor follow-up reminders (S7). One notification per sponsor per scheduled follow-up date, sent to the relationship owner. */
import { Sponsor, User } from '../models';
import { notify } from './notify';
import { logger } from '../utils/logger';

const endOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));

export interface ReminderResult {
  checked: number;
  sent: number;
}

/** Notify the owner of every open sponsor whose follow-up date is today or earlier and has not been reminded for that date yet. Idempotent and safe to run concurrently (atomic claim). */
export async function sendFollowUpReminders(now = new Date()): Promise<ReminderResult> {
  const due = await Sponsor.find({ status: { $ne: 'received' }, nextFollowUpAt: { $lte: endOfDay(now) } }).limit(500);
  let sent = 0;
  let fallback: string[] | null = null;
  for (const s of due) {
    const claimed = await Sponsor.findOneAndUpdate(
      { _id: s._id, nextFollowUpAt: s.nextFollowUpAt, $or: [{ reminderFor: { $exists: false } }, { reminderFor: null }, { reminderFor: { $ne: s.nextFollowUpAt } }] },
      { $set: { reminderFor: s.nextFollowUpAt } },
    );
    if (!claimed) continue;
    let to: string[] = [String(s.ownerId ?? s.createdBy ?? '')].filter(Boolean);
    if (to.length) {
      const u = await User.findOne({ _id: to[0], active: true }).select('_id');
      if (!u) to = [];
    }
    if (!to.length) fallback ??= (await User.find({ roles: { $in: ['organiser', 'admin'] }, active: true }).select('_id').limit(10)).map((u) => String(u._id));
    const when = s.nextFollowUpAt!.toISOString().slice(0, 10);
    const overdue = s.nextFollowUpAt! < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    for (const uid of to.length ? to : fallback ?? []) {
      try {
        await notify(uid, overdue ? 'Sponsor follow-up overdue' : 'Sponsor follow-up due', `Follow up with ${s.company} (${s.status}), scheduled ${when}.`, '/sponsors');
        sent++;
      } catch (e) {
        logger.warn('sponsor reminder failed', { message: (e as Error).message });
      }
    }
  }
  return { checked: due.length, sent };
}

let last = 0;
/** "On page load" trigger: runs at most once per `everyMs` per process and never blocks or fails the request. */
export function remindersOnPageLoad(everyMs = 10 * 60_000): void {
  if (Date.now() - last < everyMs) return;
  last = Date.now();
  sendFollowUpReminders().catch((e) => logger.warn('sponsor reminders failed', { message: (e as Error).message }));
}
