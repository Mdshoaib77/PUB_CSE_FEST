import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Award, Download, FileSpreadsheet, RefreshCw, Search, ShieldX } from 'lucide-react';
import { CERTIFICATE_TYPES, CERTIFICATE_TYPE_LABELS, type CertificateType } from '@festhub/shared';
import { api, download, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAct, useGet } from '../lib/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { EmptyState, PageHeader, Query, useConfirm, useToast } from '../components/ui';
import { CertTemplateEditor } from '../components/CertTemplateEditor';
import { CertificateCard } from '../components/CertificateCard';

interface Cert {
  id: string;
  type: CertificateType;
  typeLabel: string;
  status: 'valid' | 'revoked';
  recipientName: string;
  eventTitle: string;
  eventDate: string;
  positionLabel: string | null;
  issuedAt: string;
  replacedById: string | null;
  verifyUrl: string;
  contestId?: string | null;
  kind?: 'individual' | 'team';
  teamName?: string | null;
  members?: { userId: string; name: string }[];
}
interface ContestRow {
  id: string;
  title: string;
  status: string;
  endAt: string;
  mode?: string;
}
interface EventRow {
  _id: string;
  title: string;
  status: string;
}

const chip = (s: string) => `badge ${s === 'valid' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}`;

function useDownload() {
  const toast = useToast();
  return async (c: Cert) => {
    try {
      await download(`/certificates/${c.id}/download`, `certificate-${c.id}.pdf`);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };
}

function MyCertificates() {
  const q = useGet<Cert[]>('/certificates/mine');
  return (
    <Query q={q}>
      {(rows) =>
        rows.length === 0 ? (
          <EmptyState icon={Award} title="No certificates yet" hint="Certificates appear here after an organizer issues them (events and programming contests)." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {rows.map((c) => (
              <CertificateCard key={c.id} cert={c} />
            ))}
          </div>
        )
      }
    </Query>
  );
}

interface Page {
  items: Cert[];
  total: number;
  page: number;
  pages: number;
}

const PAGE_SIZE = 10;
const CONTEST_TYPES: CertificateType[] = ['participation', 'winner', 'runner_up'];

function Manage() {
  const confirm = useConfirm();
  const { has } = useAuth();
  const canWrite = has('organiser');
  const events = useGet<EventRow[]>('/events');
  const [eventId, setEventId] = useState('');
  const [types, setTypes] = useState<CertificateType[]>([...CERTIFICATE_TYPES]);
  const [attendedOnly, setAttendedOnly] = useState(true);
  const [search, setSearch] = useState('');
  const [qDebounced, setQDebounced] = useState('');
  const [fType, setFType] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => {
      setQDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const qs = new URLSearchParams({ paged: '1', page: String(page), pageSize: String(PAGE_SIZE), ...(qDebounced ? { q: qDebounced } : {}), ...(fType ? { type: fType } : {}), ...(fStatus ? { status: fStatus } : {}) });
  const listKey = eventId ? `/events/${eventId}/certificates?${qs}` : null;
  const list = useGet<Page>(listKey);
  const dl = useDownload();
  const toast = useToast();
  const qc = useQueryClient();
  const refetch = () => void qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith(`/events/${eventId}/certificates`) });
  const gen = useAct(() => api.post<{ created: number; skipped: number }>(`/events/${eventId}/certificates/generate`, { types, attendedOnly }), { invalidate: [], onDone: refetch });
  const revoke = useAct((v: { id: string; reason: string }) => api.post(`/certificates/${v.id}/revoke`, { reason: v.reason }), { ok: 'Certificate revoked', invalidate: [], onDone: refetch });
  const reissue = useAct((id: string) => api.post(`/certificates/${id}/reissue`, {}), { ok: 'Certificate reissued', invalidate: [], onDone: refetch });
  const exportCsv = async () => {
    const p = new URLSearchParams({ ...(qDebounced ? { q: qDebounced } : {}), ...(fType ? { type: fType } : {}), ...(fStatus ? { status: fStatus } : {}) });
    try {
      await download(`/events/${eventId}/certificates/export.csv?${p}`, 'certificates.csv');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };
  const pickEvent = (id: string) => {
    setEventId(id);
    setPage(1);
    setSearch('');
    setFType('');
    setFStatus('');
  };

  return (
    <div className="grid gap-4">
      <div className="card grid gap-3">
        <label className="block">
          <span className="label">Event</span>
          <select className="input" value={eventId} onChange={(e) => pickEvent(e.target.value)}>
            <option value="">Select an event…</option>
            {(events.data ?? [])
              .filter((e) => e.status !== 'draft')
              .map((e) => (
                <option key={e._id} value={e._id}>
                  {e.title}
                </option>
              ))}
          </select>
        </label>
        {canWrite && eventId && (
          <>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <legend className="label">Bulk generate</legend>
              {CERTIFICATE_TYPES.map((t) => (
                <label key={t} className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes((x) => (e.target.checked ? [...x, t] : x.filter((y) => y !== t)))} />
                  {CERTIFICATE_TYPE_LABELS[t]}
                </label>
              ))}
            </fieldset>
            <label className="inline-flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={attendedOnly} onChange={(e) => setAttendedOnly(e.target.checked)} />
              Participation / volunteer: only people who were checked in or marked present
            </label>
            <div>
              <button
                className="btn-primary"
                disabled={!types.length || gen.isPending}
                onClick={async () => {
                  const ok = await confirm({ title: 'Generate certificates?', message: `Issues every missing ${types.map((t) => CERTIFICATE_TYPE_LABELS[t]).join(', ')} certificate for this event. Existing ones are not duplicated.`, confirmText: 'Generate' });
                  if (!ok) return;
                  const r = await gen.mutateAsync().catch(() => null);
                  if (r) toast(`${r.created} issued, ${r.skipped} already existed`, 'ok');
                }}
              >
                <Award size={16} /> {gen.isPending ? 'Generating…' : 'Generate certificates'}
              </button>
            </div>
          </>
        )}
      </div>

      {eventId && <CertTemplateEditor eventId={eventId} canWrite={canWrite} />}

      {eventId && (
        <>
          <div className="card flex flex-wrap items-end gap-3">
            <label className="min-w-[12rem] flex-1">
              <span className="label">Search</span>
              <span className="relative block">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input className="input pl-9" placeholder="Name or certificate ID" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search certificates" />
              </span>
            </label>
            <label>
              <span className="label">Type</span>
              <select className="input" value={fType} onChange={(e) => { setFType(e.target.value); setPage(1); }} aria-label="Filter by type">
                <option value="">All types</option>
                {CERTIFICATE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CERTIFICATE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">Status</span>
              <select className="input" value={fStatus} onChange={(e) => { setFStatus(e.target.value); setPage(1); }} aria-label="Filter by status">
                <option value="">All</option>
                <option value="valid">Valid</option>
                <option value="revoked">Revoked</option>
              </select>
            </label>
            <button className="btn-ghost" onClick={exportCsv}>
              <FileSpreadsheet size={16} /> Export CSV
            </button>
          </div>
          <Query q={list}>
            {(d) =>
              d.items.length === 0 ? (
                <EmptyState icon={Award} title={qDebounced || fType || fStatus ? 'No certificates match these filters' : 'No certificates for this event yet'} />
              ) : (
                <div className="card overflow-x-auto p-0">
                  <table className="w-full min-w-[640px] text-left">
                    <thead>
                      <tr>
                        <th className="th">Recipient</th>
                        <th className="th">Type</th>
                        <th className="th">ID</th>
                        <th className="th">Status</th>
                        <th className="th" />
                      </tr>
                    </thead>
                    <tbody>
                      {d.items.map((c) => (
                        <tr key={c.id} className="border-t border-slate-100">
                          <td className="td">{c.recipientName}</td>
                          <td className="td">
                            {c.typeLabel}
                            {c.positionLabel ? ` (${c.positionLabel.split(' - ')[0]})` : ''}
                          </td>
                          <td className="td font-mono text-xs">{c.id}</td>
                          <td className="td">
                            <span className={chip(c.status)}>{c.status}</span>
                          </td>
                          <td className="td">
                            <div className="flex justify-end gap-1">
                              <button className="icon-btn" title="Download PDF" aria-label="Download PDF" onClick={() => dl(c)}>
                                <Download size={16} />
                              </button>
                              {canWrite && c.status === 'valid' && (
                                <button
                                  className="icon-btn-danger"
                                  title="Revoke"
                                  aria-label="Revoke"
                                  onClick={async () => {
                                    if (!(await confirm({ title: 'Revoke this certificate?', message: `${c.recipientName} will see it as revoked and verification will fail.`, confirmText: 'Revoke', tone: 'danger' }))) return;
                                    const reason = window.prompt('Reason (optional, shown to the recipient):', '') ?? '';
                                    revoke.mutate({ id: c.id, reason: reason.slice(0, 300) });
                                  }}
                                >
                                  <ShieldX size={16} />
                                </button>
                              )}
                              {canWrite && !c.replacedById && (
                                <button
                                  className="icon-btn"
                                  title="Reissue (new ID)"
                                  aria-label="Reissue"
                                  onClick={async () => {
                                    if (await confirm({ title: 'Reissue this certificate?', message: 'A new ID is created; the old one stops being valid.', confirmText: 'Reissue' })) reissue.mutate(c.id);
                                  }}
                                >
                                  <RefreshCw size={16} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-sm">
                    <span className="text-slate-500">
                      {d.total} certificate{d.total === 1 ? '' : 's'} · page {d.page} of {d.pages}
                    </span>
                    <span className="flex gap-2">
                      <button className="btn-ghost btn-sm" disabled={d.page <= 1} onClick={() => setPage(d.page - 1)}>
                        Previous
                      </button>
                      <button className="btn-ghost btn-sm" disabled={d.page >= d.pages} onClick={() => setPage(d.page + 1)}>
                        Next
                      </button>
                    </span>
                  </div>
                </div>
              )
            }
          </Query>
        </>
      )}
    </div>
  );
}

/** Programming-contest certificates (v4 backend): same table / actions as the event list, scoped to one contest. */
function ContestManage({ initialId }: { initialId: string }) {
  const confirm = useConfirm();
  const { has } = useAuth();
  const canWrite = has('organiser');
  const contests = useGet<ContestRow[]>('/contests');
  const [contestId, setContestId] = useState(initialId);
  const [types, setTypes] = useState<CertificateType[]>([...CONTEST_TYPES]);
  const [signature, setSignature] = useState('');
  const [search, setSearch] = useState('');
  const [qDebounced, setQDebounced] = useState('');
  const [fType, setFType] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => {
      setQDebounced(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const filters = { ...(qDebounced ? { q: qDebounced } : {}), ...(fType ? { type: fType } : {}), ...(fStatus ? { status: fStatus } : {}) };
  const qs = new URLSearchParams({ paged: '1', page: String(page), pageSize: String(PAGE_SIZE), ...filters });
  const list = useGet<Page>(contestId ? `/contests/${contestId}/certificates?${qs}` : null);
  const dl = useDownload();
  const toast = useToast();
  const qc = useQueryClient();
  const refetch = () => void qc.invalidateQueries({ predicate: (x) => String(x.queryKey[0]).startsWith(`/contests/${contestId}/certificates`) });
  const contest = (contests.data ?? []).find((c) => c.id === contestId);
  const finished = !!contest && (contest.status === 'ended' || new Date(contest.endAt).getTime() <= Date.now());
  const gen = useAct(() => api.post<{ created: number; skipped: number }>(`/contests/${contestId}/certificates/generate`, { types, ...(signature.trim() ? { signatureText: signature.trim() } : {}) }), { invalidate: [], onDone: refetch });
  const revoke = useAct((v: { id: string; reason: string }) => api.post(`/certificates/${v.id}/revoke`, { reason: v.reason }), { ok: 'Certificate revoked', invalidate: [], onDone: refetch });
  const reissue = useAct((id: string) => api.post(`/certificates/${id}/reissue`, {}), { ok: 'Certificate reissued', invalidate: [], onDone: refetch });
  const exportCsv = async () => {
    try {
      await download(`/contests/${contestId}/certificates/export.csv?${new URLSearchParams(filters)}`, 'contest-certificates.csv');
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };
  const pickContest = (id: string) => {
    setContestId(id);
    setPage(1);
    setSearch('');
    setFType('');
    setFStatus('');
  };

  return (
    <div className="grid gap-4">
      <div className="card grid gap-3">
        <label className="block">
          <span className="label">Programming contest</span>
          <select className="input" value={contestId} onChange={(e) => pickContest(e.target.value)} disabled={contests.isLoading}>
            <option value="">{contests.isLoading ? 'Loading contests…' : 'Select a contest…'}</option>
            {(contests.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
                {c.status === 'ended' ? ' (ended)' : ''}
              </option>
            ))}
          </select>
        </label>
        {contests.isError && <p className="text-sm text-red-600" role="alert">Could not load contests: {errMsg(contests.error)}</p>}
        {!contests.isLoading && !contests.isError && (contests.data ?? []).length === 0 && <p className="text-sm text-slate-500">There are no programming contests yet.</p>}
        <p className="text-xs text-slate-500">Contest certificates have no event, so they use the default certificate template.</p>
        {canWrite && contestId && (
          <>
            <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <legend className="label">Generate</legend>
              {CONTEST_TYPES.map((t) => (
                <label key={t} className="inline-flex items-center gap-1.5">
                  <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes((x) => (e.target.checked ? [...x, t] : x.filter((y) => y !== t)))} />
                  {CERTIFICATE_TYPE_LABELS[t]}
                </label>
              ))}
            </fieldset>
            <label className="block">
              <span className="label">Signature text (optional)</span>
              <input className="input" maxLength={120} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="e.g. Head of Department" />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <button
                className="btn-primary"
                disabled={!finished || !types.length || gen.isPending || !contest}
                onClick={async () => {
                  const ok = await confirm({ title: 'Generate certificates?', message: `Issues every missing ${types.map((t) => CERTIFICATE_TYPE_LABELS[t]).join(', ')} certificate for this contest. Existing ones are not duplicated.`, confirmText: 'Generate' });
                  if (!ok) return;
                  const r = await gen.mutateAsync().catch(() => null);
                  if (r) toast(`${r.created} created, ${r.skipped} skipped (already existed)`, 'ok');
                }}
              >
                <Award size={16} /> {gen.isPending ? 'Generating…' : 'Generate certificates'}
              </button>
              {contest && !finished && <span className="text-xs text-slate-500">Available once the contest has finished.</span>}
            </div>
          </>
        )}
      </div>

      {contestId && (
        <>
          <div className="card flex flex-wrap items-end gap-3">
            <label className="min-w-[12rem] flex-1">
              <span className="label">Search</span>
              <span className="relative block">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input className="input pl-9" placeholder="Name, team or certificate ID" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search contest certificates" />
              </span>
            </label>
            <label>
              <span className="label">Type</span>
              <select className="input" value={fType} onChange={(e) => { setFType(e.target.value); setPage(1); }} aria-label="Filter by type">
                <option value="">All types</option>
                {CONTEST_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {CERTIFICATE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="label">Status</span>
              <select className="input" value={fStatus} onChange={(e) => { setFStatus(e.target.value); setPage(1); }} aria-label="Filter by status">
                <option value="">All</option>
                <option value="valid">Valid</option>
                <option value="revoked">Revoked</option>
              </select>
            </label>
            <button className="btn-ghost" onClick={exportCsv}>
              <FileSpreadsheet size={16} /> Export CSV
            </button>
          </div>
          <Query q={list}>
            {(d) =>
              d.items.length === 0 ? (
                <EmptyState icon={Award} title={qDebounced || fType || fStatus ? 'No certificates match these filters' : 'No certificates for this contest yet'} hint={!qDebounced && !fType && !fStatus && canWrite ? (finished ? 'Use “Generate certificates” above.' : 'You can generate them once the contest has finished.') : undefined} />
              ) : (
                <div className="card overflow-x-auto p-0">
                  <table className="w-full min-w-[820px] text-left">
                    <thead>
                      <tr>
                        <th className="th">Recipient / team</th>
                        <th className="th">Members</th>
                        <th className="th">Type</th>
                        <th className="th">Position</th>
                        <th className="th">ID</th>
                        <th className="th">Status</th>
                        <th className="th" />
                      </tr>
                    </thead>
                    <tbody>
                      {d.items.map((c) => (
                        <tr key={c.id} className="border-t border-slate-100">
                          <td className="td font-medium">{c.kind === 'team' ? (c.teamName ?? c.recipientName) : c.recipientName}</td>
                          <td className="td text-sm text-slate-600">{c.kind === 'team' && c.members?.length ? c.members.map((m) => m.name).join(', ') : '—'}</td>
                          <td className="td">{c.typeLabel}</td>
                          <td className="td">{c.positionLabel ? c.positionLabel.split(' - ')[0] : '—'}</td>
                          <td className="td font-mono text-xs">{c.id}</td>
                          <td className="td">
                            <span className={chip(c.status)}>{c.status}</span>
                          </td>
                          <td className="td">
                            <div className="flex justify-end gap-1">
                              <button className="icon-btn" title="Download PDF" aria-label="Download PDF" onClick={() => dl(c)}>
                                <Download size={16} />
                              </button>
                              {canWrite && c.status === 'valid' && (
                                <button
                                  className="icon-btn-danger"
                                  title="Revoke"
                                  aria-label="Revoke"
                                  onClick={async () => {
                                    if (!(await confirm({ title: 'Revoke this certificate?', message: `${c.recipientName} will see it as revoked and verification will fail.`, confirmText: 'Revoke', tone: 'danger' }))) return;
                                    const reason = window.prompt('Reason (optional, shown to the recipient):', '') ?? '';
                                    revoke.mutate({ id: c.id, reason: reason.slice(0, 300) });
                                  }}
                                >
                                  <ShieldX size={16} />
                                </button>
                              )}
                              {canWrite && !c.replacedById && (
                                <button
                                  className="icon-btn"
                                  title="Reissue (new ID)"
                                  aria-label="Reissue"
                                  onClick={async () => {
                                    if (await confirm({ title: 'Reissue this certificate?', message: 'A new ID is created; the old one stops being valid.', confirmText: 'Reissue' })) reissue.mutate(c.id);
                                  }}
                                >
                                  <RefreshCw size={16} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 text-sm">
                    <span className="text-slate-500">
                      {d.total} certificate{d.total === 1 ? '' : 's'} · page {d.page} of {d.pages}
                    </span>
                    <span className="flex gap-2">
                      <button className="btn-ghost btn-sm" disabled={d.page <= 1} onClick={() => setPage(d.page - 1)}>
                        Previous
                      </button>
                      <button className="btn-ghost btn-sm" disabled={d.page >= d.pages} onClick={() => setPage(d.page + 1)}>
                        Next
                      </button>
                    </span>
                  </div>
                </div>
              )
            }
          </Query>
        </>
      )}
    </div>
  );
}

export default function Certificates() {
  const { has } = useAuth();
  const staff = has('organiser', 'coordinator');
  const [sp, setSp] = useSearchParams();
  const contestParam = sp.get('contest') ?? '';
  const [mode, setMode] = useState<'event' | 'contest'>(contestParam ? 'contest' : 'event');
  const switchMode = (m: 'event' | 'contest') => {
    setMode(m);
    if (m === 'event' && contestParam) setSp({}, { replace: true });
  };
  const showContest = staff && mode === 'contest';
  return (
    <>
      <PageHeader title="Certificates" sub="Download your certificates and verify any certificate by its ID" />
      {staff && (
        <div role="tablist" aria-label="Certificate type" className="mb-4 inline-flex rounded-xl border border-slate-200 bg-slate-100 p-1 text-sm font-medium dark:border-white/10 dark:bg-white/5">
          {(['event', 'contest'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => switchMode(m)}
              className={`rounded-lg px-4 py-1.5 transition ${mode === m ? 'bg-white text-brand-700 shadow-sm dark:bg-white/15 dark:text-white' : 'text-slate-600 hover:text-slate-900 dark:text-slate-300'}`}
            >
              {m === 'event' ? 'Event' : 'Programming contest'}
            </button>
          ))}
        </div>
      )}
      <h2 className="mb-2 text-lg font-semibold">My certificates</h2>
      <MyCertificates />
      {staff && (
        <>
          <h2 className="mb-2 mt-8 text-lg font-semibold">{showContest ? 'Manage contest certificates' : 'Manage event certificates'}</h2>
          {showContest ? <ContestManage initialId={contestParam} /> : <Manage />}
        </>
      )}
    </>
  );
}
