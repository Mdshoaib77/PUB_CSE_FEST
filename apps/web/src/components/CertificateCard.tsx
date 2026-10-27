import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Award, CalendarDays, Download, Eye, ExternalLink, Hash, Loader2, RefreshCw, ShieldCheck, ShieldX, Trophy, Users, X } from 'lucide-react';
import { errMsg } from '../lib/api';
import { fmtDate } from '../lib/hooks';
import { certBadge, certFileName, certHolder, certMembers, certTone, downloadCert, fetchCertPdf, isTeamCert, saveBlob, type CertLike, type CertTone } from '../lib/certView';
import { useToast } from './ui';

const TONE: Record<CertTone, { bg: string; ring: string; glow: string }> = {
  gold: { bg: 'from-amber-500 via-amber-600 to-orange-700', ring: 'ring-amber-300/60', glow: 'shadow-[0_18px_40px_-18px_rgba(217,119,6,0.7)]' },
  silver: { bg: 'from-slate-400 via-slate-500 to-slate-700', ring: 'ring-slate-200/60', glow: 'shadow-[0_18px_40px_-18px_rgba(71,85,105,0.7)]' },
  bronze: { bg: 'from-orange-500 via-orange-700 to-amber-900', ring: 'ring-orange-300/50', glow: 'shadow-[0_18px_40px_-18px_rgba(194,65,12,0.7)]' },
  brand: { bg: 'from-brand-600 via-brand-700 to-ink-900', ring: 'ring-brand-300/50', glow: 'shadow-[0_18px_40px_-18px_rgba(34,61,156,0.75)]' },
};

/** Modal with the REAL certificate PDF (fetched from the same endpoint as the download). Esc / backdrop / X close it. */
export function CertPreviewModal({ cert, onClose }: { cert: CertLike; onClose: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    setBlob(null);
    setErr(null);
    fetchCertPdf(cert.id)
      .then((b) => {
        if (!alive) return;
        made = URL.createObjectURL(b);
        setBlob(b);
        setUrl(made);
      })
      .catch((e) => alive && setErr(errMsg(e)));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [cert.id, tick]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const save = () => {
    if (!blob) return;
    saveBlob(blob, certFileName(cert.eventTitle, certHolder(cert)));
    toast('Certificate downloaded');
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-ink-950/70 p-0 backdrop-blur-sm sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={`Certificate preview: ${certHolder(cert)}`} className="flex h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-t-3xl border border-white/10 bg-white shadow-2xl dark:bg-ink-900 sm:h-[86vh] sm:rounded-3xl">
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-white/10">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand-600 to-ink-900 text-white"><Award size={18} /></span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-slate-900">{certHolder(cert)}</div>
            <div className="truncate text-xs text-slate-500">{certBadge(cert)} · {cert.eventTitle}</div>
          </div>
          <button className="btn-primary btn-sm" onClick={save} disabled={!blob}><Download size={14} /> <span className="hidden sm:inline">Download PDF</span><span className="sm:hidden">PDF</span></button>
          <button ref={closeRef} className="icon-btn" aria-label="Close preview" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="relative min-h-0 flex-1 bg-slate-100 dark:bg-ink-950">
          {!url && !err && (
            <div className="absolute inset-0 grid place-items-center" role="status" aria-label="Loading certificate">
              <div className="flex flex-col items-center gap-3 text-sm text-slate-500"><Loader2 className="animate-spin" size={28} /> Rendering your certificate…</div>
            </div>
          )}
          {err && (
            <div className="absolute inset-0 grid place-items-center p-6" role="alert">
              <div className="max-w-sm text-center">
                <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-red-100 text-red-600"><ShieldX size={22} /></span>
                <p className="font-semibold">Could not load the certificate</p>
                <p className="mt-1 text-sm text-slate-500">{err}</p>
                <button className="btn-ghost btn-sm mt-3" onClick={() => setTick((t) => t + 1)}><RefreshCw size={14} /> Try again</button>
              </div>
            </div>
          )}
          {url && (
            <>
              <object data={`${url}#toolbar=0&navpanes=0`} type="application/pdf" className="h-full w-full" aria-label="Certificate PDF">
                <iframe title="Certificate PDF" src={url} className="h-full w-full border-0" />
              </object>
              <a href={url} target="_blank" rel="noreferrer" className="absolute bottom-3 right-3 inline-flex items-center gap-1.5 rounded-full bg-ink-900/85 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur hover:bg-ink-900">
                <ExternalLink size={12} /> Open full size
              </a>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Premium gradient card for ONE certificate: holder (team name + members, or the person), position badge, event, date, ID, Preview / Download / Verify. */
export function CertificateCard({ cert }: { cert: CertLike }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const tone = TONE[certTone(cert)];
  const team = isTeamCert(cert);
  const members = certMembers(cert);
  const shown = all ? members : members.slice(0, 6);
  const revoked = cert.status === 'revoked';

  const dl = async () => {
    setBusy(true);
    try {
      await downloadCert(cert);
      toast('Certificate downloaded');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className={`relative overflow-hidden rounded-3xl bg-gradient-to-br ${tone.bg} p-5 text-white ring-1 ring-inset ${tone.ring} ${tone.glow} transition duration-300 hover:-translate-y-1`}>
      <div aria-hidden className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-white/10 blur-2xl" />
      <div aria-hidden className="pointer-events-none absolute -bottom-12 -left-8 h-36 w-36 rounded-full bg-black/10 blur-2xl" />
      <Award aria-hidden size={110} className="pointer-events-none absolute -bottom-4 -right-3 text-white/10" />
      <div className="relative">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-bold uppercase tracking-wide backdrop-blur"><Trophy size={13} aria-hidden /> {certBadge(cert)}</span>
          {team && <span className="inline-flex items-center gap-1 rounded-full bg-black/20 px-2.5 py-1 text-[11px] font-medium"><Users size={12} aria-hidden /> Team</span>}
          {revoked ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/90 px-2.5 py-1 text-[11px] font-bold uppercase"><ShieldX size={12} aria-hidden /> Revoked</span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-black/20 px-2.5 py-1 text-[11px] font-medium"><ShieldCheck size={12} aria-hidden /> Valid</span>
          )}
        </div>

        <h3 className="mt-3 break-words font-display text-2xl font-bold leading-tight">{team ? certHolder(cert) : certHolder(cert)}</h3>
        {team && members.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Team members">
            {shown.map((m, i) => <span key={`${m}-${i}`} className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs backdrop-blur">{m}</span>)}
            {members.length > 6 && (
              <button className="rounded-full bg-white/25 px-2.5 py-0.5 text-xs font-semibold hover:bg-white/35" onClick={() => setAll((v) => !v)}>{all ? 'Show less' : `+${members.length - 6} more`}</button>
            )}
          </div>
        )}
        <p className="mt-3 break-words text-sm font-medium text-white/90">{cert.eventTitle}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-white/80">
          <span className="inline-flex items-center gap-1"><CalendarDays size={12} aria-hidden /> {fmtDate(cert.eventDate)}</span>
          <span className="inline-flex min-w-0 items-center gap-1 font-mono"><Hash size={12} aria-hidden className="shrink-0" /> <span className="break-all">{cert.id}</span></span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {!revoked && (
            <>
              <button className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-white/20 px-3.5 py-2 text-sm font-semibold backdrop-blur transition hover:bg-white/30 active:scale-[0.97]" onClick={() => setOpen(true)}><Eye size={15} /> Preview</button>
              <button className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl bg-ink-900/70 px-3.5 py-2 text-sm font-semibold transition hover:bg-ink-900 active:scale-[0.97] disabled:opacity-60" disabled={busy} onClick={dl}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} Download PDF
              </button>
            </>
          )}
          <a className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium text-white/90 underline-offset-4 hover:underline" href={`/verify/${cert.id}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Verify</a>
        </div>
      </div>
      {open && <CertPreviewModal cert={cert} onClose={close} />}
    </article>
  );
}
