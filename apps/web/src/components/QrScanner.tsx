import { useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Loader2, TriangleAlert } from 'lucide-react';

/**
 * Webcam / phone-camera QR viewport built on html5-qrcode.
 *
 * Why this exists instead of `start({ facingMode: 'environment' })`: html5-qrcode turns a plain facingMode string into
 * `{ exact: 'environment' }`. Phones have a back camera so that works, but laptops and desktops only have a front/webcam, the
 * browser answers OverconstrainedError, and the scanner reported "camera unavailable" even though the webcam was fine.
 * Here we ask the browser which cameras exist and start one by its deviceId, so any device with a camera works.
 */
export interface QrScannerProps {
  /** Called with the decoded text. The same text is not repeated for 3 seconds. */
  onScan: (text: string) => void;
  /** Called when the camera cannot be used, so the page can point people at the manual code box. */
  onUnavailable?: (reason: string) => void;
}
interface Cam {
  id: string;
  label: string;
}

const ELEMENT_ID = 'festhub-qr-reader';
const LAST_CAMERA_KEY = 'festhub.scanner.camera';
const readLast = () => {
  try {
    return localStorage.getItem(LAST_CAMERA_KEY) ?? '';
  } catch {
    return '';
  }
};
const saveLast = (id: string) => {
  try {
    localStorage.setItem(LAST_CAMERA_KEY, id);
  } catch {
    /* private mode: the choice just is not remembered */
  }
};

const IR_OR_DEPTH = /\b(ir|infra-?red|depth)\b/i; // Windows Hello sensors: they are cameras, but show a black image
const BACK = /back|rear|environment|world/i;
const isPhone = () => typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

/** Order in which cameras are tried: the one used last time, then (phones only) the back camera, then anything that is not an IR sensor. */
export function cameraOrder(cams: Cam[], lastUsed = '', phone = isPhone()): Cam[] {
  const score = (c: Cam) => (c.id === lastUsed ? 0 : phone && BACK.test(c.label) ? 1 : IR_OR_DEPTH.test(c.label) ? 9 : 5);
  return [...cams].sort((a, b) => score(a) - score(b));
}

/** Turns the many shapes of "camera error" (DOMException, string, Error) into one sentence a volunteer can act on. */
export function describeCameraError(e: unknown): string {
  const raw = typeof e === 'string' ? e : `${(e as { name?: string })?.name ?? ''} ${(e as { message?: string })?.message ?? ''}`;
  if (/NotAllowed|Permission|denied|dismissed/i.test(raw)) return 'Camera access was blocked. Allow the camera for this site in your browser (padlock icon in the address bar), or use the manual code box below.';
  if (/NotFound|DevicesNotFound|no camera|Requested device not found/i.test(raw)) return 'No camera was found on this device. Use the manual code box below.';
  if (/NotReadable|TrackStart|in use|Could not start video source|Device in use/i.test(raw)) return 'The camera is busy in another app or tab. Close it there and press Start camera again, or use the manual code box below.';
  if (/Overconstrained|Constraint/i.test(raw)) return 'This camera could not be started. Try another camera from the list, or use the manual code box below.';
  return 'The camera could not be started. Use the manual code box below, or try again.';
}

export default function QrScanner({ onScan, onUnavailable }: QrScannerProps) {
  const [on, setOn] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'starting' | 'live' | 'error'>('idle');
  const [error, setError] = useState('');
  const [cams, setCams] = useState<Cam[]>([]);
  const [wanted, setWanted] = useState(readLast); // camera the user picked (or used last time)
  const [active, setActive] = useState(''); // camera that is actually running
  const latest = useRef({ onScan, onUnavailable });
  latest.current = { onScan, onUnavailable };
  const lastSeen = useRef({ text: '', at: 0 });

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    let scanner: import('html5-qrcode').Html5Qrcode | null = null;
    const fail = (message: string) => {
      if (cancelled) return;
      setError(message);
      setPhase('error');
      setOn(false);
      latest.current.onUnavailable?.(message);
    };
    void (async () => {
      setPhase('starting');
      setError('');
      if (typeof window !== 'undefined' && (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia))
        return fail('Browsers only allow the camera on https:// pages or on localhost. Open FestHub over HTTPS (or http://localhost), or use the manual code box below.');
      const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode');
      if (cancelled) return;
      let list: Cam[];
      try {
        list = await Html5Qrcode.getCameras(); // also triggers the permission prompt
      } catch (e) {
        return fail(describeCameraError(e));
      }
      if (cancelled) return;
      if (!list.length) return fail(describeCameraError('NotFoundError'));
      setCams(list);
      const s = new Html5Qrcode(ELEMENT_ID, { verbose: false, formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE], useBarCodeDetectorIfSupported: true });
      scanner = s;
      let started: Cam | null = null;
      let lastError: unknown;
      for (const cam of cameraOrder(list, wanted).slice(0, 3)) {
        try {
          await s.start(
            cam.id, // a deviceId string: works for any camera, unlike facingMode "exact"
            {
              fps: 10,
              qrbox: (w: number, h: number) => {
                const side = Math.max(120, Math.floor(Math.min(w, h) * 0.75));
                return { width: side, height: side };
              },
            },
            (text) => {
              const now = Date.now();
              if (text === lastSeen.current.text && now - lastSeen.current.at < 3000) return;
              lastSeen.current = { text, at: now };
              latest.current.onScan(text);
            },
            () => undefined,
          );
          started = cam;
          break;
        } catch (e) {
          lastError = e;
          if (/NotAllowed|Permission|denied/i.test(String((e as Error)?.name ?? e))) break; // another camera will not help
        }
      }
      if (cancelled) {
        // the user switched or stopped while the camera was still opening
        if (started) await s.stop().then(() => s.clear()).catch(() => undefined);
        return;
      }
      if (!started) {
        scanner = null;
        return fail(describeCameraError(lastError));
      }
      setActive(started.id);
      setPhase('live');
    })();
    return () => {
      cancelled = true;
      const s = scanner;
      scanner = null;
      if (s) void s.stop().then(() => s.clear()).catch(() => undefined);
    };
  }, [on, wanted]);

  const toggle = () => {
    if (on) {
      setOn(false);
      setPhase('idle');
    } else setOn(true);
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-ghost" onClick={toggle} aria-pressed={on}>
          {on ? <CameraOff size={14} /> : <Camera size={14} />} {on ? 'Stop camera' : 'Start camera'}
        </button>
        {cams.length > 1 && (
          <select
            className="input max-w-[14rem]"
            aria-label="Camera"
            value={active || wanted}
            onChange={(e) => {
              saveLast(e.target.value);
              setWanted(e.target.value);
              setOn(true);
            }}
          >
            {cams.map((c, i) => (
              <option key={c.id} value={c.id}>
                {c.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className={on || phase === 'starting' ? 'relative mt-2' : 'hidden'}>
        <div id={ELEMENT_ID} className="mx-auto w-full max-w-sm overflow-hidden rounded-2xl bg-slate-900/90 ring-2 ring-brand-500/30 [&_video]:w-full" />
        {phase === 'starting' && (
          <div className="absolute inset-0 grid place-items-center rounded-2xl bg-slate-900/60 text-sm text-white" role="status">
            <span className="flex items-center gap-2">
              <Loader2 size={16} className="animate-spin" /> Starting camera…
            </span>
          </div>
        )}
      </div>
      {phase === 'live' && <p className="mt-1 text-center text-xs text-slate-500">Hold the participant’s QR code inside the square.</p>}
      {phase === 'error' && (
        <p className="mt-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-sm text-amber-900" role="alert">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" /> {error}
        </p>
      )}
    </div>
  );
}
