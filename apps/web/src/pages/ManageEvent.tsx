import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ACTIVITY_KINDS } from '@festhub/shared';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { fmt, useAct, useDelete, useGet } from '../lib/hooks';
import { VenueManager } from '../components/VenueManager';
import { venueLabel, type VenueLike } from '../lib/venue';
import { Badge, Card, Empty, Field, PageHeader, Query, Tabs, TrashButton, useConfirm } from '../components/ui';

type Tab = 'ready' | 'regs' | 'schedule' | 'vol' | 'issues' | 'ann' | 'attend' | 'judging';
const TABS = [
  { id: 'ready', label: 'Readiness' },
  { id: 'regs', label: 'Registrations' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'vol', label: 'Volunteers' },
  { id: 'issues', label: 'Issues' },
  { id: 'ann', label: 'Announcements' },
  { id: 'attend', label: 'Attendance' },
  { id: 'judging', label: 'Judging' },
] as const;
interface User {
  id: string;
  name: string;
  email: string;
}
interface Activity {
  _id: string;
  title: string;
  kind: string;
  start: string;
  end: string;
  venueId?: string;
}

export default function ManageEvent() {
  const { id } = useParams();
  const { has } = useAuth();
  const nav = useNavigate();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('ready');
  const ev = useGet<{ title: string; status: string }>(`/events/${id}`);
  const publish = useAct(() => api.post(`/events/${id}/publish`), { ok: 'Event published' });
  const cancel = useAct(() => api.post(`/events/${id}/cancel`), { ok: 'Event cancelled' });
  const delEvent = useDelete({ noun: 'event', request: (i) => api.del(`/events/${i}`), invalidate: ['/events?', '/me/registrations'], onDeleted: () => nav('/events', { replace: true }) });
  return (
    <>
      <PageHeader
        title={`Manage: ${ev.data?.title ?? ''}`}
        sub={ev.data ? `Status: ${ev.data.status}` : undefined}
        actions={
          <>
            <Link className="btn-ghost" to={`/events/${id}`}>
              View page
            </Link>
            {has('organiser') && ev.data?.status === 'draft' && (
              <button className="btn-primary" onClick={() => publish.mutate()}>
                Publish
              </button>
            )}
            {has('organiser') && ev.data && ['draft', 'published'].includes(ev.data.status) && (
              <button
                className="btn-ghost"
                onClick={() => confirm({ title: 'Cancel this event?', message: 'Registrants are notified and the event is marked cancelled. You can still delete it afterwards.', tone: 'danger', confirmText: 'Cancel event', cancelText: 'Keep event', run: () => cancel.mutateAsync() })}
              >
                Cancel event
              </button>
            )}
            {has('organiser') && (
              <button
                className="btn-danger"
                onClick={() =>
                  delEvent({ id: id!, name: ev.data?.title, typeToConfirm: 'DELETE', warning: 'Every registration, schedule item, shift, task and announcement is deleted with it, and registered people are notified.' })
                }
              >
                Delete event
              </button>
            )}
          </>
        }
      />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'ready' && <Readiness id={id!} />}
      {tab === 'regs' && <Registrations id={id!} />}
      {tab === 'schedule' && <Schedule id={id!} />}
      {tab === 'vol' && <Volunteers id={id!} />}
      {tab === 'issues' && <Issues id={id!} />}
      {tab === 'ann' && <Announce id={id!} />}
      {tab === 'attend' && <Attendance id={id!} />}
      {tab === 'judging' && <JudgingAdmin id={id!} />}
    </>
  );
}

function Readiness({ id }: { id: string }) {
  const q = useGet<{
    score: number;
    status: string;
    setup: Record<string, boolean>;
    uncoveredShifts: { shiftId: string; title: string; needed: number; assigned: number }[];
    missingJudges: { activityId: string; title: string; reason: string }[];
    missingRubrics: { activityId: string; title: string }[];
    conflicts: { type: string; message: string }[];
    openIssues: { title: string; priority: string }[];
    pendingReplacements: number;
    pendingApprovals: number;
  }>(`/events/${id}/readiness`, { refetchInterval: 15000 }); // near-real-time matrix: refreshes every 15s and on every mutation
  return (
    <Query q={q}>
      {(r) => (
        <div className="space-y-3">
          <Card className="relative overflow-hidden">
            <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gradient-to-br from-brand-500/20 to-gold-400/20 blur-2xl" />
            <div className="relative flex items-center gap-3">
              <div className="bg-gradient-to-r from-brand-700 to-brand-500 bg-clip-text text-4xl font-bold text-transparent">{r.score}%</div>
              <Badge value={r.status} />
              <span className="ml-auto text-xs text-slate-500">Live · updates every 15s</span>
            </div>
            <div className="relative mt-3 h-2.5 overflow-hidden rounded-full bg-slate-200/80">
              <div
                className={`h-full rounded-full transition-all duration-700 ${r.score === 100 ? 'bg-gradient-to-r from-emerald-500 to-teal-500' : r.score >= 70 ? 'bg-gradient-to-r from-amber-400 to-orange-500' : 'bg-gradient-to-r from-rose-500 to-red-600'}`}
                style={{ width: `${r.score}%` }}
              />
            </div>
          </Card>
          <div className="grid gap-3 md:grid-cols-2">
            <Card>
              <h3 className="mb-1 font-semibold">Setup</h3>
              <ul className="text-sm">
                {Object.entries(r.setup).map(([k, v]) => (
                  <li key={k}>
                    {v ? '✅' : '⬜'} {k.replace(/([A-Z])/g, ' $1').toLowerCase()}
                  </li>
                ))}
              </ul>
            </Card>
            <Card>
              <h3 className="mb-1 font-semibold">Uncovered shifts ({r.uncoveredShifts.length})</h3>
              {r.uncoveredShifts.length === 0 ? (
                <p className="text-sm text-slate-500">All shifts are covered.</p>
              ) : (
                <ul className="text-sm">
                  {r.uncoveredShifts.map((s) => (
                    <li key={s.shiftId}>
                      {s.title}: {s.assigned}/{s.needed} volunteers
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h3 className="mb-1 font-semibold">Missing judges / rubrics</h3>
              {r.missingJudges.length + r.missingRubrics.length === 0 ? (
                <p className="text-sm text-slate-500">Judging is set up.</p>
              ) : (
                <ul className="text-sm">
                  {r.missingJudges.map((m) => (
                    <li key={m.activityId}>
                      ⚠ {m.title}: {m.reason}
                    </li>
                  ))}
                  {r.missingRubrics.map((m) => (
                    <li key={m.activityId}>⚠ {m.title}: no rubric</li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h3 className="mb-1 font-semibold">Conflicts ({r.conflicts.length})</h3>
              {r.conflicts.length === 0 ? (
                <p className="text-sm text-slate-500">No venue or volunteer conflicts.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {r.conflicts.map((c, i) => (
                    <li key={i} className="rounded bg-red-50 p-2">
                      {c.message}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card>
              <h3 className="mb-1 font-semibold">Needs attention</h3>
              <ul className="text-sm">
                <li>{r.pendingApprovals} registrations awaiting approval</li>
                <li>{r.pendingReplacements} replacement requests pending</li>
                {r.openIssues.map((i, k) => (
                  <li key={k}>
                    🔥 {i.priority}: {i.title}
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </div>
      )}
    </Query>
  );
}

interface TeamMemberRow {
  userId: string;
  name: string;
  email?: string;
  isLeader: boolean;
}
interface RegTeam {
  name: string;
  memberCount?: number;
  members?: TeamMemberRow[];
}

/** Team name, member count and an expandable roster (stacked, wraps on mobile). Emails only appear when the server sends them. */
function TeamCell({ team }: { team: RegTeam }) {
  const [open, setOpen] = useState(false);
  const members = team.members ?? [];
  const count = team.memberCount ?? members.length;
  return (
    <div className="min-w-[14rem]">
      <div className="font-medium">Team {team.name}</div>
      <button type="button" className="mt-0.5 text-xs text-brand-600 hover:underline" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {count} {count === 1 ? 'member' : 'members'} {open ? '▲' : '▼'}
      </button>
      {open && (
        <ul className="mt-2 space-y-2 border-l-2 pl-3" aria-label={`Members of ${team.name}`}>
          {members.map((m) => (
            <li key={m.userId} className="text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span>{m.name}</span>
                {m.isLeader && <span className="badge">Leader</span>}
              </div>
              {m.email && <div className="break-all text-xs text-slate-500">{m.email}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Registrations({ id }: { id: string }) {
  const confirm = useConfirm();
  const k = `/events/${id}/registrations`;
  const q = useGet<{ _id: string; status: string; waitlistPosition?: number; user?: User; team?: RegTeam | null }[]>(k);
  const act = useAct(({ rid, a }: { rid: string; a: string }) => (a === 'cancel' ? api.del(`/registrations/${rid}`) : api.post(`/registrations/${rid}/${a}`)), {
    invalidate: [k, `/events/${id}/readiness`],
  });
  return (
    <Query q={q}>
      {(r) =>
        r.length === 0 ? (
          <Empty>No registrations yet.</Empty>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="min-w-full divide-y">
              <thead>
                <tr>
                  <th className="th">Who</th>
                  <th className="th">Status</th>
                  <th className="th">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {r.map((g) => (
                  <tr key={g._id}>
                    <td className="td">
                      {g.team ? (
                        <TeamCell team={g.team} />
                      ) : (
                        <>
                          {g.user?.name}
                          <div className="text-xs text-slate-500">{g.user?.email}</div>
                        </>
                      )}
                    </td>
                    <td className="td">
                      <Badge value={g.status} />
                      {g.waitlistPosition ? ` #${g.waitlistPosition}` : ''}
                    </td>
                    <td className="td space-x-2">
                      {g.status === 'pending_approval' && (
                        <>
                          <button className="btn-primary" onClick={() => act.mutate({ rid: g._id, a: 'approve' })}>
                            Approve
                          </button>
                          <button className="btn-ghost" onClick={() => act.mutate({ rid: g._id, a: 'reject' })}>
                            Reject
                          </button>
                        </>
                      )}
                      <button
                        className="btn-danger-ghost btn-sm"
                        onClick={() =>
                          confirm({ title: 'Remove this registration?', message: 'The seat is released and the waiting list advances. The person is notified.', tone: 'danger', confirmText: 'Remove registration', cancelText: 'Keep it', run: () => act.mutateAsync({ rid: g._id, a: 'cancel' }) })
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </Query>
  );
}

function Schedule({ id }: { id: string }) {
  const k = `/events/${id}/activities`;
  const acts = useGet<Activity[]>(k);
  const venues = useGet<VenueLike[]>('/venues');
  const [f, setF] = useState({ title: '', kind: 'workshop', start: '', end: '', venueId: '', submissionDeadline: '' });
  const { has } = useAuth();
  const add = useAct(
    () =>
      api.post(`/events/${id}/activities`, {
        title: f.title,
        kind: f.kind,
        start: new Date(f.start).toISOString(),
        end: new Date(f.end).toISOString(),
        venueId: f.venueId || undefined,
        submissionDeadline: f.submissionDeadline ? new Date(f.submissionDeadline).toISOString() : undefined,
      }),
    { ok: 'Activity scheduled', invalidate: [k, `/events/${id}/readiness`, `/events/${id}`] },
  );
  const del = useDelete({ noun: 'activity', request: (aid) => api.del(`/activities/${aid}`), prune: [k], invalidate: [`/events/${id}`] });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <h3 className="mb-2 font-semibold">Activities & rounds</h3>
        <Query q={acts}>
          {(a) =>
            a.length === 0 ? (
              <Empty>No activities scheduled.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {a.map((x) => (
                  <li key={x._id} className="flex flex-wrap items-center justify-between py-2 gap-2">
                    <div>
                      <b>{x.title}</b> <Badge value={x.kind} />
                      <div className="text-slate-500">
                        {fmt(x.start)} – {fmt(x.end)} · {venues.data?.find((v) => v._id === x.venueId)?.name ?? 'no venue'}
                      </div>
                    </div>
                    <TrashButton
                      label={`Delete activity ${x.title}`}
                      onClick={() => del({ id: x._id, name: x.title, warning: x.kind === 'competition' ? 'Its entries, rubric, scores and results are deleted too.' : undefined })}
                    />
                  </li>
                ))}
              </ul>
            )
          }
        </Query>
      </Card>
      <div className="space-y-4">
        <Card>
          <h3 className="mb-2 font-semibold">Add activity</h3>
          <div className="space-y-2">
            <Field label="Title">
              <input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} />
            </Field>
            <Field label="Kind">
              <select className="input" value={f.kind} onChange={(e) => set({ kind: e.target.value })}>
                {ACTIVITY_KINDS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </Field>
            <Field label="Venue">
              <select className="input" value={f.venueId} onChange={(e) => set({ venueId: e.target.value })}>
                <option value="">Event venue</option>
                {venues.data?.map((v) => (
                  <option key={v._id} value={v._id}>
                    {venueLabel(v)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Start">
              <input className="input" type="datetime-local" value={f.start} onChange={(e) => set({ start: e.target.value })} />
            </Field>
            <Field label="End">
              <input className="input" type="datetime-local" value={f.end} onChange={(e) => set({ end: e.target.value })} />
            </Field>
            {f.kind === 'competition' && (
              <Field label="Entry deadline">
                <input className="input" type="datetime-local" value={f.submissionDeadline} onChange={(e) => set({ submissionDeadline: e.target.value })} />
              </Field>
            )}
            {add.error && (
              <p className="rounded bg-red-50 p-2 text-sm text-red-800" role="alert">
                {add.error.message}
              </p>
            )}
            <button className="btn-primary w-full" disabled={!f.title || !f.start || !f.end || add.isPending} onClick={() => add.mutate()}>
              Schedule
            </button>
          </div>
        </Card>
        {has('organiser') && (
          <Card>
            <h3 className="mb-1 font-semibold">Venues</h3>
            <VenueManager />
          </Card>
        )}
      </div>
    </div>
  );
}

interface Shift {
  _id: string;
  title: string;
  start: string;
  end: string;
  requiredCount: number;
  assignments: { id: string; volunteerId: string; name: string; attendance: string }[];
}
interface Repl {
  _id: string;
  status: string;
  reason: string;
  requesterName?: string;
  proposedName?: string;
  shift?: { title: string; start: string };
}
function Volunteers({ id }: { id: string }) {
  const k = `/events/${id}/shifts`;
  const shifts = useGet<Shift[]>(k);
  const reps = useGet<Repl[]>(`/events/${id}/replacements`);
  const vols = useGet<User[]>('/users?role=volunteer');
  const tasks = useGet<{ _id: string; title: string; status: string }[]>(`/events/${id}/tasks`);
  const [s, setS] = useState({ title: '', start: '', end: '', requiredCount: 1 });
  const [pick, setPick] = useState<Record<string, string>>({});
  const [rep, setRep] = useState<Record<string, string>>({});
  const [task, setTask] = useState({ title: '', assigneeId: '' });
  const inv = [k, `/events/${id}/replacements`, `/events/${id}/readiness`, `/events/${id}/tasks`];
  const add = useAct(() => api.post(k, { ...s, start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }), {
    ok: 'Shift created',
    invalidate: inv,
  });
  const assign = useAct(({ sid, override }: { sid: string; override?: boolean }) => api.post(`/shifts/${sid}/assign`, { volunteerId: pick[sid], override }), {
    ok: 'Volunteer assigned',
    invalidate: inv,
  });
  const mark = useAct(({ aid, status }: { aid: string; status: string }) => api.post(`/assignments/${aid}/attendance`, { status }), { invalidate: inv });
  const decide = useAct(
    ({ rid, a }: { rid: string; a: 'approve' | 'reject' }) =>
      api.post(`/replacements/${rid}/${a}`, a === 'approve' ? { volunteerId: rep[rid] || undefined } : {}),
    { ok: 'Decision saved', invalidate: inv },
  );
  const mkTask = useAct(() => api.post(`/events/${id}/tasks`, task), {
    ok: 'Task assigned',
    invalidate: inv,
    onDone: () => setTask({ title: '', assigneeId: '' }),
  });
  const delShift = useDelete({ noun: 'shift', request: (i) => api.del(`/shifts/${i}`), prune: [k], invalidate: [`/events/${id}`, '/me/dashboard'] });
  const unassign = useDelete({ noun: 'assignment', request: (i) => api.del(`/assignments/${i}`), invalidate: [`/events/${id}`] });
  const delTask = useDelete({ noun: 'task', request: (i) => api.del(`/tasks/${i}`), prune: [`/events/${id}/tasks`], invalidate: [`/events/${id}`] });
  const delRep = useDelete({ noun: 'replacement request', request: (i) => api.del(`/replacements/${i}`), prune: [`/events/${id}/replacements`], invalidate: [`/events/${id}`] });
  const volSelect = (v: string, on: (x: string) => void) => (
    <select className="input" value={v} onChange={(e) => on(e.target.value)}>
      <option value="">Choose volunteer…</option>
      {vols.data?.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  );
  return (
    <div className="space-y-4">
      <Card>
        <h3 className="mb-2 font-semibold">Create shift</h3>
        <div className="grid gap-2 md:grid-cols-5">
          <input className="input md:col-span-2" placeholder="Shift title" value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} />
          <input className="input" type="datetime-local" aria-label="Start" value={s.start} onChange={(e) => setS({ ...s, start: e.target.value })} />
          <input className="input" type="datetime-local" aria-label="End" value={s.end} onChange={(e) => setS({ ...s, end: e.target.value })} />
          <input
            className="input"
            type="number"
            min={1}
            aria-label="Volunteers needed"
            value={s.requiredCount}
            onChange={(e) => setS({ ...s, requiredCount: Number(e.target.value) })}
          />
        </div>
        <button className="btn-primary mt-2" disabled={!s.title || !s.start || !s.end} onClick={() => add.mutate()}>
          Add shift
        </button>
      </Card>
      <Query q={shifts}>
        {(l) =>
          l.length === 0 ? (
            <Empty>No shifts yet.</Empty>
          ) : (
            <div className="space-y-3">
              {l.map((sh) => (
                <Card key={sh._id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <b>{sh.title}</b>
                      <div className="text-sm text-slate-500">
                        {fmt(sh.start)} – {fmt(sh.end)}
                      </div>
                    </div>
                    <Badge value={sh.assignments.length >= sh.requiredCount ? 'ready' : 'attention'} />
                    <span className="text-sm">
                      {sh.assignments.length}/{sh.requiredCount} assigned
                    </span>
                    <TrashButton
                      label={`Delete shift ${sh.title}`}
                      onClick={() => delShift({ id: sh._id, name: sh.title, warning: sh.assignments.length ? 'Assigned volunteers are notified and unassigned.' : undefined })}
                    />
                  </div>
                  <ul className="my-2 text-sm">
                    {sh.assignments.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-center justify-between py-1 gap-2">
                        {a.name}{' '}
                        <span className="space-x-1">
                          <Badge value={a.attendance} />
                          <button className="text-xs underline" onClick={() => mark.mutate({ aid: a.id, status: 'present' })}>
                            present
                          </button>
                          <button className="text-xs underline" onClick={() => mark.mutate({ aid: a.id, status: 'absent' })}>
                            absent
                          </button>
                          <TrashButton
                            className="!h-6 !w-6 align-middle"
                            label={`Remove ${a.name} from ${sh.title}`}
                            onClick={() => unassign({ id: a.id, title: 'Remove volunteer from shift?', confirmText: 'Remove', message: <><b>{a.name}</b> is removed from “{sh.title}” and notified. You can assign them again later.</> })}
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2">
                    {volSelect(pick[sh._id] ?? '', (v) => setPick({ ...pick, [sh._id]: v }))}
                    <button className="btn-primary" disabled={!pick[sh._id]} onClick={() => assign.mutate({ sid: sh._id })}>
                      Assign
                    </button>
                    <button
                      className="btn-ghost"
                      disabled={!pick[sh._id]}
                      title="Skip the availability check (overlaps are still blocked)"
                      onClick={() => assign.mutate({ sid: sh._id, override: true })}
                    >
                      Override availability
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )
        }
      </Query>
      <Card>
        <h3 className="mb-2 font-semibold">Replacement requests</h3>
        <Query q={reps}>
          {(l) =>
            l.length === 0 ? (
              <Empty>No replacement requests.</Empty>
            ) : (
              <ul className="divide-y text-sm">
                {l.map((r) => (
                  <li key={r._id} className="py-2">
                    <div className="flex items-center gap-2">
                      <b>{r.requesterName}</b> wants out of “{r.shift?.title}” <Badge value={r.status} />
                    </div>
                    <div className="flex flex-wrap items-start justify-between gap-2 text-slate-500">
                      <span>
                        Reason: {r.reason}
                        {r.proposedName && ` · proposed: ${r.proposedName}`}
                      </span>
                      <TrashButton label="Delete replacement request" onClick={() => delRep({ id: r._id, name: `${r.requesterName} · ${r.shift?.title}` })} />
                    </div>
                    {r.status === 'pending' && (
                      <div className="mt-1 flex flex-wrap gap-2">
                        {volSelect(rep[r._id] ?? '', (v) => setRep({ ...rep, [r._id]: v }))}
                        <button className="btn-primary" onClick={() => decide.mutate({ rid: r._id, a: 'approve' })}>
                          Approve
                        </button>
                        <button className="btn-ghost" onClick={() => decide.mutate({ rid: r._id, a: 'reject' })}>
                          Reject
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          }
        </Query>
      </Card>
      <Card>
        <h3 className="mb-2 font-semibold">Tasks</h3>
        <div className="mb-2 flex flex-wrap gap-2">
          <input className="input max-w-xs" placeholder="Task" value={task.title} onChange={(e) => setTask({ ...task, title: e.target.value })} />
          {volSelect(task.assigneeId, (v) => setTask({ ...task, assigneeId: v }))}
          <button className="btn-primary" disabled={!task.title || !task.assigneeId} onClick={() => mkTask.mutate()}>
            Assign task
          </button>
        </div>
        <ul className="text-sm">
          {tasks.data?.map((t) => (
            <li key={t._id} className="flex items-center gap-2 py-0.5">
              {t.title} <Badge value={t.status} />
              <TrashButton label={`Delete task ${t.title}`} onClick={() => delTask({ id: t._id, name: t.title })} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

interface Issue {
  _id: string;
  title: string;
  priority: string;
  status: string;
  ownerName?: string;
  reporterName?: string;
  resolution?: string;
  comments: { _id?: string; text: string }[];
}
function Issues({ id }: { id: string }) {
  const k = `/events/${id}/issues`;
  const q = useGet<Issue[]>(k);
  const staff = useGet<User[]>('/users');
  const [t, setT] = useState({ title: '', priority: 'medium' });
  const [res, setRes] = useState<Record<string, string>>({});
  const add = useAct(() => api.post(k, t), {
    ok: 'Issue reported',
    invalidate: [k, `/events/${id}/readiness`],
    onDone: () => setT({ title: '', priority: 'medium' }),
  });
  const upd = useAct(({ iid, body }: { iid: string; body: object }) => api.patch(`/issues/${iid}`, body), { invalidate: [k, `/events/${id}/readiness`] });
  const [c, setC] = useState<Record<string, string>>({});
  const delIssue = useDelete({ noun: 'issue', request: (i) => api.del(`/issues/${i}`), prune: [k], invalidate: [k, `/events/${id}/readiness`] });
  const delComment = useDelete({ noun: 'comment', request: (i) => api.del(`/issues/${i.split(':')[0]}/comments/${i.split(':')[1]}`), invalidate: [k] });
  const comment = useAct(({ iid }: { iid: string }) => api.post(`/issues/${iid}/comments`, { text: c[iid] }), { invalidate: [k], onDone: () => setC({}) });
  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap gap-2">
          <input className="input max-w-md" placeholder="Describe the issue" value={t.title} onChange={(e) => setT({ ...t, title: e.target.value })} />
          <select className="input max-w-[9rem]" value={t.priority} onChange={(e) => setT({ ...t, priority: e.target.value })}>
            {['low', 'medium', 'high', 'critical'].map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <button className="btn-primary" disabled={t.title.length < 3} onClick={() => add.mutate()}>
            Report
          </button>
        </div>
      </Card>
      <Query q={q}>
        {(l) =>
          l.length === 0 ? (
            <Empty>No issues reported.</Empty>
          ) : (
            l.map((i) => (
              <Card key={i._id}>
                <div className="flex flex-wrap items-center gap-2">
                  <b>{i.title}</b>
                  <Badge value={i.priority} />
                  <Badge value={i.status} />
                  <span className="text-xs text-slate-500">
                    owner: {i.ownerName ?? 'unassigned'} · by {i.reporterName}
                  </span>
                  <TrashButton className="ml-auto" label={`Delete issue ${i.title}`} onClick={() => delIssue({ id: i._id, name: i.title })} />
                </div>
                {i.resolution && <p className="mt-1 text-sm text-green-800">Resolution: {i.resolution}</p>}
                <ul className="mt-1 text-sm text-slate-600">
                  {i.comments.map((m, x) => (
                    <li key={m._id ?? x} className="flex items-center gap-1">
                      💬 {m.text}
                      {m._id && <TrashButton className="!h-6 !w-6" label="Delete comment" onClick={() => delComment({ id: `${i._id}:${m._id}`, name: m.text.slice(0, 60) })} />}
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex flex-wrap gap-2">
                  <select
                    className="input max-w-[11rem]"
                    defaultValue=""
                    onChange={(e) => e.target.value && upd.mutate({ iid: i._id, body: { ownerId: e.target.value } })}
                  >
                    <option value="">Assign owner…</option>
                    {staff.data?.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                  <button className="btn-ghost" onClick={() => upd.mutate({ iid: i._id, body: { status: 'in_progress' } })}>
                    In progress
                  </button>
                  <input
                    className="input max-w-xs"
                    placeholder="Resolution note"
                    value={res[i._id] ?? ''}
                    onChange={(e) => setRes({ ...res, [i._id]: e.target.value })}
                  />
                  <button className="btn-primary" onClick={() => upd.mutate({ iid: i._id, body: { status: 'resolved', resolution: res[i._id] } })}>
                    Resolve
                  </button>
                  <input className="input max-w-xs" placeholder="Add comment" value={c[i._id] ?? ''} onChange={(e) => setC({ [i._id]: e.target.value })} />
                  <button className="btn-ghost" disabled={!c[i._id]} onClick={() => comment.mutate({ iid: i._id })}>
                    Comment
                  </button>
                </div>
              </Card>
            ))
          )
        }
      </Query>
    </div>
  );
}

function Announce({ id }: { id: string }) {
  const k = `/events/${id}/announcements`;
  const q = useGet<{ _id: string; title: string; body: string; createdAt: string }[]>(k);
  const [f, setF] = useState({ title: '', body: '', pinned: false });
  const delAnn = useDelete({ noun: 'announcement', request: (i) => api.del(`/announcements/${i}`), prune: [k] });
  const post = useAct(() => api.post(k, f), {
    ok: 'Announcement sent to registrants and volunteers',
    invalidate: [k],
    onDone: () => setF({ title: '', body: '', pinned: false }),
  });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <h3 className="mb-2 font-semibold">New announcement</h3>
        <div className="space-y-2">
          <input className="input" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <textarea className="input" rows={4} placeholder="Message" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} />
            Pin
          </label>
          <button className="btn-primary" disabled={f.title.length < 2 || f.body.length < 2} onClick={() => post.mutate()}>
            Send
          </button>
        </div>
      </Card>
      <Card>
        <h3 className="mb-2 font-semibold">History</h3>
        <Query q={q}>
          {(l) =>
            l.length === 0 ? (
              <Empty>Nothing yet.</Empty>
            ) : (
              <ul className="space-y-2 text-sm">
                {l.map((a) => (
                  <li key={a._id} className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <b>{a.title}</b> <span className="text-xs text-slate-400">{fmt(a.createdAt)}</span>
                      <p>{a.body}</p>
                    </div>
                    <TrashButton label={`Delete announcement ${a.title}`} onClick={() => delAnn({ id: a._id, name: a.title })} />
                  </li>
                ))}
              </ul>
            )
          }
        </Query>
      </Card>
    </div>
  );
}

function Attendance({ id }: { id: string }) {
  const q = useGet<{
    checkIns: { id: string; name: string; type: string; at: string; operator: string }[];
    volunteerAttendance: { present: number; absent: number; unmarked: number };
    tasks: { done: number; total: number };
  }>(`/events/${id}/attendance`, { refetchInterval: 10000 });
  const toks = useGet<{ id: string; name: string; subjectType: string; status: string }[]>(`/events/${id}/checkin-tokens`);
  const revoke = useAct((tid: string) => api.post(`/checkin/tokens/${tid}/revoke`), { ok: 'QR code revoked', invalidate: [`/events/${id}/checkin-tokens`] });
  const undoCheckIn = useDelete({ noun: 'check-in', request: (i) => api.del(`/checkins/${i}`), invalidate: [`/events/${id}/attendance`] });
  const delToken = useDelete({ noun: 'QR code', request: (i) => api.del(`/checkin/tokens/${i}`), prune: [`/events/${id}/checkin-tokens`], invalidate: [`/events/${id}/checkin-tokens`] });
  return (
    <div className="space-y-3">
      <Query q={q}>
        {(a) => (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Card>
                <div className="text-2xl font-semibold">{a.checkIns.length}</div>
                <div className="text-sm text-slate-500">Checked in</div>
              </Card>
              <Card>
                <div className="text-2xl font-semibold">{a.volunteerAttendance.present}</div>
                <div className="text-sm text-slate-500">Volunteers present</div>
              </Card>
              <Card>
                <div className="text-2xl font-semibold">{a.volunteerAttendance.absent}</div>
                <div className="text-sm text-slate-500">Volunteers absent</div>
              </Card>
              <Card>
                <div className="text-2xl font-semibold">
                  {a.tasks.done}/{a.tasks.total}
                </div>
                <div className="text-sm text-slate-500">Tasks done</div>
              </Card>
            </div>
            <Card>
              <h3 className="mb-2 font-semibold">Check-in log</h3>
              {a.checkIns.length === 0 ? (
                <Empty>No check-ins yet.</Empty>
              ) : (
                <ul className="divide-y text-sm">
                  {a.checkIns.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-1">
                      <span>
                        {c.name} <Badge value={c.type} /> · {fmt(c.at)} · by {c.operator}
                      </span>
                      <TrashButton
                        label={`Undo check-in for ${c.name}`}
                        onClick={() => undoCheckIn({ id: c.id, title: 'Undo this check-in?', confirmText: 'Undo check-in', message: <><b>{c.name}</b> is no longer marked as checked in and can be scanned again.</> })}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </Query>
      <Card>
        <h3 className="mb-2 font-semibold">Issued QR codes</h3>
        <ul className="divide-y text-sm">
          {toks.data?.map((t) => (
            <li key={t.id} className="flex flex-wrap items-center justify-between py-1 gap-2">
              {t.name} <Badge value={t.subjectType} />
              <Badge value={t.status} />
              {t.status === 'active' && (
                <button className="text-xs text-red-600 underline" onClick={() => revoke.mutate(t.id)}>
                  revoke
                </button>
              )}
              <TrashButton label={`Delete QR code for ${t.name}`} onClick={() => delToken({ id: t.id, name: t.name, message: <>The QR code for <b>{t.name}</b> is deleted. A fresh one is issued the next time they open their pass.</> })} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

interface Entry {
  _id: string;
  title: string;
  ownerName?: string;
  judges?: { id: string; name: string }[];
}
function JudgingAdmin({ id }: { id: string }) {
  const acts = useGet<Activity[]>(`/events/${id}/activities`);
  const comps = acts.data?.filter((a) => a.kind === 'competition') ?? [];
  return (
    <Query q={acts}>
      {() =>
        comps.length === 0 ? (
          <Empty>Add a “competition” activity in the Schedule tab first.</Empty>
        ) : (
          <div className="space-y-4">
            {comps.map((c) => (
              <Comp key={c._id} a={c} />
            ))}
          </div>
        )
      }
    </Query>
  );
}
function Comp({ a }: { a: Activity }) {
  const confirm = useConfirm();
  const rub = useGet<{ criteria: { name: string; maxScore: number; weight: number }[] } | null>(`/activities/${a._id}/rubric`);
  const entries = useGet<Entry[]>(`/activities/${a._id}/entries`);
  const judges = useGet<User[]>('/users?role=judge');
  const res = useGet<{ status: string; rankings: { rank: number; title: string; ownerName: string | null; percent: number }[] }>(`/activities/${a._id}/results`);
  const [crit, setCrit] = useState('Creativity:10:2, Execution:10:1');
  const [pick, setPick] = useState<Record<string, string>>({});
  const inv = [`/activities/${a._id}/rubric`, `/activities/${a._id}/entries`, `/activities/${a._id}/results`];
  const saveRub = useAct(
    () =>
      api.put(`/activities/${a._id}/rubric`, {
        criteria: crit.split(',').map((x) => {
          const [name, max, w] = x.trim().split(':');
          return { name, maxScore: Number(max), weight: Number(w ?? 1) };
        }),
      }),
    { ok: 'Rubric saved', invalidate: inv },
  );
  const assign = useAct((eid: string) => api.post(`/entries/${eid}/judges`, { judgeId: pick[eid] }), { ok: 'Judge assigned', invalidate: inv });
  const delRubric = useDelete({ noun: 'rubric', request: () => api.del(`/activities/${a._id}/rubric`), invalidate: inv });
  const delEntry = useDelete({ noun: 'entry', request: (i) => api.del(`/entries/${i}`), prune: [`/activities/${a._id}/entries`], invalidate: inv });
  const unJudge = useDelete({ noun: 'judge assignment', request: (i) => api.del(`/entries/${i.split(':')[0]}/judges/${i.split(':')[1]}`), invalidate: inv });
  const delResults = useDelete({ noun: 'results', request: () => api.del(`/activities/${a._id}/results`), invalidate: inv });
  const compute = useAct(() => api.post(`/activities/${a._id}/results/compute`), { ok: 'Draft results computed', invalidate: inv });
  const approve = useAct(() => api.post(`/activities/${a._id}/results/approve`), { ok: 'Results are now official', invalidate: inv });
  return (
    <Card>
      <h3 className="font-semibold">{a.title}</h3>
      <div className="my-2 text-sm">
        <b>Rubric</b> (name:max:weight, comma separated)
        <div className="flex gap-2">
          <input className="input" value={crit} onChange={(e) => setCrit(e.target.value)} />
          <button className="btn-ghost" onClick={() => saveRub.mutate()}>
            Save rubric
          </button>
        </div>
        {rub.data && (
          <p className="mt-1 flex items-center gap-1 text-slate-500">
            Current: {rub.data.criteria.map((c) => `${c.name} /${c.maxScore} ×${c.weight}`).join(' · ')}
            <TrashButton label="Delete rubric" onClick={() => delRubric({ id: a._id, name: `Rubric for ${a.title}`, warning: 'Judges can no longer score until a new rubric is saved.' })} />
          </p>
        )}
      </div>
      <Query q={entries}>
        {(l) =>
          l.length === 0 ? (
            <Empty>No entries yet.</Empty>
          ) : (
            <ul className="divide-y text-sm">
              {l.map((e) => (
                <li key={e._id} className="py-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span>
                      <b>{e.title}</b> <span className="text-slate-500">by {e.ownerName}</span>
                    </span>
                    <TrashButton label={`Delete entry ${e.title}`} onClick={() => delEntry({ id: e._id, name: e.title, warning: 'Its versions and all judges’ scores are deleted too.' })} />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-slate-600">
                    judges:
                    {e.judges?.length ? (
                      e.judges.map((j) => (
                        <span key={j.id} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2.5 pr-1 text-xs">
                          {j.name}
                          <button
                            className="grid h-4 w-4 place-items-center rounded-full text-slate-500 hover:bg-red-100 hover:text-red-600"
                            aria-label={`Unassign judge ${j.name}`}
                            onClick={() => unJudge({ id: `${e._id}:${j.id}`, title: 'Unassign this judge?', confirmText: 'Unassign', message: <><b>{j.name}</b> will no longer judge “{e.title}”.</> })}
                          >
                            ×
                          </button>
                        </span>
                      ))
                    ) : (
                      <span>none</span>
                    )}
                  </div>
                  <div className="mt-1 flex gap-2">
                    <select className="input max-w-xs" value={pick[e._id] ?? ''} onChange={(x) => setPick({ ...pick, [e._id]: x.target.value })}>
                      <option value="">Assign judge…</option>
                      {judges.data?.map((j) => (
                        <option key={j.id} value={j.id}>
                          {j.name}
                        </option>
                      ))}
                    </select>
                    <button className="btn-ghost" disabled={!pick[e._id]} onClick={() => assign.mutate(e._id)}>
                      Assign
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
        }
      </Query>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn-ghost" onClick={() => compute.mutate()}>
          Compute draft results
        </button>
        <button
          className="btn-primary"
          disabled={res.data?.status !== 'draft'}
          onClick={() => confirm({ title: 'Publish these results as official?', message: 'Participants can see the rankings straight away.', confirmText: 'Approve & publish', cancelText: 'Not yet', run: () => approve.mutateAsync() })}
        >
          Approve & publish
        </button>
        {res.data && (
          <button className="btn-danger-ghost" onClick={() => delResults({ id: a._id, name: `Results for ${a.title}`, warning: res.data?.status === 'official' ? 'These results are official; participants lose access to the rankings.' : undefined })}>
            Delete results
          </button>
        )}
        {res.data && <Badge value={res.data.status} />}
      </div>
      {res.data && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="py-1 pr-3">Rank</th>
                <th className="py-1 pr-3">Team name</th>
                <th className="py-1 pr-3">Entry title</th>
                <th className="py-1 text-right">Score %</th>
              </tr>
            </thead>
            <tbody>
              {res.data.rankings.map((r, i) => (
                <tr key={i} className="border-t">
                  <td className="py-1 pr-3 font-medium">#{r.rank}</td>
                  <td className="py-1 pr-3">{r.ownerName ?? '—'}</td>
                  <td className="py-1 pr-3">{r.title}</td>
                  <td className="py-1 text-right">{r.percent}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
export { ACTIVITY_KINDS };
