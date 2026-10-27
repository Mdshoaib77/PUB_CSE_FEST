import { useState } from 'react';
import { ChevronLeft, ChevronRight, Download, RotateCcw } from 'lucide-react';
import { download, errMsg } from '../lib/api';
import { useGet } from '../lib/hooks';
import { Empty, PageHeader, Query, useToast } from '../components/ui';

interface Row {
  id: string;
  at: string;
  action: string;
  entityType?: string;
  entityId?: string;
  ip?: string;
  meta?: unknown;
  actor: { id: string; name: string; email: string | null } | null;
}
interface Page {
  items: Row[];
  page: number;
  limit: number;
  total: number;
  pages: number;
}
interface Facets {
  actions: string[];
  entityTypes: string[];
}
const EMPTY = { q: '', action: '', entityType: '', from: '', to: '', sort: 'desc' };

export default function AdminAudit() {
  const toast = useToast();
  const [f, setF] = useState(EMPTY);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [busy, setBusy] = useState(false);

  const filters = new URLSearchParams();
  (Object.entries(f) as [string, string][]).forEach(([k, v]) => v && filters.set(k, v));
  const list = useGet<Page>(`/admin/audit?${filters}&page=${page}&limit=${limit}`);
  const facets = useGet<Facets>('/admin/audit/facets');
  const set = (k: keyof typeof EMPTY, v: string) => {
    setF((p) => ({ ...p, [k]: v }));
    setPage(1);
  };

  async function exportCsv() {
    setBusy(true);
    try {
      await download(`/admin/audit/export.csv?${filters}`, 'audit-log.csv');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        sub="Who did what, and when. Newest first. Passwords and tokens are never recorded."
        actions={
          <button className="btn btn-ghost" onClick={exportCsv} disabled={busy}>
            <Download size={16} /> {busy ? 'Exporting…' : 'Export CSV'}
          </button>
        }
      />
      <div className="card mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <input
          className="input lg:col-span-2"
          placeholder="Search action, entity or person"
          aria-label="Search audit log"
          maxLength={100}
          value={f.q}
          onChange={(e) => set('q', e.target.value)}
        />
        <select className="input" aria-label="Action" value={f.action} onChange={(e) => set('action', e.target.value)}>
          <option value="">All actions</option>
          {facets.data?.actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select className="input" aria-label="Entity type" value={f.entityType} onChange={(e) => set('entityType', e.target.value)}>
          <option value="">All entities</option>
          {facets.data?.entityTypes.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input className="input" type="date" aria-label="From date" value={f.from} max={f.to || undefined} onChange={(e) => set('from', e.target.value)} />
        <input className="input" type="date" aria-label="To date" value={f.to} min={f.from || undefined} onChange={(e) => set('to', e.target.value)} />
        <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-6">
          <select className="input max-w-[11rem]" aria-label="Sort order" value={f.sort} onChange={(e) => set('sort', e.target.value)}>
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
          <select
            className="input max-w-[8rem]"
            aria-label="Rows per page"
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setPage(1);
            }}
          >
            {[10, 25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setF(EMPTY);
              setPage(1);
            }}
          >
            <RotateCcw size={14} /> Reset
          </button>
        </div>
      </div>

      <Query q={list}>
        {(d) =>
          d.items.length === 0 ? (
            <Empty>No audit entries match these filters.</Empty>
          ) : (
            <>
              <div className="card overflow-x-auto p-0">
                <table className="min-w-full divide-y">
                  <thead>
                    <tr>
                      <th className="th">Time</th>
                      <th className="th">Actor</th>
                      <th className="th">Action</th>
                      <th className="th">Entity</th>
                      <th className="th">Details</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {d.items.map((x) => (
                      <tr key={x.id} className="align-top">
                        <td className="td whitespace-nowrap text-xs">{new Date(x.at).toLocaleString()}</td>
                        <td className="td">
                          {x.actor ? x.actor.name : <span className="text-slate-400">system / anonymous</span>}
                          {x.actor?.email && <div className="text-xs text-slate-500">{x.actor.email}</div>}
                        </td>
                        <td className="td">
                          <span className="badge bg-brand-50 text-brand-700">{x.action}</span>
                        </td>
                        <td className="td text-xs">
                          {x.entityType ?? '—'}
                          {x.entityId && (
                            <div className="max-w-[10rem] truncate text-slate-500" title={x.entityId}>
                              {x.entityId}
                            </div>
                          )}
                        </td>
                        <td className="td text-xs">
                          {x.meta ? (
                            <details>
                              <summary className="cursor-pointer text-brand-600">View</summary>
                              <pre className="mt-1 max-w-md overflow-x-auto whitespace-pre-wrap break-words text-[11px]">{JSON.stringify(x.meta, null, 2)}</pre>
                            </details>
                          ) : (
                            '—'
                          )}
                          {x.ip && <div className="text-slate-400">{x.ip}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <nav className="mt-3 flex items-center justify-between text-sm" aria-label="Pagination">
                <span className="text-slate-500">
                  {(d.page - 1) * d.limit + 1}–{Math.min(d.page * d.limit, d.total)} of {d.total}
                </span>
                <div className="flex items-center gap-2">
                  <button className="btn btn-ghost btn-sm" disabled={d.page <= 1} onClick={() => setPage(d.page - 1)} aria-label="Previous page">
                    <ChevronLeft size={16} />
                  </button>
                  <span>
                    Page {d.page} / {d.pages}
                  </span>
                  <button className="btn btn-ghost btn-sm" disabled={d.page >= d.pages} onClick={() => setPage(d.page + 1)} aria-label="Next page">
                    <ChevronRight size={16} />
                  </button>
                </div>
              </nav>
            </>
          )
        }
      </Query>
    </>
  );
}
