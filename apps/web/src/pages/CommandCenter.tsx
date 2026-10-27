import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Award, CalendarCheck2, Users, type LucideIcon } from 'lucide-react';
import { useGet, fmt } from '../lib/hooks';
import { PageHeader, Query } from '../components/ui';
import { BarList, Sparkline } from '../components/charts';

/** S16 organiser command center: live KPI cards + charts; every card links to the page that owns the data. Refreshes every 15 s. */
interface CC {
  generatedAt: string;
  registrations: { total: number; confirmed: number; waitlisted: number; pending: number; byStatus: Record<string, number>; trend: { day: string; count: number }[]; topEvents: { eventId: string; title: string; confirmed: number }[] };
  sponsors: { total: number; byStatus: Record<string, number>; pledged: number; received: number; outstanding: number; overduePayments: number };
  submissions: { codeSubmissions: number; entries: number; flaggedPairs: number; confirmedPairs: number; flaggedSubmissions: number; pendingChecks: number };
  certificates: { issued: number; revoked: number; byType: Record<string, number> };
}
const cap = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function Panel({ to, icon: Icon, title, linkLabel, children }: { to: string; icon: LucideIcon; title: string; linkLabel: string; children: ReactNode }) {
  return (
    <section className="card flex flex-col gap-4" aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-base font-semibold"><Icon size={18} aria-hidden /> {title}</h2>
        <Link to={to} className="btn btn-ghost btn-sm" aria-label={`${linkLabel}: ${title}`}>{linkLabel} <ArrowUpRight size={14} /></Link>
      </div>
      {children}
    </section>
  );
}
const Kpi = ({ label, value, tone = '' }: { label: string; value: ReactNode; tone?: string }) => (
  <div><div className={`font-display text-2xl font-semibold leading-none ${tone}`}>{value}</div><div className="mt-1 text-xs text-slate-500">{label}</div></div>
);

export default function CommandCenter() {
  const q = useGet<CC>('/command-center', { refetchInterval: 15000 });
  return (
    <div>
      <PageHeader title="Command center" sub={q.data ? `Live overview · updated ${fmt(q.data.generatedAt)} · refreshes every 15 s` : 'Live overview of the whole fest'} />
      <Query q={q}>
        {(d) => (
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel to="/events" icon={Users} title="Registrations" linkLabel="Open events">
              <div className="grid grid-cols-4 gap-3">
                <Kpi label="Total" value={d.registrations.total} />
                <Kpi label="Confirmed" value={d.registrations.confirmed} tone="text-emerald-600" />
                <Kpi label="Waitlisted" value={d.registrations.waitlisted} tone="text-amber-600" />
                <Kpi label="Pending approval" value={d.registrations.pending} tone={d.registrations.pending ? 'text-red-600' : ''} />
              </div>
              <Sparkline points={d.registrations.trend} label="New registrations" />
              <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Confirmed by event</h3><BarList rows={d.registrations.topEvents.map((e) => ({ label: e.title, value: e.confirmed }))} empty="No confirmed registrations yet" /></div>
            </Panel>

            <Panel to="/certificates" icon={Award} title="Certificates" linkLabel="Open certificates">
              <div className="grid grid-cols-4 gap-3">
                <Kpi label="Issued (valid)" value={d.certificates.issued} tone="text-emerald-600" />
                <Kpi label="Revoked" value={d.certificates.revoked} tone={d.certificates.revoked ? 'text-red-600' : ''} />
              </div>
              <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Valid by type</h3><BarList rows={Object.entries(d.certificates.byType).map(([k, v]) => ({ label: cap(k), value: v }))} empty="No certificates issued yet" /></div>
            </Panel>

            <Panel to="/leaderboard" icon={CalendarCheck2} title="Results" linkLabel="Open leaderboard">
              <p className="text-sm text-slate-600">Scores and tie-breaks per event, with CSV and PDF export.</p>
            </Panel>
          </div>
        )}
      </Query>
    </div>
  );
}
