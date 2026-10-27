import { Link } from 'react-router-dom';
import logoLg from '../assets/brand/logo-640.webp';
import logoSm from '../assets/brand/logo-256.webp';
import banner1920 from '../assets/brand/banner-1920.webp';
import banner960 from '../assets/brand/banner-960.webp';

export const UNIVERSITY_NAME = 'Pundra University of Science & Technology';
export const PLATFORM_NAME = 'PUB FestHub';
export const EVENT_NAME = 'PUB CSE Fest 2026';

/** Optimised brand assets (resized from the originals in src/assets). */
export const LOGO_SRC = logoLg;
export const LOGO_SM_SRC = logoSm;
export const BANNER_SRC = banner1920;
export const BANNER_SM_SRC = banner960;

/** The PUB CSE Fest logo. Width follows the logo's real proportions (≈1.21 : 1); `size` is the rendered height. */
export function BrandMark({ size = 40, className = '', priority = false, fluid = false }: { size?: number; className?: string; priority?: boolean; fluid?: boolean }) {
  // `fluid`: height comes from the caller's responsive classes (e.g. h-28 sm:h-36), `size` is only the largest rendered height.
  return (
    <img
      src={size > 90 || fluid ? logoLg : logoSm}
      srcSet={`${logoSm} 256w, ${logoLg} 640w`}
      sizes={`${Math.round(size * 1.22)}px`}
      alt=""
      aria-hidden
      draggable={false}
      decoding="async"
      loading={priority ? 'eager' : 'lazy'}
      className={`shrink-0 select-none object-contain drop-shadow-[0_4px_14px_rgba(14,165,238,0.35)] ${className}`}
      style={fluid ? { width: 'auto', aspectRatio: '1238 / 1019' } : { height: size, width: 'auto', aspectRatio: '1238 / 1019' }}
    />
  );
}

/** Mark + platform name + university name. `tone="light"` is for dark backgrounds. */
export function BrandLockup({ to = '/', tone = 'dark', compact = false, onClick }: { to?: string; tone?: 'dark' | 'light'; compact?: boolean; onClick?: () => void }) {
  const light = tone === 'light';
  return (
    <Link to={to} onClick={onClick} className="group inline-flex min-w-0 items-center gap-2.5 rounded-lg sm:gap-3" aria-label={`${PLATFORM_NAME} — ${UNIVERSITY_NAME}`}>
      <BrandMark size={compact ? 40 : 48} priority className="transition-transform duration-300 group-hover:scale-105 group-hover:-rotate-2" />
      <span className="min-w-0 leading-tight">
        <span className={`block truncate font-display text-lg font-bold tracking-tight ${light ? 'text-white' : 'text-ink-900 dark:text-white'}`}>{PLATFORM_NAME}</span>
        {!compact && <span className={`hidden text-[11px] font-medium leading-snug tracking-wide min-[400px]:block ${light ? 'text-white/65' : 'text-slate-500'}`}>{UNIVERSITY_NAME}</span>}
      </span>
    </Link>
  );
}
