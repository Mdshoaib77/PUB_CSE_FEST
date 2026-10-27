import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from './api';
import { useGet } from './hooks';

export interface Notice {
  _id: string;
  type?: string;
  title?: string;
  message: string;
  /** In-app path (S3). Older rows may only have `refs.eventId`. */
  link?: string | null;
  refs?: { eventId?: string } | null;
  createdAt: string;
  readAt?: string | null;
}
/** Where a notification leads: its own link when it is a safe in-app path, else its event, else nowhere. */
export const noticeTarget = (n: Notice): string | undefined =>
  n.link && /^\/(?!\/)/.test(n.link) ? n.link : n.refs?.eventId ? `/events/${n.refs.eventId}` : undefined;
export const COUNT_KEY = '/notifications/unread-count';

const isNotifKey = (q: { queryKey: readonly unknown[] }) => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith('/notifications');

/** The bell badge. Counted by the server (exact, even with hundreds of notifications) and refreshed by socket pushes + a slow poll as a fallback. */
export const useUnreadCount = () => useGet<{ count: number }>(COUNT_KEY, { refetchInterval: 60_000 });

export function refreshNotifications(qc: QueryClient) {
  qc.invalidateQueries({ predicate: isNotifKey });
  qc.invalidateQueries({ queryKey: ['/me/dashboard'] });
}

/**
 * "I have looked at my notifications": clears the badge immediately (optimistic), then tells the server.
 * `upTo` = the newest notification the person was actually shown, so one that lands a moment later keeps its badge.
 */
export function useMarkSeen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (upTo?: string) => api.post<{ unread: number }>('/notifications/read-all', upTo ? { upTo } : {}),
    onMutate: async (upTo) => {
      await qc.cancelQueries({ predicate: isNotifKey });
      const prev = qc.getQueryData<{ count: number }>([COUNT_KEY]);
      qc.setQueryData([COUNT_KEY], { count: 0 });
      const limit = upTo ? new Date(upTo).getTime() : Infinity;
      const now = new Date().toISOString();
      qc.setQueriesData<unknown>({ predicate: isNotifKey }, (old: unknown) =>
        Array.isArray(old) ? (old as Notice[]).map((n) => (!n.readAt && new Date(n.createdAt).getTime() <= limit ? { ...n, readAt: now } : n)) : old,
      );
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData([COUNT_KEY], ctx.prev);
    },
    onSettled: () => refreshNotifications(qc), // the server's number is the truth (e.g. keeps a late arrival unread)
  });
}

export const newestOf = (list: Notice[]) => list.reduce<string | undefined>((m, n) => (!m || n.createdAt > m ? n.createdAt : m), undefined);
