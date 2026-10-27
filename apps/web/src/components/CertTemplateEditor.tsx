import { useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, ImageUp, Plus, RotateCcw, Trash2 } from 'lucide-react';
import {
  CERTIFICATE_TYPES,
  CERTIFICATE_TYPE_LABELS,
  CERT_BORDER_STYLES,
  CERT_FONT_STYLES,
  CERT_PLACEHOLDERS,
  CERT_TEMPLATE_LIMITS as L,
  CERT_THEME_COLORS,
  type CertBorderStyle,
  type CertFontStyle,
  type CertSampleKind,
  type CertTemplateTheme,
  type CertificateType,
} from '@festhub/shared';
import { useQueryClient } from '@tanstack/react-query';
import { api, assetUrl, errMsg, requestBlob, uploadFile } from '../lib/api';
import { useAct, useGet } from '../lib/hooks';
import { useConfirm, useToast } from './ui';

interface Signatory {
  name: string;
  title: string;
  imageUrl: string | null;
}
export interface Tpl {
  logoUrl: string | null;
  logo2Url: string | null;
  primaryColor: string;
  accentColor: string;
  theme: CertTemplateTheme;
  borderStyle: CertBorderStyle;
  fontStyle: CertFontStyle;
  sealEnabled: boolean;
  signatories: Signatory[];
  headlines: Record<CertificateType, string>;
  bodyText: string;
  customFields: { label: string; value: string }[];
}

const SAMPLES: { id: CertSampleKind; label: string }[] = [
  { id: 'individual', label: 'Individual' },
  { id: 'team3', label: 'Team of 3' },
  { id: 'team8', label: 'Team of 8' },
  { id: 'winner', label: 'Winner' },
];
const THEMES: CertTemplateTheme[] = ['royal', 'emerald', 'sunset', 'violet', 'custom'];
const THEME_LABEL = (t: CertTemplateTheme) => (t === 'custom' ? 'Custom colours' : CERT_THEME_COLORS[t].label);

/** What is sent to the API (PUT and preview). Images are never part of it: they have their own upload endpoints. */
function payload(f: Tpl) {
  return {
    theme: f.theme,
    primaryColor: f.primaryColor,
    accentColor: f.accentColor,
    borderStyle: f.borderStyle,
    fontStyle: f.fontStyle,
    sealEnabled: f.sealEnabled,
    signatories: f.signatories.map((s) => ({ name: s.name, title: s.title })),
    headlines: f.headlines,
    bodyText: f.bodyText,
    customFields: f.customFields,
  };
}
const halfFilled = (f: Tpl) => f.customFields.some((x) => !!x.label.trim() !== !!x.value.trim());

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className={`text-[11px] tabular-nums ${value.length >= max ? 'text-amber-600' : 'text-slate-400'}`}>
      {value.length}/{max}
    </span>
  );
}

export function ImageSlot({
  label,
  hint,
  url,
  canWrite,
  path,
  invalidate,
}: {
  label: string;
  hint: string;
  url: string | null;
  canWrite: boolean;
  path: string;
  invalidate: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: [invalidate] });
  const pick = async (f?: File) => {
    if (!f) return;
    if (!/^image\/(jpeg|png)$/.test(f.type)) return toast('Use a JPG or PNG image.', 'error');
    if (f.size > 2 * 1024 * 1024) return toast('Image is too large (max 2 MB).', 'error');
    setBusy(true);
    try {
      await uploadFile(path, f);
      refresh();
      toast(`${label} saved`, 'ok');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex items-center gap-3">
        <div className="grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed border-slate-300 bg-white/60 text-xs text-slate-400">
          {url ? <img src={assetUrl(url)} alt={label} className="max-h-full max-w-full object-contain" /> : 'None'}
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-1">
            <label className={`btn-ghost btn-sm cursor-pointer ${busy ? 'pointer-events-none opacity-60' : ''}`}>
              <ImageUp size={14} /> {busy ? 'Uploading…' : url ? 'Replace' : 'Upload'}
              <input
                type="file"
                accept="image/jpeg,image/png"
                className="sr-only"
                aria-label={`Upload ${label}`}
                onChange={(e) => {
                  void pick(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
            {url && (
              <button
                className="btn-danger-ghost btn-sm"
                onClick={async () => {
                  try {
                    await api.del(path);
                    refresh();
                  } catch (e) {
                    toast(errMsg(e), 'error');
                  }
                }}
              >
                <Trash2 size={14} /> Remove
              </button>
            )}
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">{hint}</p>
    </div>
  );
}

function Seg<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={disabled}
          onClick={() => onChange(o.id)}
          className={`btn-sm rounded-lg border px-3 py-1.5 text-sm ${value === o.id ? 'border-brand-500 bg-brand-50 font-semibold text-brand-700' : 'border-slate-200 bg-white/60 text-slate-600 hover:bg-slate-100'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Live PDF preview: POSTs the (unsaved) draft + sample kind, shows the real rendered PDF from a blob URL. */
function Preview({
  eventId,
  draft,
  sample,
  setSample,
  imageKey,
}: {
  eventId: string;
  draft: Tpl;
  sample: CertSampleKind;
  setSample: (s: CertSampleKind) => void;
  imageKey: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const urlRef = useRef<string | null>(null);
  const body = useMemo(
    () => ({ sample, template: { ...payload(draft), customFields: draft.customFields.filter((x) => x.label.trim() && x.value.trim()) } }),
    [draft, sample],
  );
  const key = JSON.stringify(body) + imageKey;
  useEffect(() => {
    const mine = ++seq.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const blob = await requestBlob('POST', `/events/${eventId}/certificate-template/preview`, body);
        if (mine !== seq.current) return; // a newer edit is already on its way
        const next = URL.createObjectURL(blob);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = next;
        setUrl(next);
        setErr('');
      } catch (e) {
        if (mine === seq.current) setErr(errMsg(e));
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [key, eventId]);
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="label !mb-0">Live preview (real PDF, sample data)</span>
        {url && (
          <a className="btn-ghost btn-sm" href={url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} /> Open full size
          </a>
        )}
      </div>
      <Seg label="Sample data" value={sample} options={SAMPLES} onChange={setSample} />
      <div className="relative w-full overflow-hidden rounded-xl border border-slate-200 bg-slate-100" style={{ aspectRatio: '842 / 595' }}>
        {url ? (
          <object
            data={`${url}#toolbar=0&navpanes=0&view=Fit`}
            type="application/pdf"
            aria-label="Certificate preview"
            className="absolute inset-0 h-full w-full"
          >
            <iframe title="Certificate preview" src={`${url}#toolbar=0&navpanes=0&view=Fit`} className="absolute inset-0 h-full w-full border-0" />
            <div className="grid h-full place-items-center p-4 text-center text-sm text-slate-500">
              <span>
                Your browser cannot show PDFs here.{' '}
                <a className="underline" href={url} target="_blank" rel="noreferrer">
                  Open the preview
                </a>
                .
              </span>
            </div>
          </object>
        ) : (
          <div className="grid h-full place-items-center text-sm text-slate-500">{err ? '' : 'Rendering preview…'}</div>
        )}
        {busy && url && <div className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">Updating…</div>}
      </div>
      {err && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </p>
      )}
      <p className="text-xs text-slate-500">The preview shows unsaved changes. Text uses the standard PDF fonts, so only Latin characters print correctly.</p>
    </div>
  );
}

export function CertTemplateEditor({ eventId, canWrite }: { eventId: string; canWrite: boolean }) {
  const base = `/events/${eventId}/certificate-template`;
  const q = useGet<Tpl>(base);
  const confirm = useConfirm();
  const toast = useToast();
  const [f, setF] = useState<Tpl | null>(null);
  const [sample, setSample] = useState<CertSampleKind>('individual');
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const saved = useRef('');
  useEffect(() => {
    const d = q.data;
    if (!d) return;
    // first load: take everything; later refetches (after an upload / save): only refresh the image URLs so typing is never overwritten
    setF((old) =>
      old
        ? {
            ...old,
            logoUrl: d.logoUrl,
            logo2Url: d.logo2Url,
            signatories: old.signatories.map((s, i) => ({ ...s, imageUrl: d.signatories[i]?.imageUrl ?? null })),
          }
        : d,
    );
    if (!saved.current) saved.current = JSON.stringify(payload(d));
  }, [q.data]);
  const save = useAct((t: Tpl) => api.put<Tpl>(base, payload({ ...t, customFields: t.customFields.filter((x) => x.label.trim() || x.value.trim()) })), {
    ok: 'Template saved',
    invalidate: [base],
    onDone: (r) => {
      saved.current = JSON.stringify(payload(r));
      setF(r);
    },
  });
  const reset = useAct(() => api.del<Tpl>(base), {
    ok: 'Template reset to default',
    invalidate: [base],
    onDone: (r) => {
      saved.current = JSON.stringify(payload(r));
      setF(r);
    },
  });
  if (q.isLoading || !f) return <div className="card text-sm text-slate-500">Loading template…</div>;
  const dirty = JSON.stringify(payload(f)) !== saved.current;
  const set = <K extends keyof Tpl>(k: K, v: Tpl[K]) => setF({ ...f, [k]: v });
  const setSig = (i: number, k: 'name' | 'title', v: string) =>
    set(
      'signatories',
      f.signatories.map((s, j) => (j === i ? { ...s, [k]: v } : s)),
    );
  const setField = (i: number, k: 'label' | 'value', v: string) =>
    set(
      'customFields',
      f.customFields.map((x, j) => (j === i ? { ...x, [k]: v } : x)),
    );
  const fieldChars = f.customFields.reduce((n, x) => n + x.label.length + x.value.length, 0);
  const ro = !canWrite;
  const imageKey = [f.logoUrl, f.logo2Url, ...f.signatories.map((s) => s.imageUrl)].join('|');
  const section = 'grid gap-3 border-t border-slate-200 pt-4 first:border-0 first:pt-0';

  const controls = (
    <div className="grid gap-5">
      <section className={section}>
        <h4 className="font-semibold">Look</h4>
        <div>
          <span className="label">Theme</span>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => {
              const c = t === 'custom' ? { primary: f.primaryColor, accent: f.accentColor } : CERT_THEME_COLORS[t];
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={f.theme === t}
                  disabled={ro}
                  onClick={() => set('theme', t)}
                  className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm ${f.theme === t ? 'border-brand-500 bg-brand-50 font-semibold text-brand-700' : 'border-slate-200 bg-white/60 text-slate-600 hover:bg-slate-100'}`}
                >
                  <span className="flex overflow-hidden rounded-full border border-slate-300" aria-hidden="true">
                    <i className="block h-5 w-5" style={{ background: c.primary }} />
                    <i className="block h-5 w-5" style={{ background: c.accent }} />
                  </span>
                  {THEME_LABEL(t)}
                </button>
              );
            })}
          </div>
        </div>
        {f.theme === 'custom' && (
          <div className="flex flex-wrap gap-4">
            {(['primaryColor', 'accentColor'] as const).map((k) => (
              <label key={k} className="block">
                <span className="label">{k === 'primaryColor' ? 'Main colour' : 'Accent colour'}</span>
                <span className="flex items-center gap-2">
                  <input
                    type="color"
                    className="h-10 w-14 cursor-pointer rounded-lg border border-slate-200 bg-transparent p-1"
                    value={f[k]}
                    disabled={ro}
                    onChange={(e) => set(k, e.target.value)}
                    aria-label={k === 'primaryColor' ? 'Main colour' : 'Accent colour'}
                  />
                  <code className="text-xs text-slate-500">{f[k]}</code>
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <span className="label">Border</span>
            <Seg
              label="Border style"
              value={f.borderStyle}
              disabled={ro}
              onChange={(v) => set('borderStyle', v)}
              options={CERT_BORDER_STYLES.map((b) => ({ id: b, label: b[0].toUpperCase() + b.slice(1) }))}
            />
          </div>
          <div>
            <span className="label">Font</span>
            <Seg
              label="Font style"
              value={f.fontStyle}
              disabled={ro}
              onChange={(v) => set('fontStyle', v)}
              options={CERT_FONT_STYLES.map((b) => ({ id: b, label: b === 'serif' ? 'Serif (Times)' : 'Sans (Helvetica)' }))}
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.sealEnabled} disabled={ro} onChange={(e) => set('sealEnabled', e.target.checked)} /> Show the medal seal (top right)
        </label>
      </section>

      <section className={section}>
        <h4 className="font-semibold">Logos</h4>
        <div className="grid gap-4 sm:grid-cols-2">
          <ImageSlot label="Main logo" hint="JPG or PNG, up to 2 MB. Top left." url={f.logoUrl} canWrite={canWrite} path={`${base}/logo`} invalidate={base} />
          <ImageSlot
            label="Second logo (optional)"
            hint="Top right, next to the seal."
            url={f.logo2Url}
            canWrite={canWrite}
            path={`${base}/logo2`}
            invalidate={base}
          />
        </div>
      </section>

      <section className={section}>
        <h4 className="font-semibold">
          Signatories <span className="text-xs font-normal text-slate-500">(up to {L.signatories}; empty ones are skipped)</span>
        </h4>
        <div className="grid gap-4">
          {f.signatories.map((s, i) => (
            <div key={i} className="grid gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-2">
              <ImageSlot
                label={`Signature image ${i + 1}`}
                hint="Transparent PNG works best."
                url={s.imageUrl}
                canWrite={canWrite}
                path={`${base}/signatory-${i + 1}`}
                invalidate={base}
              />
              <div className="grid gap-2">
                <label className="block">
                  <span className="label flex justify-between">
                    Name <Counter value={s.name} max={L.signatoryName} />
                  </span>
                  <input
                    className="input"
                    maxLength={L.signatoryName}
                    value={s.name}
                    disabled={ro}
                    onChange={(e) => setSig(i, 'name', e.target.value)}
                    placeholder="Dr. A. Rahman"
                  />
                </label>
                <label className="block">
                  <span className="label flex justify-between">
                    Title / position <Counter value={s.title} max={L.signatoryTitle} />
                  </span>
                  <input
                    className="input"
                    maxLength={L.signatoryTitle}
                    value={s.title}
                    disabled={ro}
                    onChange={(e) => setSig(i, 'title', e.target.value)}
                    placeholder="Convener, PUB FestHub"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className={section}>
        <h4 className="font-semibold">
          Headline per certificate type <span className="text-xs font-normal text-slate-500">(empty = default)</span>
        </h4>
        <div className="grid gap-3 sm:grid-cols-2">
          {CERTIFICATE_TYPES.map((t) => (
            <label key={t} className="block">
              <span className="label flex justify-between">
                {CERTIFICATE_TYPE_LABELS[t]} <Counter value={f.headlines[t]} max={L.headline} />
              </span>
              <input
                className="input"
                maxLength={L.headline}
                value={f.headlines[t]}
                disabled={ro}
                onChange={(e) => set('headlines', { ...f.headlines, [t]: e.target.value })}
                placeholder={`CERTIFICATE OF ${CERTIFICATE_TYPE_LABELS[t].toUpperCase()}`}
              />
            </label>
          ))}
        </div>
      </section>

      <section className={section}>
        <h4 className="font-semibold">
          Body text <span className="text-xs font-normal text-slate-500">(empty = standard wording)</span>
        </h4>
        <label className="block">
          <span className="label flex justify-between">
            Custom paragraph <Counter value={f.bodyText} max={L.bodyText} />
          </span>
          <textarea
            className="input min-h-[96px]"
            maxLength={L.bodyText}
            value={f.bodyText}
            disabled={ro}
            onChange={(e) => set('bodyText', e.target.value)}
            placeholder="This certificate is proudly presented to {name} for {position} in {event}, held on {date} at {venue}."
          />
        </label>
        {canWrite && (
          <div className="flex flex-wrap gap-1.5" aria-label="Insert placeholder">
            {CERT_PLACEHOLDERS.map((p) => (
              <button
                key={p}
                type="button"
                className="btn-ghost btn-sm font-mono"
                onClick={() => set('bodyText', `${f.bodyText}${f.bodyText && !f.bodyText.endsWith(' ') ? ' ' : ''}{${p}}`.slice(0, L.bodyText))}
              >
                {`{${p}}`}
              </button>
            ))}
          </div>
        )}
        <p className="text-xs text-slate-500">
          {'{team}'} and {'{members}'} are empty on individual certificates. Too-long text is shrunk or cut with "..." so it can never overflow.
        </p>
      </section>

      <section className={section}>
        <h4 className="font-semibold">
          Custom fields <span className="text-xs font-normal text-slate-500">(up to {L.fields}, e.g. Organized by, Awarded at, Motto)</span>
        </h4>
        {f.customFields.map((x, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto] items-end gap-2 sm:grid-cols-[1fr_2fr_auto]">
            <label className="block">
              <span className="label">Label</span>
              <input
                className="input"
                maxLength={L.fieldLabel}
                value={x.label}
                disabled={ro}
                onChange={(e) => setField(i, 'label', e.target.value)}
                placeholder="Organized by"
              />
            </label>
            <label className="order-last col-span-2 block sm:order-none sm:col-span-1">
              <span className="label">Value</span>
              <input
                className="input"
                maxLength={L.fieldValue}
                value={x.value}
                disabled={ro}
                onChange={(e) => setField(i, 'value', e.target.value)}
                placeholder="Dept. of CSE, PUB"
              />
            </label>
            {canWrite && (
              <button
                className="btn-danger-ghost btn-sm mb-1"
                aria-label={`Remove field ${i + 1}`}
                onClick={() =>
                  set(
                    'customFields',
                    f.customFields.filter((_, j) => j !== i),
                  )
                }
              >
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          {canWrite && f.customFields.length < L.fields && (
            <button className="btn-ghost btn-sm" onClick={() => set('customFields', [...f.customFields, { label: '', value: '' }])}>
              <Plus size={14} /> Add field
            </button>
          )}
          <span className={`text-xs ${fieldChars > L.fieldsTotal ? 'text-red-600' : 'text-slate-500'}`}>
            {fieldChars}/{L.fieldsTotal} characters in total
          </span>
          {halfFilled(f) && <span className="text-xs text-amber-600">Each field needs a label and a value.</span>}
        </div>
      </section>

      {canWrite && (
        <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 rounded-xl bg-white/90 p-2 backdrop-blur dark:bg-transparent">
          <button className="btn-primary" disabled={save.isPending || !dirty || halfFilled(f) || fieldChars > L.fieldsTotal} onClick={() => save.mutate(f)}>
            {save.isPending ? 'Saving…' : 'Save template'}
          </button>
          <button
            className="btn-ghost"
            disabled={reset.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: 'Reset the certificate template?',
                  message:
                    'Removes the logos, signature images and all text options of this event and restores the default look. Issued certificates are not deleted.',
                  confirmText: 'Reset',
                  tone: 'danger',
                })
              )
                reset.mutate();
            }}
          >
            <RotateCcw size={14} /> Reset to default
          </button>
          {dirty ? (
            <span className="text-xs text-amber-600">Unsaved changes</span>
          ) : (
            <span className="text-xs text-slate-500">Applies to every PDF of this event, including ones already issued.</span>
          )}
        </div>
      )}
      {!canWrite && (
        <p className="text-xs text-slate-500" onClick={() => toast('Only organizers can edit the template', 'ok')}>
          Read-only: only organizers can change the template.
        </p>
      )}
    </div>
  );

  return (
    <div className="card grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Certificate template</h3>
        {canWrite && (
          <div className="lg:hidden" role="tablist" aria-label="Editor or preview">
            <Seg
              label="Editor or preview"
              value={tab}
              onChange={setTab}
              options={[
                { id: 'edit', label: 'Edit' },
                { id: 'preview', label: 'Preview' },
              ]}
            />
          </div>
        )}
      </div>
      <div className={`grid gap-6 ${canWrite ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : ''}`}>
        <div className={canWrite && tab === 'preview' ? 'hidden lg:block' : ''}>{controls}</div>
        {canWrite && (
          <div className={`lg:sticky lg:top-4 lg:self-start ${tab === 'edit' ? 'hidden lg:block' : ''}`}>
            <Preview eventId={eventId} draft={f} sample={sample} setSample={setSample} imageKey={imageKey} />
          </div>
        )}
      </div>
    </div>
  );
}
