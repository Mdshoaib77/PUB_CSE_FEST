import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import BrandLoader from './BrandLoader';
import { AnimatePresence, animate, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Inbox, Loader2, Trash2, X, type LucideIcon } from 'lucide-react';
import { errMsg } from '../lib/api';

// ====================================================================== toasts
type Toast = { id: number; msg: string; kind: 'ok' | 'error' };
const ToastCtx = createContext<(m: string, k?: 'ok' | 'error') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setList((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (msg: string, kind: 'ok' | 'error' = 'ok') => {
      const id = Date.now() + Math.random();
      setList((l) => [...l.slice(-4), { id, msg, kind }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 3500);
    },
    [dismiss],
  );
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[calc(100%-2rem)] max-w-sm flex-col gap-2" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {list.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 40, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
              className={`pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-2xl border p-3 pr-8 text-sm shadow-xl backdrop-blur-xl ${
                t.kind === 'ok' ? 'border-emerald-200 bg-emerald-50/95 text-emerald-900' : 'border-red-200 bg-red-50/95 text-red-900'
              }`}
            >
              {t.kind === 'ok' ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" /> : <AlertTriangle size={17} className="mt-0.5 shrink-0 text-red-600" />}
              <span className="leading-snug">{t.msg}</span>
              <button className="absolute right-2 top-2 rounded p-0.5 opacity-50 transition hover:opacity-100" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                <X size={14} />
              </button>
              <motion.span
                className={`absolute bottom-0 left-0 h-0.5 ${t.kind === 'ok' ? 'bg-emerald-500' : 'bg-red-500'}`}
                initial={{ width: '100%' }}
                animate={{ width: 0 }}
                transition={{ duration: t.kind === 'error' ? 7 : 3.5, ease: 'linear' }}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

// ====================================================================== confirm dialog
export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: 'danger' | 'primary';
  /** When set, the dialog stays open with a spinner while this runs, shows its error inline, and only closes on success. */
  run?: () => Promise<unknown>;
  /** High-blast-radius actions: the confirm button stays disabled until this exact text is typed. */
  typeToConfirm?: string;
}
type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const ConfirmCtx = createContext<ConfirmFn>(async () => window.confirm('Are you sure?'));
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<{ o: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState('');
  const [typed, setTyped] = useState('');
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const confirm = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        setErr('');
        setTyped('');
        setPending(false);
        setReq({ o, resolve });
      }),
    [],
  );
  const close = useCallback(
    (v: boolean) => {
      req?.resolve(v);
      setReq(null);
      setPending(false);
    },
    [req],
  );
  const accept = async () => {
    if (!req || pending) return;
    if (!req.o.run) return close(true);
    setPending(true);
    setErr('');
    try {
      await req.o.run();
      close(true);
    } catch (e) {
      setErr(errMsg(e));
      setPending(false);
    }
  };
  // Escape closes, Tab stays inside the dialog, page scroll is locked while open.
  useEffect(() => {
    if (!req) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !pending) return close(false);
      if (e.key !== 'Tab' || !panel.current) return;
      const f = [...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), input')];
      if (!f.length) return;
      const first = f[0],
        last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [req, pending, close]);

  const danger = (req?.o.tone ?? 'primary') === 'danger';
  const blocked = !!req?.o.typeToConfirm && typed.trim() !== req.o.typeToConfirm;
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <AnimatePresence>
        {req && (
          <motion.div
            className="fixed inset-0 z-[70] grid place-items-center bg-ink-950/50 p-4 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={(e) => e.target === e.currentTarget && !pending && close(false)}
          >
            <motion.div
              ref={panel}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="glass-strong w-full max-w-md !bg-white/90 p-6"
              initial={{ opacity: 0, y: 24, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.97 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            >
              <div className="flex items-start gap-4">
                <span className={`relative grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${danger ? 'bg-red-100 text-red-600' : 'bg-brand-100 text-brand-600'}`}>
                  {danger && <span className="absolute inset-0 animate-ping rounded-2xl bg-red-400/25 [animation-iteration-count:2]" />}
                  {danger ? <Trash2 size={20} className="relative" /> : <AlertTriangle size={20} className="relative" />}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 id={titleId} className="text-lg font-semibold text-slate-900">
                    {req.o.title}
                  </h2>
                  {req.o.message && <div className="mt-1 text-sm leading-relaxed text-slate-600">{req.o.message}</div>}
                </div>
              </div>
              {req.o.typeToConfirm && (
                <label className="mt-4 block text-sm">
                  <span className="text-slate-600">
                    Type <b className="select-all text-slate-900">{req.o.typeToConfirm}</b> to confirm
                  </span>
                  <input className="input mt-1" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
                </label>
              )}
              <AnimatePresence>
                {err && (
                  <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="mt-3 overflow-hidden rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
                    {err}
                  </motion.p>
                )}
              </AnimatePresence>
              <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button className="btn-ghost" onClick={() => close(false)} disabled={pending} autoFocus>
                  {req.o.cancelText ?? 'Keep it'}
                </button>
                <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={accept} disabled={pending || blocked}>
                  {pending && <Loader2 size={15} className="animate-spin" />}
                  {pending ? 'Working…' : (req.o.confirmText ?? 'Confirm')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </ConfirmCtx.Provider>
  );
}

/** Small trash icon button used in rows/cards. Stops the click from reaching a parent <Link>. */
export function TrashButton({ onClick, label, className = '', disabled }: { onClick: () => void; label: string; className?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={`icon-btn-danger ${className}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      <Trash2 size={15} />
    </button>
  );
}

// ====================================================================== loading / empty states
export const Spinner = () => <BrandLoader size={64} />;
export const Skeleton = ({ className = '' }: { className?: string }) => <div className={`skeleton ${className}`} aria-hidden />;
/** Placeholder rows shown while data loads (replaces the bare spinner inside <Query>). */
export const SkeletonList = ({ rows = 3 }: { rows?: number }) => (
  <div className="space-y-3" role="status" aria-label="Loading">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="card space-y-2">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    ))}
  </div>
);
export const EmptyState = ({ icon: Icon = Inbox, title, hint, action }: { icon?: LucideIcon; title: string; hint?: string; action?: ReactNode }) => (
  <motion.div
    initial={{ opacity: 0, scale: 0.97 }}
    animate={{ opacity: 1, scale: 1 }}
    className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-brand-500/30 bg-white/40 p-8 text-center backdrop-blur"
  >
    <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500/15 to-coral-500/15 text-brand-600">
      <Icon size={22} />
    </span>
    <p className="font-semibold text-slate-800">{title}</p>
    {hint && <p className="max-w-sm text-sm text-slate-500">{hint}</p>}
    {action}
  </motion.div>
);

/** Counts up to `value` (instantly when the person prefers reduced motion). */
export function AnimatedNumber({ value }: { value: number }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (reduce) return setShown(value);
    const c = animate(from.current, value, { duration: 0.8, ease: 'easeOut', onUpdate: (v) => setShown(Math.round(v)) });
    from.current = value;
    return () => c.stop();
  }, [value, reduce]);
  return <>{shown}</>;
}

export const StatTile = ({ icon: Icon, label, value, tone = 'brand' }: { icon: LucideIcon; label: string; value: ReactNode; tone?: 'brand' | 'green' | 'amber' | 'red' }) => {
  const t = { brand: 'from-brand-600 to-brand-800', green: 'from-emerald-500 to-teal-500', amber: 'from-amber-400 to-orange-500', red: 'from-rose-500 to-red-600' }[tone];
  return (
    <div className="card flex items-center gap-3 transition duration-300 hover:-translate-y-0.5 hover:shadow-lift">
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-gradient-to-br ${t} text-white shadow-sm`}>
        <Icon size={19} />
      </span>
      <div className="min-w-0">
        <div className="font-display text-2xl font-semibold leading-none">{typeof value === 'number' ? <AnimatedNumber value={value} /> : value}</div>
        <div className="mt-1 truncate text-xs text-slate-500">{label}</div>
      </div>
    </div>
  );
};
export const ErrorBox = ({ error }: { error: unknown }) => (
  <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
    {error instanceof Error ? error.message : 'Something went wrong'}
  </div>
);
export const Empty = ({ children }: { children: ReactNode }) =>
  typeof children === 'string' ? <EmptyState title={children} /> : <EmptyState title="Nothing here yet" action={children} />;
export const PageHeader = ({ title, sub, actions }: { title: string; sub?: string; actions?: ReactNode }) => (
  <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
    <div>
      <span aria-hidden className="mb-2 block h-0.5 w-10 rounded-full bg-gold-500" />
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">{title}</h1>
      {sub && <p className="mt-0.5 text-sm text-slate-500">{sub}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </div>
);
export const Field = ({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) => (
  <label className="block">
    <span className="label">{label}</span>
    {children}
    {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    <AnimatePresence>
      {error && (
        <motion.span initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-1 block text-xs font-medium text-red-600" role="alert">
          {error}
        </motion.span>
      )}
    </AnimatePresence>
  </label>
);

const tone: Record<string, string> = {
  confirmed: 'bg-emerald-100 text-emerald-800',
  AC: 'bg-emerald-100 text-emerald-800',
  published: 'bg-emerald-100 text-emerald-800',
  official: 'bg-emerald-100 text-emerald-800',
  resolved: 'bg-emerald-100 text-emerald-800',
  approved: 'bg-emerald-100 text-emerald-800',
  present: 'bg-emerald-100 text-emerald-800',
  done: 'bg-emerald-100 text-emerald-800',
  ready: 'bg-emerald-100 text-emerald-800',
  running: 'bg-blue-100 text-blue-800',
  waitlisted: 'bg-amber-100 text-amber-800',
  pending_approval: 'bg-amber-100 text-amber-800',
  pending: 'bg-amber-100 text-amber-800',
  draft: 'bg-slate-200 text-slate-700',
  queued: 'bg-slate-200 text-slate-700',
  in_progress: 'bg-blue-100 text-blue-800',
  attention: 'bg-amber-100 text-amber-800',
  upcoming: 'bg-amber-100 text-amber-800',
  WA: 'bg-red-100 text-red-800',
  TLE: 'bg-orange-100 text-orange-800',
  RE: 'bg-red-100 text-red-800',
  CE: 'bg-purple-100 text-purple-800',
  JE: 'bg-slate-300 text-slate-800',
  cancelled: 'bg-red-100 text-red-800',
  rejected: 'bg-red-100 text-red-800',
  absent: 'bg-red-100 text-red-800',
  not_ready: 'bg-red-100 text-red-800',
  critical: 'bg-red-100 text-red-800',
  high: 'bg-orange-100 text-orange-800',
  open: 'bg-red-100 text-red-800',
  ended: 'bg-slate-200 text-slate-700',
  leader: 'bg-violet-100 text-violet-800',
  registered: 'bg-brand-100 text-brand-800',
};
export const Badge = ({ value }: { value: string }) => <span className={`badge ${tone[value] ?? 'bg-slate-100 text-slate-700'}`}>{value.replace(/_/g, ' ')}</span>;
export const Card = ({ children, className = '' }: { children: ReactNode; className?: string }) => <div className={`card ${className}`}>{children}</div>;
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  const gid = useId();
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto rounded-2xl border border-white/80 bg-white/60 p-1 shadow-glass backdrop-blur-xl" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`relative whitespace-nowrap rounded-xl px-3.5 py-1.5 text-sm font-semibold transition-colors ${value === t.id ? 'text-white' : 'text-slate-600 hover:text-slate-900'}`}
        >
          {value === t.id && <motion.span layoutId={`tab-${gid}`} className="absolute inset-0 rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 shadow-md shadow-brand-500/30" transition={{ type: 'spring', stiffness: 420, damping: 34 }} />}
          <span className="relative">{t.label}</span>
        </button>
      ))}
    </div>
  );
}
export function Query<T>({ q, children }: { q: { isLoading: boolean; error: unknown; data?: T }; children: (d: T) => ReactNode }) {
  if (q.isLoading) return <SkeletonList />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (q.data === undefined) return null;
  return <>{children(q.data)}</>;
}

/** Initials avatar with a stable gradient per person. */
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
  const hues = ['from-brand-600 to-brand-800', 'from-gold-500 to-gold-600', 'from-emerald-600 to-teal-500', 'from-sky-600 to-brand-600', 'from-slate-600 to-slate-800'];
  const h = hues[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % hues.length];
  return (
    <span className={`grid shrink-0 place-items-center rounded-full bg-gradient-to-br ${h} font-semibold text-white shadow-sm`} style={{ width: size, height: size, fontSize: size * 0.38 }} aria-hidden>
      {initials || '?'}
    </span>
  );
}
