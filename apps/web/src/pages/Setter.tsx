import { useState } from 'react';
import { DIFFICULTIES, LANGUAGES, LANGUAGE_LABELS } from '@festhub/shared';
import { api } from '../lib/api';
import { Trash2 } from 'lucide-react';
import { useAct, useDelete, useGet } from '../lib/hooks';
import { Badge, Card, Empty, Field, PageHeader, Query, TrashButton } from '../components/ui';

interface P {
  id: string;
  title: string;
  tags: string[];
  difficulty: string;
  visibility: string;
  testCaseCount?: number;
}
interface Detail {
  id: string;
  title: string;
  statement: string;
  constraints?: string;
  inputDesc?: string;
  outputDesc?: string;
  samples: { input: string; output: string }[];
  tags: string[];
  difficulty: string;
  timeLimitMs: number;
  memoryLimitKb: number;
  languages: string[];
  visibility: string;
}
const blank = {
  title: '',
  statement: '',
  constraints: '',
  inputDesc: '',
  outputDesc: '',
  sampleIn: '',
  sampleOut: '',
  tags: '',
  difficulty: 'easy',
  timeLimitMs: 2000,
  memoryLimitKb: 262144,
  visibility: 'private',
  languages: [...LANGUAGES] as string[],
};

export default function Setter() {
  const list = useGet<P[]>('/problems?manage=1');
  const [editing, setEditing] = useState<string | null>(null);
  const del = useDelete({
    noun: 'problem',
    request: (id) => api.del(`/problems/${id}`),
    prune: ['/problems'],
    onDeleted: (id) => setEditing((e) => (e === id ? null : e)),
  });
  return (
    <>
      <PageHeader
        title="Problem setting"
        sub="Hidden test cases are visible only to the author and organisers."
        actions={
          <button className="btn-primary" onClick={() => setEditing('new')}>
            New problem
          </button>
        }
      />
      {editing && <Editor key={editing} id={editing} onClose={() => setEditing(null)} />}
      <Query q={list}>
        {(l) =>
          l.length === 0 ? (
            <Empty>You have not created any problems yet.</Empty>
          ) : (
            <div className="card overflow-x-auto p-0">
              <table className="min-w-full divide-y">
                <thead>
                  <tr>
                    <th className="th">Title</th>
                    <th className="th">Difficulty</th>
                    <th className="th">Visibility</th>
                    <th className="th">Tests</th>
                    <th className="th" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {l.map((p) => (
                    <tr key={p.id}>
                      <td className="td">
                        {p.title}
                        <div className="text-xs text-slate-500">{p.tags.join(', ')}</div>
                      </td>
                      <td className="td">
                        <Badge value={p.difficulty} />
                      </td>
                      <td className="td">
                        <Badge value={p.visibility === 'public' ? 'published' : 'draft'} />
                      </td>
                      <td className="td">{p.testCaseCount}</td>
                      <td className="td">
                        <div className="flex items-center gap-1">
                          <button className="btn-ghost" onClick={() => setEditing(p.id)}>
                            Edit
                          </button>
                          <TrashButton label={`Delete problem ${p.title}`} onClick={() => del({ id: p.id, name: p.title, warning: 'Its hidden test cases, editorial and every practice submission are deleted too. A problem used in a contest can’t be deleted until that contest is.' })} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Query>
    </>
  );
}

function Editor({ id, onClose }: { id: string; onClose: () => void }) {
  const isNew = id === 'new';
  const existing = useGet<Detail>(isNew ? null : `/problems/${id}`);
  const cases = useGet<{ input: string; expectedOutput: string }[]>(isNew ? null : `/problems/${id}/testcases`);
  const ed = useGet<{ content: string; releaseAt?: string }>(isNew ? null : `/problems/${id}/editorial`);
  if (!isNew && (existing.isLoading || cases.isLoading)) return <Card>Loading…</Card>;
  return <EditorForm id={id} existing={existing.data} cases={cases.data} editorial={ed.data} onClose={onClose} />;
}

function EditorForm({
  id,
  existing,
  cases,
  editorial,
  onClose,
}: {
  id: string;
  existing?: Detail;
  cases?: { input: string; expectedOutput: string }[];
  editorial?: { content: string; releaseAt?: string };
  onClose: () => void;
}) {
  const isNew = id === 'new';
  const [f, setF] = useState(
    existing
      ? { ...blank, ...existing, tags: existing.tags.join(', '), sampleIn: existing.samples[0]?.input ?? '', sampleOut: existing.samples[0]?.output ?? '' }
      : blank,
  );
  const [tests, setTests] = useState(cases?.length ? cases : [{ input: '', expectedOutput: '' }]);
  const [edText, setEdText] = useState(editorial?.content ?? '');
  const [release, setRelease] = useState('');
  const body = () => ({
    title: f.title,
    statement: f.statement,
    constraints: f.constraints,
    inputDesc: f.inputDesc,
    outputDesc: f.outputDesc,
    samples: f.sampleIn ? [{ input: f.sampleIn, output: f.sampleOut }] : [],
    tags: f.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    difficulty: f.difficulty,
    timeLimitMs: Number(f.timeLimitMs),
    memoryLimitKb: Number(f.memoryLimitKb),
    visibility: f.visibility,
    languages: f.languages,
  });
  const saveP = useAct(() => (isNew ? api.post<{ id: string }>('/problems', body()) : api.patch<{ id: string }>(`/problems/${id}`, body())), {
    ok: 'Problem saved',
    invalidate: ['/problems?manage=1'],
    onDone: (r) => {
      if (isNew) onClose();
      void r;
    },
  });
  const saveT = useAct(() => api.put(`/problems/${id}/testcases`, { cases: tests.filter((t) => t.input || t.expectedOutput) }), {
    ok: 'Test cases saved (hidden from participants)',
    invalidate: ['/problems?manage=1'],
  });
  const saveE = useAct(() => api.put(`/problems/${id}/editorial`, { content: edText, releaseAt: release ? new Date(release).toISOString() : undefined }), {
    ok: 'Editorial saved — released only after the contest ends',
  });
  const delEd = useDelete({
    noun: 'editorial',
    request: (pid) => api.del(`/problems/${pid}/editorial`),
    invalidate: [`/problems/${id}/editorial`],
    onDeleted: () => {
      setEdText('');
      setRelease('');
    },
  });
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  return (
    <Card className="mb-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">{isNew ? 'New problem' : 'Edit problem'}</h2>
        <button className="btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <Field label="Title">
            <input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} />
          </Field>
        </div>
        <div className="md:col-span-2">
          <Field label="Statement">
            <textarea className="input" rows={4} value={f.statement} onChange={(e) => set({ statement: e.target.value })} />
          </Field>
        </div>
        <Field label="Constraints">
          <textarea className="input" rows={2} value={f.constraints} onChange={(e) => set({ constraints: e.target.value })} />
        </Field>
        <Field label="Input / output description">
          <textarea className="input" rows={2} placeholder="Input…" value={f.inputDesc} onChange={(e) => set({ inputDesc: e.target.value })} />
        </Field>
        <Field label="Sample input">
          <textarea className="input font-mono text-xs" rows={2} value={f.sampleIn} onChange={(e) => set({ sampleIn: e.target.value })} />
        </Field>
        <Field label="Sample output">
          <textarea className="input font-mono text-xs" rows={2} value={f.sampleOut} onChange={(e) => set({ sampleOut: e.target.value })} />
        </Field>
        <Field label="Topic tags (comma separated)">
          <input className="input" value={f.tags} onChange={(e) => set({ tags: e.target.value })} />
        </Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Difficulty">
            <select className="input" value={f.difficulty} onChange={(e) => set({ difficulty: e.target.value })}>
              {DIFFICULTIES.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </Field>
          <Field label="Time (ms)">
            <input className="input" type="number" value={f.timeLimitMs} onChange={(e) => set({ timeLimitMs: Number(e.target.value) })} />
          </Field>
          <Field label="Memory (KB)">
            <input className="input" type="number" value={f.memoryLimitKb} onChange={(e) => set({ memoryLimitKb: Number(e.target.value) })} />
          </Field>
        </div>
        <Field label="Languages">
          <div className="flex flex-wrap gap-3 text-sm">
            {LANGUAGES.map((l) => (
              <label key={l} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={f.languages.includes(l)}
                  onChange={(e) => set({ languages: e.target.checked ? [...f.languages, l] : f.languages.filter((x) => x !== l) })}
                />
                {LANGUAGE_LABELS[l]}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Visibility">
          <select className="input" value={f.visibility} onChange={(e) => set({ visibility: e.target.value })}>
            <option value="private">Private (contest use only)</option>
            <option value="public">Public (practice after contests end)</option>
          </select>
        </Field>
      </div>
      <button className="btn-primary mt-3" disabled={f.title.length < 3 || f.statement.length < 10 || saveP.isPending} onClick={() => saveP.mutate()}>
        {isNew ? 'Create problem' : 'Save problem'}
      </button>
      {!isNew && (
        <>
          <hr className="my-4" />
          <h3 className="font-semibold">Hidden test cases</h3>
          <p className="mb-2 text-xs text-slate-500">Never shown to participants. Order matters: judging stops at the first failing case.</p>
          {tests.map((t, i) => (
            <div key={i} className="mb-2 grid gap-2 md:grid-cols-[1fr_1fr_auto]">
              <textarea
                className="input font-mono text-xs"
                rows={2}
                placeholder={`Input #${i + 1}`}
                value={t.input}
                onChange={(e) => setTests(tests.map((x, k) => (k === i ? { ...x, input: e.target.value } : x)))}
              />
              <textarea
                className="input font-mono text-xs"
                rows={2}
                placeholder="Expected output"
                value={t.expectedOutput}
                onChange={(e) => setTests(tests.map((x, k) => (k === i ? { ...x, expectedOutput: e.target.value } : x)))}
              />
              <button className="btn-ghost" aria-label={`Remove test case ${i + 1}`} title="Remove (applies when you save)" onClick={() => setTests(tests.filter((_, k) => k !== i))}>
                ✕
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => setTests([...tests, { input: '', expectedOutput: '' }])}>
              Add case
            </button>
            <button className="btn-primary" onClick={() => saveT.mutate()}>
              Save test cases
            </button>
          </div>
          <hr className="my-4" />
          <h3 className="font-semibold">Editorial</h3>
          <textarea className="input" rows={4} value={edText} onChange={(e) => setEdText(e.target.value)} placeholder="Explain the intended solution…" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="text-sm">
              Extra release time (optional){' '}
              <input className="input inline-block w-auto" type="datetime-local" value={release} onChange={(e) => setRelease(e.target.value)} />
            </label>
            <button className="btn-primary" disabled={edText.length < 10} onClick={() => saveE.mutate()}>
              Save editorial
            </button>
            {editorial?.content && (
              <button className="btn-danger-ghost" onClick={() => delEd({ id, name: `Editorial for ${f.title}` })}>
                <Trash2 size={14} /> Delete editorial
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
