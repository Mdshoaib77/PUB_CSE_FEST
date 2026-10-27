import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DIFFICULTIES, LANGUAGES, LANGUAGE_LABELS, type Language } from '@festhub/shared';
import { api, errMsg } from '../lib/api';
import { fmt, useAct, useDelete, useGet } from '../lib/hooks';
import { Badge, Card, Empty, PageHeader, Query, TrashButton } from '../components/ui';

export interface ProblemView {
  id: string;
  title: string;
  statement: string;
  constraints?: string;
  inputDesc?: string;
  outputDesc?: string;
  samples: { input: string; output: string; explanation?: string }[];
  tags: string[];
  difficulty: string;
  timeLimitMs: number;
  memoryLimitKb: number;
  languages: string[];
}
export function ProblemView({ p }: { p: ProblemView }) {
  return (
    <Card>
      <div className="mb-2 flex flex-wrap gap-2">
        <Badge value={p.difficulty} />
        {p.tags.map((t) => (
          <span key={t} className="badge bg-slate-100 text-slate-700">
            {t}
          </span>
        ))}
        <span className="text-xs text-slate-500">
          time {p.timeLimitMs} ms · memory {Math.round(p.memoryLimitKb / 1024)} MB
        </span>
      </div>
      <p className="whitespace-pre-wrap text-sm">{p.statement}</p>
      {p.constraints && (
        <>
          <h3 className="mt-3 text-sm font-semibold">Constraints</h3>
          <p className="whitespace-pre-wrap text-sm">{p.constraints}</p>
        </>
      )}
      {p.inputDesc && (
        <>
          <h3 className="mt-3 text-sm font-semibold">Input</h3>
          <p className="whitespace-pre-wrap text-sm">{p.inputDesc}</p>
        </>
      )}
      {p.outputDesc && (
        <>
          <h3 className="mt-3 text-sm font-semibold">Output</h3>
          <p className="whitespace-pre-wrap text-sm">{p.outputDesc}</p>
        </>
      )}
      {p.samples.map((s, i) => (
        <div key={i} className="mt-3 grid gap-2 sm:grid-cols-2">
          <div>
            <div className="text-xs font-semibold">Sample input {i + 1}</div>
            <pre className="overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{s.input}</pre>
          </div>
          <div>
            <div className="text-xs font-semibold">Sample output {i + 1}</div>
            <pre className="overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{s.output}</pre>
          </div>
        </div>
      ))}
    </Card>
  );
}

/** Language picker order is the shared LANGUAGES order; unknown ids coming from older data are still shown. */
const labelOf = (l: string) => LANGUAGE_LABELS[l as Language] ?? l;
const sortLanguages = (ls: string[]) => [...ls].sort((a, b) => (LANGUAGES as readonly string[]).indexOf(a) - (LANGUAGES as readonly string[]).indexOf(b));

/**
 * Code editor + submit. The editor ALWAYS starts empty: no starter template is ever inserted, in any language, and switching
 * language never injects one either. Each language keeps its own draft while the page is open, so switching back and forth
 * does not lose what you typed.
 */
export function SubmitBox({
  p,
  url,
  invalidate,
  onSubmitted,
  extra,
}: {
  p: { languages: string[] };
  url: string;
  invalidate: string[];
  onSubmitted?: () => void;
  extra?: object;
}) {
  const languages = sortLanguages(p.languages.length ? p.languages : [...LANGUAGES]);
  const [lang, setLang] = useState(languages.includes('python') ? 'python' : languages[0]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const code = drafts[lang] ?? '';
  const body = (more: object) => ({ language: lang, code, idempotencyKey: crypto.randomUUID(), ...extra, ...more });
  const submit = useAct((extra: object) => api.post(url, body(extra)), { ok: 'Submitted — judging…', invalidate, onDone: onSubmitted });
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Submit solution</h3>
        <select className="input max-w-[14rem]" aria-label="Language" value={lang} onChange={(e) => setLang(e.target.value)}>
          {languages.map((l) => (
            <option key={l} value={l}>
              {labelOf(l)}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="input font-mono text-xs"
        rows={14}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Source code"
        placeholder={`Write your ${labelOf(lang)} solution here…`}
        value={code}
        onChange={(e) => setDrafts({ ...drafts, [lang]: e.target.value })}
        onKeyDown={(e) => {
          // Tab indents instead of leaving the editor; Esc then Tab still moves focus on (keyboard users are not trapped).
          if (e.key !== 'Tab' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
          e.preventDefault();
          const t = e.currentTarget;
          const { selectionStart: from, selectionEnd: to } = t;
          setDrafts({ ...drafts, [lang]: `${code.slice(0, from)}    ${code.slice(to)}` });
          requestAnimationFrame(() => t.setSelectionRange(from + 4, from + 4));
        }}
      />
      <button className="btn-primary mt-2" disabled={!code.trim() || submit.isPending} onClick={() => submit.mutate({})}>
        {submit.isPending ? 'Submitting…' : 'Submit'}
      </button>
    </Card>
  );
}

interface Sub {
  id: string;
  status: string;
  language: string;
  submittedAt: string;
  timeMs?: number;
  memoryKb?: number;
  problemTitle?: string | null;
  /** Contest problem label (A, B, C...). Present for contest submissions. */
  problemLabel?: string | null;
  problemId: string;
}
/** `deletable` is only for practice submissions: contest submissions are evidence and can only be removed by an organiser (Contest → Admin). */
export function SubmissionTable({ url, deletable = false }: { url: string; deletable?: boolean }) {
  const q = useGet<Sub[]>(url, { refetchInterval: 3000 });
  const del = useDelete({ noun: 'submission', request: (id) => api.del(`/submissions/${id}`), prune: [url], invalidate: ['/me/submissions', '/me/progress'] });
  return (
    <Query q={q}>
      {(s) =>
        s.length === 0 ? (
          <Empty>No submissions yet. Your verdicts will appear here.</Empty>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="min-w-full divide-y">
              <thead>
                <tr>
                  <th className="th">When</th>
                  <th className="th">Problem</th>
                  <th className="th">Lang</th>
                  <th className="th">Verdict</th>
                  <th className="th">Time</th>
                  {deletable && (
                    <th className="th w-10">
                      <span className="sr-only">Delete</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y">
                {s.map((x) => (
                  <tr key={x.id}>
                    <td className="td">{fmt(x.submittedAt)}</td>
                    <td className="td">
                      {x.problemLabel ? (
                        <>
                          <b>{x.problemLabel}</b>
                          {x.problemTitle ? <span className="text-slate-500"> · {x.problemTitle}</span> : null}
                        </>
                      ) : (
                        (x.problemTitle ?? x.problemId.slice(-4))
                      )}
                    </td>
                    <td className="td">{x.language}</td>
                    <td className="td">
                      <Badge value={x.status} />
                    </td>
                    <td className="td">{x.timeMs ? `${x.timeMs} ms` : '—'}</td>
                    {deletable && (
                      <td className="td">
                        <TrashButton label="Delete submission" onClick={() => del({ id: x.id, message: 'This practice submission is removed from your history and progress.' })} />
                      </td>
                    )}
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

export function ProblemsList() {
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [d, setD] = useState('');
  const list = useGet<{ id: string; title: string; tags: string[]; difficulty: string }[]>(
    `/problems?${new URLSearchParams({ ...(q && { q }), ...(tag && { tag }), ...(d && { difficulty: d }) })}`,
  );
  return (
    <>
      <PageHeader title="Practice problems" sub="Available after their contests end. Practice results never affect contest standings." />
      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <input className="input" placeholder="Search" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <input className="input" placeholder="Topic tag (e.g. math)" aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} />
        <select className="input" aria-label="Difficulty" value={d} onChange={(e) => setD(e.target.value)}>
          <option value="">Any difficulty</option>
          {DIFFICULTIES.map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      <Query q={list}>
        {(l) =>
          l.length === 0 ? (
            <Empty>No practice problems match. Problems appear here once their contest has ended.</Empty>
          ) : (
            <div className="grid gap-2 md:grid-cols-2">
              {l.map((p) => (
                <Link key={p.id} to={`/problems/${p.id}`} className="card flex items-center justify-between hover:border-brand-500">
                  <span className="font-medium">{p.title}</span>
                  <span className="flex gap-1">
                    <Badge value={p.difficulty} />
                    {p.tags.slice(0, 2).map((t) => (
                      <span key={t} className="badge bg-slate-100 text-slate-700">
                        {t}
                      </span>
                    ))}
                  </span>
                </Link>
              ))}
            </div>
          )
        }
      </Query>
    </>
  );
}

export function ProblemDetail() {
  const { id } = useParams();
  const q = useGet<ProblemView>(`/problems/${id}`);
  const [showEd, setShowEd] = useState(false);
  const ed = useGet<{ content: string }>(showEd ? `/problems/${id}/editorial` : null);
  return (
    <Query q={q}>
      {(p) => (
        <>
          <PageHeader
            title={p.title}
            actions={
              <button className="btn-ghost" onClick={() => setShowEd(true)}>
                Show editorial
              </button>
            }
          />
          <div className="space-y-4">
            <ProblemView p={p} />
            {showEd &&
              (ed.isLoading ? (
                <p className="text-sm text-slate-500">Loading…</p>
              ) : ed.error ? (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
                  {errMsg(ed.error)}
                </div>
              ) : (
                <Card>
                  <h3 className="mb-1 font-semibold">Editorial</h3>
                  <p className="whitespace-pre-wrap text-sm">{ed.data?.content}</p>
                </Card>
              ))}
            <SubmitBox p={p} url={`/problems/${id}/practice-submissions`} invalidate={[`/me/submissions?mode=practice&problemId=${id}`, '/me/progress']} />
            <h3 className="font-semibold">My practice submissions</h3>
            <SubmissionTable url={`/me/submissions?mode=practice&problemId=${id}`} deletable />
          </div>
        </>
      )}
    </Query>
  );
}

interface Prog {
  totalAttempts: number;
  problemsAttempted: number;
  problemsSolved: number;
  topics: Record<string, { attempted: number; solved: number }>;
  difficulty: Record<string, { attempted: number; solved: number }>;
}
export function Progress() {
  const q = useGet<Prog>('/me/progress');
  const hist = useGet<Sub[]>('/me/submissions');
  const bar = (name: string, v: { attempted: number; solved: number }) => (
    <div key={name} className="mb-2">
      <div className="flex flex-wrap justify-between text-sm gap-2">
        <span>{name}</span>
        <span>
          {v.solved}/{v.attempted} solved
        </span>
      </div>
      <div className="h-2 rounded bg-slate-200">
        <div className="h-2 rounded bg-brand-600" style={{ width: `${v.attempted ? (v.solved / v.attempted) * 100 : 0}%` }} />
      </div>
    </div>
  );
  return (
    <>
      <PageHeader title="My progress" sub="Topic-wise and difficulty-wise, across practice and contests" />
      <Query q={q}>
        {(p) =>
          p.problemsAttempted === 0 ? (
            <Empty>
              No attempts yet.{' '}
              <Link className="text-brand-700 underline" to="/problems">
                Try a practice problem
              </Link>
            </Empty>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <div className="grid grid-cols-3 text-center">
                  <div>
                    <div className="text-2xl font-semibold">{p.problemsSolved}</div>
                    <div className="text-xs text-slate-500">solved</div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold">{p.problemsAttempted}</div>
                    <div className="text-xs text-slate-500">attempted</div>
                  </div>
                  <div>
                    <div className="text-2xl font-semibold">{p.totalAttempts}</div>
                    <div className="text-xs text-slate-500">submissions</div>
                  </div>
                </div>
              </Card>
              <Card>
                <h3 className="mb-2 font-semibold">By difficulty</h3>
                {Object.entries(p.difficulty).map(([k, v]) => bar(k, v))}
              </Card>
              <Card className="md:col-span-2">
                <h3 className="mb-2 font-semibold">By topic</h3>
                {Object.entries(p.topics).map(([k, v]) => bar(k, v))}
              </Card>
            </div>
          )
        }
      </Query>
      <h3 className="mb-2 mt-6 font-semibold">Recent submissions</h3>
      {hist.data && hist.data.length > 0 ? <SubmissionTable url="/me/submissions" /> : <Empty>Nothing submitted yet.</Empty>}
    </>
  );
}
