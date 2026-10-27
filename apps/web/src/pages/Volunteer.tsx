import { useState } from 'react';
import { CalendarClock, CheckCircle2, ClipboardList, Clock, ListTodo, Plus, Repeat2, Save, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { fmt, toLocalInput, useAct, useDelete, useGet } from '../lib/hooks';
import { Badge, Card, EmptyState, PageHeader, Query, StatTile, useToast } from '../components/ui';
import CheckInDesk from '../components/CheckInDesk';

interface MyShift {
  assignmentId: string;
  attendance: string;
  shift: { _id: string; title: string; start: string; end: string; eventId: string };
}
export default function Volunteer() {
  const { has } = useAuth();
  const toast = useToast();
  const events = useGet<{ _id: string; title: string }[]>('/events');
  const shifts = useGet<MyShift[]>('/me/shifts');
  const tasks = useGet<{ _id: string; title: string; status: string }[]>('/me/tasks');
  const [eventId, setEventId] = useState('');
  const [slots, setSlots] = useState<{ start: string; end: string }[]>([{ start: '', end: '' }]);
  const [reason, setReason] = useState<Record<string, string>>({});
  const avail = useGet<{ slots: { start: string; end: string }[] }>(eventId ? `/me/availability/${eventId}` : null);
  const save = useAct(
    () =>
      api.put(`/me/availability/${eventId}`, {
        slots: slots.filter((s) => s.start && s.end).map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() })),
      }),
    { ok: 'Availability saved', invalidate: [`/me/availability/${eventId}`] },
  );
  const replace = useAct((aid: string) => api.post(`/assignments/${aid}/replacement`, { reason: reason[aid] }), {
    ok: 'Replacement request sent to the coordinator',
    invalidate: ['/me/shifts'],
  });
  const clearAvail = useDelete({ noun: 'availability', request: (eid) => api.del(`/me/availability/${eid}`), invalidate: ['/me/availability'], onDeleted: () => setSlots([{ start: '', end: '' }]) });
  const done = useAct((tid: string) => api.patch(`/tasks/${tid}/complete`), { ok: 'Task marked done', invalidate: ['/me/tasks'] });
  return (
    <>
      <PageHeader title="Volunteer desk" sub="Set availability, see your duties, request replacements" />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile icon={CalendarClock} label="My shifts" value={shifts.data?.length ?? '–'} />
        <StatTile icon={CheckCircle2} tone="green" label="Marked present" value={shifts.data?.filter((x) => x.attendance === 'present').length ?? '–'} />
        <StatTile icon={ListTodo} tone="amber" label="Open tasks" value={tasks.data?.filter((x) => x.status !== 'done').length ?? '–'} />
      </div>
      {has('coordinator', 'organiser') && (
        <p className="mb-3 text-sm">
          Coordinators: assign shifts and approve replacements from an event’s{' '}
          <Link className="text-brand-700 underline" to="/events">
            Manage → Volunteers
          </Link>{' '}
          tab.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <Clock size={18} className="text-brand-600" /> My availability
          </h2>
          <select
            className="input mb-2"
            aria-label="Event"
            value={eventId}
            onChange={(e) => {
              setEventId(e.target.value);
              setSlots([{ start: '', end: '' }]);
            }}
          >
            <option value="">Choose an event…</option>
            {events.data?.map((e) => (
              <option key={e._id} value={e._id}>
                {e.title}
              </option>
            ))}
          </select>
          {eventId && (
            <>
              {avail.data?.slots.length ? (
                <p className="mb-2 text-xs text-slate-500">Saved: {avail.data.slots.map((s) => `${fmt(s.start)} → ${fmt(s.end)}`).join(' | ')}</p>
              ) : null}
              {slots.map((s, i) => (
                <div key={i} className="mb-2 grid grid-cols-2 gap-2">
                  <input
                    className="input"
                    type="datetime-local"
                    aria-label="From"
                    value={s.start}
                    onChange={(e) => setSlots(slots.map((x, k) => (k === i ? { ...x, start: e.target.value } : x)))}
                  />
                  <input
                    className="input"
                    type="datetime-local"
                    aria-label="To"
                    value={s.end}
                    onChange={(e) => setSlots(slots.map((x, k) => (k === i ? { ...x, end: e.target.value } : x)))}
                  />
                </div>
              ))}
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={() => setSlots([...slots, { start: '', end: '' }])}>
                  <Plus size={14} /> Add slot
                </button>
                <button
                  className="btn-primary"
                  disabled={save.isPending}
                  onClick={() => {
                    const filled = slots.filter((x) => x.start && x.end);
                    if (!filled.length) return toast('Add at least one complete slot', 'error');
                    if (filled.some((x) => new Date(x.end) <= new Date(x.start))) return toast('Each slot must end after it starts', 'error');
                    save.mutate();
                  }}
                >
                  <Save size={14} /> Save availability
                </button>
                {avail.data?.slots.length ? (
                  <>
                    <button
                      className="btn-ghost"
                      onClick={() => setSlots(avail.data!.slots.map((s) => ({ start: toLocalInput(s.start), end: toLocalInput(s.end) })))}
                    >
                      Edit saved
                    </button>
                    <button
                      className="btn-danger-ghost"
                      onClick={() =>
                        clearAvail({ id: eventId, title: 'Clear your availability?', confirmText: 'Clear availability', message: 'Your saved time slots for this event are removed. Coordinators will no longer see you as available.' })
                      }
                    >
                      <Trash2 size={14} /> Clear saved
                    </button>
                  </>
                ) : null}
              </div>
            </>
          )}
        </Card>
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <ClipboardList size={18} className="text-brand-600" /> My tasks
          </h2>
          <Query q={tasks}>
            {(t) =>
              t.length === 0 ? (
                <EmptyState icon={ListTodo} title="No tasks assigned" hint="Coordinators will drop tasks here. You'll get a notification." />
              ) : (
                <ul className="space-y-1 text-sm">
                  {t.map((x) => (
                    <li key={x._id} className="row-hover flex items-center justify-between gap-2 px-2 py-2">
                      {x.title}
                      {x.status === 'done' ? (
                        <Badge value="done" />
                      ) : (
                        <button className="btn-primary" disabled={done.isPending} onClick={() => done.mutate(x._id)}>
                          <CheckCircle2 size={14} /> Mark done
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )
            }
          </Query>
        </Card>
        <div className="lg:col-span-2">
          <CheckInDesk title="Check-in desk" />
        </div>
        <Card className="lg:col-span-2">
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <CalendarClock size={18} className="text-brand-600" /> My shifts
          </h2>
          <Query q={shifts}>
            {(l) =>
              l.length === 0 ? (
                <EmptyState icon={CalendarClock} title="No shifts yet" hint="Save your availability above — a coordinator can then roster you onto matching shifts." />
              ) : (
                <ul className="space-y-2 text-sm">
                  {l.map((s) => (
                    <li key={s.assignmentId} className="row-hover border-l-4 border-brand-500/60 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <b>{s.shift.title}</b>
                        <span className="text-slate-500">
                          {fmt(s.shift.start)} – {fmt(s.shift.end)}
                        </span>
                        <Badge value={s.attendance} />
                      </div>
                      <div className="mt-1 flex gap-2">
                        <input
                          className="input max-w-sm"
                          placeholder="Reason for replacement request"
                          value={reason[s.assignmentId] ?? ''}
                          onChange={(e) => setReason({ ...reason, [s.assignmentId]: e.target.value })}
                        />
                        <button className="btn-ghost" disabled={(reason[s.assignmentId] ?? '').length < 3} onClick={() => replace.mutate(s.assignmentId)}>
                          <Repeat2 size={14} /> Request replacement
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )
            }
          </Query>
        </Card>
      </div>
    </>
  );
}
