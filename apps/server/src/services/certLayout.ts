/**
 * Certificate layout engine (v5a). Pure geometry: it only needs something that can measure text, so it works with a
 * real pdfkit document (`doc.widthOfString` / `doc.heightOfString`) and with a fake in tests.
 * Page: A4 landscape 842 x 595 pt, 36 pt safe margin. Y grows DOWNWARD (pdfkit convention).
 * Each zone has a fixed vertical slot; text is shrunk to fit (down to MIN_FONT), then wrapped, then ellipsised.
 */

export const PAGE_W = 842;
export const PAGE_H = 595;
export const MARGIN = 36;
export const MIN_FONT = 9;

export type FontName = 'Times-Roman' | 'Times-Bold' | 'Times-Italic' | 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique';

/** The small part of a pdfkit document the engine uses. */
export interface TextMeasurer {
  font(name: string): unknown;
  fontSize(size: number): unknown;
  widthOfString(text: string, options?: Record<string, unknown>): number;
  heightOfString(text: string, options?: { width?: number; lineGap?: number; [k: string]: unknown }): number;
}

export interface Box {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ZoneName = 'header' | 'title' | 'recipient' | 'body' | 'members' | 'signatures' | 'footer';

export interface Zone {
  name: ZoneName;
  y: number;
  h: number;
}

const buildZones = (heights: [ZoneName, number][]): Record<ZoneName, Zone> => {
  const out = {} as Record<ZoneName, Zone>;
  let y = MARGIN;
  for (const [name, h] of heights) {
    out[name] = { name, y, h };
    y += h;
  }
  return out;
};

/** Fixed vertical budget inside the safe area (595 - 2*36 = 523 pt in total; the border sits just outside it). */
export const ZONES: Record<ZoneName, Zone> = buildZones([
  ['header', 56],
  ['title', 62],
  ['recipient', 84],
  ['body', 110],
  ['members', 52],
  ['signatures', 98],
  ['footer', 61],
]); // 523

/**
 * Team certificates (v5d): same total and the SAME signatures/footer position (y = 400 / 498), but the team name zone is a
 * little shorter, the body is compact and the members block gets 76 pt for the grid. Individual certificates keep ZONES.
 */
export const TEAM_ZONES: Record<ZoneName, Zone> = buildZones([
  ['header', 56],
  ['title', 62],
  ['recipient', 78],
  ['body', 92],
  ['members', 76],
  ['signatures', 98],
  ['footer', 61],
]); // 523

export const zonesFor = (team: boolean): Record<ZoneName, Zone> => (team ? TEAM_ZONES : ZONES);

export interface FitOptions {
  font: FontName;
  size: number;
  /** Minimum font size (default MIN_FONT). */
  min?: number;
  maxW: number;
  maxH: number;
  /** Line gap as a fraction of the font size (default 0.2). */
  lineGapRatio?: number;
  /** Maximum number of wrapped lines (default: as many as fit in maxH). */
  maxLines?: number;
}

export interface FittedText {
  text: string; // possibly wrapped by '\n' and/or ellipsised
  size: number;
  font: FontName;
  lines: string[];
  lineHeight: number;
  w: number; // widest line
  h: number; // total height
  shrunk: boolean;
  wrapped: boolean;
  truncated: boolean;
}

const ELLIPSIS = '...'; // standard fonts: stay inside WinAnsi, no U+2026

/** Natural height of one line as the measurer reports it (pdfkit: ascender-descender of the current font). */
const naturalLine = (m: TextMeasurer, font: FontName, size: number): number => {
  m.font(font);
  m.fontSize(size);
  return m.heightOfString('Mg', { width: 1e6 });
};

const widthAt = (m: TextMeasurer, text: string, font: FontName, size: number): number => {
  m.font(font);
  m.fontSize(size);
  return m.widthOfString(text);
};

/** Greedy word wrap using the measurer. Words wider than maxW are broken by characters. */
export function wrapText(m: TextMeasurer, text: string, font: FontName, size: number, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  const pushWord = (word: string) => {
    if (widthAt(m, word, font, size) <= maxW) {
      cur = word;
      return;
    }
    let chunk = '';
    for (const ch of word) {
      if (chunk && widthAt(m, chunk + ch, font, size) > maxW) {
        lines.push(chunk);
        chunk = ch;
      } else chunk += ch;
    }
    cur = chunk;
  };
  for (const word of words) {
    if (!cur) {
      pushWord(word);
      continue;
    }
    const tryLine = `${cur} ${word}`;
    if (widthAt(m, tryLine, font, size) <= maxW) cur = tryLine;
    else {
      lines.push(cur);
      cur = '';
      pushWord(word);
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/** Cut `line` so that `line + '...'` fits maxW. */
export function ellipsize(m: TextMeasurer, line: string, font: FontName, size: number, maxW: number): string {
  if (widthAt(m, line, font, size) <= maxW) return line;
  let s = line.trimEnd();
  while (s.length > 0 && widthAt(m, s + ELLIPSIS, font, size) > maxW) s = s.slice(0, -1).trimEnd();
  return s + ELLIPSIS;
}

/**
 * 1. one line at `size`, shrinking by 0.5 pt down to `min`; 2. if still too wide, wrap at `min`... (wrapping is tried at
 * every size from the largest that fits the box height, so text stays as large as possible); 3. if it still does not fit
 * the height, keep the lines that fit and ellipsise the last one.
 */
export function fitText(m: TextMeasurer, raw: string, o: FitOptions): FittedText {
  const min = Math.min(o.min ?? MIN_FONT, o.size); // text deliberately set below the minimum is not shrunk, only wrapped/ellipsised
  const gap = o.lineGapRatio ?? 0.2;
  const text = raw.replace(/\s+/g, ' ').trim();
  const lh = (size: number) => Math.max(size * (1 + gap), naturalLine(m, o.font, size));
  const base = { font: o.font } as const;

  // step 1: shrink on a single line
  for (let size = o.size; size >= min - 1e-9; size -= 0.5) {
    const w = widthAt(m, text, o.font, size);
    if (w <= o.maxW && lh(size) <= o.maxH + 1e-9) {
      return { ...base, text, size, lines: [text], lineHeight: lh(size), w, h: lh(size), shrunk: size < o.size, wrapped: false, truncated: false };
    }
  }

  // step 2: wrap (largest size first that fits the height)
  let size = Math.max(min, Math.min(o.size, o.maxH / (1 + gap)));
  for (; size >= min - 1e-9; size -= 0.5) {
    const lines = wrapText(m, text, o.font, size, o.maxW);
    const cap = Math.min(o.maxLines ?? Infinity, Math.floor((o.maxH + 1e-9) / lh(size)));
    if (lines.length <= cap) {
      const w = Math.max(...lines.map((l) => widthAt(m, l, o.font, size)));
      return { ...base, text: lines.join('\n'), size, lines, lineHeight: lh(size), w, h: lines.length * lh(size), shrunk: size < o.size, wrapped: lines.length > 1, truncated: false };
    }
  }

  // step 3: ellipsis at the minimum size
  size = min;
  const lines = wrapText(m, text, o.font, size, o.maxW);
  const cap = Math.max(1, Math.min(o.maxLines ?? Infinity, Math.floor((o.maxH + 1e-9) / lh(size))));
  const kept = lines.slice(0, cap);
  if (lines.length > cap) kept[cap - 1] = ellipsize(m, kept[cap - 1] + ' ' + lines.slice(cap).join(' '), o.font, size, o.maxW);
  else kept[kept.length - 1] = ellipsize(m, kept[kept.length - 1], o.font, size, o.maxW);
  const w = Math.max(...kept.map((l) => widthAt(m, l, o.font, size)));
  return { ...base, text: kept.join('\n'), size, lines: kept, lineHeight: lh(size), w, h: kept.length * lh(size), shrunk: true, wrapped: kept.length > 1, truncated: true };
}

export interface PlacedText extends FittedText {
  box: Box;
  zone: ZoneName;
  slotW: number; // width of the horizontal slot the lines are centred in / left-aligned from
  x: number; // left edge of the slot
  y: number; // top edge
  align: 'center' | 'left';
}

/** Fit `raw` into a zone sub-slot (horizontal centre-aligned) and return where it goes. */
export function placeInZone(
  m: TextMeasurer,
  name: string,
  zone: ZoneName,
  raw: string,
  o: Omit<FitOptions, 'maxW' | 'maxH'> & { maxW?: number; maxH?: number; top: number; cx?: number; align?: 'center' | 'left'; left?: number; zones?: Record<ZoneName, Zone> },
): PlacedText {
  const z = (o.zones ?? ZONES)[zone];
  const maxW = o.maxW ?? PAGE_W - 2 * MARGIN - 40;
  const maxH = Math.min(o.maxH ?? z.h - o.top, z.y + z.h - (z.y + o.top));
  const fit = fitText(m, raw, { ...o, maxW, maxH });
  const align = o.align ?? 'center';
  const x = align === 'center' ? (o.cx ?? PAGE_W / 2) - maxW / 2 : (o.left ?? MARGIN);
  const y = z.y + o.top;
  // The reported box is the text's own extent (not the slot), so assertNoOverlap checks real ink.
  const bx = align === 'center' ? (o.cx ?? PAGE_W / 2) - fit.w / 2 : x;
  return { ...fit, zone, align, slotW: maxW, x, y, box: { name, x: bx, y, w: fit.w, h: fit.h } };
}


// ------------------------------------------------------------------------------------------------ member grid (v5d)

export interface MemberGridCell {
  text: string;
  x: number;
  y: number;
  w: number; // ink width
  slotW: number; // width of the column slot the text is clipped to
  box: Box;
}

export interface MemberGrid {
  cols: number;
  rows: number;
  size: number;
  lineHeight: number;
  cells: MemberGridCell[];
  ellipsised: number; // names that had to be cut with "..."
  hidden: number; // names that did not fit at all (only possible above MAX_GRID_MEMBERS); the last cell says "+N more"
  bottom: number; // lowest y used
}

export const MAX_GRID_MEMBERS = 20;
const GRID_PAD = 12; // horizontal gap between columns
const GRID_MAX_SIZE = 12;

/** Preferred column count for N names: 1-3 -> 1, 4-8 -> 2, 9-14 -> 3, 15+ -> 4. */
export const preferredColumns = (n: number): number => (n <= 3 ? 1 : n <= 8 ? 2 : n <= 14 ? 3 : 4);

/**
 * Lay ALL names out in a grid of 1-4 columns (row-major, so the first name - the leader - is top-left) inside `region`.
 * The font shrinks (to `min`, default 9 pt) and columns are added until everything fits the region height; names are only
 * cut with "..." when they still do not fit one line at 9 pt in 4 columns. Nothing is ever drawn below region.y + region.h.
 */
export function layoutMemberGrid(
  m: TextMeasurer,
  names: string[],
  region: { x: number; y: number; w: number; h: number },
  o: { font?: FontName; max?: number; min?: number } = {},
): MemberGrid {
  const font = o.font ?? 'Helvetica';
  const max = o.max ?? GRID_MAX_SIZE;
  const min = o.min ?? MIN_FONT;
  const list = names.map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const n = list.length;
  const lh = (size: number) => Math.max(size * 1.2, naturalLine(m, font, size));
  const widest = (size: number) => list.reduce((w, t) => Math.max(w, widthAt(m, t, font, size)), 0);
  const eps = 1e-9;
  const pref = preferredColumns(n);

  let cols = 0;
  let size = min;
  // 1. no name cut: the largest font over pref..4 columns, fewer columns on a tie
  for (let c = pref; c <= 4; c++) {
    const rows = Math.ceil(n / c);
    for (let s = max; s >= min - eps; s -= 0.5) {
      if (rows * lh(s) <= region.h + eps && widest(s) <= region.w / c - GRID_PAD) {
        if (!cols || s > size + eps) {
          cols = c;
          size = s;
        }
        break;
      }
    }
  }
  let hidden = 0;
  let shown = list;
  if (!cols) {
    // 2. names must be cut: smallest font, fewest columns whose rows fit the height (wider columns = fewer cuts)
    size = min;
    for (let c = pref; c <= 4 && !cols; c++) if (Math.ceil(n / c) * lh(size) <= region.h + eps) cols = c;
    if (!cols) {
      // 3. more names than 4 columns x available rows can hold: keep what fits, summarise the rest
      cols = 4;
      const cap = Math.max(1, Math.floor((region.h + eps) / lh(size))) * cols;
      hidden = n - (cap - 1);
      shown = [...list.slice(0, cap - 1), `+${hidden} more`];
    }
  }
  const rows = Math.max(1, Math.ceil(shown.length / cols));
  const inner = region.w / cols - GRID_PAD;
  let ellipsised = 0;
  const texts = shown.map((t) => {
    const e = ellipsize(m, t, font, size, inner);
    if (e !== t) ellipsised++;
    return e;
  });
  const widths = texts.map((t) => widthAt(m, t, font, size));
  const colW = Math.min(region.w / cols, Math.max(0, ...widths) + 2 * GRID_PAD);
  const x0 = region.x + (region.w - cols * colW) / 2;
  const lineHeight = lh(size);
  const cells: MemberGridCell[] = texts.map((text, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = x0 + c * colW + GRID_PAD / 2;
    const y = region.y + r * lineHeight;
    return { text, x, y, w: widths[i], slotW: colW - GRID_PAD, box: { name: `member${i}`, x, y, w: widths[i], h: lineHeight } };
  });
  return { cols, rows, size, lineHeight, cells, ellipsised, hidden, bottom: region.y + rows * lineHeight };
}

const EPS = 0.01;

/** Throws when two boxes intersect (touching edges are fine) or a box leaves the 36 pt safe margin. */
export function assertNoOverlap(boxes: Box[]): void {
  for (const b of boxes) {
    if (![b.x, b.y, b.w, b.h].every(Number.isFinite) || b.w < 0 || b.h < 0) throw new Error(`Invalid box "${b.name}"`);
    if (b.x < MARGIN - EPS || b.y < MARGIN - EPS || b.x + b.w > PAGE_W - MARGIN + EPS || b.y + b.h > PAGE_H - MARGIN + EPS) {
      throw new Error(`Box "${b.name}" leaves the ${MARGIN} pt safe margin (x=${b.x.toFixed(1)}, y=${b.y.toFixed(1)}, w=${b.w.toFixed(1)}, h=${b.h.toFixed(1)})`);
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const c = boxes[j];
      if (a.w <= 0 || a.h <= 0 || c.w <= 0 || c.h <= 0) continue;
      if (a.x < c.x + c.w - EPS && c.x < a.x + a.w - EPS && a.y < c.y + c.h - EPS && c.y < a.y + a.h - EPS) {
        throw new Error(`Boxes "${a.name}" and "${c.name}" overlap`);
      }
    }
  }
}
