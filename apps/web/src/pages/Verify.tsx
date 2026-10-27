import { useState } from 'react';
import { BrandLockup } from '../components/Brand';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, CalendarDays, Hash, Search, ShieldAlert, ShieldX, Trophy, User, Users } from 'lucide-react';
import type { CertificateVerification } from '@festhub/shared';
import { api } from '../lib/api';
import { fmtDate } from '../lib/hooks';
import { Skeleton, Spinner } from '../components/ui';

const THEME = {
  valid: { icon: BadgeCheck, title: 'Valid certificate', sub: 'This certificate is genuine and currently in force.', hero: 'from-emerald-600 via-emerald-700 to-teal-800', ring: 'ring-emerald-400/40' },
  revoked: { icon: ShieldX, title: 'Certificate revoked', sub: 'This certificate is no longer valid. Do not rely on it.', hero: 'from-red-600 via-red-700 to-rose-900', ring: 'ring-red-400/40' },
  not_found: { icon: ShieldAlert, title: 'Certificate not found', sub: 'No certificate with this ID exists. Check the ID for typing mistakes.', hero: 'from-amber-500 via-amber-600 to-orange-700', ring: 'ring-amber-400/40' },
} as const;

function Row({ icon: Icon, label, children }: { icon: typeof User; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-200"><Icon size={15} aria-hidden /></span>
      <div className="min-w-0">
        <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
        <dd className="break-words font-medium">{children}</dd>
      </div>
    </div>
  );
}

/** Public page (no sign-in): /verify/<certificate id>. Shows valid / revoked / not found; team certificates list the team name and every member. */
export default function Verify() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [input, setInput] = useState(id);
  const q = useQuery({ queryKey: ['/verify', id], queryFn: () => api.get<CertificateVerification>(`/verify/${encodeURIComponent(id)}`), enabled: !!id, retry: false });
  const v = q.data;
  const go = () => input.trim() && nav(`/verify/${encodeURIComponent(input.trim())}`);
  const t = v ? THEME[v.status] : null;
  const team = v?.kind === 'team';
  const members = v?.members ?? [];
  return (
    <div className="min-h-screen bg-gradient-to-b from-brand-50 via-white to-ivory-100 dark:from-ink-900 dark:via-ink-900 dark:to-ink-950">
      <div className="mx-auto grid max-w-2xl content-start gap-5 p-4 sm:p-8">
        <BrandLockup />
        <div>
          <span aria-hidden className="mb-2 block h-0.5 w-10 rounded-full bg-gold-500" />
          <h1 className="font-display text-2xl font-semibold sm:text-3xl">Verify a certificate</h1>
          <p className="mt-1 text-sm text-slate-500">Enter the certificate ID printed on the certificate, or scan its QR code.</p>
        </div>
        <div className="card">
          <div className="flex flex-col gap-2 sm:flex-row">
            <input className="input font-mono" placeholder="FH-XXXX-XXXX-XXXX-XX" value={input} autoComplete="off" spellCheck={false} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} aria-label="Certificate ID" />
            <button className="btn-primary" disabled={!input.trim()} onClick={go}>
              <Search size={16} /> Verify
            </button>
          </div>
        </div>
        {id && q.isLoading && (
          <div className="card space-y-3" role="status" aria-label="Checking certificate">
            <div className="flex items-center gap-3"><Skeleton className="h-12 w-12 rounded-full" /><div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-3/4" /></div></div>
            <Skeleton className="h-16 w-full" />
            <div className="flex items-center gap-2 text-xs text-slate-500"><Spinner /> Checking the live record…</div>
          </div>
        )}
        {id && q.error && (
          <div className="card flex items-start gap-3 text-sm" role="alert">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-600" />
            <div>
              <p className="font-semibold">Could not check this certificate right now</p>
              <p className="text-slate-500">Please try again in a moment.</p>
              <button className="btn-ghost btn-sm mt-2" onClick={() => q.refetch()}>Try again</button>
            </div>
          </div>
        )}
        {v && t && (
          <div className={`overflow-hidden rounded-3xl border border-slate-200/80 bg-white shadow-lift ring-1 ring-inset dark:border-white/10 dark:bg-ink-800 ${t.ring}`} role="status" aria-live="polite">
            <div className={`relative overflow-hidden bg-gradient-to-br ${t.hero} p-5 text-white`}>
              <div aria-hidden className="pointer-events-none absolute -right-8 -top-8 h-36 w-36 rounded-full bg-white/10 blur-2xl" />
              <t.icon aria-hidden size={120} className="pointer-events-none absolute -bottom-6 -right-4 text-white/10" />
              <div className="relative flex items-center gap-3">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/20 backdrop-blur"><t.icon size={26} /></span>
                <div>
                  <div className="font-display text-xl font-bold">{t.title}</div>
                  <div className="text-sm text-white/85">{t.sub}</div>
                </div>
              </div>
            </div>
            {v.status !== 'not_found' && (
              <div className="p-5">
                <div className="text-center">
                  <div className="inline-flex items-center gap-1.5 rounded-full bg-gold-300/40 px-3 py-1 text-xs font-bold uppercase tracking-wide text-gold-600 dark:text-gold-300">{team && <Users size={12} aria-hidden />} {v.typeLabel}{team ? ' · Team' : ''}</div>
                  <div className="mt-2 break-words font-display text-2xl font-bold sm:text-3xl">{team ? (v.teamName ?? v.recipientName) : v.recipientName}</div>
                  <div className="mt-1 text-sm text-slate-600">{v.eventTitle}</div>
                </div>
                {team && members.length > 0 && (
                  <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-3 dark:border-white/10 dark:bg-white/5">
                    <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500"><Users size={13} aria-hidden /> Team members ({members.length})</div>
                    <ul className="flex flex-wrap gap-1.5">
                      {members.map((m, i) => (
                        <li key={`${m}-${i}`} className="rounded-full bg-white px-3 py-1 text-sm font-medium shadow-sm ring-1 ring-slate-200 dark:bg-ink-700 dark:ring-white/10">{m}{i === 0 && <span className="ml-1 text-[10px] font-bold uppercase text-gold-600">leader</span>}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <dl className="mt-3 divide-y divide-slate-100">
                  {v.positionLabel && (
                    <Row icon={Trophy} label="Position">
                      {v.positionLabel}
                    </Row>
                  )}
                  <Row icon={CalendarDays} label="Event date">
                    {fmtDate(v.eventDate)}
                  </Row>
                  <Row icon={CalendarDays} label="Issued">
                    {fmtDate(v.issuedAt)}
                  </Row>
                  <Row icon={Hash} label="Certificate ID">
                    <span className="break-all font-mono text-sm">{v.id}</span>
                  </Row>
                  {v.status === 'revoked' && (
                    <Row icon={ShieldX} label="Revoked on">
                      {fmtDate(v.revokedAt)}
                    </Row>
                  )}
                  {v.status === 'revoked' && v.replacedBy && (
                    <Row icon={BadgeCheck} label="Replaced by">
                      <Link className="font-mono text-sm text-brand-600 underline" to={`/verify/${v.replacedBy}`}>
                        {v.replacedBy}
                      </Link>
                    </Row>
                  )}
                </dl>
              </div>
            )}
          </div>
        )}
        <p className="text-center text-xs text-slate-400">Verification reflects the live record. A certificate is genuine only if it appears here as valid.</p>
      </div>
    </div>
  );
}
