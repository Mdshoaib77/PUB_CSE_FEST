import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Bell, Check, CheckCheck, Trash2, X } from 'lucide-react';
import { api } from '../lib/api';
import { fmt, timeAgo, useAct, useDelete, useGet } from '../lib/hooks';
import { noticeTarget, refreshNotifications, useUnreadCount, type Notice } from '../lib/notifications';
import { EmptyState, PageHeader, Query, Tabs, useConfirm } from '../components/ui';
import { NOTICE_ICONS } from '../components/NotificationBell';

const TABS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
] as const;
const PAGE = 25;

export default function Notifications() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('all');
  const [limit, setLimit] = useState(PAGE);
  const q = useGet<Notice[]>(`/notifications?limit=${limit}${tab === 'unread' ? '&unread=1' : ''}`);
  const unread = useUnreadCount().data?.count ?? 0;

  const markRead = useAct((id: string) => api.post(`/notifications/${id}/read`), { invalidate: [], onDone: () => refreshNotifications(qc) });
  const markAll = useAct(() => api.post('/notifications/read-all'), {
    ok: 'All notifications marked as read',
    invalidate: [],
    onDone: () => refreshNotifications(qc),
  });
  const remove = useDelete({ noun: 'notification', request: (id) => api.del(`/notifications/${id}`), prune: ['/notifications'], skipConfirm: true });
  const clear = useAct(() => api.del('/notifications'), { ok: 'Notifications cleared', invalidate: [], onDone: () => refreshNotifications(qc) });

  return (
    <>
      <PageHeader
        title="Notifications"
        sub={unread ? `${unread} unread` : 'You’re all caught up'}
        actions={
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" disabled={unread === 0 || markAll.isPending} onClick={() => markAll.mutate()}>
              <CheckCheck size={15} /> Mark all read
            </button>
            {(q.data?.length ?? 0) > 0 && (
              <button
                className="btn-ghost"
                onClick={() =>
                  confirm({
                    title: 'Clear all notifications?',
                    message: 'Every notification is permanently removed. This can’t be undone.',
                    tone: 'danger',
                    confirmText: 'Clear all',
                    run: () => clear.mutateAsync(),
                  })
                }
              >
                <Trash2 size={15} /> Clear all
              </button>
            )}
          </div>
        }
      />
      <div className="mb-3">
        <Tabs
          tabs={TABS}
          value={tab}
          onChange={(t) => {
            setTab(t);
            setLimit(PAGE);
          }}
        />
      </div>
      <Query q={q}>
        {(n) =>
          n.length === 0 ? (
            <EmptyState
              icon={Bell}
              title={tab === 'unread' ? 'No unread notifications' : 'You’re all caught up'}
              hint="Registrations, shifts, results and announcements show up here as they happen."
            />
          ) : (
            <>
              <ul className="space-y-2">
                <AnimatePresence initial={false} mode="popLayout">
                  {n.map((x, i) => {
                    const Icon = NOTICE_ICONS[x.type ?? ''] ?? Bell;
                    const isNew = !x.readAt;
                    const to = noticeTarget(x);
                    const open = () => {
                      if (isNew) markRead.mutate(x._id);
                      if (to) nav(to);
                    };
                    return (
                      <motion.li
                        key={x._id}
                        layout
                        initial={{ opacity: 0, y: 12 }}
                        animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 10) * 0.025 } }}
                        exit={{ opacity: 0, x: 60, transition: { duration: 0.2 } }}
                        className={`card flex items-start gap-3 !p-3.5 ${isNew ? 'border-brand-300 bg-brand-50/60' : ''} ${to ? 'cursor-pointer transition hover:bg-white/90' : ''}`}
                        onClick={to ? open : undefined}
                      >
                        <span
                          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${isNew ? 'bg-gradient-to-br from-brand-600 to-brand-800 text-white' : 'bg-slate-100 text-slate-500'}`}
                        >
                          <Icon size={16} />
                        </span>
                        <div className="min-w-0 flex-1 text-sm">
                          {x.title && x.title !== x.message && <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{x.title}</p>}
                          <p className={isNew ? 'font-semibold text-slate-900' : 'text-slate-700'}>{x.message}</p>
                          <p className="mt-0.5 text-xs text-slate-400" title={fmt(x.createdAt)}>
                            {timeAgo(x.createdAt)}
                            {isNew && <span className="ml-2 font-medium text-coral-600">● unread</span>}
                          </p>
                        </div>
                        {isNew && (
                          <button
                            className="btn-ghost btn-sm"
                            aria-label="Mark as read"
                            title="Mark as read"
                            onClick={(e) => {
                              e.stopPropagation();
                              markRead.mutate(x._id);
                            }}
                          >
                            <Check size={14} /> Read
                          </button>
                        )}
                        <button
                          className="icon-btn-danger"
                          aria-label="Dismiss notification"
                          title="Dismiss"
                          onClick={(e) => {
                            e.stopPropagation();
                            void remove({ id: x._id });
                          }}
                        >
                          <X size={15} />
                        </button>
                      </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ul>
              {n.length >= limit && limit < 100 && (
                <div className="mt-3 text-center">
                  <button className="btn-ghost" onClick={() => setLimit((l) => Math.min(l + PAGE, 100))}>
                    Show more
                  </button>
                </div>
              )}
            </>
          )
        }
      </Query>
    </>
  );
}
