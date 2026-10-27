import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AnimatePresence } from 'framer-motion';
import { Bell, CalendarCheck2, CalendarDays, ClipboardCheck, Hourglass, MailPlus, Plus, QrCode, Sparkles, Ticket, X } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { fmt, fmtDate, useAct, useGet } from '../lib/hooks';
import { Badge, Card, EmptyState, Query, StatTile, useConfirm } from '../components/ui';
import EventCover from '../components/EventCover';
import RoleRequestPanel from '../components/RoleRequestPanel';

interface Dash {
  registrations: { confirmed: number; waitlisted: number; pending: number };
  unreadNotifications: number;
  pendingInvitations: number;
  upcomingShifts: { _id: string; title: string; start: string; end: string }[];
  staff?: { publishedEvents: number; pendingApprovals: number };
}
interface Reg {
  _id: string;
  status: string;
  event?: { _id: string; title: string; type: string; imageUrl?: string; startAt: string };
}
interface Inv {
  _id: string;
  team: { name: string };
  eventTitle: string;
}
const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

export default function Dashboard() {
  const { user, has } = useAuth();
  const confirm = useConfirm();
  const d = useGet<Dash>('/me/dashboard');
  const regs = useGet<Reg[]>('/me/registrations');
  const invs = useGet<Inv[]>('/me/invitations');
  const cancel = useAct((id: string) => api.del(`/registrations/${id}`), { ok: 'Registration cancelled', invalidate: ['/me/registrations', '/me/dashboard', '/notifications'] });
  const first = user?.name.split(' ')[0] ?? '';
  return (
    <>
      <motion.section initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} className="relative isolate mb-6 overflow-hidden rounded-2xl bg-ink-900 p-6 text-white shadow-lift sm:p-9">
        <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
          <div className="absolute -left-16 -top-24 h-72 w-72 rounded-full bg-brand-600/50 blur-[100px]" />
          <div className="absolute -bottom-28 right-0 h-72 w-72 rounded-full bg-brand-500/20 blur-[110px]" />
          <div className="absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(255,255,255,.05)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.05)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_at_20%_10%,black,transparent_75%)]" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gold-400/70 to-transparent" />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-white/70">
          <Sparkles size={14} className="text-gold-300" /> {user?.roles.join(' · ')}
        </div>
        <h1 className="mt-2 font-display text-3xl font-bold sm:text-4xl">
          {greeting()}, {first}
        </h1>
        <p className="mt-1 max-w-xl text-sm text-white/70">Here’s where everything stands across your events, shifts and contests.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Link to="/events" className="inline-flex items-center gap-1.5 rounded-lg bg-gold-400 px-4 py-2 text-sm font-semibold text-ink-900 shadow transition hover:-translate-y-0.5 hover:bg-gold-300 active:scale-95">
            <CalendarDays size={15} /> Browse events
          </Link>
          {has('organiser') && (
            <Link to="/events/new" className="inline-flex items-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-4 py-2 text-sm font-semibold transition hover:bg-white/20 active:scale-95">
              <Plus size={15} /> Create event
            </Link>
          )}
          {has('admin', 'organiser', 'coordinator', 'participant', 'volunteer', 'judge') && (
          <Link to="/checkin" className="inline-flex items-center gap-1.5 rounded-lg border border-white/25 bg-white/10 px-4 py-2 text-sm font-semibold transition hover:bg-white/20 active:scale-95">
            <QrCode size={15} /> {has('organiser', 'coordinator') ? 'Scan check-in' : 'My QR pass'}
          </Link>
          )}
        </div>
      </motion.section>

      <RoleRequestPanel />

      <Query q={d}>
        {(x) => (
          <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.05 } } }} className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              <StatTile key="a" icon={CalendarCheck2} label="Confirmed registrations" value={x.registrations.confirmed} tone="green" />,
              <StatTile key="b" icon={Hourglass} label="On waiting list" value={x.registrations.waitlisted} tone="amber" />,
              <StatTile key="c" icon={ClipboardCheck} label="Awaiting approval" value={x.registrations.pending} />,
              <StatTile key="d" icon={Bell} label="Unread notifications" value={x.unreadNotifications} tone="red" />,
              ...(x.staff
                ? [<StatTile key="e" icon={Ticket} label="Published events" value={x.staff.publishedEvents} />, <StatTile key="f" icon={ClipboardCheck} label="Registrations to approve" value={x.staff.pendingApprovals} tone="amber" />]
                : []),
            ].map((t, i) => (
              <motion.div key={i} variants={{ hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0 } }}>
                {t}
              </motion.div>
            ))}
          </motion.div>
        )}
      </Query>

      <div className="grid gap-5 md:grid-cols-2">
        <Card className="!p-5">
          <h2 className="mb-3 text-lg font-semibold">My registrations</h2>
          <Query q={regs}>
            {(r) =>
              r.length === 0 ? (
                <EmptyState icon={Ticket} title="No registrations yet" hint="Find something to join." action={<Link className="btn-primary btn-sm mt-1" to="/events">Browse events</Link>} />
              ) : (
                <ul className="space-y-2">
                  <AnimatePresence initial={false}>
                    {r.map((g) => (
                      <motion.li key={g._id} layout exit={{ opacity: 0, x: 40 }} className="group flex items-center gap-3 rounded-xl p-1.5 transition hover:bg-white/80">
                        <Link to={`/events/${g.event?._id}`} className="flex min-w-0 flex-1 items-center gap-3">
                          <EventCover title={g.event?.title ?? ''} type={g.event?.type ?? ''} imageUrl={g.event?.imageUrl} className="h-12 w-16 shrink-0 rounded-lg" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-slate-900 group-hover:text-brand-700">{g.event?.title}</span>
                            <span className="block text-xs text-slate-500">{fmtDate(g.event?.startAt)}</span>
                          </span>
                        </Link>
                        <Badge value={g.status} />
                        <button
                          className="icon-btn-danger"
                          aria-label={`Cancel registration for ${g.event?.title}`}
                          title="Cancel registration"
                          onClick={() => confirm({ title: 'Cancel this registration?', message: `Your seat for “${g.event?.title}” is released and the next person on the waiting list is promoted.`, tone: 'danger', confirmText: 'Cancel registration', cancelText: 'Keep it', run: () => cancel.mutateAsync(g._id) })}
                        >
                          <X size={15} />
                        </button>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              )
            }
          </Query>
        </Card>
        <Card className="!p-5">
          <h2 className="mb-3 text-lg font-semibold">Team invitations</h2>
          <Query q={invs}>
            {(i) =>
              i.length === 0 ? (
                <EmptyState icon={MailPlus} title="No pending invitations" />
              ) : (
                <ul className="space-y-2 text-sm">
                  {i.map((v) => (
                    <li key={v._id} className="rounded-xl bg-amber-50 p-3">
                      Team <b>{v.team?.name}</b> · {v.eventTitle}
                    </li>
                  ))}
                </ul>
              )
            }
          </Query>
          <p className="mt-3 text-xs text-slate-500">Open the event page to accept or decline.</p>
        </Card>
        {has('volunteer') && (
          <Card className="!p-5">
            <h2 className="mb-3 text-lg font-semibold">Upcoming shifts</h2>
            <Query q={d}>
              {(x) =>
                x.upcomingShifts.length === 0 ? (
                  <EmptyState title="No upcoming shifts" />
                ) : (
                  <ul className="space-y-2 text-sm">
                    {x.upcomingShifts.map((s) => (
                      <li key={s._id} className="rounded-xl bg-white/70 p-3">
                        <b>{s.title}</b> · {fmt(s.start)}
                      </li>
                    ))}
                  </ul>
                )
              }
            </Query>
          </Card>
        )}
      </div>
    </>
  );
}
