import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Bell, BellOff, CalendarX, CheckCheck, Clock, ListTodo, Megaphone, Ticket, Trophy, Users, type LucideIcon } from 'lucide-react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/hooks';
import { COUNT_KEY, newestOf, noticeTarget, useMarkSeen, useUnreadCount, type Notice } from '../lib/notifications';
import { Skeleton } from './ui';

export const NOTICE_ICONS: Record<string, LucideIcon> = {
  registration: Ticket,
  waitlist: Ticket,
  shift: Clock,
  announcement: Megaphone,
  result: Trophy,
  invitation: Users,
  team: Users,
  task: ListTodo,
  issue: AlertTriangle,
  event: CalendarX,
  replacement: Clock,
};
const PANEL_KEY = '/notifications?limit=12';

/**
 * Bell + dropdown.
 *  - the badge is the server's exact unread count;
 *  - opening the panel counts as "seen": the badge clears at once (optimistic) and the server marks everything
 *    up to the newest notification shown as read. Items that were new when you opened it keep a "new" dot for this visit.
 */
export default function NotificationBell() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const count = useUnreadCount();
  const markSeen = useMarkSeen();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notice[] | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const wrap = useRef<HTMLDivElement>(null);
  const unread = count.data?.count ?? 0;

  const openPanel = useCallback(async () => {
    setOpen(true);
    setItems(null);
    if (unread > 0) qc.setQueryData([COUNT_KEY], { count: 0 }); // instant: don't wait for the network to clear the badge
    try {
      const list = await qc.fetchQuery({ queryKey: [PANEL_KEY], queryFn: () => api.get<Notice[]>(PANEL_KEY), staleTime: 0 });
      setFresh(new Set(list.filter((n) => !n.readAt).map((n) => n._id)));
      setItems(list);
      markSeen.mutate(newestOf(list));
    } catch {
      setItems([]);
    }
  }, [qc, unread]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !wrap.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrap}>
      <button
        className="relative grid h-10 w-10 place-items-center rounded-xl border border-white/80 bg-white/70 text-slate-700 shadow-sm backdrop-blur transition hover:bg-white active:scale-95"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : void openPanel())}
      >
        <motion.span
          key={unread}
          initial={unread ? { rotate: -18 } : false}
          animate={{ rotate: 0 }}
          transition={{ type: 'spring', stiffness: 500, damping: 8 }}
          className="grid place-items-center"
        >
          <Bell size={18} />
        </motion.span>
        <AnimatePresence>
          {unread > 0 && (
            <motion.span
              key="badge"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: 'spring', stiffness: 600, damping: 20 }}
              className="absolute -right-1.5 -top-1.5 grid min-w-[1.25rem] place-items-center rounded-full bg-gradient-to-br from-coral-500 to-rose-600 px-1 text-[11px] font-bold leading-5 text-white shadow-md ring-2 ring-white"
              data-testid="unread-badge"
            >
              {unread > 99 ? '99+' : unread}
            </motion.span>
          )}
        </AnimatePresence>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label="Notifications"
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            style={{ transformOrigin: 'top right' }}
            className="glass-strong absolute right-0 top-12 z-50 w-[min(24rem,calc(100vw-2rem))] overflow-hidden !rounded-2xl !bg-white/95 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200/70 px-4 py-3">
              <h2 className="text-sm font-semibold">Notifications</h2>
              {fresh.size > 0 && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                  <CheckCheck size={14} /> {fresh.size} marked as seen
                </span>
              )}
            </div>
            <div className="max-h-[22rem] overflow-y-auto">
              {items === null ? (
                <div className="space-y-3 p-4">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex gap-3">
                      <Skeleton className="h-8 w-8 rounded-full" />
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-1/3" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : items.length === 0 ? (
                <div className="grid place-items-center gap-1 px-6 py-10 text-center">
                  <BellOff className="text-slate-400" />
                  <p className="text-sm font-medium">You’re all caught up</p>
                  <p className="text-xs text-slate-500">New registrations, shifts and announcements land here.</p>
                </div>
              ) : (
                <ul>
                  {items.map((n, i) => {
                    const Icon = NOTICE_ICONS[n.type ?? ''] ?? Bell;
                    const isNew = fresh.has(n._id);
                    return (
                      <motion.li key={n._id} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: Math.min(i, 8) * 0.03 }}>
                        <button
                          className={`flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-brand-50/70 ${isNew ? 'bg-brand-50/50' : ''}`}
                          onClick={() => {
                            setOpen(false);
                            const to = noticeTarget(n);
                            if (to) nav(to);
                          }}
                        >
                          <span
                            className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${isNew ? 'bg-gradient-to-br from-brand-600 to-brand-800 text-white' : 'bg-slate-100 text-slate-500'}`}
                          >
                            <Icon size={15} />
                          </span>
                          <span className="min-w-0 flex-1">
                            {n.title && n.title !== n.message && (
                              <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-400">{n.title}</span>
                            )}
                            <span className={`block text-sm leading-snug ${isNew ? 'font-semibold text-slate-900' : 'text-slate-600'}`}>{n.message}</span>
                            <span className="text-xs text-slate-400">{timeAgo(n.createdAt)}</span>
                          </span>
                          {isNew && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-coral-500" aria-label="New" />}
                        </button>
                      </motion.li>
                    );
                  })}
                </ul>
              )}
            </div>
            <Link
              to="/notifications"
              onClick={() => setOpen(false)}
              className="block border-t border-slate-200/70 px-4 py-2.5 text-center text-sm font-semibold text-brand-700 transition hover:bg-brand-50"
            >
              See all notifications
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
