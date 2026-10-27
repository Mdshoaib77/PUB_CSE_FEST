import { describe, expect, it } from 'vitest';
import { pdfText, renderPortfolioPdf, renderTablePdf, toneForRank, type TableRow } from '../services/brandedPdf';

const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');
const pages = (b: Uint8Array) => (text(b).match(/\/Type \/Page\b/g) ?? []).length;
const mediaBox = (b: Uint8Array) => /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(text(b))!.slice(1).map(Number);

const row = (i: number): TableRow => ({ cells: [{ text: String(i + 1), badge: { fill: '#223d9c', color: '#fff' } }, { text: `Team ${i} ` + 'Long Name '.repeat(8), bold: true, sub: 'Team - ' + 'Member Name, '.repeat(20) }, { text: '90%' }, { text: '80%' }, { text: '85%' }, { text: 'none' }, { text: '88%', align: 'right', bar: { value: 88, color: '#c99a2e' } }] });
const cols = [{ header: 'Rank', width: 0.7 }, { header: 'Participant', width: 3 }, { header: 'Judge', width: 1 }, { header: 'AI', width: 1 }, { header: 'Base', width: 1 }, { header: 'Plag', width: 1 }, { header: 'Final', width: 1 }];

describe('v7 branded PDFs (real pdfkit)', () => {
  it('leaderboard table: A4 landscape, paginates, page numbers, valid PDF', async () => {
    const b = await renderTablePdf({ landscape: true, brandLine: 'FestHub', title: 'Event with a very long title '.repeat(4), subtitle: 'sub', note: 'note '.repeat(60), columns: cols, rows: Array.from({ length: 60 }, (_, i) => row(i)), footerLeft: 'footer' });
    expect(text(b).startsWith('%PDF')).toBe(true);
    const [w, h] = mediaBox(b);
    expect(Math.round(w)).toBe(842);
    expect(Math.round(h)).toBe(595);
    expect(pages(b)).toBeGreaterThan(2);
  });
  it('empty table still renders one page', async () => {
    const b = await renderTablePdf({ landscape: true, brandLine: 'FestHub', title: 'Empty', columns: cols, rows: [], emptyText: 'Nothing', footerLeft: 'f' });
    expect(pages(b)).toBe(1);
  });
  it('portfolio: A4 portrait, long content paginates, empty portfolio is one page', async () => {
    const base = { name: 'Nusrat '.repeat(10), generated: '26 Oct 2026', brandLine: 'FestHub', summary: { certificates: 12, results: 1, feedback: 1, bestRank: 1 } };
    const full = await renderPortfolioPdf({
      ...base,
      certificates: Array.from({ length: 12 }, (_, i) => ({ title: `Title ${i} ` + 'x'.repeat(80), badge: 'A very long badge text here', rank: (i % 4) || null, recipient: 'Team Alpha', members: Array.from({ length: 20 }, (_, k) => `Member Number ${k}`), event: 'Event '.repeat(20), date: '1 Oct 2026', id: `FH-${i}` })),
      results: [{ event: 'E', participant: 'P', rank: 12, ranked: 20, tied: true, final: 60, judge: null, ai: 60, penalty: 10 }],
      feedback: [{ event: 'E', points: 5, maxPoints: 10, percent: 50, summary: 'long summary '.repeat(80), date: '1 Oct 2026' }],
    });
    const [w, h] = mediaBox(full);
    expect([Math.round(w), Math.round(h)]).toEqual([595, 842]);
    expect(pages(full)).toBeGreaterThan(1);
    const empty = await renderPortfolioPdf({ ...base, summary: { certificates: 0, results: 0, feedback: 0, bestRank: null }, certificates: [], results: [], feedback: [] });
    expect(pages(empty)).toBe(1);
  });
  it('helpers: text is WinAnsi-safe, rank tones', () => {
    expect(pdfText('Rahim\u2019s \u09AC\u09BE\u0982\u09B2\u09BE')).toBe("Rahim's ?????");
    expect(toneForRank(1).fill).not.toBe(toneForRank(4).fill);
    expect(toneForRank(null).fill).toBe(toneForRank(9).fill);
  });
});
