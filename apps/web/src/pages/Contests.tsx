import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Award, CalendarClock, Check, Clock3, Copy, Crown, Download, Flag, Link2, Mail, MapPin, Snowflake, Trophy, UserPlus, Users } from 'lucide-react';
import { CONTEST_MODES, type ContestMode } from '@festhub/shared';
import { useAuth } from '../lib/auth';
import { api, assetUrl, errMsg } from '../lib/api';
import { downloadCert, type CertLike } from '../lib/certView';
import { fmt, toLocalInput, useAct, useDelete, useGet } from '../lib/hooks';
import { downloadCsv } from '../lib/exporters';
import { venueLabel, type VenueLike } from '../lib/venue';
import { VenueManager } from '../components/VenueManager';
import { useLive } from '../lib/socket';
import { Badge, Card, Empty, PageHeader, Query, Tabs, TrashButton, useConfirm, useToast } from '../components/ui';
import EventCover from '../components/EventCover';
import CoverPicker from '../components/CoverPicker';
import { ProblemView, SubmissionTable, SubmitBox, type ProblemView as PV } from './Practice';

interface C {
  id: string;
  title: string;
  description?: string;
  bannerImage?: string | null;
  mode: ContestMode;
  teamSize?: { min: number; max: number } | null;
  startAt: string;
  endAt: string;
  freezeAt?: string;
  /** Last moment to register / create or join a team. null = open until the contest ends. */
  registrationDeadline?: string | null;
  registrationOpen?: boolean;
  venue?: { id: string; name: string; building?: string | null; capacity?: number | null } | null;
  status: string;
  problemCount: number;
  registered: boolean;
  participants?: number;
}

const modeLabel = (c: Pick<C, 'mode' | 'teamSize'>) => (c.mode === 'TEAM' ? `Team · ${c.teamSize ? (c.teamSize.min === c.teamSize.max ? c.teamSize.max : `${c.teamSize.min}–${c.teamSize.max}`) : '1–3'} members` : 'Individual');
const STATUS_DOT: Record<string, string> = { running: 'bg-emerald-400', upcoming: 'bg-amber-300', ended: 'bg-slate-300' };

/** Frosted chip that stays readable on any banner photo. */
function GlassChip({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full border border-white/30 bg-white/15 px-2.5 py-1 text-xs font-semibold text-white shadow-[0_2px_12px_rgba(0,0,0,0.18)] backdrop-blur-md ${className}`}>{children}</span>;
}

/**
 * Premium glassmorphic contest banner: the organiser's image (or a generated gradient) behind frosted-glass chips and a frosted
 * title panel. Used by the contest list ("card"), the contest page ("hero") and the organiser's banner editor preview.
 */
export function ContestBanner({ c, variant = 'card', children }: { c: C; variant?: 'card' | 'hero'; children?: ReactNode }) {
  const hero = variant === 'hero';
  return (
    <EventCover title={c.title} type="contest" imageUrl={c.bannerImage} className={`${hero ? 'h-56 rounded-3xl sm:h-64' : 'h-44 rounded-t-2xl'} shadow-lift`} priority={hero}>
      <div className="flex h-full flex-col justify-between p-3 sm:p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <GlassChip>
            <span className={`h-2 w-2 rounded-full ${STATUS_DOT[c.status] ?? 'bg-slate-300'} ${c.status === 'running' ? 'animate-pulse' : ''}`} />
            <span className="capitalize">{c.status}</span>
          </GlassChip>
          <GlassChip>
            {c.mode === 'TEAM' ? <Users size={12} /> : <Trophy size={12} />} {modeLabel(c)}
          </GlassChip>
          {c.registered && (
            <GlassChip className="border-emerald-200/50 bg-emerald-400/25">
              <Check size={12} /> Registered
            </GlassChip>
          )}
          {children && <div className="ml-auto flex items-center gap-1.5">{children}</div>}
        </div>
        <div className="rounded-2xl border border-white/25 bg-white/10 p-3 shadow-[0_8px_32px_rgba(0,0,0,0.25)] backdrop-blur-xl">
          <h2 className={`font-display font-bold leading-tight text-white drop-shadow ${hero ? 'text-2xl sm:text-3xl' : 'line-clamp-1 text-lg'}`}>{c.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-white/85">
            <span className="inline-flex items-center gap-1">
              <Clock3 size={12} /> {fmt(c.startAt)} → {fmt(c.endAt)}
            </span>
            <span className="inline-flex items-center gap-1">
              <Flag size={12} /> {c.problemCount} problems
            </span>
            {c.venue && (
              <span className="inline-flex items-center gap-1">
                <MapPin size={12} /> {venueLabel(c.venue)}
              </span>
            )}
            {c.registrationDeadline && (
              <span className="inline-flex items-center gap-1">
                <CalendarClock size={12} /> {c.registrationOpen ? 'Register by' : 'Registration closed'} {fmt(c.registrationDeadline)}
              </span>
            )}
            {c.freezeAt && (
              <span className="inline-flex items-center gap-1">
                <Snowflake size={12} /> freeze {fmt(c.freezeAt)}
              </span>
            )}
          </p>
          {hero && c.description && <p className="mt-2 line-clamp-2 text-sm text-white/90">{c.description}</p>}
        </div>
      </div>
    </EventCover>
  );
}

export function ContestsList() {
  const { has } = useAuth();
  const q = useGet<C[]>('/contests');
  const [open, setOpen] = useState(false);
  const del = useDelete({ noun: 'contest', request: (id) => api.del(`/contests/${id}`), prune: ['/contests'], invalidate: ['/contests', '/problems'] });
  return (
    <>
      <PageHeader
        title="Programming contests"
        sub="ICPC-style scoring · individual or team · isolated judging · scoreboard freeze"
        actions={
          has('organiser') ? (
            <button className="btn-primary" onClick={() => setOpen(!open)}>
              {open ? 'Close' : 'New contest'}
            </button>
          ) : undefined
        }
      />
      {open && <NewContest onDone={() => setOpen(false)} />}
      <Query q={q}>
        {(l) =>
          l.length === 0 ? (
            <Empty>No contests yet.</Empty>
          ) : (
            <motion.div className="grid gap-4 md:grid-cols-2" initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.05 } } }}>
              {l.map((c) => (
                <motion.div key={c.id} layout variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0 } }} className="card-interactive group relative overflow-hidden !p-0">
                  <Link to={`/contests/${c.id}`} className="absolute inset-0 z-10 rounded-2xl" aria-label={`Open ${c.title}`} />
                  <ContestBanner c={c}>
                    {has('organiser') && <TrashButton className="relative z-20 !bg-white/20 !text-white hover:!bg-red-500/80" label={`Delete contest ${c.title}`} onClick={() => del({ id: c.id, name: c.title, warning: 'Registrations, teams and every submission for this contest are deleted too. The problems themselves are kept.' })} />}
                  </ContestBanner>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm text-slate-600">
                    <span className="line-clamp-1">{c.description || 'ICPC-style scoring with a live scoreboard.'}</span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-slate-500">
                      <Users size={13} /> {c.participants ?? 0} {c.mode === 'TEAM' ? 'teams' : 'joined'}
                    </span>
                  </div>
                </motion.div>
              ))}
            </motion.div>
          )
        }
      </Query>
    </>
  );
}

function NewContest({ onDone }: { onDone: () => void }) {
  const probs = useGet<{ id: string; title: string; testCaseCount?: number }[]>('/problems?manage=1');
  const venues = useGet<VenueLike[]>('/venues');
  const [f, setF] = useState({ title: '', description: '', bannerImage: '', mode: 'INDIVIDUAL' as ContestMode, teamMin: 1, teamMax: 3, startAt: '', endAt: '', freezeAt: '', revealAt: '', registrationDeadline: '', venueId: '', penaltyMinutes: 20, cooldownSec: 10 });
  const [sel, setSel] = useState<string[]>([]);
  const iso = (s: string) => (s ? new Date(s).toISOString() : undefined);
  const create = useAct(
    () =>
      api.post('/contests', {
        title: f.title,
        description: f.description || undefined,
        bannerImage: f.bannerImage || undefined,
        mode: f.mode,
        teamSize: f.mode === 'TEAM' ? { min: f.teamMin, max: f.teamMax } : undefined,
        penaltyMinutes: f.penaltyMinutes,
        cooldownSec: f.cooldownSec,
        startAt: iso(f.startAt),
        endAt: iso(f.endAt),
        freezeAt: iso(f.freezeAt),
        revealAt: iso(f.revealAt),
        registrationDeadline: iso(f.registrationDeadline),
        venueId: f.venueId || undefined,
        problems: sel.map((id, i) => ({ problemId: id, label: String.fromCharCode(65 + i) })),
      }),
    { ok: 'Contest created', invalidate: ['/contests'], onDone },
  );
  const teamSizeBad = f.mode === 'TEAM' && (f.teamMin < 1 || f.teamMax < f.teamMin);
  const deadlineBad = !!f.registrationDeadline && !!f.startAt && new Date(f.registrationDeadline) > new Date(f.startAt);
  const FIELD_LABEL = { startAt: 'Start', endAt: 'End', registrationDeadline: 'Registration deadline', freezeAt: 'Freeze scoreboard at', revealAt: 'Reveal at (optional)' } as const;
  return (
    <Card className="mb-4 space-y-4">
      <div className="grid gap-2 md:grid-cols-3">
        <input className="input md:col-span-3" placeholder="Contest title" aria-label="Contest title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <textarea className="input md:col-span-3" rows={2} placeholder="Short description shown on the banner (optional)" aria-label="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Banner image</h3>
        <CoverPicker noun="contest" type="contest" title={f.title} value={f.bannerImage} onChange={(v) => setF({ ...f, bannerImage: v })} />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Participation</h3>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Participation type">
          {CONTEST_MODES.map((m) => (
            <label key={m} className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm transition ${f.mode === m ? 'border-brand-500 bg-brand-50/70 ring-2 ring-brand-500/20' : 'border-slate-200 bg-white/60 hover:border-slate-300'}`}>
              <input type="radio" name="mode" className="mt-1" checked={f.mode === m} onChange={() => setF({ ...f, mode: m })} />
              <span>
                <b>{m === 'INDIVIDUAL' ? 'Individual' : 'Team (ICPC style)'}</b>
                <span className="block text-xs text-slate-500">{m === 'INDIVIDUAL' ? 'Every contestant has their own score.' : 'Contestants form teams; the whole team shares one score and one scoreboard row.'}</span>
              </span>
            </label>
          ))}
        </div>
        {f.mode === 'TEAM' && (
          <div className="mt-2 grid max-w-sm grid-cols-2 gap-2">
            <label className="text-sm">
              Min team size
              <input className="input" type="number" min={1} max={10} value={f.teamMin} onChange={(e) => setF({ ...f, teamMin: Number(e.target.value) })} />
            </label>
            <label className="text-sm">
              Max team size
              <input className="input" type="number" min={1} max={10} value={f.teamMax} onChange={(e) => setF({ ...f, teamMax: Number(e.target.value) })} />
            </label>
            {teamSizeBad && <p className="col-span-2 text-xs text-red-600">The maximum must be at least the minimum.</p>}
          </div>
        )}
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {(['startAt', 'endAt', 'registrationDeadline', 'freezeAt', 'revealAt'] as const).map((k) => (
          <label key={k} className="text-sm">
            {FIELD_LABEL[k]}
            <input className="input" type="datetime-local" required={k === 'registrationDeadline'} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
          </label>
        ))}
        <div className="text-sm md:col-span-2">
          <label>
            Venue (optional)
            <select className="input" aria-label="Venue" value={f.venueId} onChange={(e) => setF({ ...f, venueId: e.target.value })}>
              <option value="">No venue (online)</option>
              {venues.data?.map((v) => (
                <option key={v._id} value={v._id}>
                  {venueLabel(v)}
                </option>
              ))}
            </select>
          </label>
          <VenueManager onAdded={(vid) => setTimeout(() => setF((x) => ({ ...x, venueId: vid })), 300)} />
        </div>
        {deadlineBad && <p className="text-xs text-red-600 md:col-span-3">The registration deadline must be before the contest starts.</p>}
        <label className="text-sm">
          Penalty (min per wrong attempt)
          <input className="input" type="number" value={f.penaltyMinutes} onChange={(e) => setF({ ...f, penaltyMinutes: Number(e.target.value) })} />
        </label>
        <label className="text-sm">
          Cooldown (sec)
          <input className="input" type="number" value={f.cooldownSec} onChange={(e) => setF({ ...f, cooldownSec: Number(e.target.value) })} />
        </label>
      </div>
      <div>
        <h3 className="text-sm font-semibold">Problems (in order; each needs test cases)</h3>
        <div className="mt-1 flex flex-wrap gap-3 text-sm">
          {probs.data?.map((p) => (
            <label key={p.id} className="flex items-center gap-1">
              <input type="checkbox" checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} />
              {p.title} <span className="text-xs text-slate-400">({p.testCaseCount} tests)</span>
            </label>
          ))}
        </div>
      </div>
      <button className="btn-primary" disabled={!f.title || !f.startAt || !f.endAt || !f.registrationDeadline || sel.length === 0 || teamSizeBad || deadlineBad || create.isPending} onClick={() => create.mutate()}>
        Create contest
      </button>
    </Card>
  );
}

interface MyTeam {
  id: string;
  name: string;
  isLeader: boolean;
  joinCode?: string;
  members: { id: string; name: string; isLeader: boolean }[];
  minSize: number;
  maxSize: number;
  complete: boolean;
  /** The leader registered the team. Until then it is only a draft. */
  registered: boolean;
  registeredAt?: string | null;
}
interface Detail extends C {
  penaltyMinutes: number;
  cooldownSec: number;
  revealed: boolean;
  serverTime: string;
  revealAt?: string;
  myTeam?: MyTeam | null;
}
interface Board {
  mode?: ContestMode;
  frozen: boolean;
  freezeAt?: string;
  problems: { label: string }[];
  stats?: { label: string; solvedBy: number; attempts: number; firstSolvedAtMin: number | null }[];
  rows: {
    rank: number;
    userId: string;
    teamId?: string;
    members?: string[];
    name: string;
    solved: number;
    penalty: number;
    cells: { label: string; solved: boolean; wrong: number; solvedAtMin?: number; pending: number; firstSolve?: boolean }[];
  }[];
}
type Tab = 'problems' | 'subs' | 'board' | 'team' | 'admin' | 'regs';

/** Organiser/admin: link to the contest's certificate manager. Participants/team members: download their own certificate (from /certificates/mine). */
function ContestCertActions({ contestId }: { contestId: string }) {
  const { has } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const manager = has('organiser');
  const mine = useGet<(CertLike & { contestId?: string | null })[]>(manager ? null : '/certificates/mine');
  const own = (mine.data ?? []).filter((c) => c.contestId === contestId && c.status !== 'revoked');
  if (manager) {
    return (
      <Link to={`/certificates?contest=${contestId}`} className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">
        <Award size={14} /> Certificates
      </Link>
    );
  }
  if (own.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {own.map((c) => (
        <button
          key={c.id}
          className="btn-primary btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await downloadCert(c);
              toast('Certificate downloaded');
            } catch (e) {
              toast(errMsg(e), 'error');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Award size={14} /> Your certificate{own.length > 1 ? ` (${c.typeLabel})` : ''}
        </button>
      ))}
    </div>
  );
}

export function ContestPage() {
  const { id } = useParams();
  const { has, user } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('board');
  const [sp] = useSearchParams();
  const delContest = useDelete({ noun: 'contest', request: (i) => api.del(`/contests/${i}`), invalidate: ['/contests'], onDeleted: () => nav('/contests', { replace: true }) });
  const c = useGet<Detail>(`/contests/${id}`, { refetchInterval: 30000 });
  const register = useAct(() => api.post(`/contests/${id}/register`), { ok: 'Registered for the contest', invalidate: [`/contests/${id}`, '/contests'] });
  const staff = has('organiser', 'judge');
  // Invite / join links (?join=CODE, ?invite=ID) open the team tab of a team contest.
  const fromLink = !!(sp.get('join') || sp.get('invite'));
  useEffect(() => {
    if (fromLink && c.data?.mode === 'TEAM' && !staff) setTab('team');
  }, [fromLink, c.data?.mode, staff]);
  useLive([`contest:${id}`], { 'scoreboard:update': () => undefined });
  return (
    <Query q={c}>
      {(x) => {
        const team = x.mode === 'TEAM';
        const tabs = [
          { id: 'board', label: team ? 'Team scoreboard' : 'Scoreboard' },
          ...(team && !staff ? [{ id: 'team', label: x.myTeam ? 'My team' : 'Teams' }] : []),
          { id: 'problems', label: 'Problems' },
          { id: 'subs', label: 'My submissions' },
          ...(has('organiser', 'coordinator') ? [{ id: 'regs', label: 'Registrations' }] : []),
          ...(staff ? [{ id: 'admin', label: 'Admin' }] : []),
        ] as { id: Tab; label: string }[];
        return (
          <>
            <div className="mb-4">
              <ContestBanner c={x} variant="hero">
                {has('organiser') && (
                  <button
                    className="inline-flex items-center rounded-full border border-white/30 bg-red-500/30 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-md transition hover:bg-red-500/70"
                    onClick={() => delContest({ id: x.id, name: x.title, warning: 'Registrations, teams and every submission for this contest are deleted too. The problems themselves are kept.' })}
                  >
                    Delete contest
                  </button>
                )}
              </ContestBanner>
              <div className="mt-2 empty:hidden">
                <ContestCertActions contestId={x.id} />
              </div>
              <p className="mt-2 text-sm text-slate-500">Penalty {x.penaltyMinutes} min per wrong attempt before the first accepted solution · ranked by problems solved, then total penalty.</p>
            </div>
            {!x.registered && x.status !== 'ended' && !staff && !team && (
              <Card className="mb-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">
                    {x.registrationOpen ? 'Register to see the problems and submit.' : 'Registration for this contest is closed.'}
                    {x.registrationOpen && x.registrationDeadline && <span className="block text-xs text-slate-500">Register before {fmt(x.registrationDeadline)}.</span>}
                  </span>
                  {x.registrationOpen && (
                    <button className="btn-primary" disabled={register.isPending} onClick={() => register.mutate()}>
                      Register
                    </button>
                  )}
                </div>
              </Card>
            )}
            {team && !x.myTeam && x.status !== 'ended' && !staff && (
              <Card className="mb-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">
                    {x.registrationOpen ? 'This is a team contest. Create a team (or join one with a code), then the team leader registers the team to see the problems and submit.' : 'Registration for this contest is closed.'}
                    {x.registrationOpen && x.registrationDeadline && <span className="block text-xs text-slate-500">Register before {fmt(x.registrationDeadline)}.</span>}
                  </span>
                  {x.registrationOpen && (
                    <button className="btn-primary" onClick={() => setTab('team')}>
                      <UserPlus size={14} /> Create or join a team
                    </button>
                  )}
                </div>
              </Card>
            )}
            {team && x.myTeam && !x.myTeam.registered && x.status !== 'ended' && !staff && (
              <Card className="mb-4 border-amber-300 bg-amber-50/70">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">
                    <b>{x.myTeam.name}</b> is not registered yet.{' '}
                    {x.myTeam.isLeader ? (x.myTeam.complete ? 'Your team has enough members: register it to take part.' : `Add ${x.myTeam.minSize - x.myTeam.members.length} more member(s), then register the team.`) : 'Your team leader has to register the team.'}
                  </span>
                  <button className="btn-primary" onClick={() => setTab('team')}>
                    Open my team
                  </button>
                </div>
              </Card>
            )}
            <Tabs tabs={tabs} value={tab} onChange={setTab} />
            {tab === 'board' && <Scoreboard id={id!} me={team ? x.myTeam?.id : user?.id} full={false} />}
            {tab === 'team' && <TeamPanel contest={x} />}
            {tab === 'problems' && <Problems id={id!} status={x.status} registered={x.registered} team={team} />}
            {tab === 'regs' && <Registrations id={id!} title={x.title} />}
            {tab === 'subs' && <SubmissionTable url={`/contests/${id}/submissions/me`} />}
            {tab === 'admin' && <Admin id={id!} c={x} />}
          </>
        );
      }}
    </Query>
  );
}

interface MyInvite {
  _id: string;
  teamName: string;
  inviterName: string;
  expiresAt?: string;
}
interface SentInvite {
  _id: string;
  email: string;
  name?: string;
  accountExists: boolean;
  expired: boolean;
  expiresAt?: string;
}
interface InviteResult {
  link: string;
  emailSent: boolean;
  accountExists: boolean;
}
interface TeamRow {
  id: string;
  name: string;
  memberCount: number;
  complete: boolean;
  members: string[];
}
/** TEAM contests: create a team, join one with its code, see who is on your team. Membership locks when the contest starts. */
function TeamPanel({ contest }: { contest: Detail }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [sp] = useSearchParams();
  const linkCode = (sp.get('join') ?? '').trim().toUpperCase().slice(0, 20);
  const [code, setCode] = useState(linkCode);
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState('');
  const [lastInvite, setLastInvite] = useState<InviteResult | null>(null);
  const teams = useGet<TeamRow[]>(`/contests/${contest.id}/teams`, { refetchInterval: 15000 });
  const keys = [`/contests/${contest.id}`, `/contests/${contest.id}/teams`, '/contests'];
  const create = useAct(() => api.post(`/contests/${contest.id}/teams`, { name }), { ok: 'Team created. Add your teammates, then register the team', invalidate: keys, onDone: () => setName('') });
  const join = useAct(() => api.post(`/contests/${contest.id}/teams/join`, { joinCode: code }), { ok: 'You joined the team', invalidate: keys, onDone: () => setCode('') });
  const registerTeam = useAct(() => api.post(`/contests/${contest.id}/teams/${contest.myTeam!.id}/register`), { ok: 'Your team is registered for the contest', invalidate: [...keys, `/contests/${contest.id}/problems`, `/contests/${contest.id}/scoreboard`] });
  const unregisterTeam = useAct(() => api.del(`/contests/${contest.id}/teams/${contest.myTeam!.id}/register`), { ok: 'Team registration cancelled', invalidate: [...keys, `/contests/${contest.id}/scoreboard`] });
  const leave = useDelete({ noun: 'team member', request: (uid) => api.del(`/contests/${contest.id}/teams/${contest.myTeam!.id}/members/${uid}`), invalidate: keys });
  const disband = useDelete({ noun: 'team', request: () => api.del(`/contests/${contest.id}/teams/${contest.myTeam!.id}`), invalidate: keys });
  const { user } = useAuth();
  const locked = contest.status !== 'upcoming';
  const t = contest.myTeam;
  const canInvite = !!t?.isLeader && contest.status !== 'ended';
  const mine = useGet<MyInvite[]>(!t && contest.status !== 'ended' ? `/contests/${contest.id}/invitations/mine` : null);
  const sentPath = `/contests/${contest.id}/teams/${t?.id}/invitations`;
  const sent = useGet<SentInvite[]>(canInvite ? sentPath : null);
  const invite = useAct(() => api.post<InviteResult>(sentPath, { email }), {
    ok: 'Invitation created',
    invalidate: [...keys, sentPath],
    onDone: (r) => {
      setEmail('');
      setLastInvite(r as InviteResult);
    },
  });
  const resend = useAct((iid: string) => api.post(`${sentPath}/${iid}/resend`), { ok: 'Invitation renewed for 14 days', invalidate: [sentPath] });
  const cancelInv = useAct((iid: string) => api.del(`${sentPath}/${iid}`), { ok: 'Invitation cancelled', invalidate: [...keys, sentPath] });
  const answer = useAct(({ iid, yes }: { iid: string; yes: boolean }) => api.post(`/contests/${contest.id}/invitations/${iid}/${yes ? 'accept' : 'decline'}`), {
    ok: 'Done',
    invalidate: [...keys, `/contests/${contest.id}/invitations/mine`, '/notifications'],
  });
  const copyText = (text: string, okMsg: string) =>
    navigator.clipboard?.writeText(text).then(
      () => toast(okMsg, 'ok'),
      () => toast('Could not copy. Select the text and copy it manually.', 'error'),
    );
  const inviteLink = t?.joinCode ? `${window.location.origin}/contests/${contest.id}?join=${t.joinCode}` : '';
  const { min, max } = contest.teamSize ?? { min: 1, max: 3 };

  if (t) {
    return (
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <Users size={18} className="text-brand-600" /> {t.name}
          </h2>
          <Badge value={t.registered ? 'registered' : t.complete ? 'not registered yet' : `needs ${t.minSize - t.members.length} more`} />
        </div>
        <ul className="divide-y divide-slate-200/70 text-sm">
          {t.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex items-center gap-1.5">
                {m.isLeader && <Crown size={14} className="text-amber-500" aria-label="Team leader" />} {m.name}
                {m.id === user?.id && <span className="text-xs text-slate-400">(you)</span>}
              </span>
              {!locked && !m.isLeader && (t.isLeader || m.id === user?.id) && (
                <button className="btn-danger-ghost btn-sm" onClick={() => leave({ id: m.id, title: m.id === user?.id ? 'Leave this team?' : `Remove ${m.name}?`, confirmText: m.id === user?.id ? 'Leave team' : 'Remove', message: m.id === user?.id ? 'You can join or create another team until the contest starts.' : `${m.name} will be removed from the team.` })}>
                  {m.id === user?.id ? 'Leave' : 'Remove'}
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-500">
          Team size {min === max ? max : `${min}–${max}`}. {t.members.length}/{t.maxSize} places taken.
        </p>
        {contest.status !== 'ended' &&
          (t.registered ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 text-sm text-emerald-900">
              <span className="inline-flex items-center gap-1.5">
                <Check size={15} /> Team registered{t.registeredAt ? ` on ${fmt(t.registeredAt)}` : ''}.
              </span>
              {t.isLeader && !locked && (
                <button className="btn-ghost btn-sm" disabled={unregisterTeam.isPending} onClick={() => unregisterTeam.mutate()}>
                  Cancel registration
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
              <p>
                {t.isLeader
                  ? t.complete
                    ? 'Your team has enough members. Register it to take part in the contest.'
                    : `Your team needs ${t.minSize - t.members.length} more member${t.minSize - t.members.length === 1 ? '' : 's'} before you can register it.`
                  : 'The team leader has to register the team before it can take part.'}
              </p>
              {contest.registrationDeadline && contest.registrationOpen && <p className="mt-1 text-xs text-slate-600">Register before {fmt(contest.registrationDeadline)}.</p>}
              {!contest.registrationOpen && <p className="mt-1 text-xs text-red-700">Registration for this contest is closed.</p>}
              {t.isLeader && (
                <button className="btn-primary mt-2" disabled={!t.complete || !contest.registrationOpen || registerTeam.isPending} onClick={() => registerTeam.mutate()}>
                  Register team
                </button>
              )}
            </div>
          ))}
        {t.isLeader && t.joinCode && (
          <div className="rounded-xl border border-brand-200 bg-brand-50/60 p-3">
            <p className="text-xs text-slate-600">Share this join code with your teammates{locked ? '' : ' (until the contest ends)'}:</p>
            <div className="mt-1 flex items-center gap-2">
              <code className="select-all rounded-lg bg-white px-3 py-1.5 font-mono text-lg font-semibold tracking-widest" aria-label="Team join code">
                {t.joinCode}
              </code>
              <button
                className="btn-ghost"
                onClick={() => {
                  void navigator.clipboard?.writeText(t.joinCode!).then(
                    () => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    },
                    () => toast('Could not copy. Select the code and copy it manually.', 'error'),
                  );
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}
        {canInvite && (
          <div className="space-y-2 rounded-xl border border-slate-200 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <Mail size={15} className="text-brand-600" /> Invite teammates
              </h3>
              {inviteLink && (
                <button type="button" className="btn-ghost btn-sm" onClick={() => void copyText(inviteLink, 'Invite link copied')}>
                  <Link2 size={13} /> Copy invite link
                </button>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <input className="input min-w-[12rem] flex-1" type="email" placeholder="teammate@example.com" aria-label="Invite by e-mail" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn-primary" disabled={!email.includes('@') || invite.isPending || t.members.length >= t.maxSize} onClick={() => invite.mutate()}>
                Send invite
              </button>
            </div>
            {invite.error && <p className="text-xs text-red-600">{errMsg(invite.error)}</p>}
            {lastInvite && (
              <p className="text-xs text-slate-600" role="status">
                {lastInvite.emailSent ? 'E-mail sent. ' : 'No e-mail was sent (e-mail delivery is off or failed). '}
                {lastInvite.accountExists ? 'They also have an in-app notification. ' : 'They have no account yet: the invitation attaches when they register or log in with this e-mail. '}
                <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => void copyText(lastInvite.link, 'Invitation link copied')}>
                  Copy their invitation link
                </button>
              </p>
            )}
            {sent.data && sent.data.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Pending invitations</div>
                <ul className="space-y-1.5 text-sm">
                  {sent.data.map((i) => (
                    <li key={i._id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-2">
                      <span className="min-w-0 break-all">
                        {i.name ? `${i.name} · ` : ''}
                        {i.email}
                        <span className="block text-xs text-slate-500">
                          {i.expired ? 'Expired' : `Expires ${fmt(i.expiresAt)}`}
                          {!i.accountExists && ' · no account yet'}
                        </span>
                      </span>
                      <span className="flex gap-1.5">
                        <button type="button" className="btn-ghost btn-sm" disabled={resend.isPending} onClick={() => resend.mutate(i._id)}>
                          Resend
                        </button>
                        <button type="button" className="btn-danger-ghost btn-sm" disabled={cancelInv.isPending} onClick={() => cancelInv.mutate(i._id)}>
                          Cancel
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {locked ? (
          <p className="text-xs text-slate-500">Team members are locked now that the contest has started.</p>
        ) : (
          t.isLeader && (
            <button className="btn-danger-ghost" onClick={() => disband({ id: t.id, name: t.name, warning: 'Your teammates are released and can join other teams.' })}>
              Disband team
            </button>
          )
        )}
      </Card>
    );
  }
  if (contest.status === 'ended') return <Empty>This contest has ended.</Empty>;
  if (!contest.registrationOpen) return <Empty>Registration for this contest is closed.</Empty>;
  return (
    <div className="space-y-4">
      {(mine.data ?? []).map((i) => (
        <div key={i._id} role="alert" className={`rounded-xl border p-3 text-sm ${sp.get('invite') === i._id ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-300' : 'border-amber-300 bg-amber-50'}`}>
          <b>{i.inviterName}</b> invited you to join the team <b>{i.teamName}</b>.
          {i.expiresAt && <div className="mt-0.5 text-xs text-slate-600">Expires {fmt(i.expiresAt)}</div>}
          <div className="mt-2 flex gap-2">
            <button className="btn-primary btn-sm" disabled={answer.isPending} onClick={() => answer.mutate({ iid: i._id, yes: true })}>
              Accept
            </button>
            <button className="btn-ghost btn-sm" disabled={answer.isPending} onClick={() => answer.mutate({ iid: i._id, yes: false })}>
              Decline
            </button>
          </div>
          {answer.error && <p className="mt-1 text-xs text-red-600">{errMsg(answer.error)}</p>}
        </div>
      ))}
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2">
          <h2 className="flex items-center gap-2 font-semibold">
            <UserPlus size={18} className="text-brand-600" /> Create a team
          </h2>
          <input className="input" placeholder="Team name" aria-label="Team name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn-primary" disabled={name.trim().length < 2 || create.isPending} onClick={() => create.mutate()}>
            Create team
          </button>
          <p className="text-xs text-slate-500">You become the team leader and get a join code to share. The team is only a draft until you register it{min > 1 ? ` (it needs at least ${min} members first)` : ''}.</p>
        </Card>
        <Card className="space-y-2">
          <h2 className="flex items-center gap-2 font-semibold">
            <Users size={18} className="text-brand-600" /> Join a team
          </h2>
          <input className="input font-mono uppercase" placeholder="Join code from your team leader" aria-label="Join code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="btn-primary" disabled={code.trim().length < 4 || join.isPending} onClick={() => join.mutate()}>
            Join team
          </button>
          {linkCode && code === linkCode && <p className="text-xs text-slate-600">The code was filled in from your invite link. Press Join team.</p>}
          {join.error && <p className="text-xs text-red-600">{errMsg(join.error)}</p>}
        </Card>
      </div>
      <Query q={teams}>
        {(l) =>
          l.length === 0 ? null : (
            <Card>
              <h3 className="mb-2 text-sm font-semibold">Registered teams ({l.length})</h3>
              <ul className="grid gap-1 text-sm sm:grid-cols-2">
                {l.map((x) => (
                  <li key={x.id} className="row-hover px-2 py-1.5">
                    <b>{x.name}</b> <span className="text-xs text-slate-500">· {x.members.join(', ')}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )
        }
      </Query>
    </div>
  );
}

function Scoreboard({ id, me, full }: { id: string; me?: string; full: boolean }) {
  const q = useGet<Board>(`/contests/${id}/scoreboard${full ? '/full' : ''}`, { refetchInterval: 10000 });
  useLive([`contest:${id}`], { 'scoreboard:update': () => void q.refetch() });
  return (
    <Query q={q}>
      {(b) => {
        const team = b.mode === 'TEAM';
        return (
          <>
            {b.frozen && !full && (
              <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900" role="status">
                ❄️ The scoreboard is frozen since {fmt(b.freezeAt)}. Results after the freeze are hidden until the contest is revealed. “?” shows submissions
                awaiting reveal.
              </div>
            )}
            {full && <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Staff view: unfrozen standings. Do not share.</div>}
            {b.rows.length === 0 ? (
              <Empty>{team ? 'No teams yet.' : 'No participants yet.'}</Empty>
            ) : (
              <div className="card overflow-x-auto p-0">
                <table className="min-w-full divide-y">
                  <thead>
                    <tr>
                      <th className="th">#</th>
                      <th className="th">{team ? 'Team' : 'Name'}</th>
                      <th className="th">Solved</th>
                      <th className="th">Penalty</th>
                      {b.problems.map((p) => (
                        <th key={p.label} className="th text-center">
                          {p.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {b.rows.map((r) => (
                      <tr key={r.userId} className={r.userId === me ? 'bg-brand-50' : ''}>
                        <td className="td font-semibold">{r.rank}</td>
                        <td className="td">
                          {r.name}
                          {team && r.members && r.members.length > 0 && <div className="text-xs text-slate-500">{r.members.join(', ')}</div>}
                        </td>
                        <td className="td">{r.solved}</td>
                        <td className="td">{r.penalty}</td>
                        {r.cells.map((c, i) => (
                          <td key={i} className={`td text-center text-xs ${c.solved ? (c.firstSolve ? 'bg-emerald-200 font-semibold text-emerald-950' : 'bg-green-100 text-green-900') : c.wrong ? 'text-red-700' : ''}`}>
                            {c.solved ? (
                              <>
                                +{c.wrong || ''}
                                <div>{c.solvedAtMin}m</div>
                              </>
                            ) : c.wrong ? (
                              `-${c.wrong}`
                            ) : (
                              ''
                            )}
                            {c.pending > 0 && <span title="Pending reveal"> ?{c.pending}</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  {b.stats && (
                    <tfoot>
                      <tr className="border-t bg-white/50 text-xs text-slate-500">
                        <td className="td" colSpan={4}>
                          Solved / attempts · darker green = first to solve
                        </td>
                        {b.stats.map((x) => (
                          <td key={x.label} className="td text-center">
                            {x.solvedBy}/{x.attempts}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            )}
          </>
        );
      }}
    </Query>
  );
}

function Problems({ id, status, registered, team = false }: { id: string; status: string; registered: boolean; team?: boolean }) {
  const q = useGet<(PV & { label: string })[]>(status === 'upcoming' && !registered ? null : `/contests/${id}/problems`);
  const [sel, setSel] = useState('');
  if (status === 'upcoming') return <Empty>Problems are revealed when the contest starts.</Empty>;
  return (
    <Query q={q}>
      {(ps) => {
        const p = ps.find((x) => x.id === sel) ?? ps[0];
        return ps.length === 0 ? (
          <Empty>No problems.</Empty>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-2">
              {ps.map((x) => (
                <button key={x.id} className={x.id === p.id ? 'btn-primary' : 'btn-ghost'} title={x.title} aria-label={`Problem ${x.label}: ${x.title}`} onClick={() => setSel(x.id)}>
                  {x.label}
                </button>
              ))}
            </div>
            <ProblemView p={p} />
            {status === 'running' && registered ? (
              <SubmitBox p={p} url={`/contests/${id}/submissions`} invalidate={[`/contests/${id}/submissions/me`]} extra={{ problemId: p.id }} key={p.id} />
            ) : (
              <Empty>{status === 'ended' ? 'The contest has ended. Use practice mode to keep solving.' : team ? 'Your team must be registered to submit.' : 'Register to submit.'}</Empty>
            )}
          </div>
        );
      }}
    </Query>
  );
}
interface AllSub {
  id: string;
  status: string;
  userId: string;
  problemId: string;
  problemLabel?: string | null;
  problemTitle?: string | null;
  userName?: string | null;
  failedTest?: number;
  language: string;
  submittedAt: string;
}
function Admin({ id, c }: { id: string; c: Detail }) {
  const { has } = useAuth();
  const confirm = useConfirm();
  const subs = useGet<AllSub[]>(`/contests/${id}/submissions`, { refetchInterval: 8000 });
  const delSub = useDelete({ noun: 'submission', request: (sid) => api.del(`/submissions/${sid}`), prune: [`/contests/${id}/submissions`], invalidate: [`/contests/${id}`] });
  const reveal = useAct(() => api.post(`/contests/${id}/reveal`), { ok: 'Scoreboard revealed', invalidate: [`/contests/${id}`, `/contests/${id}/scoreboard`] });
  const rejudge = useAct((sid: string) => api.post(`/submissions/${sid}/rejudge`), { ok: 'Queued for rejudging', invalidate: [`/contests/${id}/submissions`] });
  return (
    <div className="space-y-4">
      {has('organiser') && (
        <Card>
          <button
            className="btn-primary"
            disabled={c.status !== 'ended' || c.revealed}
            onClick={() => confirm({ title: 'Reveal the final scoreboard?', message: 'Everyone sees the unfrozen standings immediately.', confirmText: 'Reveal scoreboard', cancelText: 'Not yet', run: () => reveal.mutateAsync() })}
          >
            {c.revealed ? 'Already revealed' : 'Reveal final scoreboard'}
          </button>
          <p className="mt-1 text-xs text-slate-500">
            Available after the contest ends. Without a manual reveal, the board unfreezes automatically at the reveal time (or contest end).
          </p>
        </Card>
      )}
      {has('organiser') && <RegistrationSettings c={c} />}
      {has('organiser') && <BannerEditor c={c} />}
      <Scoreboard id={id} full />
      <Card>
        <h3 className="mb-2 font-semibold">All submissions</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr>
                <th className="th">When</th>
                <th className="th">User</th>
                <th className="th">Problem</th>
                <th className="th">Lang</th>
                <th className="th">Verdict</th>
                <th className="th">Failed test</th>
                <th className="th" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {subs.data?.map((s) => (
                <tr key={s.id}>
                  <td className="td">{fmt(s.submittedAt)}</td>
                  <td className="td">{s.userName ?? `…${s.userId.slice(-5)}`}</td>
                  <td className="td" title={s.problemTitle ?? undefined}>
                    {s.problemLabel ? <b>{s.problemLabel}</b> : '—'}
                  </td>
                  <td className="td">{s.language}</td>
                  <td className="td">
                    <Badge value={s.status} />
                  </td>
                  <td className="td">{s.failedTest ?? '—'}</td>
                  <td className="td">
                    <button className="text-xs underline" onClick={() => rejudge.mutate(s.id)}>
                      rejudge
                    </button>
                    {has('organiser') && <TrashButton className="ml-1 align-middle" label="Delete submission" onClick={() => delSub({ id: s.id, message: 'This submission is removed from the standings and cannot be recovered.' })} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/** Organiser dashboard: change or remove the contest banner after creation. */
function BannerEditor({ c }: { c: Detail }) {
  const [value, setValue] = useState(c.bannerImage ?? '');
  const save = useAct(() => api.patch(`/contests/${c.id}`, { bannerImage: value }), { ok: 'Banner saved', invalidate: [`/contests/${c.id}`, '/contests'] });
  const dirty = value !== (c.bannerImage ?? '');
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Contest banner</h3>
        <button className="btn-primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          Save banner
        </button>
      </div>
      <CoverPicker noun="contest" type="contest" title={c.title} value={value} onChange={setValue} />
      {c.bannerImage && !dirty && (
        <p className="text-xs text-slate-500">
          Currently showing <span className="break-all font-mono">{assetUrl(c.bannerImage)}</span>
        </p>
      )}
    </Card>
  );
}

/** Organiser dashboard: change the registration deadline and the venue after creation. */
function RegistrationSettings({ c }: { c: Detail }) {
  const venues = useGet<VenueLike[]>('/venues');
  const [deadline, setDeadline] = useState(toLocalInput(c.registrationDeadline));
  const [venueId, setVenueId] = useState(c.venue?.id ?? '');
  const startedAlready = c.status !== 'upcoming';
  const save = useAct(() => api.patch(`/contests/${c.id}`, { registrationDeadline: new Date(deadline).toISOString(), venueId: venueId || null }), {
    ok: 'Registration settings saved',
    invalidate: [`/contests/${c.id}`, '/contests'],
  });
  const dirty = deadline !== toLocalInput(c.registrationDeadline) || venueId !== (c.venue?.id ?? '');
  const bad = !deadline || new Date(deadline) > new Date(c.startAt);
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Registration deadline &amp; venue</h3>
        <button className="btn-primary" disabled={!dirty || bad || save.isPending} onClick={() => save.mutate()}>
          Save
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="text-sm">
          Registration deadline
          <input className="input" type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </label>
        <label className="text-sm">
          Venue
          <select className="input" value={venueId} onChange={(e) => setVenueId(e.target.value)}>
            <option value="">No venue (online)</option>
            {venues.data?.map((v) => (
              <option key={v._id} value={v._id}>
                {venueLabel(v)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {bad && <p className="text-xs text-red-600">{deadline ? `The registration deadline must be before the contest starts (${fmt(c.startAt)}).` : 'A registration deadline is required.'}</p>}
      {startedAlready && <p className="text-xs text-slate-500">The contest has already started: the deadline can still be changed, but it must stay before the start time.</p>}
    </Card>
  );
}

interface RegPerson {
  userId: string;
  name: string;
  email: string;
  department: string;
  batch: string;
  isLeader: boolean;
}
interface RegRow extends Partial<RegPerson> {
  id: string;
  kind: 'individual' | 'team';
  status: 'registered' | 'draft';
  registeredAt?: string | null;
  createdAt?: string;
  memberCount?: number;
  minSize?: number;
  maxSize?: number;
  members?: RegPerson[];
}
interface RegList {
  mode: ContestMode;
  rows: RegRow[];
  summary: { registered: number; draftTeams: number };
}

/** Organiser / coordinator: everyone (or every team) that registered for the contest, with a CSV export. */
function Registrations({ id, title }: { id: string; title: string }) {
  const q = useGet<RegList>(`/contests/${id}/registrations`, { refetchInterval: 15000 });
  const [search, setSearch] = useState('');
  return (
    <Query q={q}>
      {(d) => {
        const team = d.mode === 'TEAM';
        const needle = search.trim().toLowerCase();
        const rows = d.rows.filter((r) => !needle || [r.name, r.email, ...(r.members ?? []).flatMap((m) => [m.name, m.email])].some((v) => (v ?? '').toLowerCase().includes(needle)));
        const exportCsv = () =>
          team
            ? downloadCsv(`contest-registrations-${title}`, d.rows, [
                { header: 'Team', value: (r: RegRow) => r.name ?? '' },
                { header: 'Status', value: (r: RegRow) => r.status },
                { header: 'Members', value: (r: RegRow) => r.memberCount ?? 0 },
                { header: 'Leader', value: (r: RegRow) => r.members?.find((m) => m.isLeader)?.name ?? '' },
                { header: 'Member list', value: (r: RegRow) => (r.members ?? []).map((m) => `${m.name} <${m.email}>`).join('; ') },
                { header: 'Registered at', value: (r: RegRow) => r.registeredAt ?? '' },
              ])
            : downloadCsv(`contest-registrations-${title}`, d.rows, [
                { header: 'Name', value: (r: RegRow) => r.name ?? '' },
                { header: 'Email', value: (r: RegRow) => r.email ?? '' },
                { header: 'Department', value: (r: RegRow) => r.department ?? '' },
                { header: 'Batch', value: (r: RegRow) => r.batch ?? '' },
                { header: 'Registered at', value: (r: RegRow) => r.registeredAt ?? '' },
              ]);
        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-slate-600">
                <b>{d.summary.registered}</b> {team ? 'registered teams' : 'registered participants'}
                {team && d.summary.draftTeams > 0 && <span className="text-slate-500"> · {d.summary.draftTeams} draft team{d.summary.draftTeams === 1 ? '' : 's'} (not registered yet)</span>}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input className="input !w-56" placeholder="Search name or e-mail" aria-label="Search registrations" value={search} onChange={(e) => setSearch(e.target.value)} />
                <button className="btn-ghost" disabled={d.rows.length === 0} onClick={exportCsv}>
                  <Download size={14} /> Export CSV
                </button>
              </div>
            </div>
            {rows.length === 0 ? (
              <Empty>{d.rows.length === 0 ? (team ? 'No teams yet.' : 'No registrations yet.') : 'No registration matches your search.'}</Empty>
            ) : (
              <div className="card overflow-x-auto p-0">
                <table className="min-w-full divide-y">
                  <thead>
                    <tr>
                      <th className="th">#</th>
                      <th className="th">{team ? 'Team' : 'Participant'}</th>
                      {team ? <th className="th">Members</th> : <th className="th">Department / batch</th>}
                      <th className="th">{team ? 'Status' : 'Registered'}</th>
                      {team && <th className="th">Registered</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((r, i) => (
                      <tr key={r.id}>
                        <td className="td">{i + 1}</td>
                        <td className="td">
                          {r.name}
                          {!team && <div className="text-xs text-slate-500">{r.email}</div>}
                          {team && (
                            <div className="text-xs text-slate-500">
                              {r.memberCount}/{r.maxSize} members (min {r.minSize})
                            </div>
                          )}
                        </td>
                        {team ? (
                          <td className="td">
                            <ul className="space-y-0.5 text-sm">
                              {(r.members ?? []).map((m) => (
                                <li key={m.userId}>
                                  {m.isLeader && <Crown size={12} className="mr-1 inline text-amber-500" aria-label="Team leader" />}
                                  {m.name} <span className="text-xs text-slate-500">· {m.email}</span>
                                </li>
                              ))}
                            </ul>
                          </td>
                        ) : (
                          <td className="td">{[r.department, r.batch].filter(Boolean).join(' · ') || '—'}</td>
                        )}
                        <td className="td">{team ? <Badge value={r.status === 'registered' ? 'registered' : 'draft'} /> : fmt(r.registeredAt)}</td>
                        {team && <td className="td">{r.registeredAt ? fmt(r.registeredAt) : '—'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      }}
    </Query>
  );
}
