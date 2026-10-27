import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, CalendarClock, CalendarDays, Clock3, GraduationCap, MapPin, Menu, QrCode, Search, ShieldCheck, Trophy, Users, X, type LucideIcon } from 'lucide-react';
import { EVENT_TYPES } from '@festhub/shared';
import { useGet, fmtDate, fmtTime } from '../lib/hooks';
import { BANNER_SM_SRC, BANNER_SRC, BrandLockup, BrandMark, EVENT_NAME, PLATFORM_NAME, UNIVERSITY_NAME } from '../components/Brand';
import EventCover from '../components/EventCover';
import { AnimatedNumber, Badge, Skeleton } from '../components/ui';

/** The public `GET /events` payload (drafts are never returned to visitors). Only fields we actually render. */
interface PublicEvent {
  _id: string;
  title: string;
  type: string;
  status: string;
  description?: string;
  imageUrl?: string;
  venueName?: string;
  startAt: string;
  endAt: string;
  registrationDeadline: string;
  capacity: number;
  spotsLeft: number;
  participationType: 'individual' | 'team';
}

const NAV: { href: string; label: string }[] = [
  { href: '#events', label: 'Events' },
  { href: '#how', label: 'How it works' },
  { href: '#about', label: 'About' },
  { href: '/verify', label: 'Verify certificate' },
];

/** Re-render once a minute so deadline text never goes stale while the page stays open. */
function useNow(ms = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function regState(e: PublicEvent, now: number): { label: string; tone: 'open' | 'full' | 'closed' | 'done' } {
  if (e.status === 'cancelled') return { label: 'Cancelled', tone: 'closed' };
  if (e.status === 'completed' || new Date(e.endAt).getTime() < now) return { label: 'Completed', tone: 'done' };
  if (new Date(e.registrationDeadline).getTime() < now) return { label: 'Registration closed', tone: 'closed' };
  if (e.spotsLeft <= 0) return { label: 'Waiting list open', tone: 'full' };
  return { label: 'Registration open', tone: 'open' };
}
const TONE: Record<string, string> = {
  open: 'bg-emerald-50 text-emerald-800 ring-emerald-600/25',
  full: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  closed: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  done: 'bg-slate-100 text-slate-700 ring-slate-500/20',
};
function closesIn(iso: string, now: number) {
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ------------------------------------------------------------------ chrome
/** Which in-page section is on screen, for highlighting the matching nav link. */
function useActiveSection(ids: string[]) {
  const [active, setActive] = useState('');
  useEffect(() => {
    const els = ids.map((i) => document.getElementById(i)).filter((x): x is HTMLElement => !!x);
    if (!els.length || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (vis) setActive(vis.target.id);
        else if (window.scrollY < 200) setActive('');
      },
      { rootMargin: '-35% 0px -55% 0px', threshold: [0, 0.2, 0.6] },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

/**
 * Navbar that morphs on scroll: at the top it has NO background of its own, it sits directly on the hero's background (the hero runs behind it); once you scroll it
 * lifts off into a floating rounded glass pill (inset from the edges, soft cyan glow) with a scroll-progress line.
 * The <header> is position:fixed, so the page never jumps while the inner bar animates.
 */
function PublicNav() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [progress, setProgress] = useState(0);
  const active = useActiveSection(['events', 'schedule', 'how', 'about']);
  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        setScrolled(window.scrollY > 24);
        setProgress(max > 0 ? Math.min(1, window.scrollY / max) : 0);
      });
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
    };
  }, []);
  const floating = scrolled || open;
  const link = (on: boolean) => `relative rounded-full px-4 py-2 text-sm font-medium transition-colors duration-200 ${on ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white'}`;
  const hrefActive = (href: string) => href.startsWith('#') && active === href.slice(1);
  return (
    <header className="fixed inset-x-0 top-0 z-50 h-[76px] sm:h-[88px]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink-900">
        Skip to content
      </a>
      <div
        className={`absolute inset-x-0 top-0 mx-auto transition-all duration-500 ease-[cubic-bezier(.22,1,.36,1)] ${
          floating
            ? 'mt-3 w-[calc(100%-1.25rem)] max-w-[1480px] overflow-hidden rounded-[1.4rem] border border-white/15 bg-[#071033]/80 shadow-[0_18px_50px_-14px_rgba(3,10,40,0.85),0_0_0_1px_rgba(53,196,255,0.12),0_10px_40px_-18px_rgba(14,165,238,0.55)] backdrop-blur-2xl sm:mt-4 sm:w-[calc(100%-3rem)]'
            : 'mt-2 w-full max-w-[100vw] rounded-none border border-transparent bg-transparent shadow-none sm:mt-3'
        }`}
      >
        <div className={`flex items-center justify-between gap-4 transition-all duration-500 ${floating ? 'h-[60px] px-3 sm:h-[64px] sm:px-5' : 'h-[68px] px-5 sm:h-[76px] sm:px-8 lg:px-10 xl:px-14'} ${floating ? '' : 'mx-auto max-w-[1680px]'}`}>
          <PublicBrand compact={floating} />
          <nav className="hidden items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] p-1 md:flex" aria-label="Primary">
            {NAV.map((n) =>
              n.href.startsWith('#') ? (
                <a key={n.href} href={n.href} className={link(hrefActive(n.href))} aria-current={hrefActive(n.href) ? 'location' : undefined}>
                  {n.label}
                  {hrefActive(n.href) && <span aria-hidden className="absolute inset-x-5 -bottom-px h-px bg-gradient-to-r from-transparent via-coral-400 to-transparent" />}
                </a>
              ) : (
                <Link key={n.href} to={n.href} className={link(false)}>{n.label}</Link>
              ),
            )}
          </nav>
          <div className="hidden items-center gap-1.5 md:flex">
            <Link to="/login" className="rounded-full px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10">Log in</Link>
            <Link to="/register" className="btn-cyan !rounded-full !px-5 !py-2.5">Register</Link>
          </div>
          <button className="grid h-11 w-11 place-items-center rounded-xl border border-white/15 bg-white/5 text-white transition hover:bg-white/10 md:hidden" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="mobile-nav" aria-label={open ? 'Close menu' : 'Open menu'}>
            {open ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div id="mobile-nav" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden border-t border-white/10 md:hidden">
              <nav className="flex flex-col gap-1 px-3 py-4" aria-label="Mobile">
                {NAV.map((n) =>
                  n.href.startsWith('#') ? (
                    <a key={n.href} href={n.href} onClick={() => setOpen(false)} className={`${link(hrefActive(n.href))} !rounded-xl !py-3`}>{n.label}</a>
                  ) : (
                    <Link key={n.href} to={n.href} className={`${link(false)} !rounded-xl !py-3`}>{n.label}</Link>
                  ),
                )}
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <Link to="/login" className="btn-outline-light !py-3">Log in</Link>
                  <Link to="/register" className="btn-cyan !py-3">Register</Link>
                </div>
              </nav>
            </motion.div>
          )}
        </AnimatePresence>
        {/* scroll progress */}
        <span aria-hidden className={`pointer-events-none absolute inset-x-0 bottom-0 h-[2px] origin-left bg-gradient-to-r from-brand-400 via-coral-400 to-gold-300 transition-opacity duration-300 ${floating ? 'opacity-100' : 'opacity-0'}`} style={{ transform: `scaleX(${progress})` }} />
      </div>
    </header>
  );
}

/** Logo for the navbar. The logo is a thick-outlined "sticker", so it sits on a soft glow (no hard box) and is shown large enough to read; the wordmark text only appears on wide screens. */
function PublicBrand({ compact }: { compact: boolean }) {
  return (
    <Link to="/" aria-label={`${PLATFORM_NAME} — ${UNIVERSITY_NAME}`} className="group relative flex min-w-0 items-center gap-3 rounded-xl">
      <span className="relative grid place-items-center">
        <span aria-hidden className="absolute inset-0 -z-10 scale-125 rounded-full bg-brand-500/35 blur-xl transition-opacity duration-500 group-hover:opacity-100" />
        <BrandMark size={56} fluid priority className={`transition-all duration-500 group-hover:-rotate-3 group-hover:scale-105 ${compact ? 'h-10 sm:h-11' : 'h-11 sm:h-[3.4rem]'}`} />
      </span>
      <span className="hidden min-w-0 leading-tight min-[480px]:block">
        <span className="block truncate font-display text-lg font-bold tracking-tight text-white">{PLATFORM_NAME}</span>
        <span className="hidden truncate text-[11px] font-medium tracking-wide text-white/60 xl:block">{UNIVERSITY_NAME}</span>
      </span>
    </Link>
  );
}

export function PublicFooter() {
  const col = 'text-sm text-white/65 transition hover:text-coral-400';
  return (
    <footer className="relative isolate overflow-hidden bg-ink-950 text-white">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-coral-400/70 to-transparent" />
        <div className="absolute -left-32 top-0 h-80 w-80 rounded-full bg-brand-600/25 blur-[120px]" />
        <div className="absolute -right-20 bottom-0 h-72 w-72 rounded-full bg-coral-500/15 blur-[120px]" />
      </div>
      <div className="shell grid gap-12 py-14 sm:py-16 lg:grid-cols-[1.5fr_1fr_1fr] lg:gap-16">
        <div>
          <BrandMark size={104} className="mb-5" />
          <BrandLockup tone="light" />
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/60">
            The events, contests and volunteer platform of {UNIVERSITY_NAME}.
          </p>
        </div>
        <nav aria-label="Explore">
          <h2 className="font-ui text-sm font-semibold text-white">Explore</h2>
          <ul className="mt-4 space-y-3">
            <li><a className={col} href="/#events">Events &amp; competitions</a></li>
            <li><a className={col} href="/#about">About PUB FestHub</a></li>
            <li><Link className={col} to="/verify">Verify a certificate</Link></li>
          </ul>
        </nav>
        <nav aria-label="Account">
          <h2 className="font-ui text-sm font-semibold text-white">Account</h2>
          <ul className="mt-4 space-y-3">
            <li><Link className={col} to="/login">Log in</Link></li>
            <li><Link className={col} to="/register">Create an account</Link></li>
          </ul>
        </nav>
      </div>
      <div className="border-t border-white/10">
        <div className="shell flex flex-col gap-1 py-5 text-xs text-white/50 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} {UNIVERSITY_NAME}</p>
          <p>{PLATFORM_NAME} · {EVENT_NAME}</p>
        </div>
      </div>
    </footer>
  );
}

// ------------------------------------------------------------------ pieces
const reveal = { hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: 'easeOut' as const } } };

function SectionTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <p className="font-ui text-xs font-semibold uppercase tracking-[0.18em] text-gold-600">{eyebrow}</p>
      <h2 className="mt-2 font-display text-3xl font-bold leading-tight text-ink-900 dark:text-white sm:text-4xl">{title}</h2>
      {children && <p className="mt-3 text-base leading-relaxed text-slate-600">{children}</p>}
    </div>
  );
}

function PublicEventCard({ e, now }: { e: PublicEvent; now: number }) {
  const d = new Date(e.startAt);
  const st = regState(e, now);
  const left = closesIn(e.registrationDeadline, now);
  return (
    <motion.article variants={reveal} className="card-interactive group relative flex flex-col overflow-hidden !p-0">
      <Link to={`/events/${e._id}`} className="absolute inset-0 z-10 rounded-xl" aria-label={`View details: ${e.title}`} />
      <EventCover title={e.title} type={e.type} imageUrl={e.imageUrl} className="h-44">
        <div className="flex h-full flex-col justify-between p-3">
          <div className="flex flex-wrap gap-1.5"><Badge value={e.type} /></div>
          <div className="w-fit rounded-lg border border-white/25 bg-ink-950/40 px-2.5 py-1 text-center text-white backdrop-blur-sm">
            <div className="text-[10px] font-semibold leading-none tracking-wider">{d.toLocaleString([], { month: 'short' }).toUpperCase()}</div>
            <div className="font-display text-xl font-bold leading-tight">{d.getDate()}</div>
          </div>
        </div>
      </EventCover>
      <div className="flex flex-1 flex-col gap-2 p-5">
        <span className={`w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${TONE[st.tone]}`}>{st.label}</span>
        <h3 className="line-clamp-2 font-display text-xl font-semibold leading-snug text-ink-900 dark:text-slate-100">{e.title}</h3>
        <p className="flex items-center gap-2 text-sm text-slate-600"><Clock3 size={15} className="shrink-0 text-slate-400" /> {fmtDate(e.startAt)} · {fmtTime(e.startAt)}</p>
        {e.venueName && <p className="flex items-center gap-2 text-sm text-slate-600"><MapPin size={15} className="shrink-0 text-slate-400" /> {e.venueName}</p>}
        {st.tone === 'open' || st.tone === 'full' ? (
          <p className="flex items-center gap-2 text-sm text-slate-600"><CalendarClock size={15} className="shrink-0 text-slate-400" /> Register by {fmtDate(e.registrationDeadline)}{left ? ` · ${left} left` : ''}</p>
        ) : null}
        <span className="mt-auto inline-flex items-center gap-1.5 pt-3 text-sm font-semibold text-brand-700 transition group-hover:gap-2.5">
          View details <ArrowRight size={15} />
        </span>
      </div>
    </motion.article>
  );
}

function Feature({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <motion.li variants={reveal} className="flex gap-4 rounded-xl border border-slate-200/90 bg-white p-5 shadow-glass">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700"><Icon size={20} /></span>
      <div>
        <h3 className="font-ui text-base font-semibold text-ink-900 dark:text-slate-100">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">{text}</p>
      </div>
    </motion.li>
  );
}

/** Slow marquee under the hero: live event titles + what the platform does. Pauses on hover, static for reduced motion. */
function Ticker({ titles }: { titles: string[] }) {
  const base = [...titles.slice(0, 6), 'Seminars', 'Workshops', 'Competitions', 'Programming contests', 'QR check-in', 'Live scoreboards', 'Verified certificates'];
  const half = [...base, ...base];
  return (
    <div aria-hidden className="group relative overflow-hidden border-y border-white/10 bg-ink-900 py-4 text-white">
      <div className="[mask-image:linear-gradient(90deg,transparent,black_8%,black_92%,transparent)]">
        <div className="flex w-max animate-marquee motion-reduce:animate-none group-hover:[animation-play-state:paused]">
          {[0, 1].map((k) => (
            <ul key={k} className="flex shrink-0 items-center">
              {half.map((t, i) => (
                <li key={`${k}-${i}`} className="flex items-center gap-6 pr-6 text-sm font-semibold uppercase tracking-[0.16em] text-white/70">
                  {t}
                  <span className="h-1.5 w-1.5 rotate-45 bg-coral-400" />
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Upcoming events grouped by day as a vertical timeline. */
function Schedule({ events }: { events: PublicEvent[] }) {
  const days = useMemo(() => {
    const m = new Map<string, PublicEvent[]>();
    for (const e of events.slice(0, 14)) {
      const k = new Date(e.startAt).toDateString();
      m.set(k, [...(m.get(k) ?? []), e]);
    }
    return [...m.entries()].slice(0, 6);
  }, [events]);
  if (!days.length) return null;
  return (
    <section id="schedule" className="section-y scroll-mt-20 border-y border-slate-200/80 bg-white">
      <div className="shell">
        <SectionTitle eyebrow="Fest schedule" title="What’s happening, day by day">The next events at a glance, in the order they start.</SectionTitle>
        <div className="mt-10 grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {days.map(([k, list]) => {
            const d = new Date(k);
            return (
              <motion.div key={k} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }} variants={reveal} className="rounded-2xl border border-slate-200/90 bg-ivory-50 p-5 shadow-glass sm:p-6">
                <div className="flex items-center gap-4 border-b border-slate-200/80 pb-4">
                  <div className="grid h-16 w-16 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-brand-800 text-center text-white shadow-md shadow-brand-700/25">
                    <div>
                      <div className="text-[10px] font-bold uppercase leading-none tracking-wider text-gold-300">{d.toLocaleString([], { month: 'short' })}</div>
                      <div className="font-display text-2xl font-bold leading-tight">{d.getDate()}</div>
                    </div>
                  </div>
                  <div>
                    <p className="font-display text-lg font-semibold text-ink-900">{d.toLocaleString([], { weekday: 'long' })}</p>
                    <p className="text-xs text-slate-500">{list.length} {list.length === 1 ? 'event' : 'events'}</p>
                  </div>
                </div>
                <ol className="mt-5 space-y-5">
                  {list.map((e) => (
                    <li key={e._id} className="relative border-l-2 border-brand-200 pl-5">
                      <span aria-hidden className="absolute -left-[7px] top-1 h-3 w-3 rounded-full border-2 border-white bg-coral-500 shadow" />
                      <p className="text-xs font-semibold text-brand-700">{fmtTime(e.startAt)}</p>
                      <Link to={`/events/${e._id}`} className="mt-0.5 block font-ui text-base font-semibold leading-snug text-ink-900 transition hover:text-brand-700">{e.title}</Link>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                        <span className="rounded-full bg-brand-50 px-2 py-0.5 font-semibold capitalize text-brand-700">{e.type}</span>
                        {e.venueName && <span className="inline-flex items-center gap-1"><MapPin size={12} />{e.venueName}</span>}
                      </p>
                    </li>
                  ))}
                </ol>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

const STEPS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: CalendarDays, title: 'Register', text: 'Pick an event and join solo or as a team. Eligibility is checked for you, and a waiting list fills seats the moment one frees up.' },
  { icon: QrCode, title: 'Check in with a QR pass', text: 'Your pass refreshes every few seconds, so screenshots can’t be shared. Volunteers scan it at the door in a blink.' },
  { icon: Trophy, title: 'Compete & get certified', text: 'Follow live contest scoreboards, collect achievements, and receive a certificate anyone can verify online.' },
];
function HowItWorks() {
  return (
    <section id="how" className="section-y scroll-mt-20">
      <div className="shell">
        <SectionTitle eyebrow="How it works" title="From sign-up to certificate in three steps" />
        <motion.ol initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }} variants={{ hidden: {}, show: { transition: { staggerChildren: 0.12 } } }} className="relative mt-12 grid gap-6 lg:grid-cols-3 lg:gap-8">
          <span aria-hidden className="absolute left-[16%] right-[16%] top-9 hidden h-px bg-gradient-to-r from-transparent via-brand-300 to-transparent lg:block" />
          {STEPS.map((st, i) => (
            <motion.li key={st.title} variants={reveal} className="group relative rounded-2xl border border-slate-200/90 bg-white p-6 shadow-glass transition duration-300 hover:-translate-y-1 hover:shadow-lift sm:p-8">
              <div className="flex items-center gap-4">
                <span className="relative grid h-[4.5rem] w-[4.5rem] place-items-center rounded-2xl bg-gradient-to-br from-brand-600 to-brand-800 text-white shadow-lg shadow-brand-700/30 transition group-hover:scale-105">
                  <st.icon size={28} />
                  <span className="absolute -right-2 -top-2 grid h-7 w-7 place-items-center rounded-full bg-coral-400 font-display text-sm font-bold text-ink-950 ring-4 ring-white">{i + 1}</span>
                </span>
              </div>
              <h3 className="mt-5 font-display text-xl font-semibold text-ink-900">{st.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{st.text}</p>
            </motion.li>
          ))}
        </motion.ol>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ page
export default function Landing() {
  const events = useGet<PublicEvent[]>('/events');
  const now = useNow();
  const [q, setQ] = useState('');
  const [type, setType] = useState<string>('');

  const all = useMemo(() => events.data ?? [], [events.data]);
  const { upcoming, past } = useMemo(() => {
    const live = all.filter((e) => e.status !== 'cancelled');
    const up = live.filter((e) => e.status === 'published' && new Date(e.endAt).getTime() >= now).sort((a, b) => +new Date(a.startAt) - +new Date(b.startAt));
    const pa = all.filter((e) => !up.includes(e)).sort((a, b) => +new Date(b.startAt) - +new Date(a.startAt));
    return { upcoming: up, past: pa };
  }, [all, now]);
  const match = (e: PublicEvent) => (!type || e.type === type) && (!q.trim() || `${e.title} ${e.description ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const shownUp = upcoming.filter(match);
  const shownPast = past.filter(match);
  const openCount = upcoming.filter((e) => regState(e, now).tone === 'open').length;

  return (
    <div className="min-h-screen overflow-x-clip bg-ivory-100 text-slate-800">
      <PublicNav />
      <main id="main">
        {/* ---------------------------------------------------------- hero */}
        <section className="relative isolate overflow-hidden bg-ink-950 text-white lg:flex lg:min-h-svh lg:items-center">
          <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
            <div className="absolute -left-48 -top-48 h-[40rem] w-[40rem] rounded-full bg-brand-600/35 blur-[140px]" />
            <div className="absolute -bottom-56 right-[-8rem] h-[38rem] w-[38rem] rounded-full bg-coral-500/20 blur-[150px]" />
            <div className="absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(255,255,255,.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.045)_1px,transparent_1px)] [background-size:64px_64px] [mask-image:radial-gradient(ellipse_at_30%_30%,black,transparent_72%)]" />
            <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          </div>
          <div className="shell grid items-center gap-x-12 gap-y-16 pb-20 pt-[calc(76px+2.5rem)] sm:pt-[calc(88px+3rem)] lg:grid-cols-[1.02fr_0.98fr] lg:gap-x-14 lg:pb-[clamp(3rem,8vh,5rem)] lg:pt-[calc(88px+clamp(2rem,6vh,4rem))] xl:gap-x-20">
            <motion.div initial="hidden" animate="show" variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08 } } }}>
              <motion.p variants={reveal} className="inline-flex max-w-full items-center gap-2 rounded-full border border-coral-400/40 bg-coral-400/10 px-3.5 py-1.5 text-xs font-semibold text-gold-300 backdrop-blur">
                <GraduationCap size={14} className="shrink-0" /> <span className="truncate">{UNIVERSITY_NAME}</span>
              </motion.p>
              <motion.h1 variants={reveal} className="mt-6 font-display text-[2.15rem] font-bold leading-[1.08] sm:text-5xl lg:mt-[clamp(1rem,3vh,1.5rem)] lg:text-[clamp(2.4rem,3.2vw+0.6rem,4.4rem)]">
                Compete, learn and celebrate,{' '}
                <span className="bg-gradient-to-r from-gold-300 via-coral-400 to-brand-300 bg-clip-text text-transparent">together at PUB.</span>
              </motion.h1>
              <motion.p variants={reveal} className="mt-6 max-w-xl text-base leading-relaxed text-white/75 sm:text-lg lg:mt-[clamp(0.75rem,2.5vh,1.5rem)] xl:max-w-2xl">
                Browse the university’s seminars, workshops, competitions and programming contests, register in minutes, and follow results as they happen.
              </motion.p>
              <motion.div variants={reveal} className="mt-9 grid gap-3 min-[460px]:flex min-[460px]:flex-wrap lg:mt-[clamp(1.25rem,4vh,2.25rem)]">
                <a href="#events" className="btn-cyan">
                  Explore events <ArrowRight size={16} />
                </a>
                <Link to="/register" className="btn-outline-light">Create an account</Link>
              </motion.div>
              {all.length > 0 && (
                <motion.dl variants={reveal} className="mt-12 grid max-w-lg grid-cols-3 lg:mt-[clamp(1.25rem,5vh,3rem)] divide-x divide-white/15 rounded-2xl border border-white/15 bg-white/[0.05] py-4 backdrop-blur">
                  {[
                    [upcoming.length, 'upcoming'],
                    [openCount, 'open now'],
                    [past.length, 'completed'],
                  ].map(([v, l]) => (
                    <div key={l} className="px-3 text-center sm:px-5">
                      <dd className="font-display text-2xl font-bold tabular-nums text-white sm:text-3xl"><AnimatedNumber value={v as number} /></dd>
                      <dt className="text-xs text-white/60">{l as string}</dt>
                    </div>
                  ))}
                </motion.dl>
              )}
            </motion.div>

            {/* campus photo in a glowing frame, with the logo breaking out of the top-left corner */}
            <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.6, ease: 'easeOut' }} className="relative mx-auto w-full max-w-xl lg:max-w-none">
              <span aria-hidden className="absolute -inset-4 -z-10 rounded-[2.5rem] bg-gradient-to-br from-coral-400/50 via-brand-500/30 to-transparent opacity-80 blur-2xl" />
              <div className="relative overflow-hidden rounded-[1.75rem] border border-white/25 p-1.5 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.7)] [background:linear-gradient(135deg,rgba(255,255,255,.28),rgba(255,255,255,.04))]">
                <div className="relative aspect-[4/3.1] overflow-hidden rounded-[1.3rem] sm:aspect-[4/3] lg:aspect-auto lg:h-[min(62vh,700px)]">
                  <picture>
                    <source media="(max-width: 767px)" srcSet={BANNER_SM_SRC} />
                    <img src={BANNER_SRC} alt="Aerial view of the PUB campus entrance, surrounded by green fields" fetchPriority="high" decoding="async" className="h-full w-full animate-ken-burns object-cover motion-reduce:animate-none" />
                  </picture>
                  <div aria-hidden className="absolute inset-0 bg-gradient-to-t from-ink-950/80 via-ink-950/5 to-brand-700/20" />
                  <p className="absolute bottom-4 left-5 hidden text-xs font-medium text-white/85 sm:block">{UNIVERSITY_NAME}</p>
                </div>
              </div>
              <div className="absolute -left-2 -top-9 sm:-left-5 sm:-top-11 lg:-left-7 lg:-top-[clamp(2rem,5vh,3.25rem)]">
                <span aria-hidden className="absolute inset-0 -z-10 scale-110 animate-glow-pulse rounded-full bg-brand-500/60 blur-3xl" />
                <BrandMark size={176} fluid priority className="h-20 animate-float !drop-shadow-[0_12px_32px_rgba(14,165,238,0.6)] sm:h-24 lg:h-[clamp(5rem,13vh,8.25rem)]" />
                <span className="sr-only">{EVENT_NAME}</span>
              </div>
            </motion.div>
          </div>
        </section>

        <Ticker titles={upcoming.map((e) => e.title)} />

        {/* ---------------------------------------------------------- events */}
        <section id="events" className="section-y scroll-mt-20">
          <div className="shell">
            <div className="flex flex-wrap items-end justify-between gap-6">
              <SectionTitle eyebrow="What’s on" title="Events & competitions">Sign in to open an event, see its full schedule and eligibility, and register.</SectionTitle>
              <div className="flex w-full flex-col gap-3 sm:w-auto sm:min-w-[22rem]">
                <label className="relative block">
                  <span className="sr-only">Search events</span>
                  <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input className="input pl-9" placeholder="Search events…" value={q} onChange={(x) => setQ(x.target.value)} />
                </label>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
                  {['', ...EVENT_TYPES].map((t) => (
                    <button key={t || 'all'} type="button" aria-pressed={type === t} onClick={() => setType(t)} className={`rounded-full border px-3 py-1 text-xs font-semibold capitalize transition ${type === t ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-brand-400'}`}>
                      {t || 'All'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-10" aria-live="polite">
              {events.isLoading ? (
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 min-[1560px]:grid-cols-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-80 rounded-xl" />)}</div>
              ) : events.error ? (
                <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-800">Events could not be loaded right now. Please try again shortly.</div>
              ) : shownUp.length === 0 && shownPast.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
                  <CalendarDays className="mx-auto text-slate-300" size={36} />
                  <p className="mt-3 font-display text-lg font-semibold text-ink-900 dark:text-slate-100">{all.length ? 'No events match your search' : 'No events have been published yet'}</p>
                  <p className="mt-1 text-sm text-slate-500">{all.length ? 'Try a different keyword or event type.' : 'Check back soon — new events appear here as they are announced.'}</p>
                </div>
              ) : (
                <>
                  {shownUp.length > 0 && (
                    <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }} variants={{ hidden: {}, show: { transition: { staggerChildren: 0.07 } } }} className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 min-[1560px]:grid-cols-4">
                      {shownUp.map((e) => <PublicEventCard key={e._id} e={e} now={now} />)}
                    </motion.div>
                  )}
                  {shownPast.length > 0 && (
                    <div className="mt-16">
                      <h3 className="font-display text-2xl font-semibold text-ink-900 dark:text-slate-100">Past events</h3>
                      <motion.div initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }} variants={{ hidden: {}, show: { transition: { staggerChildren: 0.07 } } }} className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3 min-[1560px]:grid-cols-4">
                        {shownPast.map((e) => <PublicEventCard key={e._id} e={e} now={now} />)}
                      </motion.div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </section>

        <Schedule events={upcoming} />
        <HowItWorks />

        {/* ---------------------------------------------------------- about */}
        <section id="about" className="section-y scroll-mt-20 border-y border-slate-200/80 bg-ivory-50">
          <div className="shell grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-16">
            <div>
              <SectionTitle eyebrow="About" title={UNIVERSITY_NAME}>
                {PLATFORM_NAME} is the home of the university’s events, programming contests and volunteer teams. Students, organisers and judges each get the tools they need — from registration to results.
              </SectionTitle>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link to="/register" className="btn-primary !rounded-md !px-5 !py-2.5">Create an account</Link>
                <Link to="/login" className="btn-ghost !rounded-md !px-5 !py-2.5">Log in</Link>
              </div>
            </div>
            <motion.ul initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }} variants={{ hidden: {}, show: { transition: { staggerChildren: 0.08 } } }} className="grid gap-4 sm:grid-cols-2">
              <Feature icon={CalendarDays} title="Simple registration" text="Register as an individual or a team, with eligibility checks and an automatic waiting list." />
              <Feature icon={QrCode} title="QR check-in" text="Short-lived QR passes make arrival at the venue quick and hard to share." />
              <Feature icon={Trophy} title="Live contests" text="Programming contests with judged submissions and a live leaderboard." />
              <Feature icon={Users} title="Teams & volunteers" text="Shifts, tasks and announcements keep organisers and volunteers in step." />
            </motion.ul>
          </div>
        </section>

        {/* ---------------------------------------------------------- verify */}
        <section className="section-y">
          <div className="shell">
          <div className="relative isolate flex flex-col items-start justify-between gap-6 overflow-hidden rounded-3xl bg-gradient-to-br from-ink-900 via-ink-800 to-brand-800 px-6 py-10 text-white shadow-lift sm:flex-row sm:items-center sm:px-10 lg:px-14 lg:py-12"><span aria-hidden className="absolute -right-16 -top-20 -z-10 h-64 w-64 rounded-full bg-coral-500/25 blur-[90px]" />
            <div className="flex items-start gap-4">
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-white/10 text-gold-300"><ShieldCheck size={24} /></span>
              <div>
                <h2 className="font-display text-2xl font-semibold">Verify a certificate</h2>
                <p className="mt-1 max-w-xl text-sm leading-relaxed text-white/70">Received a PUB FestHub certificate? Enter its ID to confirm it is genuine — no account needed.</p>
              </div>
            </div>
            <Link to="/verify" className="btn-cyan shrink-0">Verify now <ArrowRight size={15} /></Link>
          </div>
          </div>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}