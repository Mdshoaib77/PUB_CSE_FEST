import { useRef, useState } from 'react';
import { CheckCircle2, Clock, Keyboard, ScanLine, XCircle } from 'lucide-react';
import { ApiError, api, errMsg } from '../lib/api';
import { fmt } from '../lib/hooks';
import { Card, useToast } from './ui';
import QrScanner from './QrScanner';

interface ScanLog {
  ok: boolean;
  text: string;
  at: Date;
}
const SCAN_COOLDOWN_MS = 1500;

/**
 * The operator's check-in desk: camera viewport on top, and underneath a manual field that always works. If the laptop has no camera,
 * the browser blocks it, or a QR will not scan, type the participant's 8-character registration code (or paste the QR text) and press
 * "Submit Code". Both paths hit the same endpoint and the same rules (once-only check-in, roster and eligibility checks).
 */
export default function CheckInDesk({ title = 'Scan a code (operator)' }: { title?: string }) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [log, setLog] = useState<ScanLog[]>([]);
  const cameraBusy = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const push = (ok: boolean, text: string) => setLog((l) => [{ ok, text, at: new Date() }, ...l].slice(0, 6));

  /** Returns true when the person was checked in. */
  const checkIn = async (text: string): Promise<boolean> => {
    try {
      const r = await api.post<{ name: string; type: string; at: string }>('/checkin/scan', { token: text.trim() });
      push(true, `${r.name} checked in as ${r.type} at ${fmt(r.at)}`);
      toast(`${r.name} checked in`, 'ok');
      return true;
    } catch (e) {
      const expired = e instanceof ApiError && e.code === 'TOKEN_EXPIRED';
      push(false, expired ? 'Code expired — ask them to hold their screen steady until it refreshes, then scan again. Or type the code shown under their QR.' : errMsg(e));
      toast(expired ? 'QR code expired' : errMsg(e), 'error');
      return false;
    }
  };
  const fromCamera = (text: string) => {
    if (cameraBusy.current) return;
    cameraBusy.current = true;
    void checkIn(text).finally(() => setTimeout(() => (cameraBusy.current = false), SCAN_COOLDOWN_MS));
  };
  const fromKeyboard = async () => {
    if (pending || code.trim().length < 4) return;
    setPending(true);
    const done = await checkIn(code);
    setPending(false);
    if (done) setCode('');
    input.current?.focus(); // ready for the next person in the queue, or to fix a typo
  };

  return (
    <Card>
      <h2 className="mb-3 flex items-center gap-2 font-semibold">
        <ScanLine size={18} className="text-brand-600" /> {title}
      </h2>
      <QrScanner onScan={fromCamera} onUnavailable={() => input.current?.focus()} />
      <form
        className="mt-4 border-t border-slate-200/70 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void fromKeyboard();
        }}
      >
        <label htmlFor="manual-code" className="label flex items-center gap-1.5">
          <Keyboard size={14} className="text-brand-600" /> No camera? Enter the code manually
        </label>
        <div className="flex gap-2">
          <input
            id="manual-code"
            ref={input}
            className="input font-mono"
            placeholder="Registration code (K7QM-2XPA) or pasted QR text"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit" className="btn-primary shrink-0" disabled={pending || code.trim().length < 4}>
            <CheckCircle2 size={14} /> {pending ? 'Checking…' : 'Submit Code'}
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500">The participant sees their code under their QR on the Check-in page. Capital letters and the dash are optional.</p>
      </form>
      <ul className="mt-4 space-y-2" aria-live="polite">
        {log.length === 0 && (
          <li className="flex items-center gap-2 text-sm text-slate-500">
            <Clock size={14} /> Recent check-ins appear here.
          </li>
        )}
        {log.map((l, i) => (
          <li
            key={l.at.getTime() + i}
            className={`flex items-start gap-2 rounded-xl border p-2 text-sm [animation:pop-in_0.2s_ease-out] ${l.ok ? 'border-green-200 bg-green-50/80 text-green-900' : 'border-red-200 bg-red-50/80 text-red-900'}`}
          >
            {l.ok ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <XCircle size={16} className="mt-0.5 shrink-0" />}
            <span>{l.text}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
