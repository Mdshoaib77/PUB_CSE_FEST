import { createElement, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, errMsg } from './api';
import { useConfirm, useToast } from '../components/ui';

export function useGet<T>(path: string | null, opts: { refetchInterval?: number } = {}) {
  return useQuery<T>({ queryKey: [path], queryFn: () => api.get<T>(path!), enabled: !!path, refetchInterval: opts.refetchInterval });
}
/** Mutation with toast feedback + cache invalidation. */
export function useAct<TIn = void, TOut = unknown>(
  fn: (i: TIn) => Promise<TOut>,
  o: { ok?: string; invalidate?: (string | null)[]; onDone?: (r: TOut) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation<TOut, Error, TIn>({
    mutationFn: fn,
    onSuccess: (r) => {
      if (o.ok) toast(o.ok, 'ok');
      (o.invalidate ?? []).forEach((k) => qc.invalidateQueries({ queryKey: k ? [k] : undefined }));
      if (!o.invalidate) qc.invalidateQueries();
      o.onDone?.(r);
    },
    onError: (e) => toast(errMsg(e), 'error'),
  });
}

// ------------------------------------------------------------------ universal delete
const keyStr = (q: { queryKey: readonly unknown[] }) => (typeof q.queryKey[0] === 'string' ? (q.queryKey[0] as string) : '');
const matches = (prefixes: string[]) => (q: { queryKey: readonly unknown[] }) => prefixes.some((p) => keyStr(q).startsWith(p));
const idOf = (x: unknown): string | undefined => {
  const o = x as { _id?: string; id?: string } | null;
  return o?._id ?? o?.id;
};

/** Remove `id` from every cached array whose key starts with one of `prefixes`. Returns an undo function. */
function pruneCaches(qc: QueryClient, prefixes: string[], id: string) {
  const snap = qc.getQueriesData<unknown>({ predicate: matches(prefixes) });
  for (const [key, data] of snap) if (Array.isArray(data)) qc.setQueryData(key, data.filter((x) => idOf(x) !== id));
  return () => snap.forEach(([key, data]) => qc.setQueryData(key, data));
}

export interface DeleteConfig {
  /** Singular noun for the dialog and toast: "event", "shift"… */
  noun: string;
  request: (id: string) => Promise<unknown>;
  /** Cache-key prefixes holding lists that contain the item. When given, the item vanishes from them instantly (optimistic) and reappears if the server refuses. */
  prune?: string[];
  /** Cache-key prefixes to refetch once the server has answered. Defaults to `prune`. */
  invalidate?: string[];
  onDeleted?: (id: string) => void;
  /** Only for trivially reversible dismissals (a single notification). Everything with real consequences keeps its modal. */
  skipConfirm?: boolean;
}
export interface DeleteTarget {
  id: string;
  /** What the person knows it as: "Hackathon 2026" */
  name?: string;
  /** Override the dialog heading / body for actions that aren't literally "delete" (e.g. removing a volunteer from a shift). */
  title?: string;
  message?: ReactNode;
  /** Extra consequence text shown in the dialog */
  warning?: ReactNode;
  confirmText?: string;
  /** Make the person type this (e.g. the event title) before the delete button unlocks. */
  typeToConfirm?: string;
}

/**
 * One consistent way to delete anything: confirmation modal → (optimistic) UI update → request → toast → refetch.
 *  - with `prune`: the row disappears immediately and is restored with an error toast if the server says no;
 *  - without `prune` (e.g. deleting the page you are standing on): the modal stays open with a spinner until the server confirms.
 */
export function useDelete(cfg: DeleteConfig) {
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const settle = (id: string) => {
    const keys = cfg.invalidate ?? cfg.prune ?? [];
    if (keys.length) qc.invalidateQueries({ predicate: matches(keys) });
    qc.invalidateQueries({ queryKey: ['/me/dashboard'] });
    cfg.onDeleted?.(id);
  };
  return async (t: DeleteTarget) => {
    const optimistic = !!cfg.prune?.length;
    const body = createElement(
      'span',
      null,
      ...(t.message
        ? [t.message]
        : [t.name ? createElement('b', { className: 'text-slate-900' }, `“${t.name}”`) : `This ${cfg.noun}`, ' will be permanently deleted. This can’t be undone.']),
      t.warning ? createElement('span', { className: 'mt-2 block rounded-lg bg-amber-50 px-3 py-2 text-amber-900' }, t.warning) : null,
    );
    const common = { title: t.title ?? `Delete this ${cfg.noun}?`, message: body, confirmText: t.confirmText ?? `Delete ${cfg.noun}`, tone: 'danger' as const, typeToConfirm: t.typeToConfirm };
    if (!optimistic) {
      const done = await confirm({
        ...common,
        run: async () => {
          await cfg.request(t.id);
        },
      });
      if (done) {
        toast(`${cap(cfg.noun)} deleted`, 'ok');
        settle(t.id);
      }
      return;
    }
    if (!cfg.skipConfirm && !(await confirm(common))) return;
    await qc.cancelQueries({ predicate: matches(cfg.prune!) });
    const undo = pruneCaches(qc, cfg.prune!, t.id);
    try {
      await cfg.request(t.id);
      if (!cfg.skipConfirm) toast(`${cap(cfg.noun)} deleted`, 'ok');
    } catch (e) {
      undo();
      toast(errMsg(e), 'error');
    } finally {
      settle(t.id);
    }
  };
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ------------------------------------------------------------------ formatting
export const fmt = (d?: string | Date | null) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtDate = (d?: string | Date | null) => (d ? new Date(d).toLocaleDateString([], { dateStyle: 'medium' }) : '—');
export const fmtTime = (d?: string | Date | null) => (d ? new Date(d).toLocaleTimeString([], { timeStyle: 'short' }) : '—');
export const toLocalInput = (d?: string | Date | null) => {
  if (!d) return '';
  const x = new Date(d);
  x.setMinutes(x.getMinutes() - x.getTimezoneOffset());
  return x.toISOString().slice(0, 16);
};
export function timeAgo(d?: string | Date | null, now = Date.now()) {
  if (!d) return '';
  const s = Math.max(0, Math.round((now - new Date(d).getTime()) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return fmtDate(d);
}
