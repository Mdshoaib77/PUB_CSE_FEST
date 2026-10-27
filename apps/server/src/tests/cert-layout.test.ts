import { describe, expect, it } from 'vitest';
import { assertNoOverlap, fitText, layoutMemberGrid, MARGIN, MIN_FONT, PAGE_H, PAGE_W, preferredColumns, TEAM_ZONES, ZONES, type TextMeasurer } from '../services/certLayout';
import { CERT_THEMES, renderCertificateKit, resolveCertPalette, type CertificatePdfInput, type CertTheme } from '../services/certificatePdf';

/** Deterministic fake measurer (no pdfkit needed): 0.5 em per char, 1.15 em line height. */
function fake(): TextMeasurer {
  let size = 12;
  return {
    font: () => undefined,
    fontSize: (s: number) => {
      size = s;
    },
    widthOfString: (t: string) => t.length * size * 0.5,
    heightOfString: (t: string, o?: { width?: number }) => {
      const lines = o?.width ? Math.max(1, Math.ceil((t.length * size * 0.5) / o.width)) : 1;
      return lines * size * 1.15;
    },
  };
}

describe('certLayout (pure)', () => {
  it('fitText: shrink, then wrap, then ellipsis', () => {
    const m = fake();
    const a = fitText(m, 'Short', { font: 'Times-Bold', size: 30, maxW: 400, maxH: 50 });
    expect(a.size).toBe(30);
    const b = fitText(m, 'A fairly long name that will not fit on one line at full size', { font: 'Times-Bold', size: 30, maxW: 300, maxH: 50 });
    expect(b.shrunk || b.wrapped).toBe(true);
    expect(b.size).toBeGreaterThanOrEqual(9);
    const c = fitText(m, 'X'.repeat(500), { font: 'Times-Bold', size: 30, maxW: 200, maxH: 30 });
    expect(c.truncated).toBe(true);
    expect(c.size).toBe(9);
    expect(c.lines.at(-1)!.endsWith('...')).toBe(true);
    expect(c.w).toBeLessThanOrEqual(200);
  });
  it('assertNoOverlap: passes for disjoint/touching boxes, throws on overlap or margin breach', () => {
    const ok = [{ name: 'a', x: 40, y: 40, w: 100, h: 20 }, { name: 'b', x: 40, y: 60, w: 100, h: 20 }];
    expect(() => assertNoOverlap(ok)).not.toThrow();
    expect(() => assertNoOverlap([...ok, { name: 'c', x: 50, y: 50, w: 20, h: 20 }])).toThrow(/overlap/);
    expect(() => assertNoOverlap([{ name: 'd', x: MARGIN - 5, y: 100, w: 10, h: 10 }])).toThrow(/safe margin/);
    expect(() => assertNoOverlap([{ name: 'e', x: 100, y: PAGE_H - MARGIN - 5, w: 10, h: 10 }])).toThrow(/safe margin/);
    expect(() => assertNoOverlap([{ name: 'f', x: PAGE_W - MARGIN - 5, y: 100, w: 10, h: 10 }])).toThrow(/safe margin/);
  });
});

const base: CertificatePdfInput = {
  certId: 'FH-1234-5678-9ABC-6V',
  type: 'winner',
  recipientName: 'Ada Lovelace',
  eventTitle: 'Poster Design Competition',
  eventDate: new Date('2026-11-02T10:00:00Z'),
  positionLabel: '1st Place - Poster Design Competition',
  signatureText: 'Organizing Committee',
  verifyUrl: 'http://localhost:5173/verify/FH-1234-5678-9ABC-6V',
  venue: 'Main Auditorium',
};
const pageCount = (b: Uint8Array) => (Buffer.from(b).toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

describe('renderCertificateKit (pdfkit)', () => {
  it('normal name: 1 page, no overlap', async () => {
    const r = await renderCertificateKit(base);
    expect(Buffer.from(r.bytes).subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.pages).toBe(1);
    expect(pageCount(r.bytes)).toBe(1);
    expect(() => assertNoOverlap(r.boxes)).not.toThrow();
  });
  it('very long name: shrinks/wraps, 1 page, no overlap', async () => {
    const r = await renderCertificateKit({ ...base, recipientName: 'Maximilian Bartholomew Wolfeschlegelstein-Hausen the Third of Greater Metropolitan Dhaka '.repeat(2), eventTitle: 'An Extremely Long Event Title '.repeat(8), positionLabel: undefined, type: 'participation' });
    expect(r.pages).toBe(1);
    expect(pageCount(r.bytes)).toBe(1);
    expect(() => assertNoOverlap(r.boxes)).not.toThrow();
  });
  it('team of 3 with signatories: 1 page, no overlap', async () => {
    const r = await renderCertificateKit({
      ...base,
      type: 'participation',
      positionLabel: undefined,
      recipientName: 'Team Alpha',
      teamName: 'Team Alpha',
      members: ['Ada Lovelace', 'Grace Hopper', 'Alan Turing'],
      signatories: [{ name: 'Dr. A', title: 'Convenor' }, { name: 'Prof. B', title: 'Head of Department' }],
    });
    expect(r.pages).toBe(1);
    expect(pageCount(r.bytes)).toBe(1);
    expect(r.boxes.some((b) => b.name === 'members')).toBe(true);
    expect(() => assertNoOverlap(r.boxes)).not.toThrow();
  });
});

describe('certificate themes (v5b)', () => {
  it('maps preset colour pairs to a theme, keeps custom hex colours, falls back to royal', () => {
    for (const k of Object.keys(CERT_THEMES) as CertTheme[]) {
      expect(resolveCertPalette({ theme: k }).theme).toBe(k);
      expect(resolveCertPalette({ primaryColor: CERT_THEMES[k].primary.toUpperCase(), accentColor: CERT_THEMES[k].accent }).theme).toBe(k);
    }
    const custom = resolveCertPalette({ primaryColor: '#123456', accentColor: '#abcdef' });
    expect([custom.theme, custom.primary, custom.accent]).toEqual(['custom', '#123456', '#abcdef']);
    expect(resolveCertPalette({ primaryColor: 'nope' }).primary).toBe(CERT_THEMES.royal.primary);
  });
  it('every theme and a custom colour render one page without overlap', async () => {
    const brands = [...(Object.keys(CERT_THEMES) as CertTheme[]).map((theme) => ({ theme })), { primaryColor: '#0f766e', accentColor: '#b45309' }];
    for (const brand of brands) {
      const r = await renderCertificateKit({ ...base, brand });
      expect(r.pages).toBe(1);
      expect(() => assertNoOverlap(r.boxes)).not.toThrow();
    }
  });
});

// 1x1 PNG, enough for pdfkit to embed
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sigs3 = [
  { name: 'Md. Rabiul Islam', title: 'Convener, Contest Sub Committee', imageBuf: PNG },
  { name: 'Md. Palash Tai', title: 'President, PUPC', imageBuf: PNG },
  { name: 'Prof. Dr. Chitta Ranjan Misra', title: 'Vice Chancellor, PUB', imageBuf: PNG },
];

describe('seal, logo, signatories, QR footer, revoked (v5c)', () => {
  const check = async (input: CertificatePdfInput) => {
    const r = await renderCertificateKit(input);
    expect(r.pages).toBe(1);
    expect(pageCount(r.bytes)).toBe(1);
    expect(() => assertNoOverlap(r.boxes)).not.toThrow();
    return r;
  };
  it('winner (gold seal) with logo and 3 signatories', async () => {
    const r = await check({ ...base, logoBuf: PNG, signatories: sigs3 });
    const names = r.boxes.map((b) => b.name);
    expect(names).toEqual(expect.arrayContaining(['seal', 'qr', 'logo', 'certid', 'verify', 'signame0', 'signame1', 'signame2', 'sigimg2']));
  });
  it('runner-up (silver seal), no logo, no signatories (default signature line)', async () => {
    const r = await check({ ...base, type: 'runner_up', positionLabel: '2nd Place - Poster Design Competition' });
    const names = r.boxes.map((b) => b.name);
    expect(names).not.toContain('logo');
    expect(names.filter((n) => n.startsWith('signame'))).toHaveLength(1);
  });
  it('participation / volunteer / organizer use the brand seal', async () => {
    for (const type of ['participation', 'volunteer', 'organizer'] as const) await check({ ...base, type, positionLabel: undefined, brand: { theme: 'emerald' } });
  });
  it('skips empty signatories and keeps the rest centred', async () => {
    const r = await check({ ...base, signatories: [sigs3[0], { name: '', title: '' }, sigs3[2]] });
    expect(r.boxes.filter((b) => b.name.startsWith('signame'))).toHaveLength(2);
  });
  it('revoked certificate renders the watermark and still passes the layout checks', async () => {
    await check({ ...base, revoked: true, logoBuf: PNG, signatories: sigs3 });
  });
  it('a very long verify URL wraps in the footer without overlap', async () => {
    await check({ ...base, verifyUrl: `https://festhub.example.edu/verify/${'A'.repeat(60)}` });
  });
});

// ---------------------------------------------------------------------------------------------- team member grid (v5d)

const NAMES = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Linus Torvalds', 'Margaret Hamilton', 'Dennis Ritchie', 'Barbara Liskov', 'Donald Knuth', 'Radia Perlman', 'Edsger Dijkstra', 'Frances Allen', 'Ken Thompson', 'Shafi Goldwasser', 'Tim Berners-Lee', 'Sophie Wilson', 'Guido van Rossum', 'Anita Borg', 'Bjarne Stroustrup', 'Hedy Lamarr'];
const LONG = (i: number) => `Member${i} Maximilian Bartholomew Wolfeschlegelstein-Hausen the Third of Greater Metropolitan Dhaka`;
const teamInput = (members: string[], extra: Partial<CertificatePdfInput> = {}): CertificatePdfInput => ({ ...base, type: 'participation', positionLabel: undefined, teamName: 'Team Byte Rangers', recipientName: 'Team Byte Rangers', members, ...extra });
const MZ = TEAM_ZONES.members;
const region = { x: MARGIN + 20, y: MZ.y + 17, w: PAGE_W - 2 * MARGIN - 40, h: MZ.y + MZ.h - 3 - (MZ.y + 17) };

describe('member grid layout (pure, fake measurer)', () => {
  it('team zones keep the signature and footer zones where the individual layout has them', () => {
    expect(TEAM_ZONES.signatures).toEqual(ZONES.signatures);
    expect(TEAM_ZONES.footer).toEqual(ZONES.footer);
    expect(TEAM_ZONES.members.y + TEAM_ZONES.members.h).toBe(ZONES.signatures.y);
  });
  it('column count adapts to the member count (1-4)', () => {
    expect([1, 3, 4, 8, 9, 14, 15, 20].map(preferredColumns)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
  it('every count 1..20 lists ALL names, in order, inside the region, above the signature zone', () => {
    const m = fake();
    for (let n = 1; n <= 20; n++) {
      const g = layoutMemberGrid(m, NAMES.slice(0, n), region);
      expect(g.cells.map((c) => c.text)).toEqual(NAMES.slice(0, n));
      expect(g.cols).toBeGreaterThanOrEqual(1);
      expect(g.cols).toBeLessThanOrEqual(4);
      expect(g.size).toBeGreaterThanOrEqual(MIN_FONT);
      expect(g.bottom).toBeLessThanOrEqual(ZONES.signatures.y);
      expect(g.bottom).toBeLessThanOrEqual(region.y + region.h + 1e-6);
      expect(g.ellipsised).toBe(0);
      expect(() => assertNoOverlap(g.cells.map((c) => c.box))).not.toThrow();
      expect(g.cells[0].x).toBeLessThanOrEqual(Math.min(...g.cells.map((c) => c.x)) + 1e-6); // leader first = top-left
    }
  });
  it('font shrinks and columns are added as the team grows', () => {
    const m = fake();
    const g2 = layoutMemberGrid(m, NAMES.slice(0, 2), region);
    const g20 = layoutMemberGrid(m, NAMES.slice(0, 20), region);
    expect(g2.cols).toBe(1);
    expect(g20.cols).toBe(4);
    expect(g20.size).toBeLessThan(g2.size);
  });
  it('very long names: still all listed, cut with "...", never below the minimum font or into the signature zone', () => {
    const m = fake();
    const names = Array.from({ length: 20 }, (_, i) => LONG(i));
    const g = layoutMemberGrid(m, names, region);
    expect(g.cells).toHaveLength(20);
    expect(g.ellipsised).toBe(20);
    expect(g.size).toBe(MIN_FONT);
    expect(g.bottom).toBeLessThanOrEqual(ZONES.signatures.y);
    for (const c of g.cells) expect(c.w).toBeLessThanOrEqual(c.slotW + 1e-6);
  });
  it('more than 20 names: the rest is summarised as "+N more", still above the signature zone', () => {
    const g = layoutMemberGrid(fake(), Array.from({ length: 30 }, (_, i) => `Person ${i + 1}`), region);
    expect(g.hidden).toBeGreaterThan(0);
    expect(g.cells.at(-1)!.text).toBe(`+${g.hidden} more`);
    expect(g.bottom).toBeLessThanOrEqual(ZONES.signatures.y);
  });
});

describe('team certificate (pdfkit): 2, 6, 12, 20 members and very long names', () => {
  const run = async (members: string[], extra: Partial<CertificatePdfInput> = {}) => {
    const r = await renderCertificateKit(teamInput(members, extra));
    expect(r.pages).toBe(1);
    expect(pageCount(r.bytes)).toBe(1);
    expect(() => assertNoOverlap(r.boxes)).not.toThrow();
    expect(r.grid).toBeDefined();
    expect(r.grid!.bottom).toBeLessThanOrEqual(r.grid!.limit);
    // every member box (and the label) ends above the signature zone and every signature box starts at or below it
    const sigTop = ZONES.signatures.y;
    for (const b of r.boxes.filter((x) => /^member\d+$/.test(x.name) || x.name === 'members')) expect(b.y + b.h).toBeLessThanOrEqual(sigTop + 1e-6);
    for (const b of r.boxes.filter((x) => /^sig/.test(x.name))) expect(b.y).toBeGreaterThanOrEqual(sigTop - 1e-6);
    expect(r.boxes.filter((x) => /^member\d+$/.test(x.name))).toHaveLength(members.length);
    return r;
  };
  it.each([2, 6, 12, 20])('team of %i', async (n) => {
    const r = await run(NAMES.slice(0, n));
    expect(r.grid!.hidden).toBe(0);
    expect(r.grid!.cols).toBe(preferredColumns(n) > 1 || n > 3 ? r.grid!.cols : 1);
  });
  it('team of 20 with very long member names, a long team name and a long event title', async () => {
    const r = await run(Array.from({ length: 20 }, (_, i) => LONG(i)), { teamName: 'The Extraordinarily Long Team Name of the Greater Metropolitan Programming Society '.repeat(2), eventTitle: 'An Extremely Long Event Title '.repeat(6), positionLabel: '1st Place - Poster Design Competition', type: 'winner', signatories: sigs3 });
    expect(r.grid!.size).toBeGreaterThanOrEqual(MIN_FONT);
  });
  it('team of 20 with a position label, venue, 3 signatories, logo and revoked stamp', async () => {
    await run(NAMES, { type: 'runner_up', positionLabel: '2nd Place - Poster Design Competition', logoBuf: PNG, signatories: sigs3, revoked: true });
  });
  it('individual certificates have no member grid and keep their zones', async () => {
    const r = await renderCertificateKit(base);
    expect(r.grid).toBeUndefined();
    expect(r.boxes.some((b) => /^member\d+$/.test(b.name))).toBe(false);
  });
});
