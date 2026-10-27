import { forwardRef, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CalendarClock,
  CalendarDays,
  Clock3,
  Copy,
  Crown,
  MapPin,
  Pencil,
  Pin,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Trophy,
  UserMinus,
  Users,
} from 'lucide-react';
import { EVENT_TYPES } from '@festhub/shared';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { fmt, fmtDate, fmtTime, useAct, useDelete, useGet } from '../lib/hooks';
import { useLive } from '../lib/socket';
import { Badge, Card, Empty, EmptyState, Field, Query, Skeleton, TrashButton, useConfirm, useToast } from '../components/ui';
import EventCover from '../components/EventCover';
import EntryPanel from './EntryPanel';

interface Ev {
  _id: string;
  title: string;
  type: string;
  status: string;
  description: string;
  imageUrl?: string;
  venueName?: string;
  startAt: string;
  endAt: string;
  registrationDeadline: string;
  capacity: number;
  spotsLeft: number;
  participationType: 'individual' | 'team';
  teamSize?: { min: number; max: number };
  requiresApproval: boolean;
  eligibility?: { department?: string; batch?: string; notes?: string };
  myRegistrationStatus?: string | null;
}

const closesIn = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'Closed';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `Closes in ${d}d ${h}h` : h > 0 ? `Closes in ${h}h ${m}m` : `Closes in ${m}m`;
};
const DELETE_WARNING = 'Every registration, schedule item, shift, task and announcement for this event is deleted with it, and registered people are notified.';

function SeatMeter({ capacity, left }: { capacity: number; left: number }) {
  const taken = capacity - left;
  const pct = Math.min(100, Math.round((taken / Math.max(1, capacity)) * 100));
  const hot = pct >= 85;
  return (
    <div>
      <div className="mb-1 flex justify-between text-xs">
        <span className="font-medium text-slate-600">{left > 0 ? `${left} of ${capacity} spots left` : 'Full · waiting list open'}</span>
        <span className="text-slate-400">{pct}%</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-slate-200/80"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Seats taken"
      >
        <motion.div
          className={`h-full rounded-full ${hot ? 'bg-gradient-to-r from-gold-500 to-gold-600' : 'bg-gradient-to-r from-brand-600 to-brand-800'}`}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
        />
      </div>
    </div>
  );
}

// forwardRef: <AnimatePresence mode="popLayout"> measures its children through a ref
const EventCard = forwardRef<HTMLElement, { e: Ev; organiser: boolean; onDelete: () => void }>(function EventCard({ e, organiser, onDelete }, ref) {
  const d = new Date(e.startAt);
  return (
    <motion.article
      ref={ref}
      layout
      variants={{ hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0 } }}
      exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.2 } }}
      className="card-interactive group relative flex flex-col overflow-hidden !p-0"
    >
      <Link to={`/events/${e._id}`} className="absolute inset-0 z-10 rounded-2xl" aria-label={`Open ${e.title}`} />
      <EventCover title={e.title} type={e.type} imageUrl={e.imageUrl} className="h-44">
        <div className="flex h-full flex-col justify-between p-3">
          <div className="flex flex-wrap gap-1.5">
            <Badge value={e.type} />
            {e.status !== 'published' && <Badge value={e.status} />}
            {e.myRegistrationStatus && <Badge value={e.myRegistrationStatus} />}
          </div>
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="rounded-xl border border-white/30 bg-white/20 px-2.5 py-1 text-center text-white backdrop-blur-md">
              <div className="text-[10px] font-semibold leading-none">{d.toLocaleString([], { month: 'short' }).toUpperCase()}</div>
              <div className="font-display text-xl font-bold leading-tight">{d.getDate()}</div>
            </div>
          </div>
        </div>
      </EventCover>
      {organiser && (
        <div className="absolute right-3 top-3 z-20 flex gap-1 opacity-100 transition sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <Link
            to={`/events/${e._id}/edit`}
            className="grid h-8 w-8 place-items-center rounded-lg bg-white/90 text-slate-700 shadow transition hover:bg-white active:scale-90"
            aria-label={`Edit ${e.title}`}
            title="Edit"
            onClick={(x) => x.stopPropagation()}
          >
            <Pencil size={14} />
          </Link>
          <button
            className="grid h-8 w-8 place-items-center rounded-lg bg-white/90 text-red-600 shadow transition hover:bg-red-600 hover:text-white active:scale-90"
            aria-label={`Delete ${e.title}`}
            title="Delete"
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </button>
        </div>
      )}
      <div className="flex flex-1 flex-col gap-2 p-4">
        <h2 className="line-clamp-2 font-display text-lg font-semibold leading-snug">{e.title}</h2>
        <p className="flex items-center gap-1.5 text-sm text-slate-500">
          <Clock3 size={14} className="shrink-0" /> {fmtDate(e.startAt)} · {fmtTime(e.startAt)}
        </p>
        {e.venueName && (
          <p className="flex items-center gap-1.5 text-sm text-slate-500">
            <MapPin size={14} className="shrink-0" /> {e.venueName}
          </p>
        )}
        <div className="mt-auto pt-2">
          <SeatMeter capacity={e.capacity} left={e.spotsLeft} />
        </div>
      </div>
    </motion.article>
  );
});

export function EventsList() {
  const { has } = useAuth();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const staff = has('organiser', 'coordinator');
  const organiser = has('organiser');
  const qs = new URLSearchParams({ ...(q && { q }), ...(type && { type }), ...(status && staff && { status }) }).toString();
  const events = useGet<Ev[]>(`/events?${qs}`);
  const del = useDelete({ noun: 'event', request: (id) => api.del(`/events/${id}`), prune: ['/events?'], invalidate: ['/events?', '/me/registrations'] });
  // Invitation links look like /events?invite=<id>: jump to the event the invitation is for.
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const inviteId = sp.get('invite');
  const myInv = useGet<Inv[]>(inviteId ? '/me/invitations' : null);
  const target = inviteId ? myInv.data?.find((x) => x._id === inviteId) : undefined;
  useEffect(() => {
    if (inviteId && target) nav(`/events/${target.eventId}?invite=${inviteId}`, { replace: true });
  }, [inviteId, target, nav]);
  return (
    <>
      {inviteId && myInv.data && !target && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm" role="alert">
          This invitation is no longer available. It may have expired, been answered or cancelled, or it was sent to a different e-mail address. Ask the team
          leader to send a new one.
        </div>
      )}
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold sm:text-4xl">Events</h1>
          <p className="mt-1 text-sm text-slate-500">Seminars, workshops, competitions and contests</p>
        </div>
        {organiser && (
          <Link to="/events/new" className="btn-primary">
            <CalendarDays size={16} /> New event
          </Link>
        )}
      </div>
      <div className="mb-5 flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative lg:w-80">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-500" />
          <input className="input !pl-9" placeholder="Search events…" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-1 flex-wrap items-center gap-1.5" role="group" aria-label="Type">
          {['', ...EVENT_TYPES].map((t) => (
            <button
              key={t || 'all'}
              onClick={() => setType(t)}
              aria-pressed={type === t}
              className={`relative rounded-full px-3.5 py-1.5 text-sm font-semibold capitalize transition ${type === t ? 'text-white' : 'border border-white/80 bg-white/60 text-slate-600 hover:bg-white'}`}
            >
              {type === t && (
                <motion.span
                  layoutId="type-chip"
                  className="absolute inset-0 rounded-full bg-gradient-to-br from-brand-600 to-brand-800 shadow-md shadow-brand-500/30"
                  transition={{ type: 'spring', stiffness: 450, damping: 34 }}
                />
              )}
              <span className="relative">{t || 'All'}</span>
            </button>
          ))}
        </div>
        {staff && (
          <select className="input lg:w-44" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {['draft', 'published', 'cancelled', 'completed'].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        )}
      </div>
      {events.isLoading ? (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading events">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card overflow-hidden !p-0">
              <Skeleton className="h-44 !rounded-none" />
              <div className="space-y-2 p-4">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="mt-4 h-2 w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Query q={events}>
          {(list) =>
            list.length === 0 ? (
              <EmptyState icon={CalendarDays} title="No events match your filters" hint="Try a different search or clear the type filter." />
            ) : (
              <motion.div
                className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3"
                initial="hidden"
                animate="show"
                variants={{ show: { transition: { staggerChildren: 0.05 } } }}
              >
                <AnimatePresence mode="popLayout">
                  {list.map((e) => (
                    <EventCard
                      key={e._id}
                      e={e}
                      organiser={organiser}
                      onDelete={() => del({ id: e._id, name: e.title, warning: DELETE_WARNING, typeToConfirm: 'DELETE' })}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            )
          }
        </Query>
      )}
    </>
  );
}

interface Detail extends Ev {
  venue?: { name: string };
  activities: { _id: string; title: string; kind: string; start: string; end: string; submissionDeadline?: string }[];
  myRegistration?: { _id: string; status: string; waitlistPosition?: number } | null;
  myTeam?: { _id: string; name: string; leaderId: string; members: { id: string; name: string; email: string }[] } | null;
}
interface Ann {
  _id: string;
  title: string;
  body: string;
  pinned: boolean;
  createdAt: string;
}
interface Inv {
  _id: string;
  eventId: string;
  team: { name: string };
  eventTitle: string;
  inviterName?: string;
  expiresAt?: string;
}
interface SentInv {
  _id: string;
  email: string;
  name?: string;
  accountExists: boolean;
  expiresAt?: string;
  expired: boolean;
  link: string;
}
interface InviteResult {
  link: string;
  emailSent: boolean;
  accountExists: boolean;
}

const Fact = ({ icon: Icon, label, children }: { icon: typeof Clock3; label: string; children: React.ReactNode }) => (
  <div className="flex items-start gap-3 rounded-xl bg-white/60 p-3">
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand-600/10 to-brand-800/10 text-brand-700">
      <Icon size={17} />
    </span>
    <div className="min-w-0">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-sm font-semibold text-slate-900">{children}</dd>
    </div>
  </div>
);

interface PublishedResults {
  published: boolean;
  activities: { activityId: string; title: string; rankings: { rank: number; title: string; ownerName: string | null; percent: number; mine: boolean }[] }[];
}
const RANK_STYLE: Record<number, string> = {
  1: 'bg-amber-100 text-amber-800 ring-amber-300',
  2: 'bg-slate-100 text-slate-700 ring-slate-300',
  3: 'bg-orange-100 text-orange-800 ring-orange-300',
};

function ResultsTab({ eventId }: { eventId: string }) {
  const q = useGet<PublishedResults>(`/events/${eventId}/results`);
  return (
    <Query q={q}>
      {(d) =>
        !d.published ? (
          <Card>
            <Empty>Results not published yet</Empty>
          </Card>
        ) : (
          <>
            {d.activities.map((a) => (
              <Card key={a.activityId}>
                <h2 className="mb-3 text-lg font-semibold">{a.title}</h2>
                <ol className="space-y-2">
                  {a.rankings.map((x, i) => (
                    <li
                      key={i}
                      aria-current={x.mine ? 'true' : undefined}
                      className={`flex items-center gap-3 rounded-xl p-3 text-sm ${x.mine ? 'bg-brand-50 ring-2 ring-brand-300' : 'bg-white/70'}`}
                    >
                      <span
                        className={`inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-full px-2 font-bold ring-1 ${RANK_STYLE[x.rank] ?? 'bg-slate-50 text-slate-600 ring-slate-200'}`}
                        aria-label={`Position ${x.rank}`}
                      >
                        {x.rank <= 3 && <Trophy size={13} aria-hidden />}#{x.rank}
                      </span>
                      <span className="min-w-0 flex-1">
                        <b className="block truncate">
                          {x.ownerName ?? x.title}
                          {x.mine && <span className="ml-2 rounded-full bg-brand-600 px-2 py-0.5 text-xs font-semibold text-white">You</span>}
                        </b>
                        {x.ownerName && <span className="block truncate text-xs text-slate-500">{x.title}</span>}
                      </span>
                      <b className="tabular-nums">{x.percent}%</b>
                    </li>
                  ))}
                </ol>
              </Card>
            ))}
          </>
        )
      }
    </Query>
  );
}

export function EventDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { user, has } = useAuth();
  const confirm = useConfirm();
  const key = `/events/${id}`;
  const q = useGet<Detail>(key);
  const anns = useGet<Ann[]>(`/events/${id}/announcements`);
  const invs = useGet<Inv[]>('/me/invitations');
  const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const focusInvite = sp.get('invite');
  const [lastInvite, setLastInvite] = useState<InviteResult | null>(null);
  const mt = q.data?.myTeam;
  const leaderTeamId = mt && mt.leaderId === user?.id && !q.data?.myRegistration ? mt._id : null;
  const sent = useGet<SentInv[]>(leaderTeamId ? `/teams/${leaderTeamId}/invitations` : null);
  const sentKey = `/teams/${leaderTeamId}/invitations`;
  const copyLink = (link: string) =>
    navigator.clipboard?.writeText(link).then(
      () => toast('Invite link copied', 'ok'),
      () => toast('Could not copy. Select and copy the link manually.', 'error'),
    );
  useLive([`event:${id}`], {});
  const refresh = [key, '/me/dashboard', '/me/registrations', '/notifications'];
  const register = useAct((teamId?: string) => api.post(`/events/${id}/register`, teamId ? { teamId } : {}), {
    ok: 'Registration submitted',
    invalidate: refresh,
  });
  const cancel = useAct((rid: string) => api.del(`/registrations/${rid}`), { ok: 'Registration cancelled', invalidate: refresh });
  const [teamName, setTeamName] = useState('');
  const [email, setEmail] = useState('');
  const mkTeam = useAct(() => api.post(`/events/${id}/teams`, { name: teamName }), { ok: 'Team created', invalidate: refresh, onDone: () => setTeamName('') });
  const invite = useAct((teamId: string) => api.post<InviteResult>(`/teams/${teamId}/invitations`, { email }), {
    ok: 'Invitation created',
    invalidate: [...refresh, sentKey],
    onDone: (r) => {
      setEmail('');
      setLastInvite(r as InviteResult);
    },
  });
  const resend = useAct(({ t, i }: { t: string; i: string }) => api.post<{ emailSent: boolean }>(`/teams/${t}/invitations/${i}/resend`), {
    ok: 'Invitation renewed for 14 days',
    invalidate: [sentKey],
  });
  const cancelInv = useAct(({ t, i }: { t: string; i: string }) => api.del(`/teams/${t}/invitations/${i}`), {
    ok: 'Invitation cancelled',
    invalidate: [...refresh, sentKey],
  });
  const answer = useAct(({ iid, yes }: { iid: string; yes: boolean }) => api.post(`/invitations/${iid}/${yes ? 'accept' : 'reject'}`), {
    ok: 'Done',
    invalidate: [...refresh, '/me/invitations'],
  });
  const kick = useAct(({ t, u }: { t: string; u: string }) => api.del(`/teams/${t}/members/${u}`), { invalidate: refresh });

  const delEvent = useDelete({
    noun: 'event',
    request: (i) => api.del(`/events/${i}`),
    invalidate: ['/events?', '/me/registrations'],
    onDeleted: () => nav('/events', { replace: true }),
  });
  const delAnn = useDelete({ noun: 'announcement', request: (i) => api.del(`/announcements/${i}`), prune: [`/events/${id}/announcements`] });
  const delTeam = useDelete({ noun: 'team', request: (i) => api.del(`/teams/${i}`), invalidate: refresh });

  return (
    <Query q={q}>
      {(e) => {
        const open = e.status === 'published' && new Date() <= new Date(e.registrationDeadline);
        const reg = e.myRegistration;
        const team = e.myTeam;
        const isLeader = team && team.leaderId === user?.id;
        const canSeeResults = !!(reg || team);
        const tab = canSeeResults && sp.get('tab') === 'results' ? 'results' : 'overview';
        const myInvites = (invs.data ?? []).filter((i) => i.eventId === e._id);
        return (
          <>
            {/* ---------------------------------------------------------------- hero */}
            <div className="relative -mx-1 mb-6 overflow-hidden rounded-3xl shadow-lift">
              <EventCover title={e.title} type={e.type} imageUrl={e.imageUrl} priority className="min-h-[18rem] sm:min-h-[24rem]">
                <div className="flex h-full min-h-[18rem] flex-col justify-between p-5 sm:min-h-[24rem] sm:p-8">
                  <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex flex-wrap gap-1.5">
                      <Badge value={e.type} />
                      <Badge value={e.status} />
                      <Badge value={e.participationType} />
                      {e.requiresApproval && <Badge value="approval required" />}
                    </div>
                    <div className="flex gap-1.5">
                      {has('organiser') && (
                        <Link
                          className="inline-flex items-center gap-1.5 rounded-xl border border-white/30 bg-white/20 px-3 py-1.5 text-sm font-semibold text-white backdrop-blur-md transition hover:bg-white/30 active:scale-95"
                          to={`/events/${id}/edit`}
                        >
                          <Pencil size={14} /> Edit
                        </Link>
                      )}
                      {has('organiser', 'coordinator') && (
                        <Link
                          className="inline-flex items-center gap-1.5 rounded-xl border border-white/30 bg-white/20 px-3 py-1.5 text-sm font-semibold text-white backdrop-blur-md transition hover:bg-white/30 active:scale-95"
                          to={`/events/${id}/manage`}
                        >
                          <Settings2 size={14} /> Manage
                        </Link>
                      )}
                      {has('organiser') && (
                        <button
                          className="inline-flex items-center gap-1.5 rounded-xl border border-red-300/40 bg-red-500/30 px-3 py-1.5 text-sm font-semibold text-white backdrop-blur-md transition hover:bg-red-500/60 active:scale-95"
                          onClick={() => delEvent({ id: e._id, name: e.title, warning: DELETE_WARNING, typeToConfirm: 'DELETE' })}
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      )}
                    </div>
                  </motion.div>
                  <div>
                    <motion.h1
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.1 }}
                      className="max-w-3xl font-display text-3xl font-bold leading-[1.05] text-white drop-shadow-md sm:text-5xl"
                    >
                      {e.title}
                    </motion.h1>
                    <motion.div
                      initial={{ opacity: 0, y: 12 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.2 }}
                      className="mt-4 flex flex-wrap gap-2 text-sm text-white"
                    >
                      {[
                        [CalendarClock, `${fmt(e.startAt)} – ${fmtTime(e.endAt)}`],
                        ...(e.venue ? [[MapPin, e.venue.name]] : []),
                        [Users, `${e.capacity} seats`],
                      ].map(([Icon, text], i) => {
                        const I = Icon as typeof Clock3;
                        return (
                          <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/15 px-3 py-1 backdrop-blur-md">
                            <I size={14} /> {text as string}
                          </span>
                        );
                      })}
                    </motion.div>
                  </div>
                </div>
              </EventCover>
            </div>

            <div className="grid gap-5 lg:grid-cols-3">
              <div className="space-y-5 lg:col-span-2">
                {canSeeResults && (
                  <div role="tablist" aria-label="Event sections" className="flex gap-1 rounded-xl bg-white/60 p-1">
                    {(['overview', 'results'] as const).map((t) => (
                      <button
                        key={t}
                        role="tab"
                        aria-selected={tab === t}
                        className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-semibold capitalize transition ${tab === t ? 'bg-brand-600 text-white shadow' : 'text-slate-600 hover:bg-white'}`}
                        onClick={() => setSp(t === 'results' ? { tab: 'results' } : {}, { replace: true })}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                {tab === 'results' && <ResultsTab eventId={e._id} />}
                {tab === 'overview' && (
                  <>
                    <Card>
                      <h2 className="mb-2 text-lg font-semibold">About this event</h2>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{e.description || 'No description.'}</p>
                      <dl className="mt-4 grid gap-2 sm:grid-cols-2">
                        <Fact icon={CalendarClock} label="Registration deadline">
                          {fmt(e.registrationDeadline)}
                        </Fact>
                        <Fact icon={Users} label="Capacity">
                          {e.capacity} ({e.spotsLeft} left)
                        </Fact>
                        <Fact icon={ShieldCheck} label="Eligibility">
                          {[e.eligibility?.department, e.eligibility?.batch && `batch ${e.eligibility.batch}`, e.eligibility?.notes]
                            .filter(Boolean)
                            .join(' · ') || 'Open to all'}
                        </Fact>
                        {e.participationType === 'team' && (
                          <Fact icon={Users} label="Team size">
                            {e.teamSize?.min}–{e.teamSize?.max} members
                          </Fact>
                        )}
                      </dl>
                    </Card>
                    <Card>
                      <h2 className="mb-3 text-lg font-semibold">Schedule</h2>
                      {e.activities.length === 0 ? (
                        <Empty>The schedule has not been published yet.</Empty>
                      ) : (
                        <ol className="relative ml-2 space-y-4 border-l-2 border-brand-200 pl-5">
                          {e.activities.map((a) => (
                            <li key={a._id} className="relative">
                              <span className="absolute -left-[1.78rem] top-1.5 h-3 w-3 rounded-full border-2 border-white bg-gradient-to-br from-brand-500 to-coral-500 shadow" />
                              <div className="flex flex-wrap items-center gap-2 text-sm">
                                <b className="text-base">{a.title}</b>
                                <Badge value={a.kind} />
                              </div>
                              <div className="text-sm text-slate-500">
                                {fmt(a.start)} – {fmtTime(a.end)}
                              </div>
                              {a.kind === 'competition' && (
                                <EntryPanel activityId={a._id} deadline={a.submissionDeadline} canSubmit={reg?.status === 'confirmed'} />
                              )}
                            </li>
                          ))}
                        </ol>
                      )}
                    </Card>
                    <Card>
                      <h2 className="mb-3 text-lg font-semibold">Announcements</h2>
                      <Query q={anns}>
                        {(a) =>
                          a.length === 0 ? (
                            <Empty>No announcements yet.</Empty>
                          ) : (
                            <ul className="space-y-2 text-sm">
                              <AnimatePresence initial={false}>
                                {a.map((x) => (
                                  <motion.li
                                    key={x._id}
                                    layout
                                    exit={{ opacity: 0, height: 0, marginTop: 0 }}
                                    className="group/ann flex gap-2 rounded-xl bg-white/70 p-3"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <b className="flex items-center gap-1.5">
                                        {x.pinned && <Pin size={13} className="text-coral-500" />}
                                        {x.title}
                                      </b>
                                      <p className="mt-0.5 text-slate-600">{x.body}</p>
                                      <span className="text-xs text-slate-400">{fmt(x.createdAt)}</span>
                                    </div>
                                    {has('organiser', 'coordinator') && (
                                      <TrashButton label={`Delete announcement ${x.title}`} onClick={() => delAnn({ id: x._id, name: x.title })} />
                                    )}
                                  </motion.li>
                                ))}
                              </AnimatePresence>
                            </ul>
                          )
                        }
                      </Query>
                    </Card>
                  </>
                )}
              </div>

              <div className="space-y-5 lg:sticky lg:top-20 lg:self-start">
                <Card className="!p-5">
                  <h2 className="mb-3 text-lg font-semibold">Registration</h2>
                  <SeatMeter capacity={e.capacity} left={e.spotsLeft} />
                  <p className="mb-4 mt-2 text-xs font-medium text-slate-500">{closesIn(e.registrationDeadline)}</p>
                  {reg ? (
                    <div className="space-y-3 text-sm">
                      <div className="flex items-center gap-2">
                        Status: <Badge value={reg.status} />
                      </div>
                      {reg.status === 'waitlisted' && (
                        <p className="rounded-lg bg-amber-50 p-2 text-amber-900">
                          You are #{reg.waitlistPosition} on the waiting list. You will be notified if a seat opens.
                        </p>
                      )}
                      <button
                        className="btn-danger-ghost w-full !border-red-200"
                        disabled={cancel.isPending}
                        onClick={() =>
                          confirm({
                            title: 'Cancel your registration?',
                            message: 'Your seat is released and the next person on the waiting list is promoted.',
                            tone: 'danger',
                            confirmText: 'Cancel registration',
                            cancelText: 'Keep my seat',
                            run: () => cancel.mutateAsync(reg._id),
                          })
                        }
                      >
                        Cancel registration
                      </button>
                    </div>
                  ) : e.participationType === 'individual' ? (
                    <>
                      <button className="btn-primary w-full !py-3" disabled={!open || register.isPending} onClick={() => register.mutate(undefined)}>
                        {e.spotsLeft > 0 ? 'Register now' : 'Join waiting list'}
                      </button>
                      {!open && <p className="mt-2 text-xs text-slate-500">Registration is closed.</p>}
                    </>
                  ) : (
                    <p className="text-sm text-slate-600">This is a team event. Create or join a team below, then the team leader registers the team.</p>
                  )}
                </Card>
                {e.participationType === 'team' && (
                  <Card className="!p-5">
                    <h2 className="mb-3 text-lg font-semibold">My team</h2>
                    {myInvites.length > 0 && (
                      <div className="mb-3 space-y-2">
                        {myInvites.map((i) => (
                          <div
                            key={i._id}
                            role="alert"
                            className={`rounded-xl border p-3 text-sm ${focusInvite === i._id ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-300' : 'border-amber-300 bg-amber-50'}`}
                          >
                            <b>{i.inviterName ?? 'A participant'}</b> invited you to join the team <b>{i.team?.name}</b>.
                            {i.expiresAt && <div className="mt-0.5 text-xs text-slate-600">Expires {fmtDate(i.expiresAt)}</div>}
                            <div className="mt-2 flex gap-2">
                              <button className="btn-primary btn-sm" disabled={answer.isPending} onClick={() => answer.mutate({ iid: i._id, yes: true })}>
                                Accept
                              </button>
                              <button className="btn-ghost btn-sm" disabled={answer.isPending} onClick={() => answer.mutate({ iid: i._id, yes: false })}>
                                Decline
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {team ? (
                      <div className="space-y-3 text-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="flex items-center gap-1.5 text-base font-semibold">
                            {team.name} {isLeader && <Crown size={14} className="text-amber-500" aria-label="leader" />}
                          </span>
                          {isLeader && (
                            <TrashButton
                              label="Delete team"
                              onClick={() =>
                                delTeam({ id: team._id, name: team.name, warning: reg ? 'Its registration is cancelled and its seat is released.' : undefined })
                              }
                            />
                          )}
                        </div>
                        <ul>
                          {team.members.map((m) => (
                            <li key={m.id} className="flex flex-wrap items-center justify-between py-1 gap-2">
                              {m.name}
                              {((isLeader && m.id !== user?.id) || (m.id === user?.id && !isLeader)) && !reg && (
                                <button
                                  className="inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:underline"
                                  onClick={() => kick.mutate({ t: team._id, u: m.id })}
                                >
                                  <UserMinus size={12} /> {m.id === user?.id ? 'leave' : 'remove'}
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                        {isLeader && !reg && (
                          <>
                            <Field label="Invite by email">
                              <input className="input" type="email" value={email} onChange={(x) => setEmail(x.target.value)} />
                            </Field>
                            <div className="flex gap-2">
                              <button className="btn-ghost flex-1" disabled={!email || invite.isPending} onClick={() => invite.mutate(team._id)}>
                                Send invite
                              </button>
                              <button className="btn-primary flex-1" disabled={!open || register.isPending} onClick={() => register.mutate(team._id)}>
                                Register team
                              </button>
                            </div>
                            {lastInvite && (
                              <div className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600" role="status">
                                {lastInvite.emailSent ? 'E-mail sent. ' : 'No e-mail was sent (e-mail delivery is off or failed). '}
                                {lastInvite.accountExists
                                  ? 'They also have an in-app notification. '
                                  : 'They have no account yet: the invitation attaches when they register or log in with this e-mail. '}
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
                                  onClick={() => copyLink(lastInvite.link)}
                                >
                                  <Copy size={12} /> Copy invite link
                                </button>
                              </div>
                            )}
                            {sent.data && sent.data.length > 0 && (
                              <div>
                                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Pending invitations</div>
                                <ul className="space-y-1.5">
                                  {sent.data.map((i) => (
                                    <li key={i._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-2">
                                      <span className="min-w-0 break-all">
                                        {i.name ? `${i.name} · ` : ''}
                                        {i.email}
                                        <span className="block text-xs text-slate-500">
                                          {i.expired ? 'Expired' : `Expires ${fmtDate(i.expiresAt)}`}
                                          {!i.accountExists && ' · no account yet'}
                                        </span>
                                      </span>
                                      <span className="flex flex-wrap gap-1.5">
                                        <button type="button" className="btn-ghost btn-sm" onClick={() => copyLink(i.link)}>
                                          <Copy size={12} /> Copy link
                                        </button>
                                        <button
                                          type="button"
                                          className="btn-ghost btn-sm"
                                          disabled={resend.isPending}
                                          onClick={() => resend.mutate({ t: team._id, i: i._id })}
                                        >
                                          Resend
                                        </button>
                                        <button
                                          type="button"
                                          className="btn-danger-ghost btn-sm"
                                          disabled={cancelInv.isPending}
                                          onClick={() => cancelInv.mutate({ t: team._id, i: i._id })}
                                        >
                                          Cancel
                                        </button>
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <Field label="Create a team">
                          <input className="input" placeholder="Team name" value={teamName} onChange={(x) => setTeamName(x.target.value)} />
                        </Field>
                        <button className="btn-primary w-full" disabled={teamName.length < 2 || !open || mkTeam.isPending} onClick={() => mkTeam.mutate()}>
                          Create team
                        </button>
                      </div>
                    )}
                  </Card>
                )}
              </div>
            </div>
          </>
        );
      }}
    </Query>
  );
}
