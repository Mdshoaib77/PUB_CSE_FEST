import { LOGO_SRC } from './Brand';

/**
 * Branded loader: the logo breathes inside a spinning light ring, over a pulsing glow, with an indeterminate bar.
 * `fullscreen` = app start / route change (matches the splash in index.html, so there is no visual jump).
 * Otherwise it is an inline block for loading a section of a page.
 */
export default function BrandLoader({ fullscreen = false, label = 'Loading…', size }: { fullscreen?: boolean; label?: string; size?: number }) {
  const s = size ?? (fullscreen ? 132 : 84);
  const body = (
    <div role="status" aria-live="polite" className="flex flex-col items-center">
      <div className="relative grid place-items-center" style={{ height: s * 1.45, width: s * 1.45 }}>
        <span aria-hidden className="absolute inset-[8%] animate-glow-pulse rounded-full bg-brand-500/40 blur-2xl" />
        <span
          aria-hidden
          className="absolute inset-0 animate-ring-spin rounded-full"
          style={{
            background: 'conic-gradient(from 0deg, transparent 0 55%, rgba(53,196,255,0.0) 55%, #35c4ff 100%)',
            WebkitMask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))',
            mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))',
          }}
        />
        <span aria-hidden className="absolute inset-0 rounded-full border border-white/10 dark:border-white/10" />
        <img src={LOGO_SRC} alt="" width={s} height={Math.round(s * 0.823)} draggable={false} className="relative animate-logo-breathe select-none object-contain drop-shadow-[0_6px_20px_rgba(14,165,238,0.5)]" style={{ width: s, height: 'auto' }} />
      </div>
      <div aria-hidden className="relative mt-5 h-1 w-40 overflow-hidden rounded-full bg-brand-500/20">
        <span className="absolute inset-y-0 left-0 w-2/5 animate-load-bar rounded-full bg-gradient-to-r from-brand-500 to-coral-400" />
      </div>
      <p className={`mt-3 text-xs font-medium tracking-wide ${fullscreen ? 'text-white/70' : 'text-slate-500'}`}>{label}</p>
    </div>
  );
  if (!fullscreen) return <div className="grid place-items-center py-14">{body}</div>;
  return (
    <div className="fixed inset-0 z-[100] grid place-items-center overflow-hidden bg-ink-950">
      <div aria-hidden className="absolute -left-40 -top-40 h-[30rem] w-[30rem] rounded-full bg-brand-700/40 blur-[120px]" />
      <div aria-hidden className="absolute -bottom-48 -right-24 h-[28rem] w-[28rem] rounded-full bg-coral-500/15 blur-[120px]" />
      <div className="relative">{body}</div>
    </div>
  );
}
