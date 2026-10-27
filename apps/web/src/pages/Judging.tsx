import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, ExternalLink, Gavel, Save, Star, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { fmt, useAct, useDelete, useGet } from '../lib/hooks';
import { Badge, Card, EmptyState, PageHeader, Query, StatTile, useToast } from '../components/ui';

interface Assigned {
  _id: string;
  title: string;
  eventId: string;
  eventTitle?: string;
  activityId: string;
  activityTitle?: string;
  teamName?: string | null;
  currentVersion: number;
  latest?: { content: string; link?: string; submittedAt: string };
  rubric: { criteria: { name: string; maxScore: number; weight: number }[] } | null;
  myScore: { criterionScores: { name: string; score: number }[]; feedback?: string; percent: number } | null;
}
interface ActivityGroup {
  id: string;
  title: string;
  entries: Assigned[];
}
interface EventGroup {
  id: string;
  title: string;
  activities: ActivityGroup[];
}

/** event -> activity -> entries, both levels sorted by name so the page is stable between refreshes. */
function groupByEvent(list: Assigned[]): EventGroup[] {
  const events = new Map<string, EventGroup>();
  for (const e of list) {
    const g = events.get(e.eventId) ?? { id: e.eventId, title: e.eventTitle ?? 'Unknown event', activities: [] };
    let a = g.activities.find((x) => x.id === e.activityId);
    if (!a) g.activities.push((a = { id: e.activityId, title: e.activityTitle ?? 'Activity', entries: [] }));
    a.entries.push(e);
    events.set(e.eventId, g);
  }
  const by = (x: { title: string }, y: { title: string }) => x.title.localeCompare(y.title);
  return [...events.values()].sort(by).map((g) => ({ ...g, activities: g.activities.sort(by) }));
}

export default function Judging() {
  const q = useGet<Assigned[]>('/me/assigned-entries');
  const [sp, setSp] = useSearchParams();
  const scored = q.data?.filter((e) => e.myScore).length ?? 0;
  const groups = useMemo(() => groupByEvent(q.data ?? []), [q.data]);
  // ?event= comes from the notification link; an unknown/stale id falls back to showing every event
  const wanted = sp.get('event') ?? '';
  const eventId = groups.some((g) => g.id === wanted) ? wanted : '';
  const shown = eventId ? groups.filter((g) => g.id === eventId) : groups;
  return (
    <>
      <PageHeader title="Judging" sub="You can only see and score entries assigned to you." />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile icon={Gavel} label="Assigned entries" value={q.data?.length ?? '–'} />
        <StatTile icon={CheckCircle2} tone="green" label="Scored" value={q.data ? scored : '–'} />
        <StatTile icon={Star} tone="amber" label="Still to score" value={q.data ? q.data.length - scored : '–'} />
      </div>
      {groups.length > 1 && (
        <div className="mb-4">
          <select
            className="input sm:max-w-xs"
            aria-label="Filter by event"
            value={eventId}
            onChange={(x) => setSp(x.target.value ? { event: x.target.value } : {}, { replace: true })}
          >
            <option value="">All events</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </select>
        </div>
      )}
      <Query q={q}>
        {(l) =>
          l.length === 0 ? (
            <EmptyState icon={Gavel} title="No entries assigned yet" hint="When an organiser assigns you to a competition, its entries will show up here for scoring." />
          ) : (
            <div className="space-y-8">
              {shown.map((g) => (
                <section key={g.id} aria-label={`Event ${g.title}`} className="space-y-5">
                  <h2 className="text-lg font-bold">
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Event</span> {g.title}
                  </h2>
                  {g.activities.map((a) => {
                    const done = a.entries.filter((e) => e.myScore).length;
                    return (
                      <div key={a.id} className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-1">
                          <h3 className="font-semibold">{a.title}</h3>
                          <Badge value={`scored ${done} of ${a.entries.length}`} />
                        </div>
                        {a.entries.map((e) => (
                          <ScoreCard key={e._id} e={e} />
                        ))}
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
          )
        }
      </Query>
    </>
  );
}

function ScoreCard({ e }: { e: Assigned }) {
  const toast = useToast();
  const [vals, setVals] = useState<Record<string, number>>(Object.fromEntries((e.myScore?.criterionScores ?? []).map((s) => [s.name, s.score])));
  const [feedback, setFeedback] = useState(e.myScore?.feedback ?? '');
  const criteria = e.rubric?.criteria ?? [];
  // same weighted-percent idea the server uses, shown live so judges see the effect of each score
  const percent = useMemo(() => {
    const w = criteria.reduce((a, c) => a + c.weight, 0);
    if (!w) return 0;
    return Math.round((criteria.reduce((a, c) => a + ((vals[c.name] ?? 0) / c.maxScore) * c.weight, 0) / w) * 100);
  }, [criteria, vals]);
  const invalid = criteria.some((c) => !Number.isFinite(vals[c.name] ?? 0) || (vals[c.name] ?? 0) < 0 || (vals[c.name] ?? 0) > c.maxScore);
  const submit = useAct(
    () => api.put(`/entries/${e._id}/score`, { criterionScores: criteria.map((c) => ({ name: c.name, score: Number(vals[c.name] ?? 0) })), feedback }),
    { ok: 'Score saved', invalidate: ['/me/assigned-entries'] },
  );
  const delScore = useDelete({
    noun: 'score',
    request: (id) => api.del(`/entries/${id}/score`),
    invalidate: ['/me/assigned-entries'],
    onDeleted: () => {
      setVals({});
      setFeedback('');
    },
  });
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-semibold">{e.title}</h4>
        <Badge value={`v${e.currentVersion}`} />
        {e.teamName && <span className="text-sm text-slate-500">Team {e.teamName}</span>}
        {e.myScore && <Badge value={`scored ${e.myScore.percent}%`} />}
      </div>
      {e.latest && (
        <div className="my-3 rounded-xl border border-white/70 bg-white/60 p-3 text-sm">
          <p className="whitespace-pre-wrap">{e.latest.content}</p>
          {e.latest.link && (
            <a className="mt-1 inline-flex items-center gap-1 text-brand-700 underline" href={e.latest.link} target="_blank" rel="noreferrer">
              <ExternalLink size={12} /> {e.latest.link}
            </a>
          )}
          <div className="text-xs text-slate-400">Submitted {fmt(e.latest.submittedAt)}</div>
        </div>
      )}
      {!e.rubric ? (
        <p className="rounded-xl bg-amber-50/80 p-3 text-sm text-amber-800">The organiser has not defined a rubric yet.</p>
      ) : (
        <div className="space-y-3">
          {criteria.map((c) => {
            const v = vals[c.name] ?? 0;
            const bad = v < 0 || v > c.maxScore;
            return (
              <label key={c.name} className="block text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    {c.name} <span className="text-slate-500">(0–{c.maxScore}, weight {c.weight})</span>
                  </span>
                  <input
                    className={`input max-w-[6rem] ${bad ? 'border-red-500' : ''}`}
                    type="number"
                    min={0}
                    max={c.maxScore}
                    value={vals[c.name] ?? ''}
                    onChange={(x) => setVals({ ...vals, [c.name]: Number(x.target.value) })}
                  />
                </div>
                <input
                  type="range"
                  className="mt-1 w-full accent-brand-600"
                  aria-label={`${c.name} slider`}
                  min={0}
                  max={c.maxScore}
                  step={c.maxScore > 20 ? 1 : 0.5}
                  value={Math.min(Math.max(v, 0), c.maxScore)}
                  onChange={(x) => setVals({ ...vals, [c.name]: Number(x.target.value) })}
                />
              </label>
            );
          })}
          <div>
            <div className="mb-1 flex justify-between text-xs text-slate-500">
              <span>Live weighted total</span>
              <b className="text-slate-800">{percent}%</b>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-200/80">
              <div className="h-full rounded-full bg-gradient-to-r from-brand-600 to-brand-800 transition-all" style={{ width: `${percent}%` }} />
            </div>
          </div>
          <textarea className="input" rows={2} placeholder="Feedback for the participant" value={feedback} onChange={(x) => setFeedback(x.target.value)} />
          <button
            className="btn-primary"
            disabled={submit.isPending}
            onClick={() => (invalid ? toast('Every score must be between 0 and its maximum', 'error') : submit.mutate())}
          >
            <Save size={14} /> {e.myScore ? 'Update score' : 'Save score'}
          </button>
          {e.myScore && (
            <button className="btn-danger-ghost ml-2" onClick={() => delScore({ id: e._id, title: 'Delete your score?', confirmText: 'Delete score', message: <>Your {e.myScore!.percent}% score and feedback for <b>“{e.title}”</b> are removed. You can score it again afterwards.</> })}>
              <Trash2 size={14} /> Delete my score
            </button>
          )}
        </div>
      )}
    </Card>
  );
}
