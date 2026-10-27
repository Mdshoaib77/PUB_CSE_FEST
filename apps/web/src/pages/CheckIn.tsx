import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { QrCode, RefreshCw, ShieldCheck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api, errMsg } from '../lib/api';
import { useGet } from '../lib/hooks';
import { Card, EmptyState, PageHeader, Skeleton } from '../components/ui';
import CheckInDesk from '../components/CheckInDesk';

interface Tok {
  token: string;
  manualCode?: string;
  subjectType: string;
  ttlSec: number;
  expiresAt: string;
}

/**
 * Keeps a short-lived check-in token fresh: re-requests it at 60% of its lifetime, when the tab becomes
 * visible again, or on demand. A stale screenshot therefore stops working within `ttlSec` seconds.
 */
function useLiveToken(eventId: string, as: string) {
  const [tok, setTok] = useState<Tok | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const gen = useRef(0);

  const load = useCallback(async () => {
    if (!eventId) return;
    const my = ++gen.current;
    clearTimeout(timer.current);
    try {
      const t = await api.get<Tok>(`/me/checkin-token/${eventId}?as=${as}`);
      if (my !== gen.current) return;
      setTok(t);
      setError(null);
      timer.current = setTimeout(() => void load(), Math.max(3000, t.ttlSec * 600));
    } catch (e) {
      if (my !== gen.current) return;
      setTok(null);
      setError(errMsg(e));
    } finally {
      if (my === gen.current) setLoading(false);
    }
  }, [eventId, as]);

  useEffect(() => {
    setTok(null);
    setError(null);
    if (!eventId) return;
    setLoading(true);
    void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      gen.current++;
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [eventId, as, load]);

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(i);
  }, []);

  const msLeft = tok ? new Date(tok.expiresAt).getTime() - now : 0;
  return { tok, error, loading, msLeft, expired: !!tok && msLeft <= 0, fraction: tok ? Math.max(0, Math.min(1, msLeft / (tok.ttlSec * 1000))) : 0, reload: load };
}

export default function CheckIn() {
  const { has } = useAuth();
  const events = useGet<{ _id: string; title: string }[]>('/events');
  const [eventId, setEventId] = useState('');
  const [as, setAs] = useState<'participant' | 'volunteer'>('participant');
  const live = useLiveToken(eventId, as);
  const operator = has('volunteer', 'coordinator', 'organiser');
  return (
    <>
      <PageHeader title="QR check-in" sub="Your code refreshes automatically every few seconds, so screenshots can't be shared." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <h2 className="mb-3 flex items-center gap-2 font-semibold">
            <QrCode size={18} className="text-brand-600" /> My QR code
          </h2>
          <select className="input mb-2" aria-label="Event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">Choose an event…</option>
            {events.data?.map((e) => (
              <option key={e._id} value={e._id}>
                {e.title}
              </option>
            ))}
          </select>
          {has('volunteer') && (
            <select className="input mb-2" aria-label="Role" value={as} onChange={(e) => setAs(e.target.value as 'participant' | 'volunteer')}>
              <option value="participant">As participant</option>
              <option value="volunteer">As volunteer</option>
            </select>
          )}
          {!eventId ? (
            <EmptyState icon={QrCode} title="Pick an event" hint="Your personal check-in code appears here once you have a confirmed registration or a volunteer shift." />
          ) : live.loading && !live.tok ? (
            <div className="flex flex-col items-center gap-3 py-4">
              <Skeleton className="h-56 w-56" />
              <Skeleton className="h-3 w-40" />
            </div>
          ) : live.error ? (
            <p className="rounded-xl border border-red-200 bg-red-50/80 p-3 text-sm text-red-800" role="alert">
              {live.error}
            </p>
          ) : (
            live.tok && (
              <div className="flex flex-col items-center gap-3">
                <div className="glass-strong relative p-4">
                  <div className={`rounded-2xl bg-white p-3 transition ${live.expired ? 'opacity-20 blur-[2px]' : ''}`}>
                    <QRCodeSVG value={live.tok.token} size={220} level="M" />
                  </div>
                  {live.expired && (
                    <button className="btn-primary absolute inset-0 m-auto h-10 w-40" onClick={() => void live.reload()}>
                      <RefreshCw size={14} /> Refresh code
                    </button>
                  )}
                </div>
                <div className="w-full max-w-[16rem]">
                  <div className="h-1.5 overflow-hidden rounded-full bg-slate-200/80">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${live.fraction < 0.25 ? 'bg-amber-500' : 'bg-gradient-to-r from-brand-500 to-emerald-500'}`}
                      style={{ width: `${live.fraction * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 flex items-center justify-center gap-1 text-xs text-slate-500">
                    <ShieldCheck size={12} /> Renews automatically · valid {Math.max(0, Math.ceil(live.msLeft / 1000))}s
                  </p>
                </div>
                {live.tok.manualCode && (
                  <div className="w-full max-w-[16rem] rounded-xl border border-slate-200/80 bg-white/70 p-2 text-center">
                    <p className="text-xs text-slate-500">Camera not working? Read this code to the volunteer</p>
                    <p className="mt-0.5 select-all font-mono text-lg font-semibold tracking-widest" aria-label="Registration code">
                      {live.tok.manualCode}
                    </p>
                  </div>
                )}
              </div>
            )
          )}
        </Card>
        {operator && <CheckInDesk />}
      </div>
    </>
  );
}
