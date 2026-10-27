/**
 * Dependency-free export helpers shared by server and web (S4).
 *  - toCsv(): RFC-4180 CSV text (formula-injection guard, optional UTF-8 BOM).
 *  - toPdf(): minimal valid PDF 1.4 table/report writer (Helvetica, WinAnsi).
 * Pure functions: no Node or DOM APIs, so they work in both places.
 */

export type ExportCell = string | number | boolean | Date | null | undefined;
export interface ExportColumn<T = Record<string, unknown>> {
  /** Header text. */
  header: string;
  /** Property name or function that returns the cell value. */
  value: keyof T | ((row: T) => ExportCell);
  /** PDF only: relative width (default 1). */
  width?: number;
}

function cellValue<T>(row: T, col: ExportColumn<T>): ExportCell {
  const v = typeof col.value === 'function' ? col.value(row) : ((row as Record<string, unknown>)[col.value as string] as ExportCell);
  return v;
}
function cellText(v: ExportCell): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString();
  return String(v);
}

export const CSV_BOM = '\uFEFF';

/** Escape one CSV field. A leading = + - @ (or tab/CR) is prefixed with ' so spreadsheets do not run it as a formula (numbers are left alone). */
export function csvField(v: ExportCell): string {
  let s = cellText(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvOptions {
  /** Prepend a UTF-8 BOM so Excel detects UTF-8 (default true). */
  bom?: boolean;
}
export function toCsv<T = Record<string, unknown>>(rows: readonly T[], columns: readonly ExportColumn<T>[], opts: CsvOptions = {}): string {
  const lines = [columns.map((c) => csvField(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvField(cellValue(r, c))).join(','));
  return (opts.bom === false ? '' : CSV_BOM) + lines.join('\r\n') + '\r\n';
}

export interface PdfOptions {
  title: string;
  subtitle?: string;
  landscape?: boolean;
  /** Footer text on every page (default: "Page n of N"). */
  footer?: string;
  /** Font size of table text (default 9). */
  fontSize?: number;
}

/** Helvetica has no glyphs outside WinAnsi: map common typography, replace the rest with '?'. */
function pdfSafe(s: string): string {
  const map: Record<string, string> = { '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u2022': '*' };
  let out = '';
  for (const ch of s.replace(/[\r\n\t]+/g, ' ')) {
    const c = ch.charCodeAt(0);
    out += map[ch] ?? (c >= 32 && c <= 126 ? ch : c >= 160 && c <= 255 ? ch : '?');
  }
  return out;
}
const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Build a PDF (A4) with a title, optional subtitle and a paginated table. Returns the file bytes. */
export function toPdf<T = Record<string, unknown>>(rows: readonly T[], columns: readonly ExportColumn<T>[], opts: PdfOptions): Uint8Array {
  const [W, H] = opts.landscape ? [841.89, 595.28] : [595.28, 841.89];
  const M = 40;
  const fs = opts.fontSize ?? 9;
  const lead = fs + 6;
  const usable = W - 2 * M;
  const totalW = columns.reduce((a, c) => a + (c.width ?? 1), 0) || 1;
  const widths = columns.map((c) => ((c.width ?? 1) / totalW) * usable);
  const maxChars = (w: number) => Math.max(1, Math.floor((w - 6) / (fs * 0.52))); // Helvetica averages ~0.5em
  const fit = (s: string, w: number) => {
    const t = pdfSafe(s);
    const n = maxChars(w);
    return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '~' : t;
  };

  const pages: string[] = [];
  let ops: string[] = [];
  let y = 0;
  const text = (x: number, yy: number, size: number, s: string, bold = false) =>
    ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${x.toFixed(2)} ${yy.toFixed(2)} Td (${esc(s)}) Tj ET`);
  const rowLine = (cells: string[], bold: boolean, shade: boolean) => {
    if (shade) ops.push(`0.93 0.94 0.98 rg ${M} ${(y - 4).toFixed(2)} ${usable.toFixed(2)} ${lead} re f 0 g`);
    let x = M;
    cells.forEach((c, i) => {
      text(x + 3, y, fs, fit(c, widths[i]), bold);
      x += widths[i];
    });
    y -= lead;
  };
  const newPage = (first: boolean) => {
    if (ops.length) pages.push(ops.join('\n'));
    ops = [];
    y = H - M;
    if (first) {
      text(M, y - 12, 18, fit(opts.title, usable * 1.9), true);
      y -= 30;
      if (opts.subtitle) {
        text(M, y, 10, fit(opts.subtitle, usable * 1.7));
        y -= 18;
      }
      y -= 6;
    }
    rowLine(columns.map((c) => c.header), true, true);
    ops.push(`0.6 G ${M} ${(y + lead - 5).toFixed(2)} m ${W - M} ${(y + lead - 5).toFixed(2)} l S`);
  };
  newPage(true);
  rows.forEach((r, i) => {
    if (y < M + 20) newPage(false);
    rowLine(columns.map((c) => cellText(cellValue(r, c))), false, i % 2 === 1);
  });
  if (!rows.length) {
    text(M + 3, y, fs, 'No records.');
  }
  pages.push(ops.join('\n'));

  // Footers need the page count, so append them now.
  const total = pages.length;
  const contents = pages.map((p, i) => {
    const foot = pdfSafe(opts.footer ?? `Page ${i + 1} of ${total}`);
    const f = opts.footer ? `${foot}  -  ${i + 1}/${total}` : foot;
    return `${p}\nBT /F1 8 Tf ${M} ${M - 18} Td (${esc(f)}) Tj ET`;
  });

  // Objects: 1 catalog, 2 pages, 3 F1, 4 F2, then (page, content) pairs.
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = contents.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${total} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  contents.forEach((c, i) => {
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = `<< /Length ${c.length} >>\nstream\n${c}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every char is <= 0xFF (pdfSafe), so 1 char = 1 byte and the xref offsets above are byte offsets.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/** Safe download file name: letters/digits/._- only, with the extension enforced. */
export function exportFileName(base: string, ext: 'csv' | 'pdf'): string {
  const b = base.replace(/\.(csv|pdf)$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'export';
  return `${b}.${ext}`;
}
