/** Certificate template + safe branding images (S6). Images: JPG/PNG only (no SVG/GIF/WebP), magic-byte checked, size limited, random names. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';
import multer from 'multer';
import { env } from '../config/env';
import { badRequest, AppError } from '../utils/errors';
import { CERTIFICATE_TYPES, CERT_BORDER_STYLES, CERT_FONT_STYLES, CERT_TEMPLATE_LIMITS, CERT_TEMPLATE_THEMES, cleanTemplateText, type CertBorderStyle, type CertFontStyle, type CertSampleKind, type CertTemplateInput, type CertTemplateTheme, type CertificateType } from '@festhub/shared';
import { CertificateTemplate } from '../models';
import type { CertificatePdfInput } from './certificatePdf';

export const CERT_IMAGE_DIR = path.join(env.uploadDir, 'certs');
export const CERT_IMAGE_PREFIX = '/uploads/certs/';
const SAFE = /^[a-f0-9]{24}\.(jpg|png)$/;
export const CERT_IMAGE_MAX = Math.min(env.maxImageBytes, 2 * 1024 * 1024); // 2 MB cap for logos/signatures
export const HEX = /^#[0-9a-fA-F]{6}$/;

export const certImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CERT_IMAGE_MAX, files: 1, fields: 0 } });

export function detectCertImage(b: Buffer): 'jpg' | 'png' | null {
  if (b.length < 24) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}
export async function saveCertImage(buf: Buffer): Promise<string> {
  const ext = detectCertImage(buf);
  if (!ext) throw badRequest('Use a JPG or PNG image.');
  await fs.promises.mkdir(CERT_IMAGE_DIR, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(CERT_IMAGE_DIR, name), buf, { flag: 'wx' });
  return `${CERT_IMAGE_PREFIX}${name}`;
}
export async function removeCertImage(url?: string | null) {
  if (!url || !url.startsWith(CERT_IMAGE_PREFIX)) return;
  const n = url.slice(CERT_IMAGE_PREFIX.length);
  if (SAFE.test(n)) await fs.promises.unlink(path.join(CERT_IMAGE_DIR, n)).catch(() => undefined);
}
export async function readCertImage(url?: string | null): Promise<Buffer | null> {
  if (!url || !url.startsWith(CERT_IMAGE_PREFIX)) return null;
  const n = url.slice(CERT_IMAGE_PREFIX.length);
  if (!SAFE.test(n)) return null;
  return fs.promises.readFile(path.join(CERT_IMAGE_DIR, n)).catch(() => null);
}
export function mapCertUploadError(e: unknown): unknown {
  const code = (e as { code?: string })?.code;
  if (code === 'LIMIT_FILE_SIZE') return new AppError(413, 'FILE_TOO_LARGE', `Image is too large. The limit is ${(CERT_IMAGE_MAX / 1048576).toFixed(0)} MB.`);
  if (code === 'LIMIT_UNEXPECTED_FILE' || code === 'LIMIT_FILE_COUNT') return badRequest('Upload exactly one image in the "file" field');
  if ((e as { name?: string })?.name === 'MulterError') return badRequest('Upload failed');
  return e;
}

// ---------------------------------------------------------------- template view / update (S6, extended in v6)
export type ImageSlot = 'logo' | 'logo2' | 'sig1' | 'sig2' | 'sig3';
export const IMAGE_SLOTS: readonly ImageSlot[] = ['logo', 'logo2', 'sig1', 'sig2', 'sig3'];
export interface SignatoryView {
  name: string;
  title: string;
  imageUrl: string | null;
}
const L = CERT_TEMPLATE_LIMITS;
const blankSigs = (): SignatoryView[] => [0, 1, 2].map(() => ({ name: '', title: '', imageUrl: null }));
const blankHeadlines = (): Record<CertificateType, string> => Object.fromEntries(CERTIFICATE_TYPES.map((t) => [t, ''])) as Record<CertificateType, string>;
export const TEMPLATE_DEFAULTS = {
  logoUrl: null as string | null,
  logo2Url: null as string | null,
  signatureImageUrl: null as string | null, // legacy mirror of signatories[0]
  signatureName: '', // legacy mirror of signatories[0]
  signatureTitle: '', // legacy mirror of signatories[0]
  primaryColor: '#4f46e5',
  accentColor: '#d94c33',
  theme: 'custom' as CertTemplateTheme,
  borderStyle: 'classic' as CertBorderStyle,
  fontStyle: 'serif' as CertFontStyle,
  sealEnabled: true,
  signatories: blankSigs(),
  headlines: blankHeadlines(),
  bodyText: '',
  customFields: [] as { label: string; value: string }[],
};
export type TemplateView = typeof TEMPLATE_DEFAULTS;
export const defaultTemplate = (): TemplateView => ({ ...TEMPLATE_DEFAULTS, signatories: blankSigs(), headlines: blankHeadlines(), customFields: [] });

const clip = (v: unknown, max: number) => (typeof v === 'string' ? cleanTemplateText(v).slice(0, max) : '');
const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => ((list as readonly string[]).includes(v as string) ? (v as T) : fallback);
type RawTemplate = Record<string, unknown> | null | undefined;

/** Normalise a stored document (any age) into the full view. Pure: also used by tests. Bad / missing values fall back to defaults and every text is clipped to its limit. */
export function templateView(t: RawTemplate): TemplateView {
  const d = defaultTemplate();
  if (!t) return d;
  const str = (k: string) => (typeof t[k] === 'string' ? (t[k] as string) : null);
  const hex = (k: string, fb: string) => (HEX.test(str(k) ?? '') ? str(k)! : fb);
  const stored = Array.isArray(t.signatories) ? (t.signatories as Record<string, unknown>[]) : null;
  const rows = stored ?? [{ name: t.signatureName, title: t.signatureTitle, imageUrl: t.signatureImageUrl }];
  const signatories = blankSigs().map((blank, i) => {
    const r = rows[i];
    return r ? { name: clip(r.name, L.signatoryName), title: clip(r.title, L.signatoryTitle), imageUrl: typeof r.imageUrl === 'string' && r.imageUrl ? r.imageUrl : null } : blank;
  });
  const rawHead = t.headlines instanceof Map ? Object.fromEntries(t.headlines) : ((t.headlines as Record<string, unknown> | undefined) ?? {});
  const headlines = blankHeadlines();
  for (const k of CERTIFICATE_TYPES) headlines[k] = clip(rawHead[k], L.headline);
  const fields = (Array.isArray(t.customFields) ? (t.customFields as Record<string, unknown>[]) : [])
    .slice(0, L.fields)
    .map((f) => ({ label: clip(f.label, L.fieldLabel), value: clip(f.value, L.fieldValue) }))
    .filter((f) => f.label && f.value);
  return {
    logoUrl: str('logoUrl') || null,
    logo2Url: str('logo2Url') || null,
    signatureImageUrl: signatories[0].imageUrl,
    signatureName: signatories[0].name,
    signatureTitle: signatories[0].title,
    primaryColor: hex('primaryColor', d.primaryColor),
    accentColor: hex('accentColor', d.accentColor),
    theme: pick(t.theme, CERT_TEMPLATE_THEMES, 'custom'),
    borderStyle: pick(t.borderStyle, CERT_BORDER_STYLES, 'classic'),
    fontStyle: pick(t.fontStyle, CERT_FONT_STYLES, 'serif'),
    sealEnabled: t.sealEnabled === false ? false : true,
    signatories,
    headlines,
    bodyText: clip(t.bodyText, L.bodyText),
    customFields: fields,
  };
}

export async function getTemplate(eventId: string | null | undefined): Promise<TemplateView> {
  if (!eventId || !/^[a-f0-9]{24}$/i.test(String(eventId))) return defaultTemplate();
  return templateView(await CertificateTemplate.findOne({ eventId }).lean<Record<string, unknown>>());
}

/** Apply validated input on top of a view (no database). Used by the PUT route and by the live preview (unsaved edits). */
export function mergeTemplateInput(base: TemplateView, input: CertTemplateInput): TemplateView {
  const v: TemplateView = { ...base, signatories: base.signatories.map((s) => ({ ...s })), headlines: { ...base.headlines }, customFields: base.customFields.map((f) => ({ ...f })) };
  if (input.theme !== undefined) v.theme = input.theme;
  if (input.primaryColor !== undefined) v.primaryColor = input.primaryColor;
  if (input.accentColor !== undefined) v.accentColor = input.accentColor;
  if (input.borderStyle !== undefined) v.borderStyle = input.borderStyle;
  if (input.fontStyle !== undefined) v.fontStyle = input.fontStyle;
  if (input.sealEnabled !== undefined) v.sealEnabled = input.sealEnabled;
  if (input.bodyText !== undefined) v.bodyText = input.bodyText;
  if (input.customFields !== undefined) v.customFields = input.customFields;
  if (input.headlines) for (const k of CERTIFICATE_TYPES) if (input.headlines[k] !== undefined) v.headlines[k] = input.headlines[k]!;
  // legacy single-signatory fields edit signatory 1; the array (when sent) wins
  if (input.signatureName !== undefined) v.signatories[0].name = input.signatureName;
  if (input.signatureTitle !== undefined) v.signatories[0].title = input.signatureTitle;
  input.signatories?.forEach((s, i) => {
    if (i < 3) v.signatories[i] = { name: s.name, title: s.title, imageUrl: v.signatories[i].imageUrl };
  });
  v.signatureName = v.signatories[0].name;
  v.signatureTitle = v.signatories[0].title;
  v.signatureImageUrl = v.signatories[0].imageUrl;
  return v;
}

async function upsertTemplate(eventId: string, update: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await CertificateTemplate.findOneAndUpdate({ eventId }, update, { upsert: true, new: false, setDefaultsOnInsert: true });
    } catch (e) {
      if ((e as { code?: number }).code !== 11000 || attempt > 0) throw e; // lost the unique-index race to a parallel upsert: retry once as a plain update
    }
  }
}

/** Persist validated input (partial update, atomic $set). Returns the saved view. */
export async function saveTemplateInput(eventId: string, input: CertTemplateInput, userId: string): Promise<TemplateView> {
  const next = mergeTemplateInput(await getTemplate(eventId), input);
  const $set: Record<string, unknown> = { updatedBy: userId };
  for (const k of ['theme', 'primaryColor', 'accentColor', 'borderStyle', 'fontStyle', 'sealEnabled', 'bodyText'] as const) if (input[k] !== undefined) $set[k] = next[k];
  if (input.customFields !== undefined) $set.customFields = next.customFields;
  if (input.headlines) $set.headlines = next.headlines;
  if (input.signatories !== undefined || input.signatureName !== undefined || input.signatureTitle !== undefined) {
    $set.signatories = next.signatories.map((s) => ({ name: s.name, title: s.title, ...(s.imageUrl ? { imageUrl: s.imageUrl } : {}) }));
    $set.signatureName = next.signatureName; // legacy mirror
    $set.signatureTitle = next.signatureTitle;
  }
  await upsertTemplate(eventId, { $set });
  return getTemplate(eventId);
}

/** Make sure the signatories array exists (copied from the legacy fields) so a single slot can be updated atomically. */
async function ensureSignatories(eventId: string) {
  await upsertTemplate(eventId, { $setOnInsert: { eventId } });
  const doc = await CertificateTemplate.findOne({ eventId }).lean<Record<string, unknown>>();
  if (doc && !Array.isArray(doc.signatories)) {
    const v = templateView(doc);
    await CertificateTemplate.updateOne({ eventId, signatories: { $exists: false } }, { $set: { signatories: v.signatories.map((s) => ({ name: s.name, title: s.title, ...(s.imageUrl ? { imageUrl: s.imageUrl } : {}) })) } });
  }
}
const slotIndex = (slot: ImageSlot) => (slot === 'sig1' ? 0 : slot === 'sig2' ? 1 : 2);
/** Store a new image URL in a slot; returns the URL it replaced (the caller deletes that file). */
export async function setTemplateImage(eventId: string, slot: ImageSlot, url: string, userId: string): Promise<string | null> {
  if (slot === 'logo' || slot === 'logo2') {
    const key = slot === 'logo' ? 'logoUrl' : 'logo2Url';
    const prev = await upsertTemplate(eventId, { $set: { [key]: url, updatedBy: userId } });
    return ((prev as unknown as Record<string, string | undefined> | null)?.[key]) ?? null;
  }
  await ensureSignatories(eventId);
  const i = slotIndex(slot);
  const prev = templateView(await CertificateTemplate.findOne({ eventId }).lean<Record<string, unknown>>()).signatories[i].imageUrl;
  await CertificateTemplate.updateOne({ eventId }, { $set: { [`signatories.${i}.imageUrl`]: url, updatedBy: userId, ...(i === 0 ? { signatureImageUrl: url } : {}) } });
  return prev;
}
export async function clearTemplateImage(eventId: string, slot: ImageSlot): Promise<string | null> {
  if (slot === 'logo' || slot === 'logo2') {
    const key = slot === 'logo' ? 'logoUrl' : 'logo2Url';
    const prev = await CertificateTemplate.findOneAndUpdate({ eventId }, { $unset: { [key]: 1 } }, { new: false });
    return ((prev as unknown as Record<string, string | undefined> | null)?.[key]) ?? null;
  }
  if (!(await CertificateTemplate.exists({ eventId }))) return null;
  await ensureSignatories(eventId);
  const i = slotIndex(slot);
  const prev = templateView(await CertificateTemplate.findOne({ eventId }).lean<Record<string, unknown>>()).signatories[i].imageUrl;
  await CertificateTemplate.updateOne({ eventId }, { $unset: { [`signatories.${i}.imageUrl`]: 1, ...(i === 0 ? { signatureImageUrl: 1 } : {}) } });
  return prev;
}
/** Reset to default: deletes the template document and every image file it owned. */
export async function resetTemplate(eventId: string): Promise<void> {
  const old = await CertificateTemplate.findOneAndDelete({ eventId }).lean<Record<string, unknown>>();
  if (!old) return;
  const v = templateView(old);
  const urls = new Set<string | null>([v.logoUrl, v.logo2Url, ...v.signatories.map((s) => s.imageUrl), typeof old.signatureImageUrl === 'string' ? old.signatureImageUrl : null]);
  await Promise.all([...urls].map((u) => removeCertImage(u)));
}

// ---------------------------------------------------------------- template -> PDF input
export interface TemplateAssets {
  logoBuf?: Buffer;
  logo2Buf?: Buffer;
  sigBufs: (Buffer | undefined)[];
}
export async function loadTemplateAssets(v: TemplateView): Promise<TemplateAssets> {
  const [logo, logo2, ...sigs] = await Promise.all([readCertImage(v.logoUrl), readCertImage(v.logo2Url), ...v.signatories.map((s) => readCertImage(s.imageUrl))]);
  return { logoBuf: logo ?? undefined, logo2Buf: logo2 ?? undefined, sigBufs: sigs.map((b) => b ?? undefined) };
}
export interface CertificateFacts {
  certId: string;
  type: CertificateType;
  recipientName: string;
  eventTitle: string;
  eventDate: Date;
  positionLabel?: string;
  signatureText?: string;
  verifyUrl: string;
  revoked?: boolean;
  teamName?: string;
  members?: string[];
  venue?: string;
}
/** Everything the pdfkit renderer needs: certificate facts + every template option + the loaded images. */
export function templateToPdfInput(v: TemplateView, assets: TemplateAssets, c: CertificateFacts): CertificatePdfInput {
  const signatories = v.signatories.map((s, i) => ({ name: s.name, title: s.title, imageBuf: assets.sigBufs[i] })).filter((s) => s.name || s.title || s.imageBuf);
  return {
    certId: c.certId,
    type: c.type,
    recipientName: c.recipientName,
    eventTitle: c.eventTitle,
    eventDate: c.eventDate,
    positionLabel: c.positionLabel,
    signatureText: c.signatureText ?? '',
    verifyUrl: c.verifyUrl,
    revoked: c.revoked,
    teamName: c.teamName,
    members: c.members,
    venue: c.venue,
    signatories,
    logoBuf: assets.logoBuf,
    logo2Buf: assets.logo2Buf,
    brand: {
      theme: v.theme === 'custom' ? undefined : v.theme,
      primaryColor: v.primaryColor,
      accentColor: v.accentColor,
      signatureName: v.signatureName,
      signatureTitle: v.signatureTitle,
      borderStyle: v.borderStyle,
      fontStyle: v.fontStyle,
      sealEnabled: v.sealEnabled,
      headlines: v.headlines,
      bodyText: v.bodyText,
      customFields: v.customFields,
    },
  };
}

const SAMPLE_NAMES = ['Aisha Rahman', 'Tanvir Hasan', 'Nusrat Jahan', 'Rafiul Karim', 'Sadia Islam', 'Imran Hossain', 'Mahira Chowdhury', 'Fahim Ahmed'];
/** Sample certificate for the editor preview (individual / team of 3 / team of 8 / winner). */
export function sampleCertificate(kind: CertSampleKind, ev: { title: string; date: Date; venue?: string }, verifyUrl: string): CertificateFacts {
  const base = { certId: 'FH-SAMPLE-PREVIEW', eventTitle: ev.title, eventDate: ev.date, venue: ev.venue, verifyUrl, signatureText: '' };
  if (kind === 'team3') return { ...base, type: 'participation', recipientName: 'Team StackForge', teamName: 'Team StackForge', members: SAMPLE_NAMES.slice(0, 3) };
  if (kind === 'team8') return { ...base, type: 'runner_up', positionLabel: '2nd Place - Hackathon', recipientName: 'Team Code Crusaders', teamName: 'Team Code Crusaders', members: SAMPLE_NAMES };
  if (kind === 'winner') return { ...base, type: 'winner', positionLabel: '1st Place - Hackathon', recipientName: SAMPLE_NAMES[0] };
  return { ...base, type: 'participation', recipientName: SAMPLE_NAMES[0] };
}

// ---------------------------------------------------------------- PDF image embedding
export interface PdfImage {
  w: number;
  h: number;
  /** PDF image XObject dictionary entries (without Length) + raw stream bytes */
  dict: string;
  data: Buffer;
  smask?: { dict: string; data: Buffer };
}
/** JPEG: embedded as-is (DCTDecode). PNG: 8-bit, non-interlaced grey/RGB/RGBA only; decoded and re-deflated (alpha -> SMask). Returns null if unsupported (the PDF is then rendered without the image). */
export function prepareImage(buf: Buffer): PdfImage | null {
  try {
    const kind = detectCertImage(buf);
    if (kind === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          const h = buf.readUInt16BE(i + 5);
          const w = buf.readUInt16BE(i + 7);
          const comps = buf[i + 9];
          if (!w || !h || ![1, 3].includes(comps)) return null; // CMYK not supported
          return { w, h, dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${comps === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode`, data: buf };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (kind === 'png') {
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), depth = buf[24], ct = buf[25], interlace = buf[28];
      if (depth !== 8 || interlace !== 0 || ![0, 2, 6].includes(ct) || !w || !h || w * h > 4_000_000) return null;
      const idat: Buffer[] = [];
      for (let p = 8; p + 8 <= buf.length; ) {
        const len = buf.readUInt32BE(p);
        const type = buf.subarray(p + 4, p + 8).toString('ascii');
        if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
        if (type === 'IEND') break;
        p += 12 + len;
      }
      const raw = zlib.inflateSync(Buffer.concat(idat));
      const bpp = ct === 0 ? 1 : ct === 2 ? 3 : 4;
      const stride = w * bpp;
      if (raw.length < (stride + 1) * h) return null;
      const px = Buffer.alloc(stride * h);
      for (let y = 0; y < h; y++) {
        const f = raw[y * (stride + 1)];
        for (let x = 0; x < stride; x++) {
          const v = raw[y * (stride + 1) + 1 + x];
          const a = x >= bpp ? px[y * stride + x - bpp] : 0;
          const b = y > 0 ? px[(y - 1) * stride + x] : 0;
          const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
          let r: number;
          if (f === 0) r = v;
          else if (f === 1) r = v + a;
          else if (f === 2) r = v + b;
          else if (f === 3) r = v + ((a + b) >> 1);
          else if (f === 4) {
            const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
            r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          } else return null;
          px[y * stride + x] = r & 0xff;
        }
      }
      const cs = ct === 0 ? 'DeviceGray' : 'DeviceRGB';
      if (ct === 6) {
        const rgb = Buffer.alloc(w * h * 3), al = Buffer.alloc(w * h);
        for (let i = 0; i < w * h; i++) {
          rgb[i * 3] = px[i * 4]; rgb[i * 3 + 1] = px[i * 4 + 1]; rgb[i * 3 + 2] = px[i * 4 + 2]; al[i] = px[i * 4 + 3];
        }
        return {
          w, h,
          dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode`,
          data: zlib.deflateSync(rgb),
          smask: { dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, data: zlib.deflateSync(al) },
        };
      }
      return { w, h, dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /${cs} /BitsPerComponent 8 /Filter /FlateDecode`, data: zlib.deflateSync(px) };
    }
  } catch {
    /* corrupt image: render without it */
  }
  return null;
}
