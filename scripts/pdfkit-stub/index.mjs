/**
 * Minimal pdfkit-compatible STUB used only to render docs/samples/ when the real `pdfkit` package cannot be installed
 * (offline sandbox). It implements just the calls certificatePdf.ts makes, writes a real single-page PDF 1.4 with the
 * 14 standard fonts and real AFM text metrics (metrics.json). Differences from pdfkit: gradients are drawn as one solid
 * colour, SVG arcs as straight lines, images are skipped. `npm install` + real pdfkit replaces it (see docs/samples/README.md).
 */
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

const M = JSON.parse(readFileSync(new URL('./metrics.json', import.meta.url), 'utf8'));
const FONTS = ['Helvetica', 'Helvetica-Bold', 'Times-Roman', 'Times-Bold', 'Times-Italic'];
const f2 = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => {
  if (Array.isArray(c)) return c.map((v) => f2(v / 255)).join(' ');
  const h = String(c).replace('#', '');
  return [0, 2, 4].map((i) => f2(parseInt(h.slice(i, i + 2), 16) / 255)).join(' ');
};
const latin = (s) => Array.from(s, (ch) => (ch.charCodeAt(0) <= 255 ? ch : '?')).join('');
const esc = (s) => latin(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export default class PDFDocument extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.pages = [];
    this.ops = null;
    this.fontName = 'Helvetica';
    this.size = 12;
    this.fill_ = '0 0 0';
    this.stroke_ = '0 0 0';
    this.pth = [];
    this.cur = { x: 0, y: 0 };
  }
  addPage(o = {}) {
    const [w, h] = o.size ?? this.opts.size ?? [595, 842];
    this.W = w;
    this.H = h;
    this.ops = [`1 0 0 -1 0 ${f2(h)} cm`]; // top-left origin like pdfkit
    this.pages.push(this.ops);
    return this;
  }
  bufferedPageRange() {
    return { start: 0, count: this.pages.length };
  }
  font(n) { if (FONTS.includes(n)) this.fontName = n; return this; }
  fontSize(s) { this.size = s; return this; }
  fillColor(c) { this.fill_ = rgb(c); return this; }
  strokeColor(c) { this.stroke_ = rgb(c); return this; }
  lineWidth(w) { this.ops.push(`${f2(w)} w`); return this; }
  widthOfString(t) {
    const tb = M[this.fontName];
    let w = 0;
    for (const ch of t) w += tb[Math.min(255, ch.charCodeAt(0))] ?? 556;
    return (w * this.size) / 1000;
  }
  heightOfString() { return this.size * 1.155; }
  // --- paths
  moveTo(x, y) { this.pth.push(`${f2(x)} ${f2(y)} m`); this.cur = { x, y }; return this; }
  lineTo(x, y) { this.pth.push(`${f2(x)} ${f2(y)} l`); this.cur = { x, y }; return this; }
  rect(x, y, w, h) { this.pth.push(`${f2(x)} ${f2(y)} ${f2(w)} ${f2(h)} re`); return this; }
  polygon(...pts) { pts.forEach((p, i) => this.pth.push(`${f2(p[0])} ${f2(p[1])} ${i ? 'l' : 'm'}`)); this.pth.push('h'); return this; }
  circle(cx, cy, r) {
    const k = 0.5523 * r;
    const c = [[cx + r, cy], [cx + r, cy + k, cx + k, cy + r, cx, cy + r], [cx - k, cy + r, cx - r, cy + k, cx - r, cy], [cx - r, cy - k, cx - k, cy - r, cx, cy - r], [cx + k, cy - r, cx + r, cy - k, cx + r, cy]];
    this.pth.push(`${f2(c[0][0])} ${f2(c[0][1])} m`);
    for (const s of c.slice(1)) this.pth.push(`${s.map(f2).join(' ')} c`);
    this.pth.push('h');
    return this;
  }
  // doc.path('M x y A r r 0 0 1 x2 y2'): the only form used (a circular arc, sweep 1) is sampled into short segments
  path(d) {
    const n = d.match(/-?\d+(?:\.\d+)?/g).map(Number);
    const [x1, y1, r, , , , x2, y2] = [n[0], n[1], n[2], n[3], n[4], n[5], n[6], n[7]];
    this.moveTo(x1, y1);
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1;
    const half = Math.hypot(dx, dy) / 2, h = Math.sqrt(Math.max(0, r * r - half * half));
    const cx = mx + (dy / (2 * half)) * h * -1, cy = my + (dx / (2 * half)) * h; // centre on the sweep-1 side
    const a1 = Math.atan2(y1 - cy, x1 - cx);
    let a2 = Math.atan2(y2 - cy, x2 - cx);
    while (a2 < a1) a2 += Math.PI * 2;
    for (let i = 1; i <= 12; i++) { const a = a1 + ((a2 - a1) * i) / 12; this.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
    return this;
  }
  linearGradient(x1, y1, x2, y2) {
    const g = { stops: [], stop(o, c) { this.stops.push(c); return this; } };
    return g;
  }
  _flush(op) { if (this.pth.length) this.ops.push(this.pth.join(' ') + ' ' + op); this.pth = []; }
  stroke(c) { if (c) this.strokeColor(c); this.ops.push(`${this.stroke_} RG`); this._flush('S'); return this; }
  fill(c) {
    if (c && typeof c === 'object' && !Array.isArray(c) && c.stops) c = c.stops[0];
    if (c) this.fillColor(c);
    this.ops.push(`${this.fill_} rg`);
    this._flush('f');
    return this;
  }
  clip() { this._flush('W n'); return this; }
  save() { this.ops.push('q'); return this; }
  restore() { this.ops.push('Q'); return this; }
  translate(x, y) { this.ops.push(`1 0 0 1 ${f2(x)} ${f2(y)} cm`); return this; }
  scale(x, y) { this.ops.push(`${f2(x)} 0 0 ${f2(y ?? x)} 0 0 cm`); return this; }
  rotate(deg, o = {}) {
    const [ox, oy] = o.origin ?? [0, 0];
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    // pdfkit rotates about the origin: T(o) R T(-o)
    this.ops.push(`${f2(c)} ${f2(s)} ${f2(-s)} ${f2(c)} ${f2(ox - c * ox + s * oy)} ${f2(oy - s * ox - c * oy)} cm`);
    return this;
  }
  image() { return this; }
  text(t, x, y, o = {}) {
    const s = latin(String(t));
    if (o.width && o.align === 'center') x += (o.width - this.widthOfString(s)) / 2; // pdfkit centres inside `width`
    else if (o.width && o.align === 'right') x += o.width - this.widthOfString(s);
    const fi = FONTS.indexOf(this.fontName) + 1;
    const mode = o.stroke ? (o.fill ? 2 : 1) : 0;
    const col = mode === 1 ? `${this.stroke_} RG` : `${this.fill_} rg`;
    const asc = (M[this.fontName + '__ad'][0] * this.size) / 1000;
    this.ops.push(`BT ${col} ${mode} Tr /F${fi} ${f2(this.size)} Tf 1 0 0 -1 ${f2(x)} ${f2(y + asc)} Tm (${esc(s)}) Tj ET`);
    return this;
  }
  end() {
    const objs = [];
    const add = (s) => (objs.push(s), objs.length);
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add('PAGES');
    const fontIds = FONTS.map((f) => add(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`));
    const kids = [];
    for (const ops of this.pages) {
      const body = ops.join('\n');
      const cid = add(`<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`);
      kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << ${fontIds.map((id, i) => `/F${i + 1} ${id} 0 R`).join(' ')} >> >> /Contents ${cid} 0 R >>`));
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n';
    const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
    this.emit('data', Buffer.from(out, 'latin1'));
    this.emit('end');
  }
}
