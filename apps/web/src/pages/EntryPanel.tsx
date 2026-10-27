import { useState } from 'react';
import { api } from '../lib/api';
import { Trash2 } from 'lucide-react';
import { fmt, useAct, useDelete, useGet } from '../lib/hooks';
import { Badge } from '../components/ui';

interface Entry {
  _id: string;
  title: string;
  currentVersion: number;
  ownerName?: string;
}
interface Ver {
  _id: string;
  version: number;
  content: string;
  link?: string;
  submittedAt: string;
}
interface Res {
  status: string;
  rankings: { rank: number; title: string; ownerName: string | null; percent: number }[];
}

/** Competition entries: every save creates a new immutable version. */
export default function EntryPanel({ activityId, deadline, canSubmit }: { activityId: string; deadline?: string; canSubmit: boolean }) {
  const entries = useGet<Entry[]>(`/activities/${activityId}/entries`);
  const results = useGet<Res>(`/activities/${activityId}/results`);
  const mine = entries.data?.[0];
  const versions = useGet<Ver[]>(mine ? `/entries/${mine._id}/versions` : null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [link, setLink] = useState('');
  const keys = [`/activities/${activityId}/entries`, mine ? `/entries/${mine._id}/versions` : null];
  const create = useAct(() => api.post(`/activities/${activityId}/entries`, { title, content, link: link || undefined }), {
    ok: 'Entry submitted (version 1)',
    invalidate: keys,
    onDone: () => setContent(''),
  });
  const update = useAct(() => api.put(`/entries/${mine!._id}`, { content, link: link || undefined }), {
    ok: 'New version saved',
    invalidate: keys,
    onDone: () => setContent(''),
  });
  const del = useDelete({ noun: 'entry', request: (id) => api.del(`/entries/${id}`), invalidate: [`/activities/${activityId}/entries`, '/entries/'] });
  const closed = deadline && new Date() > new Date(deadline);
  return (
    <div className="mt-2 rounded-lg bg-slate-50 p-3 text-sm">
      {entries.error != null && <div className="mb-2 rounded border border-red-200 bg-red-50 p-2 text-red-800" role="alert">{entries.error instanceof Error ? entries.error.message : 'Could not load your entry.'}</div>}
      {entries.isLoading && <div className="mb-2 text-slate-500">Loading…</div>}
      <div className="mb-1 font-medium">My entry {deadline && <span className="font-normal text-slate-500">· deadline {fmt(deadline)}</span>}</div>
      {results.data?.status === 'official' && (
        <div className="mb-2 rounded border border-green-200 bg-green-50 p-2">
          <b>Official results</b>
          <ol className="ml-4 list-decimal">
            {results.data.rankings.map((r, i) => (
              <li key={i}>
                #{r.rank} {r.ownerName ? `${r.ownerName} · ` : ''}{r.title} — {r.percent}%
              </li>
            ))}
          </ol>
        </div>
      )}
      {mine && (
        <div className="mb-2">
          <div className="flex items-center gap-2">
            <b>{mine.title}</b> <Badge value={`v${mine.currentVersion}`} />
            {!closed && results.data?.status !== 'official' && (
              <button className="btn-danger-ghost btn-sm ml-auto" onClick={() => del({ id: mine._id, name: mine.title, warning: 'All saved versions are deleted too.' })}>
                <Trash2 size={13} /> Delete entry
              </button>
            )}
          </div>
          <ul className="mt-1 space-y-1">
            {versions.data?.map((v) => (
              <li key={v._id} className="rounded border bg-white p-2">
                <span className="text-xs text-slate-500">
                  v{v.version} · {fmt(v.submittedAt)}
                </span>
                <p className="line-clamp-3 whitespace-pre-wrap">{v.content}</p>
                {v.link && (
                  <a className="text-brand-700 underline" href={v.link} target="_blank" rel="noreferrer">
                    {v.link}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!canSubmit ? (
        <p className="text-slate-500">You need a confirmed registration to submit an entry.</p>
      ) : closed ? (
        <p className="text-slate-500">Submissions are closed.</p>
      ) : (
        <div className="space-y-2">
          {!mine && <input className="input" placeholder="Entry title" value={title} onChange={(e) => setTitle(e.target.value)} />}
          <textarea
            className="input"
            rows={3}
            placeholder={mine ? 'Write the new version…' : 'Describe your entry…'}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <input className="input" placeholder="Link (optional)" value={link} onChange={(e) => setLink(e.target.value)} />
          <button
            className="btn-primary"
            disabled={create.isPending || update.isPending || (!mine && title.length < 2)}
            onClick={() => (mine ? update.mutate() : create.mutate())}
          >
            {mine ? 'Save as new version' : 'Submit entry'}
          </button>
        </div>
      )}
    </div>
  );
}
