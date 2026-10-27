import { Suspense, useEffect, useId, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate, useOutlet } from 'react-router-dom';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { Award, CalendarDays, Code2, Gavel, GraduationCap, HandHelping, LayoutDashboard, LogOut, Gauge, Medal, Sparkles, Menu, Moon, QrCode, ScrollText, Sun, Trophy, UserCheck, Users, X, type LucideIcon } from 'lucide-react';
import type { Role } from '@festhub/shared';
import { useAuth } from '../lib/auth';
import { useNotificationSocket } from '../lib/socket';
import { useTheme } from '../lib/theme';
import { usePendingRoleCount } from '../lib/roleRequests';
import { Avatar, Spinner, useToast } from './ui';
import NotificationBell from './NotificationBell';
import { BrandLockup, BrandMark } from './Brand';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  roles?: Role[];
}
const NON_SPONSOR: Role[] = ['admin', 'organiser', 'coordinator', 'participant', 'volunteer', 'judge'];
const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: 'Fest',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/command-center', label: 'Command center', icon: Gauge, roles: ['organiser'] },
      { to: '/events', label: 'Events', icon: CalendarDays },
      { to: '/checkin', label: 'QR check-in', icon: QrCode, roles: NON_SPONSOR },
      { to: '/achievements', label: 'My achievements', icon: Sparkles },
      { to: '/certificates', label: 'Certificates', icon: Award },
      { to: '/volunteer', label: 'Volunteer desk', icon: HandHelping, roles: ['volunteer', 'coordinator', 'organiser'] },
      { to: '/leaderboard', label: 'Leaderboard', icon: Medal },
      { to: '/judging', label: 'Judging', icon: Gavel, roles: ['judge'] },
    ],
  },
  {
    title: 'Programming',
    items: [
      { to: '/contests', label: 'Contests', icon: Trophy, roles: NON_SPONSOR },
      { to: '/problems', label: 'Practice', icon: Code2, roles: NON_SPONSOR },
      { to: '/progress', label: 'My progress', icon: GraduationCap, roles: NON_SPONSOR },
      { to: '/setter', label: 'Problem setting', icon: Code2, roles: ['judge', 'organiser'] },
    ],
  },
  {
    title: 'Admin',
    items: [
      { to: '/admin/users', label: 'Users & roles', icon: Users, roles: ['organiser'] },
      { to: '/admin/role-requests', label: 'Role requests', icon: UserCheck, roles: ['organiser'] },
      { to: '/admin/audit', label: 'Audit log', icon: ScrollText, roles: ['organiser'] },
    ],
  },
];

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button className="icon-btn" onClick={toggle} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} title={dark ? 'Light mode' : 'Dark mode'}>
      {dark ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

/** Thin gradient bar at the top: visible only while a first load or a save is in flight (background polling never triggers it). */
function NavProgress() {
  const loading = useIsFetching({ predicate: (q) => q.state.status === 'pending' });
  const saving = useIsMutating();
  const active = loading + saving > 0;
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!active) return setShow(false);
    const t = setTimeout(() => setShow(true), 120); // don't flash for instant responses
    return () => clearTimeout(t);
  }, [active]);
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="bar"
          className="fixed inset-x-0 top-0 z-[90] h-[3px] origin-left bg-gradient-to-r from-brand-700 via-brand-500 to-gold-400 shadow-glow"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 0.85, transition: { duration: 6, ease: 'easeOut' } }}
          exit={{ scaleX: 1, opacity: 0, transition: { duration: 0.25 } }}
        />
      )}
    </AnimatePresence>
  );
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const { user, has, logout } = useAuth();
  const nav = useNavigate();
  const pill = useId();
  const pendingRoles = usePendingRoleCount(has('organiser'));
  return (
    <div className="flex h-full flex-col">
      <div className="mb-6 px-1.5">
        <BrandLockup onClick={onNavigate} />
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto" aria-label="Main">
        {GROUPS.map((g) => {
          const items = g.items.filter((n) => !n.roles || has(...n.roles));
          if (!items.length) return null;
          return (
            <div key={g.title}>
              <div className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{g.title}</div>
              <div className="space-y-0.5">
                {items.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.to === '/'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `group relative flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'text-brand-800' : 'text-slate-600 hover:bg-brand-50/70 hover:text-slate-900'}`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {isActive && (
                          <motion.span
                            layoutId={`pill-${pill}`}
                            className="absolute inset-0 rounded-lg border border-brand-100 bg-brand-50 shadow-sm"
                            transition={{ type: 'spring', stiffness: 450, damping: 36 }}
                          />
                        )}
                        {isActive && (
                          <motion.span
                            layoutId={`bar-${pill}`}
                            className="absolute -left-1 top-2 bottom-2 w-1 rounded-full bg-gold-500"
                          />
                        )}
                        <n.icon size={17} className="relative transition-transform duration-200 group-hover:scale-110" />
                        <span className="relative">{n.label}</span>
                        {n.to === '/admin/role-requests' && pendingRoles > 0 && (
                          <span className="relative ml-auto grid min-w-[1.25rem] place-items-center rounded-full bg-gradient-to-br from-coral-500 to-rose-600 px-1.5 text-[11px] font-bold leading-5 text-white" aria-label={`${pendingRoles} pending`}>
                            {pendingRoles > 99 ? '99+' : pendingRoles}
                          </span>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-slate-200/90 bg-white p-2.5 shadow-sm">
        <Avatar name={user?.name ?? '?'} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-semibold">{user?.name}</div>
          <div className="truncate text-xs text-slate-500">{user?.roles.join(', ')}</div>
        </div>
        <button
          className="icon-btn"
          aria-label="Log out"
          title="Log out"
          onClick={async () => {
            await logout();
            nav('/login');
          }}
        >
          <LogOut size={16} />
        </button>
      </div>
    </div>
  );
}

export default function Layout({ children }: { children?: ReactNode } = {}) {
  const toast = useToast();
  const loc = useLocation();
  const routed = useOutlet();
  const outlet = children ?? routed;
  const [open, setOpen] = useState(false);
  useNotificationSocket((m) => toast(m, 'ok')); // live push: badge + toast, in this tab and every other open tab
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <div className="min-h-screen lg:flex" style={{ overflowX: 'clip' }}>
      <NavProgress />
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-slate-200/90 bg-ivory-50 p-4 lg:block">
        <SideNav />
      </aside>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-ink-950/40 backdrop-blur-sm lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />
            <motion.aside
              className="fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] overflow-y-auto border-r border-slate-200/90 bg-ivory-50 p-4 shadow-2xl lg:hidden"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 380, damping: 38 }}
            >
              <button className="icon-btn absolute right-3 top-4" onClick={() => setOpen(false)} aria-label="Close menu">
                <X size={18} />
              </button>
              <SideNav onNavigate={() => setOpen(false)} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-slate-200/90 bg-ivory-50/90 px-4 py-2.5 backdrop-blur-xl sm:px-8 lg:px-10 xl:px-14">
          <button className="icon-btn lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu size={20} />
          </button>
          <Link to="/" className="flex min-w-0 flex-1 items-center gap-2 lg:hidden" aria-label="PUB FestHub home">
            <BrandMark size={34} priority />
            <span className="truncate font-display text-base font-bold">PUB FestHub</span>
          </Link>
          <div className="hidden flex-1 text-sm text-slate-500 lg:block" />
          <div className="flex items-center gap-1">
            <ThemeToggle />
            <NotificationBell />
          </div>
        </header>
        <main className="mx-auto w-full min-w-0 max-w-[1680px] flex-1 overflow-x-hidden px-3 py-4 sm:px-8 sm:py-8 lg:px-10 xl:px-14">
          <motion.div key={loc.pathname} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: 'easeOut' }}>
            <Suspense fallback={<Spinner />}>{outlet}</Suspense>
          </motion.div>
        </main>
      </div>
    </div>
  );
}
