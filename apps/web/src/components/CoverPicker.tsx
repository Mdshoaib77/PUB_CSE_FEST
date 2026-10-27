import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ImagePlus, Link2, Loader2, Trash2, UploadCloud } from 'lucide-react';
import { assetUrl, errMsg, uploadFile } from '../lib/api';
import { useToast } from './ui';
import EventCover from './EventCover';

const MAX_MB = 5;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Cover image picker: drag & drop / browse (uploaded straight away with a real progress bar) or paste an image URL.
 * Calls onChange with the stored URL ('' = no image). The live preview uses the exact component the event card/hero use.
 */
export default function CoverPicker({ value, onChange, title, type, noun = 'event' }: { value: string; onChange: (v: string) => void; title: string; type: string; noun?: 'event' | 'contest' }) {
  const toast = useToast();
  const [mode, setMode] = useState<'upload' | 'url'>('upload');
  const [pct, setPct] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const [err, setErr] = useState('');
  const [url, setUrl] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const pick = async (file?: File) => {
    if (!file) return;
    setErr('');
    if (!OK_TYPES.includes(file.type)) return setErr('Use a JPG, PNG, WebP or GIF image.');
    if (file.size > MAX_MB * 1024 * 1024) return setErr(`That image is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MAX_MB} MB.`);
    setPct(0);
    try {
      const r = await uploadFile<{ url: string }>('/uploads/event-image', file, setPct);
      onChange(r.url);
      toast('Cover image uploaded', 'ok');
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setPct(null);
    }
  };
  const applyUrl = () => {
    if (!/^https?:\/\/\S+$/i.test(url.trim())) return setErr('Enter a full http(s) image address.');
    setErr('');
    onChange(url.trim());
    setUrl('');
  };

  return (
    <div className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
      <div>
        <div className="mb-2 inline-flex rounded-xl border border-white/80 bg-white/60 p-0.5 text-sm font-semibold" role="tablist">
          {([['upload', 'Upload', UploadCloud], ['url', 'Image URL', Link2]] as const).map(([k, label, Icon]) => (
            <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => setMode(k)} className={`relative inline-flex items-center gap-1.5 rounded-[0.65rem] px-3 py-1.5 transition-colors ${mode === k ? 'text-white' : 'text-slate-600'}`}>
              {mode === k && <motion.span layoutId="cover-mode" className="absolute inset-0 rounded-[0.65rem] bg-gradient-to-br from-brand-600 to-brand-800" transition={{ type: 'spring', stiffness: 450, damping: 34 }} />}
              <Icon size={14} className="relative" />
              <span className="relative">{label}</span>
            </button>
          ))}
        </div>
        {mode === 'upload' ? (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              void pick(e.dataTransfer.files?.[0]);
            }}
            className={`relative grid min-h-[11rem] place-items-center rounded-2xl border-2 border-dashed p-5 text-center transition ${drag ? 'scale-[1.01] border-brand-500 bg-brand-50' : 'border-slate-300 bg-white/50 hover:border-brand-400'}`}
          >
            <input ref={input} type="file" accept={OK_TYPES.join(',')} className="sr-only" aria-label="Upload cover image" onChange={(e) => void pick(e.target.files?.[0]).then(() => (e.target.value = ''))} />
            {pct !== null ? (
              <div className="w-full max-w-xs" role="status" aria-label="Uploading">
                <Loader2 className="mx-auto mb-2 animate-spin text-brand-600" />
                <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                  <motion.div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-coral-500" animate={{ width: `${pct}%` }} />
                </div>
                <p className="mt-2 text-xs text-slate-500">Uploading… {pct}%</p>
              </div>
            ) : (
              <button type="button" className="flex flex-col items-center gap-1.5" onClick={() => input.current?.click()}>
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br from-brand-500/15 to-coral-500/15 text-brand-600">
                  <ImagePlus size={22} />
                </span>
                <span className="text-sm font-semibold text-slate-800">{value ? 'Replace image' : 'Drop an image here, or browse'}</span>
                <span className="text-xs text-slate-500">JPG, PNG, WebP or GIF · up to {MAX_MB} MB · 16:9 looks best</span>
              </button>
            )}
          </div>
        ) : (
          <div className="flex gap-2">
            <input className="input" type="url" placeholder="https://…/cover.jpg" aria-label="Image URL" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), applyUrl())} />
            <button type="button" className="btn-primary" onClick={applyUrl}>
              Use
            </button>
          </div>
        )}
        <AnimatePresence>
          {err && (
            <motion.p initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden pt-2 text-sm font-medium text-red-600" role="alert">
              {err}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
      <div>
        <div className="mb-2 flex items-center justify-between text-sm font-medium text-slate-700">
          Preview
          {value && (
            <button type="button" className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 hover:underline" onClick={() => onChange('')}>
              <Trash2 size={12} /> Remove image
            </button>
          )}
        </div>
        <EventCover key={assetUrl(value)} title={title || `Your ${noun} title`} type={type} imageUrl={value} className="aspect-video rounded-2xl shadow-lift">
          <div className="flex h-full items-end p-3">
            <span className="line-clamp-2 font-display text-lg font-bold leading-tight text-white">{title || `Your ${noun} title`}</span>
          </div>
        </EventCover>
        <p className="mt-1.5 text-xs text-slate-500">{value ? `This is how the ${noun} card and banner will look.` : 'No image? A tasteful generated cover is used instead.'}</p>
      </div>
    </div>
  );
}

