/**
 * v7 branded PDF kit (pdfkit, standard Helvetica fonts, A4). Used by the leaderboard export and the portfolio.
 * Everything is measured before it is drawn: table cells and cards wrap (nothing is cut off), a row/card that does not fit
 * moves to the next page, every page has the branded header, the table header repeats, and every page has "Page n of N".
 * Theme colours = the web theme (royal blue `brand`, deep navy `ink`, antique `gold`).
 * Limitation: standard fonts (WinAnsi); characters outside Latin-1 print as '?'.
 */
import type PDFKit from 'pdfkit';

export const PDF_COLORS = {
  brand: '#223d9c',
  brandDark: '#182a66',
  brandSoft: '#eff4ff',
  ink: '#0a1230',
  gold: '#c99a2e',
  goldSoft: '#fbf3dc',
  silver: '#8a94a6',
  silverSoft: '#eef1f6',
  bronze: '#b9733a',
  bronzeSoft: '#f8ebdf',
  green: '#0f9d6e',
  greenSoft: '#e3f6ee',
  red: '#c0392b',
  violet: '#6d3fc4',
  text: '#1c2540',
  muted: '#667089',
  line: '#dbe1ee',
  white: '#ffffff',
};
const C = PDF_COLORS;

const MAP: Record<string, string> = { '\u2018': "'", '\u2019': "'", '\u201C': '"', '\u201D': '"', '\u2013': '-', '\u2014': '-', '\u2026': '...', '\u2022': '*', '\u2212': '-', '\u00B7': '\u00B7' };
/** Standard fonts only know WinAnsi: map common typography, replace the rest with '?'. */
export function pdfText(s: unknown): string {
  let out = '';
  for (const ch of String(s ?? '').replace(/[\r\n\t]+/g, ' ')) {
    const c = ch.charCodeAt(0);
    out += MAP[ch] ?? (c >= 32 && c <= 126 ? ch : c >= 160 && c <= 255 ? ch : '?');
  }
  return out;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const pdfDate = (d: unknown) => {
  const x = d ? new Date(d as string) : null;
  return x && !Number.isNaN(x.getTime()) ? `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}` : '';
};

export interface Tone { fill: string; soft: string; text: string }
/** Rank / position colours: 1 gold, 2 silver, 3 bronze, everything else brand blue. */
export const toneForRank = (rank: number | null | undefined): Tone =>
  rank === 1 ? { fill: C.gold, soft: C.goldSoft, text: '#7a5a0c' } : rank === 2 ? { fill: C.silver, soft: C.silverSoft, text: '#47506a' } : rank === 3 ? { fill: C.bronze, soft: C.bronzeSoft, text: '#7a431a' } : { fill: C.brand, soft: C.brandSoft, text: C.brandDark };

type Doc = PDFKit.PDFDocument;
async function newDoc(landscape: boolean, title: string): Promise<{ doc: Doc; W: number; H: number; done: () => Promise<Uint8Array> }> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 0, bufferPages: true, info: { Title: pdfText(title), Author: 'FestHub', Producer: 'FestHub' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Uint8Array>((res, rej) => {
    doc.on('end', () => res(new Uint8Array(Buffer.concat(chunks))));
    doc.on('error', rej);
  });
  return { doc, W: doc.page.width, H: doc.page.height, done: () => { doc.end(); return finished; } };
}

const M = 32; // page margin

/** Single-line text that never overflows its box: shrinks the font down to `min`, then cuts with "...". Returns the drawn text. */
function fitLine(doc: Doc, text: string, font: string, size: number, min: number, width: number): { text: string; size: number } {
  const t = pdfText(text);
  let sz = size;
  doc.font(font).fontSize(sz);
  while (doc.widthOfString(t) > width && sz > min) { sz -= 0.5; doc.fontSize(sz); }
  if (doc.widthOfString(t) <= width) return { text: t, size: sz };
  let cut = t;
  while (cut.length > 1 && doc.widthOfString(cut + '...') > width) cut = cut.slice(0, -1);
  return { text: cut.trimEnd() + '...', size: sz };
}

/** Branded band at the top of a page. `big` = first page (taller, with title + subtitle), otherwise a slim running header. */
function drawHeader(doc: Doc, W: number, o: { brandLine: string; title: string; subtitle?: string; big: boolean }): number {
  const h = o.big ? 92 : 40;
  const g = doc.linearGradient(0, 0, W, h);
  g.stop(0, C.brandDark).stop(0.6, C.brand).stop(1, '#3b64e0');
  doc.rect(0, 0, W, h).fill(g);
  doc.rect(0, h, W, 3).fill(C.gold);
  // emblem
  const ex = M, ey = o.big ? 22 : 8, es = o.big ? 40 : 24;
  doc.roundedRect(ex, ey, es, es, es * 0.28).fill(C.gold);
  doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(es * 0.42).text('FH', ex, ey + es * 0.28, { width: es, align: 'center', lineBreak: false });
  const tx = ex + es + 12;
  if (o.big) {
    doc.fillColor('#f1d98d').font('Helvetica-Bold').fontSize(8.5).text(pdfText(o.brandLine).toUpperCase(), tx, 20, { width: W - tx - M, lineBreak: false, characterSpacing: 1.2 });
    const t = fitLine(doc, o.title, 'Helvetica-Bold', 23, 13, W - tx - M);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(t.size).text(t.text, tx, 33 + (23 - t.size) / 2, { width: W - tx - M, lineBreak: false });
    if (o.subtitle) { const st = fitLine(doc, o.subtitle, 'Helvetica', 9.5, 7, W - tx - M); doc.fillColor('#dbe4ff').font('Helvetica').fontSize(st.size).text(st.text, tx, 66, { width: W - tx - M, lineBreak: false }); }
  } else {
    const t = fitLine(doc, o.title, 'Helvetica-Bold', 11, 8, W - tx - M - 250);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(t.size).text(t.text, tx, 14, { width: W - tx - M - 240, lineBreak: false });
    doc.fillColor('#f1d98d').font('Helvetica-Bold').fontSize(8).text(pdfText(o.brandLine).toUpperCase(), W - M - 230, 17, { width: 230, align: 'right', lineBreak: false, characterSpacing: 1 });
  }
  return h + 3;
}

function drawFooters(doc: Doc, W: number, H: number, left: string) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.moveTo(M, H - 30).lineTo(W - M, H - 30).lineWidth(0.6).strokeColor(C.line).stroke();
    const fl = fitLine(doc, left, 'Helvetica', 8, 6, W - 2 * M - 100);
    doc.fillColor(C.muted).font('Helvetica').fontSize(fl.size).text(fl.text, M, H - 22, { width: W - 2 * M - 90, lineBreak: false });
    doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(8.5).text(`Page ${i + 1} of ${range.count}`, W - M - 90, H - 22, { width: 90, align: 'right', lineBreak: false });
  }
}

// ------------------------------------------------------------------------------------------------ table (leaderboard)

export interface TableCell {
  text: string;
  /** smaller second line (wraps) */
  sub?: string;
  bold?: boolean;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** coloured circle/pill behind the text (rank badges) */
  badge?: { fill: string; color: string };
  /** 0-100: draws a small progress bar under the text */
  bar?: { value: number; color: string };
}
export interface TableColumn { header: string; width: number; align?: 'left' | 'center' | 'right' }
export interface TableRow { cells: TableCell[]; tint?: string; stripe?: string }
export interface TablePdfOptions {
  landscape?: boolean;
  brandLine: string; // e.g. "FestHub  |  Pundra University ..." (small caps line)
  title: string;
  subtitle?: string;
  note?: string; // small paragraph under the header on the first page (how the score is built)
  columns: TableColumn[];
  rows: TableRow[];
  emptyText?: string;
  footerLeft: string;
}

export async function renderTablePdf(o: TablePdfOptions): Promise<Uint8Array> {
  const { doc, W, H, done } = await newDoc(o.landscape ?? true, o.title);
  const usable = W - 2 * M;
  const total = o.columns.reduce((a, c) => a + c.width, 0) || 1;
  const widths = o.columns.map((c) => (c.width / total) * usable);
  const PADX = 6, PADY = 6;
  const bottom = H - 40;
  let y = 0;

  const page = (first: boolean) => {
    if (!first) doc.addPage();
    y = drawHeader(doc, W, { brandLine: o.brandLine, title: o.title, subtitle: o.subtitle, big: first }) + 12;
    if (first && o.note) {
      doc.font('Helvetica').fontSize(8.5);
      const nh = doc.heightOfString(pdfText(o.note), { width: usable - 20 }) + 12;
      doc.roundedRect(M, y, usable, nh, 6).fill(C.brandSoft);
      doc.rect(M, y, 3, nh).fill(C.gold);
      doc.fillColor(C.text).text(pdfText(o.note), M + 12, y + 6, { width: usable - 24 });
      y += nh + 10;
    }
    tableHeader();
  };
  const tableHeader = () => {
    const h = 24;
    const g = doc.linearGradient(M, y, W - M, y);
    g.stop(0, C.brandDark).stop(1, C.brand);
    doc.roundedRect(M, y, usable, h, 5).fill(g);
    let x = M;
    o.columns.forEach((c, i) => {
      doc.fillColor(C.white).font('Helvetica-Bold').fontSize(8.5).text(pdfText(c.header).toUpperCase(), x + PADX, y + 8, { width: widths[i] - 2 * PADX, align: c.align ?? 'left', lineBreak: false, characterSpacing: 0.4 });
      x += widths[i];
    });
    y += h + 2;
  };

  const measure = (cell: TableCell, w: number) => {
    const inner = w - 2 * PADX;
    doc.font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
    let h = doc.heightOfString(pdfText(cell.text) || ' ', { width: inner });
    if (cell.sub) {
      doc.font('Helvetica').fontSize(7.8);
      h += 2 + doc.heightOfString(pdfText(cell.sub), { width: inner });
    }
    if (cell.bar) h += 7;
    return h;
  };

  page(true);
  if (!o.rows.length) {
    doc.fillColor(C.muted).font('Helvetica-Oblique').fontSize(10).text(pdfText(o.emptyText ?? 'No records.'), M + PADX, y + 10, { width: usable });
  }
  o.rows.forEach((row, ri) => {
    const rowH = Math.max(26, ...row.cells.map((c, i) => measure(c, widths[i]))) + 2 * PADY;
    if (y + rowH > bottom) page(false);
    doc.roundedRect(M, y, usable, rowH, 4).fill(row.tint ?? (ri % 2 ? '#f6f8fd' : C.white));
    if (row.stripe) doc.rect(M, y + 2, 3, rowH - 4).fill(row.stripe);
    let x = M;
    row.cells.forEach((cell, i) => {
      const w = widths[i] - 2 * PADX;
      const align = cell.align ?? o.columns[i].align ?? 'left';
      let cy = y + PADY;
      if (cell.badge) {
        const d = 20;
        const bx = align === 'center' ? x + (widths[i] - d) / 2 : x + PADX;
        doc.circle(bx + d / 2, y + rowH / 2, d / 2).fill(cell.badge.fill);
        doc.fillColor(cell.badge.color).font('Helvetica-Bold').fontSize(cell.text.length > 2 ? 8 : 10).text(pdfText(cell.text), bx, y + rowH / 2 - (cell.text.length > 2 ? 4 : 5), { width: d, align: 'center', lineBreak: false });
        if (cell.sub) doc.fillColor(C.muted).font('Helvetica').fontSize(7).text(pdfText(cell.sub), x + PADX, y + rowH / 2 + 12, { width: w, align, lineBreak: false });
      } else {
        doc.fillColor(cell.color ?? C.text).font(cell.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).text(pdfText(cell.text) || ' ', x + PADX, cy, { width: w, align });
        cy += doc.heightOfString(pdfText(cell.text) || ' ', { width: w }) ;
        if (cell.sub) {
          doc.fillColor(C.muted).font('Helvetica').fontSize(7.8).text(pdfText(cell.sub), x + PADX, cy + 2, { width: w, align });
          cy += 2 + doc.heightOfString(pdfText(cell.sub), { width: w });
        }
        if (cell.bar) {
          const bw = Math.min(w, 70);
          const bx = align === 'right' ? x + PADX + w - bw : align === 'center' ? x + PADX + (w - bw) / 2 : x + PADX;
          doc.roundedRect(bx, cy + 3, bw, 4, 2).fill('#e3e8f4');
          doc.roundedRect(bx, cy + 3, Math.max(2, (bw * Math.max(0, Math.min(100, cell.bar.value))) / 100), 4, 2).fill(cell.bar.color);
        }
      }
      x += widths[i];
    });
    y += rowH + 2;
  });

  drawFooters(doc, W, H, o.footerLeft);
  return done();
}

// ------------------------------------------------------------------------------------------------ portfolio (portrait cards)

export interface PortfolioCert { title: string; badge: string; rank: number | null; recipient: string; members: string[]; event: string; date: string; id: string }
export interface PortfolioResult { event: string; participant: string; rank: number | null; ranked: number; tied: boolean; final: number | null; judge: number | null; ai: number | null; penalty: number }
export interface PortfolioFeedback { event: string; points: number; maxPoints: number; percent: number; summary: string; date: string }
export interface PortfolioInput {
  name: string;
  generated: string;
  brandLine: string;
  summary: { certificates: number; results: number; feedback: number; bestRank: number | null };
  certificates: PortfolioCert[];
  results: PortfolioResult[];
  feedback: PortfolioFeedback[];
}

export async function renderPortfolioPdf(p: PortfolioInput): Promise<Uint8Array> {
  const { doc, W, H, done } = await newDoc(false, `Portfolio - ${p.name}`);
  const usable = W - 2 * M;
  const bottom = H - 42;
  let y = 0;
  const head = (first: boolean) => {
    y = drawHeader(doc, W, { brandLine: p.brandLine, title: first ? p.name : `Portfolio - ${p.name}`, subtitle: first ? `Achievement portfolio  |  Generated ${p.generated}` : undefined, big: first }) + 14;
  };
  const ensure = (h: number) => {
    if (y + h > bottom) { doc.addPage(); head(false); }
  };
  head(true);

  // summary tiles
  const tiles: [string, string, string][] = [
    [String(p.summary.certificates), 'Certificates', C.gold],
    [p.summary.bestRank ? `#${p.summary.bestRank}` : String(p.summary.results), p.summary.bestRank ? 'Best rank' : 'Published results', C.brand],
    [String(p.summary.feedback), 'Feedback received', C.green],
  ];
  const tw = (usable - 20) / 3;
  tiles.forEach(([v, l, col], i) => {
    const x = M + i * (tw + 10);
    doc.roundedRect(x, y, tw, 58, 8).fill(C.white);
    doc.roundedRect(x, y, tw, 58, 8).lineWidth(0.8).strokeColor(C.line).stroke();
    doc.roundedRect(x, y, 5, 58, 2).fill(col);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(24).text(v, x + 16, y + 9, { width: tw - 24, lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(9).text(l.toUpperCase(), x + 16, y + 40, { width: tw - 24, lineBreak: false, characterSpacing: 0.6 });
  });
  y += 58 + 18;

  const section = (title: string, count: number) => {
    ensure(46);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(13).text(pdfText(title), M, y, { width: usable - 60, lineBreak: false });
    doc.roundedRect(W - M - 44, y - 1, 44, 17, 8).fill(C.brandSoft);
    doc.fillColor(C.brand).font('Helvetica-Bold').fontSize(9).text(String(count), W - M - 44, y + 3, { width: 44, align: 'center', lineBreak: false });
    y += 20;
    doc.moveTo(M, y).lineTo(M + 38, y).lineWidth(2).strokeColor(C.gold).stroke();
    y += 10;
  };
  const empty = (t: string) => {
    ensure(40);
    doc.roundedRect(M, y, usable, 32, 8).dash(3, { space: 3 }).lineWidth(0.8).strokeColor(C.line).stroke().undash();
    doc.fillColor(C.muted).font('Helvetica-Oblique').fontSize(9).text(pdfText(t), M + 12, y + 11, { width: usable - 24, lineBreak: false });
    y += 32 + 16;
  };

  // certificates
  section('Certificates', p.certificates.length);
  if (!p.certificates.length) empty('No certificates yet. They appear here once an organizer issues them.');
  for (const c of p.certificates) {
    const tone = toneForRank(c.rank);
    const x0 = M + 16, w = usable - 32 - 118;
    doc.font('Helvetica-Bold').fontSize(12);
    const th = doc.heightOfString(pdfText(c.title), { width: w });
    doc.font('Helvetica').fontSize(9);
    const rh = doc.heightOfString(pdfText(c.recipient), { width: w });
    const membersText = c.members.length ? `Members: ${c.members.join(', ')}` : '';
    doc.font('Helvetica').fontSize(8.5);
    const mh = membersText ? doc.heightOfString(pdfText(membersText), { width: w }) + 3 : 0;
    const eh = doc.heightOfString(pdfText(`${c.event}  |  ${c.date}`), { width: w });
    const h = 14 + th + 3 + rh + mh + 4 + eh + 8 + 12;
    ensure(h + 10);
    doc.roundedRect(M, y, usable, h, 8).fill(tone.soft);
    doc.roundedRect(M, y, 6, h, 3).fill(tone.fill);
    let cy = y + 12;
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(12).text(pdfText(c.title), x0, cy, { width: w });
    cy += th + 3;
    doc.fillColor(tone.text).font('Helvetica-Bold').fontSize(9).text(pdfText(c.recipient), x0, cy, { width: w });
    cy += rh;
    if (membersText) { doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(pdfText(membersText), x0, cy + 3, { width: w }); cy += mh; }
    doc.fillColor(C.text).font('Helvetica').fontSize(8.5).text(pdfText(`${c.event}  |  ${c.date}`), x0, cy + 4, { width: w });
    cy += 4 + eh;
    doc.fillColor(C.muted).font('Courier').fontSize(8).text(pdfText(`ID ${c.id}`), x0, cy + 6, { width: w, lineBreak: false });
    // position badge
    const bw = 100;
    doc.roundedRect(W - M - bw - 12, y + 12, bw, 22, 11).fill(tone.fill);
    const bt = fitLine(doc, c.badge, 'Helvetica-Bold', 8.5, 6, bw - 12);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(bt.size).text(bt.text, W - M - bw - 12, y + 19, { width: bw, align: 'center', lineBreak: false });
    y += h + 8;
  }
  y += 8;

  // results
  section('Results', p.results.length);
  if (!p.results.length) empty('No published results yet. Your rank appears once the leaderboard is published.');
  for (const r of p.results) {
    const tone = toneForRank(r.rank);
    const w = usable - 32 - 120;
    doc.font('Helvetica-Bold').fontSize(11);
    const th = doc.heightOfString(pdfText(r.event), { width: w });
    const detail = `${r.participant}  |  Judge ${r.judge ?? '-'}%  |  AI ${r.ai ?? '-'}%${r.penalty ? `  |  Penalty -${r.penalty}` : ''}`;
    doc.font('Helvetica').fontSize(8.5);
    const dh = doc.heightOfString(pdfText(detail), { width: w });
    const h = 12 + th + 4 + dh + 12;
    ensure(h + 10);
    doc.roundedRect(M, y, usable, h, 8).fill(C.white);
    doc.roundedRect(M, y, usable, h, 8).lineWidth(0.8).strokeColor(C.line).stroke();
    doc.roundedRect(M, y, 6, h, 3).fill(tone.fill);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11).text(pdfText(r.event), M + 16, y + 12, { width: w });
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(pdfText(detail), M + 16, y + 12 + th + 4, { width: w });
    const bx = W - M - 104;
    const cy = y + h / 2;
    doc.circle(bx + 18, cy, 17).fill(tone.fill);
    doc.fillColor(C.white).font('Helvetica-Bold').fontSize(r.rank && r.rank > 9 ? 11 : 14).text(r.rank === null ? '-' : `#${r.rank}`, bx, cy - (r.rank && r.rank > 9 ? 6 : 8), { width: 36, align: 'center', lineBreak: false });
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(13).text(r.final === null ? '-' : `${r.final}%`, bx + 42, cy - 12, { width: 62, lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(7.5).text(r.rank === null ? 'unranked' : `of ${r.ranked}${r.tied ? ' (tie)' : ''}`, bx + 42, cy + 4, { width: 62, lineBreak: false });
    y += h + 8;
  }
  y += 8;

  // feedback
  section('Feedback', p.feedback.length);
  if (!p.feedback.length) empty('No published feedback yet.');
  for (const f of p.feedback) {
    const w = usable - 32 - 96;
    doc.font('Helvetica-Bold').fontSize(11);
    const th = doc.heightOfString(pdfText(f.event), { width: w });
    const sum = f.summary || 'Open the Feedback page for the full review.';
    doc.font('Helvetica').fontSize(8.8);
    const sh = Math.min(doc.heightOfString(pdfText(sum), { width: w }), 8.8 * 1.2 * 5);
    const h = 12 + th + 4 + sh + 6 + 10 + 10;
    ensure(h + 10);
    doc.roundedRect(M, y, usable, h, 8).fill(C.greenSoft);
    doc.roundedRect(M, y, 6, h, 3).fill(C.green);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(11).text(pdfText(f.event), M + 16, y + 12, { width: w });
    doc.fillColor(C.text).font('Helvetica').fontSize(8.8).text(pdfText(sum), M + 16, y + 12 + th + 4, { width: w, height: sh, ellipsis: true });
    doc.fillColor(C.muted).font('Helvetica').fontSize(8).text(`Published ${pdfText(f.date)}`, M + 16, y + h - 16, { width: w, lineBreak: false });
    const bx = W - M - 90;
    doc.fillColor(C.green).font('Helvetica-Bold').fontSize(14).text(`${f.points}/${f.maxPoints}`, bx, y + 14, { width: 78, align: 'right', lineBreak: false });
    doc.fillColor(C.muted).font('Helvetica').fontSize(8.5).text(`${f.percent}%`, bx, y + 32, { width: 78, align: 'right', lineBreak: false });
    y += h + 8;
  }

  drawFooters(doc, W, H, `FestHub portfolio - ${p.name} - generated ${p.generated}`);
  return done();
}
