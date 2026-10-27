import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Award, Crown, Download, FileText, Loader2, Medal, Save, Users } from 'lucide-react';
import { api, download, errMsg } from '../lib/api';
import { useAct, useGet } from '../lib/hooks';
import { EmptyState, ErrorBox, PageHeader, Query, useToast } from '../components/ui';
import { certFileName, fetchCertPdf, saveBlob } from '../lib/certView';

/** S15 per-event leaderboard: every row shows exactly how its final score was built (judge + AI - plagiarism penalty). */
type TieBreak = 'judge' | 'ai' | 'none';
interface Settings { judgeWeight: number; aiWeight: number; penaltyPerPair: number; maxPenalty: number; tieBreak: TieBreak; published: boolean }
interface Row {
  key: string; name: string; kind: 'team' | 'person';
  judgePercent: number | null; aiPercent: number | null; judgeShare: number; aiShare: number; judgePoints: number | null; aiPoints: number | null;
  base: number | null; confirmedPairs: number; penalty: number; final: number | null; rank: number | null; tied: boolean; brokeTie: boolean;
  judgeScores: number; entries: number; feedbackCount: number;
  /** v7: team member names (leader first), own-row flag, and the row's certificate (staff: every row; others: own row only) */
  members: string[]; isMine: boolean; certificate: { id: string; type: string; typeLabel: string; positionLabel: string | null } | null;
}
interface Board { event: { id: string; title: string }; settings: Settings; rows: Row[]; generatedAt: string; canConfigure: boolean }
interface EventRow { _id?: string; id?: string; title: string }
const evId = (e: EventRow) => e._id ?? e.id ?? '';
const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

const MEDAL: Record<number, { grad: string; text: string; label: string }> = {
  1: { grad: 'from-amber-300 via-amber-400 to-amber-600', text: 'text-amber-950', label: 'Gold' },
  2: { grad: 'from-slate-200 via-slate-300 to-slate-500', text: 'text-slate-900', label: 'Silver' },
  3: { grad: 'from-orange-300 via-orange-500 to-orange-800', text: 'text-orange-950', label: 'Bronze' },
};

function RankBadge({ r }: { r: Row }) {
  if (r.rank === null) return <span className="text-slate-400" title="No judge or AI score yet">—</span>;
  const m = MEDAL[r.rank];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`grid h-8 min-w-8 place-items-center rounded-full px-2 text-sm font-bold shadow-sm ${m ? `bg-gradient-to-br ${m.grad} ${m.text} ring-2 ring-white/60 dark:ring-white/10` : 'bg-brand-50 text-brand-800 ring-1 ring-brand-200 dark:bg-brand-500/20 dark:text-brand-100 dark:ring-brand-400/30'}`}
        aria-label={`Rank ${r.rank}${m ? ` (${m.label})` : ''}`}
      >
        {r.rank}
      </span>
      {r.tied && <span className="rounded-full bg-sky-100 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 dark:bg-sky-500/20 dark:text-sky-300" title="Another participant has exactly the same score; they share this rank.">tie</span>}
      {r.brokeTie && <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[11px] font-medium text-violet-700 dark:bg-violet-500/20 dark:text-violet-300" title="Same final score as the row above; the tie-break put this participant lower.">tie-break</span>}
    </span>
  );
}

/** Team name + member names (or "Individual"). */
function WhoCell({ r, light = false }: { r: Row; light?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="break-words font-semibold">{r.name}</span>
        {r.isMine && <span className="rounded-full bg-gold-500/90 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-900">You</span>}
      </div>
      {r.kind === 'team' ? (
        <div className={`mt-0.5 flex items-start gap-1 text-xs ${light ? 'text-white/80' : 'text-slate-500'}`}>
          <Users size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span className="break-words">{r.members.length ? r.members.join(', ') : 'Team'}</span>
        </div>
      ) : (
        <div className={`text-xs ${light ? 'text-white/80' : 'text-slate-500'}`}>Individual{r.entries ? ` · ${r.entries} entr${r.entries === 1 ? 'y' : 'ies'}` : ''}</div>
      )}
    </div>
  );
}

/** "Certificate" download for a row; only rendered when the server returned one (staff: all rows, participants: own row). */
function CertButton({ r, eventTitle, compact = false, onDark = false }: { r: Row; eventTitle: string; compact?: boolean; onDark?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!r.certificate) return null;
  const c = r.certificate;
  const go = async () => {
    setBusy(true);
    try {
      saveBlob(await fetchCertPdf(c.id), certFileName(eventTitle, r.name));
      toast('Certificate downloaded');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-lg font-semibold transition active:scale-[0.97] disabled:opacity-60 ${compact ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-sm'} ${onDark ? 'bg-white/20 text-white hover:bg-white/30' : 'bg-brand-50 text-brand-800 hover:bg-brand-100 dark:bg-brand-500/20 dark:text-brand-100 dark:hover:bg-brand-500/30'}`}
      disabled={busy}
      onClick={go}
      title={`${c.typeLabel}${c.positionLabel ? ` - ${c.positionLabel}` : ''} (${c.id})`}
      aria-label={`Download certificate for ${r.name}`}
    >
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Award size={13} />} Certificate
    </button>
  );
}

/** Premium top-3 podium. Ties share a place (their cards stack in that column); missing places are simply left out. */
function Podium({ rows, eventTitle }: { rows: Row[]; eventTitle: string }) {
  const by = (n: number) => rows.filter((r) => r.rank === n);
  const places = [2, 1, 3].filter((n) => by(n).length);
  if (!places.length) return null;
  const pedestal: Record<number, string> = { 1: 'h-24 sm:h-28', 2: 'h-16 sm:h-20', 3: 'h-12 sm:h-14' };
  const order = (n: number) => (n === 1 ? 'order-1 sm:order-2' : n === 2 ? 'order-2 sm:order-1' : 'order-3');
  return (
    <section aria-label="Top three" className="relative mb-6 overflow-hidden rounded-3xl border border-slate-200/80 bg-gradient-to-b from-brand-50 via-white to-white p-4 shadow-glass dark:border-white/10 dark:from-ink-800 dark:via-ink-900 dark:to-ink-900 sm:p-6">
      <div aria-hidden className="pointer-events-none absolute -top-20 left-1/2 h-48 w-96 -translate-x-1/2 rounded-full bg-amber-300/30 blur-3xl dark:bg-amber-400/10" />
      <h2 className="relative mb-4 flex items-center justify-center gap-2 font-display text-lg font-semibold">
        <Crown size={18} className="text-gold-500" aria-hidden /> Top 3 Winners
      </h2>
      <div className={`relative grid items-end gap-4 ${places.length === 1 ? 'mx-auto max-w-sm' : places.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
        {places.map((n) => {
          const m = MEDAL[n];
          return (
            <div key={n} className={`flex flex-col justify-end gap-3 ${order(n)}`}>
              {by(n).map((r) => (
                <div key={r.key} className={`relative overflow-hidden rounded-2xl bg-gradient-to-br ${m.grad} p-4 shadow-lift ${n === 1 ? 'sm:pb-6' : ''}`}>
                  <div aria-hidden className="pointer-events-none absolute -right-6 -top-6 h-24 w-24 rounded-full bg-white/30 blur-xl" />
                  <div className={`relative flex items-start gap-3 ${m.text}`}>
                    <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/70 font-display text-2xl font-extrabold shadow-inner" aria-label={`Rank ${n}`}>{n}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-bold uppercase tracking-widest opacity-80">{m.label}{r.tied ? ' · tie' : ''}</div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="break-words text-lg font-bold leading-tight">{r.name}</span>
                        {r.isMine && <span className="rounded-full bg-ink-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">You</span>}
                      </div>
                      {r.kind === 'team' ? (
                        <div className="mt-1 flex items-start gap-1 text-xs opacity-85"><Users size={12} className="mt-0.5 shrink-0" aria-hidden /><span className="break-words">{r.members.length ? r.members.join(', ') : 'Team'}</span></div>
                      ) : (
                        <div className="mt-0.5 text-xs opacity-80">Individual</div>
                      )}
                    </div>
                  </div>
                  <div className={`relative mt-3 flex flex-wrap items-end justify-between gap-2 ${m.text}`}>
                    <div>
                      <div className="font-display text-3xl font-extrabold leading-none">{pct(r.final)}</div>
                      <div className="mt-1 text-[11px] opacity-80">judge {pct(r.judgePercent)} · AI {pct(r.aiPercent)}{r.penalty ? ` · −${r.penalty}` : ''}</div>
                    </div>
                    <CertButton r={r} eventTitle={eventTitle} compact />
                  </div>
                </div>
              ))}
              <div aria-hidden className={`hidden rounded-t-xl bg-gradient-to-b ${m.grad} opacity-80 sm:grid sm:place-items-center ${pedestal[n]}`}>
                <span className={`font-display text-4xl font-extrabold opacity-50 ${m.text}`}>{n}</span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ConfigPanel({ b, path }: { b: Board; path: string }) {
  const [published, setPublished] = useState(b.settings.published);
  useEffect(() => setPublished(b.settings.published), [b.settings.published]);
  // the server expects the whole settings object: send the saved scoring values back unchanged, only "published" is edited here
  const save = useAct(() => api.put(`/events/${b.event.id}/leaderboard/config`, { ...b.settings, published }), { ok: 'Leaderboard settings saved', invalidate: [path] });
  return (
    <div className="card mb-4 flex flex-wrap items-center gap-4">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} /> Visible to participants
      </label>
      <button className="btn btn-primary" disabled={save.isPending || published === b.settings.published} onClick={() => save.mutate()}><Save size={16} /> Save settings</button>
    </div>
  );
}

export default function Leaderboard() {
  const [sp, setSp] = useSearchParams();
  const toast = useToast();
  const events = useGet<EventRow[]>('/events');
  const eventId = sp.get('event') ?? '';
  useEffect(() => {
    if (!eventId && events.data?.length) setSp({ event: evId(events.data[0]) }, { replace: true });
  }, [eventId, events.data, setSp]);
  const path = eventId ? `/events/${eventId}/leaderboard` : null;
  const q = useGet<Board>(path);
  const [busy, setBusy] = useState<'csv' | 'pdf' | null>(null);
  const exp = async (ext: 'csv' | 'pdf') => {
    setBusy(ext);
    try {
      await download(`/events/${eventId}/leaderboard.${ext}`, `leaderboard.${ext}`);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div>
      <PageHeader
        title="Leaderboard"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select className="input w-auto max-w-full" value={eventId} onChange={(e) => setSp({ event: e.target.value })} aria-label="Event">
              {(events.data ?? []).map((e) => <option key={evId(e)} value={evId(e)}>{e.title}</option>)}
            </select>
            <button className="btn btn-ghost" disabled={!q.data || busy !== null} onClick={() => exp('csv')}>{busy === 'csv' ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} CSV</button>
            <button className="btn btn-ghost" disabled={!q.data || busy !== null} onClick={() => exp('pdf')}>{busy === 'pdf' ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />} PDF</button>
          </div>
        }
      />
      {events.error ? <ErrorBox error={events.error} /> : null}
      {!eventId && !events.isLoading && !events.error && <EmptyState icon={Medal} title="No events yet" hint="Create an event to see its leaderboard." />}
      <Query q={q}>
        {(b) => {
          const title = b.event.title;
          const anyCert = b.rows.some((r) => r.certificate);
          return (
            <>
              {b.canConfigure && <ConfigPanel b={b} path={path!} />}
              {b.rows.length === 0 ? (
                <EmptyState icon={Medal} title="Nothing to rank yet" hint="Entries appear once they exist; scores appear after judges score them or feedback is generated." />
              ) : (
                <>
                  <Podium rows={b.rows} eventTitle={title} />

                  {/* desktop / tablet: full breakdown table */}
                  <div className="card hidden overflow-x-auto p-0 md:block">
                    <table className="w-full min-w-[860px] text-left text-sm">
                      <caption className="sr-only">Leaderboard for {title} with per-participant score breakdown</caption>
                      <thead className="bg-gradient-to-r from-brand-50 to-gold-300/20 text-xs uppercase tracking-wide text-slate-500 dark:from-brand-500/10 dark:to-gold-500/10">
                        <tr>
                          <th scope="col" className="px-4 py-3">Rank</th>
                          <th scope="col" className="px-4 py-3">Participant</th>
                          <th scope="col" className="px-4 py-3">Judge score</th>
                          <th scope="col" className="px-4 py-3">AI-suggested</th>
                          <th scope="col" className="px-4 py-3">Base</th>
                          <th scope="col" className="px-4 py-3">Plagiarism</th>
                          <th scope="col" className="px-4 py-3 text-right">Final</th>
                          {anyCert && <th scope="col" className="px-4 py-3 text-right">Certificate</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {b.rows.map((r) => {
                          const podium = r.rank !== null && r.rank <= 3;
                          return (
                            <tr key={r.key} className={`align-top transition hover:bg-brand-50/40 dark:hover:bg-white/5 ${r.isMine ? 'bg-gold-300/10' : ''} ${podium ? 'border-l-4 ' + (r.rank === 1 ? 'border-l-amber-400' : r.rank === 2 ? 'border-l-slate-400' : 'border-l-orange-500') : 'border-l-4 border-l-transparent'}`}>
                              <td className="px-4 py-3"><RankBadge r={r} /></td>
                              <td className="max-w-[320px] px-4 py-3"><WhoCell r={r} /></td>
                              <td className="px-4 py-3">
                                <div className="font-semibold text-brand-700">{pct(r.judgePercent)}</div>
                                <div className="text-xs text-slate-500">{r.judgePoints === null ? 'no judge score yet' : `${r.judgePoints} pts (${Math.round(r.judgeShare * 100)}%) · ${r.judgeScores} score${r.judgeScores === 1 ? '' : 's'}`}</div>
                              </td>
                              <td className="px-4 py-3">
                                <div className="font-semibold text-violet-700 dark:text-violet-300">{pct(r.aiPercent)}</div>
                                <div className="text-xs text-slate-500">{r.aiPoints === null ? 'no AI score yet' : `${r.aiPoints} pts (${Math.round(r.aiShare * 100)}%) · ${r.feedbackCount} feedback`}</div>
                              </td>
                              <td className="px-4 py-3">{pct(r.base)}</td>
                              <td className="px-4 py-3">
                                {r.confirmedPairs ? (
                                  <span className="text-red-600 dark:text-red-300"><b>−{r.penalty}</b><span className="block text-xs">{r.confirmedPairs} confirmed pair{r.confirmedPairs === 1 ? '' : 's'}</span></span>
                                ) : (
                                  <span className="text-slate-400">none</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="font-display text-lg font-bold">{pct(r.final)}</div>
                                {r.final !== null && <div className="ml-auto mt-1 h-1.5 w-24 rounded-full bg-slate-100 dark:bg-slate-700"><div className={`h-1.5 rounded-full ${r.rank === 1 ? 'bg-amber-400' : r.rank === 2 ? 'bg-slate-400' : r.rank === 3 ? 'bg-orange-500' : 'bg-brand-500'}`} style={{ width: `${r.final}%` }} /></div>}
                              </td>
                              {anyCert && <td className="px-4 py-3 text-right"><CertButton r={r} eventTitle={title} compact /></td>}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* phones: one card per participant with the same breakdown */}
                  <ul className="grid gap-3 md:hidden" aria-label={`Leaderboard for ${title}`}>
                    {b.rows.map((r) => (
                      <li key={r.key} className={`card ${r.isMine ? 'ring-2 ring-gold-400/60' : ''}`}>
                        <div className="flex items-start gap-3">
                          <RankBadge r={r} />
                          <div className="min-w-0 flex-1"><WhoCell r={r} /></div>
                          <div className="text-right"><div className="font-display text-xl font-bold">{pct(r.final)}</div><div className="text-[11px] text-slate-500">final</div></div>
                        </div>
                        <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                          <div className="rounded-lg bg-brand-50 p-2 dark:bg-brand-500/10"><dt className="text-slate-500">Judge</dt><dd className="font-semibold text-brand-700">{pct(r.judgePercent)}</dd></div>
                          <div className="rounded-lg bg-violet-50 p-2 dark:bg-violet-500/10"><dt className="text-slate-500">AI</dt><dd className="font-semibold text-violet-700 dark:text-violet-300">{pct(r.aiPercent)}</dd></div>
                          <div className="rounded-lg bg-red-50 p-2 dark:bg-red-500/10"><dt className="text-slate-500">Penalty</dt><dd className="font-semibold text-red-600 dark:text-red-300">{r.confirmedPairs ? `−${r.penalty}` : 'none'}</dd></div>
                        </dl>
                        {r.certificate && <div className="mt-3"><CertButton r={r} eventTitle={title} /></div>}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          );
        }}
      </Query>
    </div>
  );
}
