import { useState, type ReactNode } from 'react';
import { Award, CalendarDays, Code2, Presentation, Wrench, type LucideIcon } from 'lucide-react';
import { assetUrl } from '../lib/api';

const ICONS: Record<string, LucideIcon> = { seminar: Presentation, workshop: Wrench, competition: Award, contest: Code2 };
// Cover gradients are deterministic per event, so an image-less event still looks intentional and stays the same between visits.
const PALETTES = [
  'from-brand-800 via-brand-700 to-brand-500',
  'from-ink-900 via-brand-800 to-brand-600',
  'from-ink-800 via-brand-700 to-sky-600',
  'from-brand-900 via-ink-800 to-gold-600',
  'from-ink-900 via-slate-700 to-brand-600',
  'from-brand-700 via-brand-800 to-ink-900',
];
const pick = (seed: string) => PALETTES[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTES.length];

/**
 * The event's cover image with a graceful fallback (generated gradient + type icon) when there is no image or it fails to load.
 * `children` are laid over the image on top of a legibility gradient.
 */
export default function EventCover({ title, type, imageUrl, className = '', children, priority }: { title: string; type: string; imageUrl?: string | null; className?: string; children?: ReactNode; priority?: boolean }) {
  const [broken, setBroken] = useState(false);
  const src = imageUrl && !broken ? assetUrl(imageUrl) : '';
  const Icon = ICONS[type] ?? CalendarDays;
  return (
    <div className={`relative isolate overflow-hidden bg-gradient-to-br ${pick(title + type)} ${className}`}>
      {src ? (
        <img
          src={src}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setBroken(true)}
          className="absolute inset-0 -z-10 h-full w-full object-cover transition duration-700 ease-out group-hover:scale-[1.04]"
        />
      ) : (
        <>
          <div className="absolute inset-0 -z-10 opacity-30 [background:radial-gradient(circle_at_20%_20%,white,transparent_45%),radial-gradient(circle_at_85%_80%,rgba(255,255,255,.7),transparent_40%)]" />
          <Icon aria-hidden className="absolute -bottom-4 -right-4 -z-10 h-36 w-36 rotate-12 text-white/20 transition duration-700 group-hover:rotate-6 group-hover:scale-110" strokeWidth={1.2} />
        </>
      )}
      {children && <div className="absolute inset-0 bg-gradient-to-t from-ink-950/80 via-ink-950/20 to-transparent" />}
      {children && <div className="relative h-full">{children}</div>}
    </div>
  );
}
