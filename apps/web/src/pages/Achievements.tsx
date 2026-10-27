import { Award, FileText, Loader2, Medal, Trophy, Users } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { download, errMsg } from '../lib/api';
import { fmtDate, useGet } from '../lib/hooks';
import { EmptyState, PageHeader, Query, StatTile, useToast } from '../components/ui';
import { CertificateCard } from '../components/CertificateCard';
import type { CertLike } from '../lib/certView';

/** My achievements (S16, v7 premium): own certificates as gradient cards (Preview / Download), rank + score per published event, PUBLISHED feedback, portfolio PDF. */
interface AchCert extends CertLike { verifyUrl?: string; members: string[] }
interface Ach {
  certificates: AchCert[];
  feedback: { id: string; eventTitle: string | null; percent: number; points: number; maxPoints: number; rating: number | null; summary: string; publishedAt: string | null }[];
  results: { eventId: string; eventTitle: string; participant: string; kind: 'team' | 'person'; rank: number | null; tied: boolean; ranked: number; final: number | null; judgePercent: number | null; aiPercent: number | null; penalty: number }[];
  summary: { certificates: number; feedback: number; events: number; bestRank: number | null };
}

const rankTone = (r: number | null) =>
  r === 1 ? 'from-amber-400 to-amber-600 text-white' : r === 2 ? 'from-slate-300 to-slate-500 text-white' : r === 3 ? 'from-orange-400 to-orange-700 text-white' : 'from-brand-500 to-brand-800 text-white';

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold">
        {title}
        <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-semibold text-brand-700">{count}</span>
      </h2>
      {children}
    </section>
  );
}

export default function Achievements() {
  const q = useGet<Ach>('/me/achievements');
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const portfolio = async () => {
    setBusy(true);
    try {
      await download('/me/achievements/portfolio.pdf', 'FestHub-Portfolio.pdf');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <PageHeader
        title="My achievements"
        sub="Everything you have earned: certificates, results and feedback."
        actions={
          <button className="btn btn-primary" disabled={busy} onClick={portfolio}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />} Download portfolio PDF
          </button>
        }
      />
      <Query q={q}>
        {(a) => (
          <>
            <div className="mb-6 grid gap-3 sm:grid-cols-2">
              <StatTile icon={Award} label="Certificates" value={a.summary.certificates} tone="amber" />
              <StatTile icon={Medal} label={a.summary.bestRank ? 'Best rank' : 'Published results'} value={a.summary.bestRank ? `#${a.summary.bestRank}` : a.summary.events} tone="green" />
            </div>

            <Section title="Certificates" count={a.certificates.length}>
              {a.certificates.length === 0 ? (
                <div className="card"><EmptyState icon={Award} title="No certificates yet" hint="Certificates you receive appear here, ready to preview and download." /></div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">{a.certificates.map((c) => <CertificateCard key={c.id} cert={{ ...c, status: 'valid' }} />)}</div>
              )}
            </Section>

            <Section title="Rank & results" count={a.results.length}>
              {a.results.length === 0 ? (
                <div className="card"><EmptyState icon={Medal} title="No published results yet" hint="Your rank and score appear here once an organizer publishes an event's leaderboard." /></div>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {a.results.map((r) => (
                    <Link key={r.eventId} to={`/leaderboard?event=${r.eventId}`} className="card card-interactive flex items-center gap-4">
                      <span className={`grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${rankTone(r.rank)} font-display text-2xl font-bold shadow-lift`} aria-label={r.rank === null ? 'Unranked' : `Rank ${r.rank}`}>
                        {r.rank === null ? '—' : `#${r.rank}`}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">{r.eventTitle}</div>
                        <div className="flex items-center gap-1 truncate text-xs text-slate-500">{r.kind === 'team' ? <><Users size={12} aria-hidden /> Team {r.participant}</> : <><Trophy size={12} aria-hidden /> Individual</>}{r.rank !== null && ` · of ${r.ranked}${r.tied ? ' (tie)' : ''}`}</div>
                        <div className="mt-1 text-sm text-slate-600">
                          <b>{r.final ?? '—'}%</b> final · judge {r.judgePercent ?? '—'}% · AI {r.aiPercent ?? '—'}%{r.penalty ? ` · penalty −${r.penalty}` : ''}
                        </div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Section>
          </>
        )}
      </Query>
    </div>
  );
}
