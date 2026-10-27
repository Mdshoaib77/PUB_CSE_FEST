/**
 * Certificate PDF renderer (S5). Dependency-free: single-page A4 landscape PDF 1.4 using the built-in Helvetica fonts,
 * with the QR code drawn as vector rectangles (shared/qr.ts). Pure function: same input -> same bytes.
 * Limitation: Helvetica/WinAnsi only; characters outside Latin-1 print as '?'.
 */
import { applyPlaceholders, CERTIFICATE_TYPE_LABELS, CERT_THEME_COLORS, CERT_TEMPLATE_LIMITS, cleanTemplateText, qrMatrix, type CertBorderStyle, type CertFontStyle, type CertificateType } from '@festhub/shared';
import type { PdfImage } from './certTemplate';
import { assertNoOverlap, layoutMemberGrid, MARGIN, PAGE_H, PAGE_W, placeInZone, ZONES, zonesFor, type Box, type MemberGrid, type PlacedText, type TextMeasurer, type ZoneName } from './certLayout';

/** Optional branding (S6). Without it the output is byte-identical to S5. */
export interface CertificateBrand {
  primaryColor?: string; // #rrggbb
  accentColor?: string;
  logo?: PdfImage | null;
  signatureImage?: PdfImage | null;
  signatureName?: string;
  signatureTitle?: string;
  /** v5b: preset look. Without it, primaryColor/accentColor decide (a pair equal to a preset selects that preset). */
  theme?: CertTheme;
  // v6 template options (pdfkit renderer only; every one is optional and defaults to the v5 look)
  borderStyle?: CertBorderStyle; // classic (default) | modern | minimal
  fontStyle?: CertFontStyle; // serif (default, Times) | sans (Helvetica)
  sealEnabled?: boolean; // default true
  headlines?: Partial<Record<CertificateType, string>>; // per-type title override ('' = default)
  bodyText?: string; // custom paragraph with {name} {team} {members} {event} {position} {date} {venue}
  customFields?: { label: string; value: string }[]; // up to 4
}
const rgbOf = (hex: string | undefined, fallback: string) => (hex && /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ') : fallback);

export interface CertificatePdfInput {
  certId: string;
  type: CertificateType;
  recipientName: string;
  eventTitle: string;
  eventDate: Date;
  positionLabel?: string;
  signatureText: string;
  verifyUrl: string;
  revoked?: boolean;
  brand?: CertificateBrand;
  // v5a (pdfkit renderer; ignored by the legacy renderCertificatePdf)
  teamName?: string;
  members?: string[];
  venue?: string;
  signatories?: { name: string; title: string; imageBuf?: Buffer }[];
  logoBuf?: Buffer;
  logo2Buf?: Buffer; // v6: optional second logo (top right, next to the seal)
}

// Helvetica / Helvetica-Bold advance widths for ASCII 32..126 (per 1000 em) - used to centre and shrink-to-fit text.
const HW = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HB = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const formatCertDate = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

function safe(s: string): string {
  const map: Record<string, string> = { '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u2022': '*' };
  let out = '';
  for (const ch of s.replace(/[\r\n\t]+/g, ' ')) {
    const c = ch.charCodeAt(0);
    out += map[ch] ?? (c >= 32 && c <= 126 ? ch : c >= 160 && c <= 255 ? ch : '?');
  }
  return out;
}
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const width = (s: string, size: number, bold: boolean) => {
  const t = bold ? HB : HW;
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? t[c - 32] : 556;
  }
  return (w * size) / 1000;
};
const n2 = (n: number) => n.toFixed(2);

/** Intro / role phrase printed between the recipient and the event name. */
export function certificatePhrase(type: CertificateType, positionLabel?: string): string {
  switch (type) {
    case 'winner':
    case 'runner_up':
      return positionLabel ? `has secured ${positionLabel.split(' - ')[0]} in` : type === 'winner' ? 'has won' : 'has been the runner-up in';
    case 'volunteer':
      return 'has served as a Volunteer at';
    case 'organizer':
      return 'has served as an Organizer of';
    default:
      return 'has successfully participated in';
  }
}

export function renderCertificatePdf(c: CertificatePdfInput): Uint8Array {
  const W = 841.89;
  const H = 595.28;
  const ops: string[] = [];
  const text = (s: string, y: number, size: number, o: { bold?: boolean; x?: number; center?: boolean; rgb?: string; maxW?: number } = {}) => {
    const t = safe(s);
    let sz = size;
    if (o.maxW) while (sz > 8 && width(t, sz, !!o.bold) > o.maxW) sz -= 0.5;
    const x = o.center === false ? (o.x ?? 0) : (o.x ?? W / 2) - width(t, sz, !!o.bold) / 2;
    ops.push(`${o.rgb ?? '0.09 0.11 0.2'} rg BT /${o.bold ? 'F2' : 'F1'} ${n2(sz)} Tf ${n2(x)} ${n2(y)} Td (${esc(t)}) Tj ET`);
  };
  const rect = (x: number, y: number, w: number, h: number, lw: number, rgb: string) => ops.push(`${rgb} RG ${lw} w ${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re S`);
  const fill = (x: number, y: number, w: number, h: number, rgb: string) => ops.push(`${rgb} rg ${n2(x)} ${n2(y)} ${n2(w)} ${n2(h)} re f`);
  const indigo = rgbOf(c.brand?.primaryColor, '0.31 0.27 0.9');
  const accent = rgbOf(c.brand?.accentColor, '0.85 0.3 0.2');

  // frame
  rect(24, 24, W - 48, H - 48, 3, indigo);
  rect(32, 32, W - 64, H - 64, 0.8, '0.65 0.68 0.9');
  fill(24, H - 30, W - 48, 6, indigo);

  text('PUB FestHub', H - 78, 13, { bold: true, rgb: indigo });
  text(`CERTIFICATE OF ${CERTIFICATE_TYPE_LABELS[c.type].toUpperCase()}`, H - 122, 30, { bold: true, maxW: W - 140 });
  text('This is to certify that', H - 160, 13, { rgb: '0.35 0.38 0.5' });
  text(c.recipientName, H - 212, 38, { bold: true, rgb: indigo, maxW: W - 140 });
  ops.push(`0.75 0.77 0.9 RG 1 w ${n2(W / 2 - 200)} ${n2(H - 224)} m ${n2(W / 2 + 200)} ${n2(H - 224)} l S`);
  text(certificatePhrase(c.type, c.positionLabel), H - 258, 14, { rgb: '0.35 0.38 0.5' });
  text(c.eventTitle, H - 292, 24, { bold: true, maxW: W - 140 });
  if (c.positionLabel) text(c.positionLabel, H - 318, 14, { bold: true, rgb: accent, maxW: W - 140 });
  text(`held on ${formatCertDate(c.eventDate)}`, H - (c.positionLabel ? 344 : 322), 13, { rgb: '0.35 0.38 0.5' });

  // images (optional): logo top-left, signature image above the signature line
  const place = (name: string, im: PdfImage, x: number, y: number, maxW: number, maxH: number) => {
    const k = Math.min(maxW / im.w, maxH / im.h);
    ops.push(`q ${n2(im.w * k)} 0 0 ${n2(im.h * k)} ${n2(x)} ${n2(y)} cm /${name} Do Q`);
  };
  const logo = c.brand?.logo ?? null;
  const sigImg = c.brand?.signatureImage ?? null;
  if (logo) place('Im1', logo, 56, H - 100, 110, 56);
  if (sigImg) place('Im2', sigImg, 90 + 105 - 60, 116, 120, 44);

  // signature (left)
  const sx = 90;
  ops.push(`0.2 0.2 0.3 RG 0.8 w ${sx} 110 m ${sx + 210} 110 l S`);
  const sigName = c.brand?.signatureName?.trim();
  text(sigName || c.signatureText || 'Organizing Committee', 96, 11, { bold: !!sigName, x: sx + 105, maxW: 210 });
  text(c.brand?.signatureTitle?.trim() || (sigName ? c.signatureText : '') || 'Authorised signature', 82, 8.5, { x: sx + 105, rgb: '0.5 0.52 0.6', maxW: 210 });

  // QR (right) with quiet zone
  const m = qrMatrix(c.verifyUrl);
  const cell = 3;
  const qrSize = m.length * cell;
  const qx = W - 90 - qrSize;
  const qy = 70;
  fill(qx - 6, qy - 6, qrSize + 12, qrSize + 12, '1 1 1');
  rect(qx - 6, qy - 6, qrSize + 12, qrSize + 12, 0.5, '0.8 0.82 0.9');
  ops.push('0 g');
  for (let y = 0; y < m.length; y++) {
    let x = 0;
    while (x < m.length) {
      if (!m[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < m.length && m[y][x + run]) run++;
      ops.push(`${n2(qx + x * cell)} ${n2(qy + (m.length - 1 - y) * cell)} ${n2(run * cell)} ${cell} re`);
      x += run;
    }
  }
  ops.push('f');
  text('Scan to verify', qy - 20, 8.5, { x: qx + qrSize / 2, rgb: '0.5 0.52 0.6' });

  // id + url (centre bottom)
  text(`Certificate ID: ${c.certId}`, 62, 10, { bold: true, rgb: '0.35 0.38 0.5', x: W / 2 - 40 });
  text(c.verifyUrl, 48, 7.5, { rgb: '0.5 0.52 0.6', x: W / 2 - 40, maxW: 330 });

  if (c.revoked) {
    // diagonal red "REVOKED" stamp
    const a = (-28 * Math.PI) / 180;
    ops.push(`q ${n2(Math.cos(a))} ${n2(Math.sin(a))} ${n2(-Math.sin(a))} ${n2(Math.cos(a))} ${n2(W / 2 - 170)} ${n2(H / 2 - 30)} cm 0.85 0.1 0.1 rg BT /F2 96 Tf 0 0 Td (REVOKED) Tj ET Q`);
  }

  const content = ops.join('\n');
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = '<< /Type /Pages /Kids [5 0 R] /Count 1 >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objs[6] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  const xo: string[] = [];
  const addImage = (name: string, im: PdfImage | null) => {
    if (!im) return;
    let sm = '';
    if (im.smask) {
      const si = objs.length;
      objs[si] = `<< ${im.smask.dict} /Length ${im.smask.data.length} >>\nstream\n${im.smask.data.toString('latin1')}\nendstream`;
      sm = ` /SMask ${si} 0 R`;
    }
    const i = objs.length;
    objs[i] = `<< ${im.dict}${sm} /Length ${im.data.length} >>\nstream\n${im.data.toString('latin1')}\nendstream`;
    xo.push(`/${name} ${i} 0 R`);
  };
  addImage('Im1', logo);
  addImage('Im2', sigImg);
  objs[5] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n2(W)} ${n2(H)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xo.length ? ` /XObject << ${xo.join(' ')} >>` : ''} >> /Contents 6 0 R >>`;
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offs[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offs[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length); // every char <= 0xFF (see safe()), so offsets are byte offsets
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

// ------------------------------------------------------------------------------------------------ pdfkit renderer (v5a)

// ------------------------------------------------------------------------------------------------ decoration (v5b)
// Vector only, light tints, solid colours (no transparency). Everything is drawn BEFORE the text and never changes a
// text zone: corner ornaments stay within 45 pt of the page corner, the bottom stripes below y = 505, the bands in the
// 33..40 / 554..561 gutters, the flourish in the 148..154 gap between the title and recipient zones.

export type CertTheme = 'royal' | 'emerald' | 'sunset' | 'violet';
export const CERT_THEMES: Record<CertTheme, { label: string; primary: string; accent: string }> = CERT_THEME_COLORS;

export interface CertPalette {
  theme: CertTheme | 'custom';
  primary: string;
  accent: string;
  accentDark: string; // readable accent for text
  ink: string;
  muted: string;
  stripe: string; // background pattern
  rosette: string; // watermark
  wash: string; // light corner triangles
}

const HEX6 = /^#[0-9a-f]{6}$/i;
const parseHex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (c: number[]) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
/** t = share of `b` (0..1). */
const mixHex = (a: string, b: string, t: number) => {
  const x = parseHex(a);
  const y = parseHex(b);
  return toHex(x.map((v, i) => v * (1 - t) + y[i] * t));
};
const tint = (hex: string, amount: number) => mixHex(hex, '#ffffff', amount);
const darken = (hex: string, amount: number) => mixHex(hex, '#000000', amount);

export function resolveCertPalette(brand?: Pick<CertificateBrand, 'theme' | 'primaryColor' | 'accentColor'>): CertPalette {
  const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  let theme: CertTheme | 'custom' = 'custom';
  if (brand?.theme && CERT_THEMES[brand.theme]) theme = brand.theme;
  else {
    const hit = (Object.keys(CERT_THEMES) as CertTheme[]).find((k) => eq(brand?.primaryColor, CERT_THEMES[k].primary) && eq(brand?.accentColor, CERT_THEMES[k].accent));
    if (hit) theme = hit;
  }
  const base = CERT_THEMES.royal;
  const primary = theme !== 'custom' ? CERT_THEMES[theme].primary : brand?.primaryColor && HEX6.test(brand.primaryColor) ? brand.primaryColor : base.primary;
  const accent = theme !== 'custom' ? CERT_THEMES[theme].accent : brand?.accentColor && HEX6.test(brand.accentColor) ? brand.accentColor : base.accent;
  return {
    theme,
    primary,
    accent,
    accentDark: darken(accent, 0.38),
    ink: '#17203a',
    muted: '#4a5170',
    stripe: tint(primary, 0.9),
    rosette: tint(primary, 0.92),
    wash: tint(primary, 0.82),
  };
}

type PdfDoc = InstanceType<typeof import('pdfkit')>;

function drawDecoration(doc: PdfDoc, p: CertPalette, style: CertBorderStyle = 'classic'): void {
  const W = PAGE_W;
  const H = PAGE_H;
  if (style === 'minimal') {
    // one hairline frame and a short rule under the title: nothing else, so it prints cleanly in black and white
    doc.lineWidth(1).strokeColor(p.primary).rect(22, 22, W - 44, H - 44).stroke();
    const my = ZONES.title.y + ZONES.title.h - 4;
    doc.lineWidth(0.8).strokeColor(p.accent).moveTo(W / 2 - 60, my).lineTo(W / 2 + 60, my).stroke();
    return;
  }
  const band = (y: number, h: number) => {
    const g = doc.linearGradient(MARGIN, 0, W - MARGIN, 0);
    g.stop(0, p.primary).stop(0.5, p.accent).stop(1, p.primary);
    doc.rect(MARGIN, y, W - 2 * MARGIN, h).fill(g);
  };

  const classic = style === 'classic';
  // 1. pattern (fine vertical stripes) + rosette watermark, clipped to the inner frame (classic only)
  if (classic) {
  doc.save();
  doc.rect(30, 30, W - 60, H - 60).clip();
  doc.lineWidth(0.5).strokeColor(p.stripe);
  for (let x = 34; x < W - 30; x += 8) doc.moveTo(x, 30).lineTo(x, H - 30).stroke();
  const cx = W / 2;
  const cy = H / 2 + 10;
  doc.lineWidth(0.6).strokeColor(p.rosette);
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI * 2) / 24;
    doc.circle(cx + Math.cos(a) * 70, cy + Math.sin(a) * 70, 70).stroke();
  }
  for (const r of [150, 158, 166]) doc.circle(cx, cy, r).stroke();
  doc.restore();
  }

  // 2. gradient bands (top and bottom gutters, outside every text zone)
  band(33, 7);
  band(554, 7);

  // 3. bottom corner stripes (nested right triangles, mirrored on the right)
  for (const mirror of [false, true]) {
    doc.save();
    if (mirror) {
      doc.translate(W, 0);
      doc.scale(-1, 1);
    }
    const tri = (legX: number, legY: number, color: string) => doc.polygon([30, H - 30], [30, H - 30 - legY], [30 + legX, H - 30]).fill(color);
    tri(170, 60, p.wash);
    tri(130, 46, p.accent);
    tri(90, 32, p.primary);
    doc.restore();
  }

  // 4. frames: classic = three layers, modern = one bold frame + a hairline
  if (classic) {
    doc.lineWidth(5).strokeColor(p.primary).rect(16, 16, W - 32, H - 32).stroke();
    doc.lineWidth(1.6).strokeColor(p.accent).rect(24, 24, W - 48, H - 48).stroke();
    doc.lineWidth(0.6).strokeColor(p.primary).rect(28, 28, W - 56, H - 56).stroke();
  } else {
    doc.lineWidth(3).strokeColor(p.primary).rect(18, 18, W - 36, H - 36).stroke();
    doc.lineWidth(0.8).strokeColor(p.accent).rect(26, 26, W - 52, H - 52).stroke();
  }

  // 5. corner ornaments (classic only; local top-left coordinates, mirrored to the other corners)
  const corners: [number, number, number, number][] = [[1, 1, 0, 0], [-1, 1, W, 0], [1, -1, 0, H], [-1, -1, W, H]];
  for (const [sx, sy, tx, ty] of classic ? corners : []) {
    doc.save();
    doc.translate(tx, ty);
    doc.scale(sx, sy);
    doc.circle(24, 24, 11).fill('#ffffff');
    doc.lineWidth(1.2).strokeColor(p.accent).circle(24, 24, 11).stroke();
    doc.polygon([24, 17.5], [30.5, 24], [24, 30.5], [17.5, 24]).fill(p.primary);
    doc.circle(24, 24, 2).fill('#ffffff');
    doc.lineWidth(0.8).strokeColor(p.accent).path('M 41 24 A 17 17 0 0 1 24 41').stroke();
    doc.polygon([36, 20.5], [44, 24], [36, 27.5]).fill(p.accent);
    doc.polygon([20.5, 36], [24, 44], [27.5, 36]).fill(p.accent);
    doc.restore();
  }

  // 6. flourish under the title (sits in the gap between the title and recipient zones)
  const fy = ZONES.title.y + ZONES.title.h - 4;
  doc.lineWidth(1).strokeColor(p.accent);
  doc.moveTo(W / 2 - 130, fy).lineTo(W / 2 - 12, fy).stroke();
  doc.moveTo(W / 2 + 12, fy).lineTo(W / 2 + 130, fy).stroke();
  doc.polygon([W / 2, fy - 4], [W / 2 + 5, fy], [W / 2, fy + 4], [W / 2 - 5, fy]).fill(p.primary);
}

// ------------------------------------------------------------------------------------------------ seal + QR (v5c)

const MEDALS = {
  gold: { base: '#d4a017', light: '#f4dc82', dark: '#8a6508' },
  silver: { base: '#aeb6c2', light: '#e8ecf1', dark: '#667080' },
} as const;

/** Medal with two ribbon tails inside `b` (48 x 50): gold = winner, silver = runner-up, brand colour otherwise. */
function drawSeal(doc: PdfDoc, b: Box, kind: 'gold' | 'silver' | 'brand', p: CertPalette): void {
  const col = kind === 'brand' ? { base: p.primary, light: tint(p.primary, 0.55), dark: darken(p.primary, 0.35) } : MEDALS[kind];
  const ribbon = kind === 'brand' ? p.accent : p.primary;
  const cx = b.x + b.w / 2;
  const cy = b.y + 18;
  // ribbon tails (behind the medal)
  doc.polygon([cx - 14, cy + 6], [cx - 3, cy + 6], [cx - 3, b.y + b.h], [cx - 8.5, b.y + b.h - 6], [cx - 14, b.y + b.h]).fill(ribbon);
  doc.polygon([cx + 3, cy + 6], [cx + 14, cy + 6], [cx + 14, b.y + b.h], [cx + 8.5, b.y + b.h - 6], [cx + 3, b.y + b.h]).fill(darken(ribbon, 0.2));
  // scalloped edge, face, inner ring, star
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI * 2) / 16;
    doc.circle(cx + Math.cos(a) * 16, cy + Math.sin(a) * 16, 2.6).fill(col.base);
  }
  doc.circle(cx, cy, 16).fill(col.base);
  doc.lineWidth(1).strokeColor(col.dark).circle(cx, cy, 16).stroke();
  doc.circle(cx, cy, 12.5).fill(col.light);
  doc.lineWidth(0.8).strokeColor(col.dark).circle(cx, cy, 12.5).stroke();
  const star: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 === 0 ? 8.5 : 3.6;
    star.push([cx + Math.cos(a) * r, cy + 0.5 + Math.sin(a) * r]);
  }
  doc.polygon(...star).fill(col.dark);
}

/** Vector QR: white plate with a 2-module quiet zone, black modules as rectangles. */
function drawQr(doc: PdfDoc, m: boolean[][], b: Box): void {
  const n = m.length;
  const cell = b.w / (n + 4);
  doc.rect(b.x, b.y, b.w, b.h).fill('#ffffff');
  doc.lineWidth(0.4).strokeColor('#c9ccd8').rect(b.x, b.y, b.w, b.h).stroke();
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!m[y][x]) {
        x++;
        continue;
      }
      let run = 1;
      while (x + run < n && m[y][x + run]) run++;
      doc.rect(b.x + (x + 2) * cell, b.y + (y + 2) * cell, run * cell, cell).fill('#000000');
      x += run;
    }
  }
}

export interface CertificateKitResult {
  bytes: Uint8Array;
  /** Bounding boxes the layout engine used (already passed assertNoOverlap). */
  boxes: Box[];
  pages: number;
  /** Team certificates: how the member grid was laid out; `bottom` is always <= `limit` (top of the signature zone). */
  grid?: { cols: number; rows: number; size: number; bottom: number; ellipsised: number; hidden: number; limit: number };
}


/**
 * v5a renderer: pdfkit, A4 landscape 842 x 595, 36 pt safe margin, standard fonts only, ONE page, PLAIN content
 * (border, title, recipient or team name, position, event, date, venue, footer certificate ID). pdfkit is asynchronous,
 * so this is a separate Promise-returning entry; the synchronous renderCertificatePdf above is unchanged.
 */
export async function renderCertificateKit(c: CertificatePdfInput): Promise<CertificateKitResult> {
  const { default: PDFDocument } = await import('pdfkit'); // lazy: the legacy path never loads pdfkit
  const doc = new PDFDocument({ size: [PAGE_W, PAGE_H], margin: 0, autoFirstPage: false, bufferPages: true, info: { Title: `Certificate ${c.certId}`, Producer: 'FestHub' } });
  const chunks: Buffer[] = [];
  doc.on('data', (d: Buffer) => chunks.push(d));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });
  doc.addPage({ size: [PAGE_W, PAGE_H], margin: 0 });
  const m = doc as unknown as TextMeasurer;
  const pal = resolveCertPalette(c.brand);
  const INK = pal.ink;
  const MUTED = pal.muted;

  const br = c.brand ?? {};
  const serif = br.fontStyle !== 'sans';
  const F = serif
    ? ({ title: 'Times-Bold', name: 'Times-Bold', certify: 'Times-Italic', event: 'Times-Bold' } as const)
    : ({ title: 'Helvetica-Bold', name: 'Helvetica-Bold', certify: 'Helvetica-Oblique', event: 'Helvetica-Bold' } as const);
  const sealOn = br.sealEnabled !== false;
  const isTeam = !!c.teamName?.trim();
  const recipient = safe(isTeam ? c.teamName!.trim() : c.recipientName);
  const Z = zonesFor(isTeam);
  const place = (name: string, zone: ZoneName, raw: string, o: Parameters<typeof placeInZone>[4]) => placeInZone(m, name, zone, raw, { ...o, zones: Z });
  const items: PlacedText[] = [];
  const add = (p: PlacedText, color = INK) => {
    items.push(Object.assign(p, { color }));
  };
  const fullW = PAGE_W - 2 * MARGIN - 40;

  // custom fields (up to 4 label + value pairs). Individual certificates have a free 52 pt "members" zone: one column per field.
  // Team certificates need that zone for the member grid, so their fields go on two compact lines at the bottom of the header.
  const fields = (br.customFields ?? [])
    .slice(0, CERT_TEMPLATE_LIMITS.fields)
    .map((f) => ({ label: safe(cleanTemplateText(f.label)).slice(0, CERT_TEMPLATE_LIMITS.fieldLabel), value: safe(cleanTemplateText(f.value)).slice(0, CERT_TEMPLATE_LIMITS.fieldValue) }))
    .filter((f) => f.label && f.value);
  const fieldsInHeader = isTeam && fields.length > 0;
  // second logo (top right, left of the seal); the centred header text keeps clear of it
  const logo2Box: Box | null = c.logo2Buf ? { name: 'logo2', x: (sealOn ? PAGE_W - 98 - 8 : PAGE_W - 50) - 110, y: Z.header.y + 6, w: 110, h: 44 } : null;
  const headHalf = Math.min((fullW - 2 * 140) / 2, logo2Box ? logo2Box.x - 8 - PAGE_W / 2 : Infinity);
  // header: org name, centred; space is reserved on both sides so a logo (left) never meets it
  add(place('header', 'header', 'PUB FestHub', { font: 'Helvetica-Bold', size: 14, top: fieldsInHeader ? 8 : 14, maxW: headHalf * 2, maxH: 22 }), pal.primary);
  if (fieldsInHeader) add(place('fields', 'header', safe(fields.map((f) => `${f.label}: ${f.value}`).join('   |   ')), { font: 'Helvetica', size: 9.5, top: 30, maxW: headHalf * 2, maxH: 26, maxLines: 2 }), pal.accentDark);
  // title
  const headline = cleanTemplateText(br.headlines?.[c.type] ?? '').slice(0, CERT_TEMPLATE_LIMITS.headline);
  add(place('title', 'title', safe(headline || `CERTIFICATE OF ${CERTIFICATE_TYPE_LABELS[c.type].toUpperCase()}`), { font: F.title, size: 40, top: 6, maxH: 52 }), INK);
  // recipient
  add(place('certify', 'recipient', isTeam ? 'This is to certify that team' : 'This is to certify that', { font: F.certify, size: 13, top: 4, maxH: 18 }), MUTED);
  add(place('recipient', 'recipient', recipient || '-', { font: F.name, size: 38, top: isTeam ? 22 : 24, maxH: isTeam ? 54 : 58, maxLines: 2 }), pal.primary);
  // body: a custom paragraph (placeholders) or the default phrase / event / position / date block
  const customBody = br.bodyText?.trim() ?? '';
  if (customBody) {
    const text = applyPlaceholders(customBody, {
      name: c.recipientName,
      team: isTeam ? c.teamName : '',
      members: (c.members ?? []).join(', '),
      event: c.eventTitle,
      position: c.positionLabel ?? '',
      date: formatCertDate(c.eventDate),
      venue: c.venue ?? '',
    });
    add(place('bodytext', 'body', safe(text), { font: 'Helvetica', size: 14, top: 6, maxW: 640, maxH: Z.body.h - 8 }), INK);
  } else {
    const phrase = certificatePhrase(c.type, c.positionLabel);
    add(place('phrase', 'body', safe(phrase), { font: 'Helvetica', size: 13, top: 0, maxH: 18 }), MUTED);
    // team body is 92 pt: phrase 18 + event + (position 17) + date 15 must fit, so the event title gets 35 pt when a position line follows
    const eventP = place('event', 'body', safe(c.eventTitle), { font: F.event, size: 24, top: 20, maxH: isTeam && c.positionLabel ? 35 : 54, maxLines: 2 });
    add(eventP);
    // individual: fixed tops (unchanged since v5a); team: stacked under the real height of the event title (compact body)
    let bodyTop = isTeam ? Math.ceil(20 + eventP.h) + 3 : 76;
    if (c.positionLabel) {
      add(place('position', 'body', safe(c.positionLabel), { font: 'Helvetica-Bold', size: 14, top: bodyTop, maxH: 16 }), pal.accentDark);
      bodyTop += 17;
    }
    const dateLine = `held on ${formatCertDate(c.eventDate)}${c.venue?.trim() ? ` at ${c.venue.trim()}` : ''}`;
    add(place('date', 'body', safe(dateLine), { font: 'Helvetica', size: 12, top: bodyTop, maxH: Z.body.h - bodyTop }), MUTED);
  }
  // members (team): "Team members" label + grid of 1-4 columns holding ALL names, leader first. The grid shrinks its font
  // and adds columns until it fits the members zone, so it can never reach the signature zone.
  let grid: MemberGrid | null = null;
  const memberNames = (c.members ?? []).map((n) => safe(n).trim()).filter(Boolean);
  if (isTeam && memberNames.length) {
    add(place('members', 'members', 'Team members', { font: 'Helvetica-Bold', size: 10.5, top: 0, maxH: 14 }), pal.accentDark);
    const mz = Z.members;
    const top = mz.y + 17;
    grid = layoutMemberGrid(m, memberNames, { x: MARGIN + 20, y: top, w: PAGE_W - 2 * MARGIN - 40, h: mz.y + mz.h - 3 - top });
    for (const cell of grid.cells) {
      const placed: PlacedText = { text: cell.text, size: grid.size, font: 'Helvetica', lines: [cell.text], lineHeight: grid.lineHeight, w: cell.w, h: grid.lineHeight, shrunk: false, wrapped: false, truncated: false, box: cell.box, zone: 'members', slotW: cell.slotW, x: cell.x, y: cell.y, align: 'left' };
      add(placed, MUTED);
    }
  }
  // individual certificates: custom fields as one column each (label over value) in the free members zone
  if (!isTeam && fields.length) {
    const colW = fullW / fields.length;
    fields.forEach((f, i) => {
      const cx = MARGIN + 20 + colW * (i + 0.5);
      add(place(`fieldlabel${i}`, 'members', safe(f.label.toUpperCase()), { font: 'Helvetica-Bold', size: 9, top: 6, maxW: colW - 16, maxH: 12, cx }), pal.accentDark);
      add(place(`fieldvalue${i}`, 'members', safe(f.value), { font: 'Helvetica', size: 12, top: 19, maxW: colW - 16, maxH: 30, cx, maxLines: 2 }), INK);
    });
  }
  // signatures: up to 3 non-empty signatories, evenly spaced and centred
  const given = (c.signatories ?? []).filter((sg) => sg && (sg.name?.trim() || sg.title?.trim() || sg.imageBuf));
  const sigs = (given.length
    ? given
    : [{ name: c.brand?.signatureName?.trim() || c.signatureText || 'Organizing Committee', title: c.brand?.signatureTitle?.trim() || (c.brand?.signatureName ? c.signatureText : '') || 'Authorised signature' }]
  ).slice(0, 3) as { name: string; title: string; imageBuf?: Buffer }[];
  const slotW = Math.min(220, (PAGE_W - 2 * MARGIN - 40) / sigs.length - 20);
  const rules: { x1: number; x2: number; y: number }[] = [];
  const images: { buf: Buffer; box: Box }[] = [];
  sigs.forEach((sg, i) => {
    const cx = MARGIN + 20 + ((PAGE_W - 2 * MARGIN - 40) / sigs.length) * (i + 0.5);
    const z = Z.signatures;
    if (sg.imageBuf) images.push({ buf: sg.imageBuf, box: { name: `sigimg${i}`, x: cx - 60, y: z.y + 4, w: 120, h: 40 } });
    rules.push({ x1: cx - slotW / 2, x2: cx + slotW / 2, y: z.y + 48 });
    if (sg.name?.trim()) add(place(`signame${i}`, 'signatures', safe(sg.name), { font: 'Helvetica-Bold', size: 11, top: 52, maxW: slotW, maxH: 16, cx }));
    if (sg.title?.trim()) add(place(`sigtitle${i}`, 'signatures', safe(sg.title), { font: 'Helvetica', size: 9.5, top: 70, maxW: slotW, maxH: 26, cx, maxLines: 2 }), MUTED);
  });
  // footer: [QR] + certificate ID / "Verify at <url>", the group centred on the page
  const QR = 50;
  let qrM: boolean[][] = [];
  try {
    qrM = qrMatrix(c.verifyUrl);
  } catch {
    qrM = []; // URL too long for the built-in generator: footer text only
  }
  const hasQr = qrM.length > 0;
  const idText = `Certificate ID: ${safe(c.certId)}`;
  const verifyText = `Verify at ${safe(c.verifyUrl)}`;
  const footText = (left: number) => [
    place('certid', 'footer', idText, { font: 'Helvetica-Bold', size: 10, top: 14, maxW: 330, maxH: 14, align: 'left', left }),
    place('verify', 'footer', verifyText, { font: 'Helvetica', size: 9, top: 30, maxW: 330, maxH: 26, maxLines: 2, align: 'left', left }),
  ];
  const probe = footText(0);
  const textW = Math.max(...probe.map((t) => t.w));
  const groupW = (hasQr ? QR + 12 : 0) + textW;
  const gx = PAGE_W / 2 - groupW / 2;
  const [idP, verP] = footText(gx + (hasQr ? QR + 12 : 0));
  add(idP, pal.muted);
  add(verP, pal.muted);
  const qrBox: Box | null = hasQr ? { name: 'qr', x: gx, y: Z.footer.y + 6, w: QR, h: QR } : null;

  // medal / ribbon seal, top right of the header (mirrors the logo)
  const medal = c.type === 'winner' ? 'gold' : c.type === 'runner_up' ? 'silver' : 'brand';
  const sealBox: Box = { name: 'seal', x: PAGE_W - 94 - 4, y: Z.header.y + 4, w: 48, h: 50 };

  const logo = c.logoBuf ? ({ name: 'logo', x: MARGIN + 8, y: Z.header.y + 6, w: 120, h: 44 } as Box) : null;
  const boxes = [...items.map((p) => p.box), ...images.map((i) => i.box), ...(logo ? [logo] : []), ...(logo2Box ? [logo2Box] : []), ...(qrBox ? [qrBox] : []), ...(sealOn ? [sealBox] : [])];
  assertNoOverlap(boxes);

  // ---- draw (everything below is decoration or pure drawing of the boxes above)
  drawDecoration(doc, pal, br.borderStyle ?? 'classic');
  for (const it of items as (PlacedText & { color: string })[]) {
    doc.font(it.font).fontSize(it.size).fillColor(it.color);
    it.lines.forEach((line, i) => doc.text(line, it.x, it.y + i * it.lineHeight, { width: it.slotW, align: it.align, lineBreak: false }));
  }
  doc.lineWidth(0.8).strokeColor('#33334d');
  for (const r of rules) doc.moveTo(r.x1, r.y).lineTo(r.x2, r.y).stroke();
  const fitImg = (buf: Buffer, b: Box) => {
    try {
      doc.image(buf, b.x, b.y, { fit: [b.w, b.h], align: 'center', valign: 'center' });
    } catch {
      /* unsupported image: render without it */
    }
  };
  if (logo && c.logoBuf) fitImg(c.logoBuf, logo);
  if (logo2Box && c.logo2Buf) fitImg(c.logo2Buf, logo2Box);
  for (const i of images) fitImg(i.buf, i.box);
  if (sealOn) drawSeal(doc, sealBox, medal, pal);
  if (qrBox) drawQr(doc, qrM, qrBox);
  if (c.revoked) {
    doc.save();
    doc.rotate(-28, { origin: [PAGE_W / 2, PAGE_H / 2] });
    doc.font('Helvetica-Bold').fontSize(96);
    const rw = doc.widthOfString('REVOKED');
    doc.lineWidth(2.5).strokeColor('#d91a1a').text('REVOKED', PAGE_W / 2 - rw / 2, PAGE_H / 2 - 50, { lineBreak: false, stroke: true, fill: false });
    doc.restore();
  }
  const pages = doc.bufferedPageRange().count;
  doc.end();
  await done;
  return { bytes: new Uint8Array(Buffer.concat(chunks)), boxes, pages, grid: grid ? { cols: grid.cols, rows: grid.rows, size: grid.size, bottom: grid.bottom, ellipsised: grid.ellipsised, hidden: grid.hidden, limit: Z.signatures.y } : undefined };
}

/** Convenience wrapper: just the PDF bytes. */
export async function renderCertificatePdfKit(c: CertificatePdfInput): Promise<Uint8Array> {
  return (await renderCertificateKit(c)).bytes;
}
