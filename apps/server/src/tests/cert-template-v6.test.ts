import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_TYPES,
  CERT_BORDER_STYLES,
  CERT_FONT_STYLES,
  CERT_TEMPLATE_LIMITS as L,
  CERT_TEMPLATE_THEMES,
  applyPlaceholders,
  certTemplateInputSchema,
  unknownPlaceholders,
  type CertTemplateInput,
} from '@festhub/shared';
import { assertNoOverlap, PAGE_H, PAGE_W, ZONES } from '../services/certLayout';
import { renderCertificateKit, type CertificatePdfInput } from '../services/certificatePdf';
import { defaultTemplate, mergeTemplateInput, sampleCertificate, templateToPdfInput, templateView } from '../services/certTemplate';

const ok = (x: unknown) => certTemplateInputSchema.safeParse(x);
const msg = (x: unknown) => {
  const r = ok(x);
  return r.success ? '' : r.error.issues.map((i) => i.message).join(' | ');
};

describe('template validation limits', () => {
  it('accepts an empty body and every legacy S6 body', () => {
    expect(ok({}).success).toBe(true);
    expect(ok({ signatureName: 'Dr. A', signatureTitle: 'Convener', primaryColor: '#4f46e5', accentColor: '#d94c33' }).success).toBe(true);
  });
  it('enforces the limit of every text field (exactly at the limit passes, one over fails)', () => {
    const at = (n: number) => 'x'.repeat(n);
    expect(ok({ signatories: [{ name: at(L.signatoryName), title: at(L.signatoryTitle) }] }).success).toBe(true);
    expect(ok({ signatories: [{ name: at(L.signatoryName + 1), title: '' }] }).success).toBe(false);
    expect(ok({ signatories: [{ name: '', title: at(L.signatoryTitle + 1) }] }).success).toBe(false);
    expect(ok({ signatureName: at(L.signatoryName + 1) }).success).toBe(false);
    for (const t of CERTIFICATE_TYPES) {
      expect(ok({ headlines: { [t]: at(L.headline) } }).success).toBe(true);
      expect(ok({ headlines: { [t]: at(L.headline + 1) } }).success).toBe(false);
    }
    expect(ok({ bodyText: at(L.bodyText) }).success).toBe(true);
    expect(ok({ bodyText: at(L.bodyText + 1) }).success).toBe(false);
    expect(ok({ customFields: [{ label: at(L.fieldLabel), value: at(L.fieldValue) }] }).success).toBe(true);
    expect(ok({ customFields: [{ label: at(L.fieldLabel + 1), value: 'v' }] }).success).toBe(false);
    expect(ok({ customFields: [{ label: 'l', value: at(L.fieldValue + 1) }] }).success).toBe(false);
  });
  it('limits counts: 3 signatories, 4 custom fields, combined field length', () => {
    const s = { name: 'A', title: 'B' };
    expect(ok({ signatories: [s, s, s] }).success).toBe(true);
    expect(ok({ signatories: [s, s, s, s] }).success).toBe(false);
    const f = { label: 'Label', value: 'Value' };
    expect(ok({ customFields: [f, f, f, f] }).success).toBe(true);
    expect(ok({ customFields: [f, f, f, f, f] }).success).toBe(false);
    const big = { label: 'x'.repeat(L.fieldLabel), value: 'y'.repeat(L.fieldValue) }; // 72 each -> 4 x 72 > 150
    expect(msg({ customFields: [big, big, big, big] })).toMatch(/too long together/);
  });
  it('rejects unknown enum values, bad colours, unknown placeholders and half-filled fields; drops empty rows', () => {
    expect(ok({ theme: 'neon' }).success).toBe(false);
    expect(ok({ borderStyle: 'fancy' }).success).toBe(false);
    expect(ok({ fontStyle: 'comic' }).success).toBe(false);
    expect(ok({ primaryColor: 'red' }).success).toBe(false);
    expect(ok({ sealEnabled: 'yes' }).success).toBe(false);
    expect(msg({ bodyText: 'Hello {nmae}' })).toMatch(/Unknown placeholder/);
    expect(msg({ customFields: [{ label: 'Motto', value: '' }] })).toMatch(/both a label and a value/);
    const r = ok({
      customFields: [
        { label: '', value: '' },
        { label: 'Motto', value: 'Code' },
      ],
    });
    expect(r.success && r.data.customFields).toEqual([{ label: 'Motto', value: 'Code' }]);
    for (const t of CERT_THEMES_ALL()) expect(ok({ theme: t }).success).toBe(true);
    for (const b of CERT_BORDER_STYLES) expect(ok({ borderStyle: b }).success).toBe(true);
    for (const f of CERT_FONT_STYLES) expect(ok({ fontStyle: f }).success).toBe(true);
  });
  it('strips control characters and line breaks from text', () => {
    const r = ok({ bodyText: 'Line one\n\nline\ttwo\u0000 {name}', headlines: { winner: '  Great\r\nWin  ' } });
    expect(r.success && r.data.bodyText).toBe('Line one line two {name}');
    expect(r.success && r.data.headlines?.winner).toBe('Great Win');
  });
  it('templateView: old documents read as defaults, legacy signatory becomes slot 1, long values are clipped', () => {
    expect(templateView(null)).toEqual(defaultTemplate());
    const old = templateView({
      logoUrl: '/uploads/certs/a.png',
      signatureName: 'Dr. A',
      signatureTitle: 'Convener',
      signatureImageUrl: '/uploads/certs/b.png',
      primaryColor: '#111111',
      accentColor: 'bad',
    });
    expect(old.signatories[0]).toEqual({ name: 'Dr. A', title: 'Convener', imageUrl: '/uploads/certs/b.png' });
    expect(old.signatories[1]).toEqual({ name: '', title: '', imageUrl: null });
    expect(old.accentColor).toBe('#d94c33'); // invalid colour falls back
    expect(old).toMatchObject({
      theme: 'custom',
      borderStyle: 'classic',
      fontStyle: 'serif',
      sealEnabled: true,
      bodyText: '',
      customFields: [],
      signatureName: 'Dr. A',
    });
    const long = templateView({
      signatories: [{ name: 'N'.repeat(300), title: 'T'.repeat(300) }],
      bodyText: 'b'.repeat(900),
      customFields: Array.from({ length: 9 }, () => ({ label: 'L'.repeat(90), value: 'V'.repeat(90) })),
      headlines: { winner: 'h'.repeat(200) },
    });
    expect(long.signatories[0].name).toHaveLength(L.signatoryName);
    expect(long.signatories[0].title).toHaveLength(L.signatoryTitle);
    expect(long.bodyText).toHaveLength(L.bodyText);
    expect(long.customFields).toHaveLength(L.fields);
    expect(long.customFields[0].label).toHaveLength(L.fieldLabel);
    expect(long.headlines.winner).toHaveLength(L.headline);
  });
  it('mergeTemplateInput: partial update keeps images and untouched values; legacy signature fields edit slot 1', () => {
    const base = templateView({
      signatories: [
        { name: 'A', title: 'a', imageUrl: '/uploads/certs/s1.png' },
        { name: 'B', title: 'b' },
      ],
      theme: 'emerald',
      bodyText: 'keep',
    });
    const m = mergeTemplateInput(base, { signatories: [{ name: 'A2', title: 'a2' }], fontStyle: 'sans' } as CertTemplateInput);
    expect(m.signatories[0]).toEqual({ name: 'A2', title: 'a2', imageUrl: '/uploads/certs/s1.png' });
    expect(m.signatories[1].name).toBe('B'); // slot not sent: unchanged
    expect(m).toMatchObject({ theme: 'emerald', bodyText: 'keep', fontStyle: 'sans', signatureName: 'A2' });
    expect(mergeTemplateInput(base, { signatureName: 'Legacy' }).signatories[0].name).toBe('Legacy');
  });
});
const CERT_THEMES_ALL = () => [...CERT_TEMPLATE_THEMES];

describe('placeholder replacement', () => {
  const v = {
    name: 'Aisha Rahman',
    team: 'StackForge',
    members: 'Aisha, Tanvir, Nusrat',
    event: 'PUB CSE Fest-26',
    position: '1st Place',
    date: '12 November 2026',
    venue: 'Main Auditorium',
  };
  it('replaces every placeholder, also repeated ones', () => {
    expect(applyPlaceholders('{name} of {team} ({members}) won {position} at {event} on {date}, {venue}. {name}!', v)).toBe(
      'Aisha Rahman of StackForge (Aisha, Tanvir, Nusrat) won 1st Place at PUB CSE Fest-26 on 12 November 2026, Main Auditorium. Aisha Rahman!',
    );
  });
  it('empty values vanish cleanly (no double spaces, no space before punctuation, no empty brackets)', () => {
    expect(applyPlaceholders('Presented to {name} ({team}) for {position} .', { name: 'Aisha', team: '', position: '' })).toBe('Presented to Aisha for.');
    expect(applyPlaceholders('A  {team}   B', {})).toBe('A B');
  });
  it('is not an injection vector: values are inserted as text and are not re-expanded', () => {
    expect(applyPlaceholders('{name}', { name: '{event}', event: 'X' })).toBe('{event}');
    expect(applyPlaceholders('Hi {name}', { name: 'a\nb\u0000c' })).toBe('Hi a b c');
  });
  it('unknown tokens are left as typed and reported; the result is capped', () => {
    expect(applyPlaceholders('{who}', v)).toBe('{who}');
    expect(unknownPlaceholders('{name} {who} {who} {x}')).toEqual(['who', 'x']);
    const capped = applyPlaceholders('{members}', { members: 'm'.repeat(2000) });
    expect(capped.length).toBeLessThanOrEqual(L.bodyRendered);
    expect(capped.endsWith('...')).toBe(true);
  });
});

// ------------------------------------------------------------------ real pdfkit renders
const EV = { title: 'PUB CSE Fest-26 Hackathon', date: new Date(Date.UTC(2026, 10, 12)), venue: 'Main Auditorium' };
const url = 'https://festhub.example/verify/FH-SAMPLE-PREVIEW';
const png = (() => {
  // 1x1 PNG: enough for pdfkit to embed as logo / signature image
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
})();
const ALL_ON: CertTemplateInput = {
  theme: 'emerald',
  borderStyle: 'classic',
  fontStyle: 'serif',
  sealEnabled: true,
  signatories: [
    { name: 'N'.repeat(L.signatoryName), title: 'T'.repeat(L.signatoryTitle) },
    { name: 'Prof. Dr. Chitta Ranjan Misra', title: 'Vice Chancellor, Pundra University of Science & Technology' },
    { name: 'Md. Palash Tai', title: 'President, PUPC and Head of the Department of CSE' },
  ],
  headlines: {
    participation: 'Certificate of Appreciation',
    winner: 'Certificate of Excellence',
    runner_up: 'Certificate of Merit',
    volunteer: 'V'.repeat(L.headline),
    organizer: 'Certificate of Service',
  },
  bodyText: 'This certificate is proudly presented to {name} {team} ({members}) in recognition of {position} in {event}, held on {date} at {venue}.',
  customFields: [
    { label: 'Organized by', value: 'Dept. of CSE, PUB' },
    { label: 'Awarded at', value: 'Main Auditorium' },
    { label: 'Motto', value: 'Build. Break. Learn.' },
    { label: 'Sponsor', value: 'StackForge Labs' },
  ],
};
async function render(
  input: CertTemplateInput,
  kind: 'individual' | 'team3' | 'team8' | 'winner' | 'team20',
  images = true,
  type?: CertificatePdfInput['type'],
) {
  const view = mergeTemplateInput(defaultTemplate(), input);
  const assets = { logoBuf: images ? png : undefined, logo2Buf: images ? png : undefined, sigBufs: images ? [png, png, png] : [] };
  let facts =
    kind === 'team20'
      ? { ...sampleCertificate('team8', EV, url), members: Array.from({ length: 20 }, (_, i) => `Member Number ${i + 1} With A Long Name`) }
      : sampleCertificate(kind, EV, url);
  if (type) facts = { ...facts, type };
  const res = await renderCertificateKit(templateToPdfInput(view, assets, facts));
  assertNoOverlap(res.boxes);
  return res;
}
const names = (r: { boxes: { name: string }[] }) => r.boxes.map((b) => b.name);

describe('renderCertificateKit with every template option (real pdfkit)', () => {
  for (const kind of ['individual', 'team3', 'team8', 'winner', 'team20'] as const) {
    it(`all options ON, ${kind}: 1 page, no overlap, everything inside the page`, async () => {
      const r = await render(ALL_ON, kind);
      expect(r.pages).toBe(1);
      expect(Buffer.from(r.bytes.subarray(0, 5)).toString()).toBe('%PDF-');
      for (const b of r.boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(PAGE_W);
        expect(b.y + b.h).toBeLessThanOrEqual(PAGE_H);
      }
      const n = names(r);
      expect(n).toContain('logo');
      expect(n).toContain('logo2');
      expect(n).toContain('seal');
      expect(n).toContain('bodytext');
      expect(n.filter((x) => x.startsWith('sigimg'))).toHaveLength(3);
      expect(n.filter((x) => x.startsWith('signame'))).toHaveLength(3);
      expect(n).not.toContain('event'); // custom body replaces the default event block
      if (kind.startsWith('team'))
        expect(n).toContain('fields'); // team: custom fields in the header
      else expect(n.filter((x) => x.startsWith('fieldvalue'))).toHaveLength(4); // individual: one column per field
    });
  }
  it('every theme x border x font combination renders without overlap (individual and team of 8)', async () => {
    for (const theme of CERT_TEMPLATE_THEMES)
      for (const borderStyle of CERT_BORDER_STYLES)
        for (const fontStyle of CERT_FONT_STYLES)
          for (const kind of ['individual', 'team8'] as const) {
            const r = await render({ ...ALL_ON, theme, borderStyle, fontStyle, primaryColor: '#0f766e', accentColor: '#be185d' }, kind);
            expect(r.pages).toBe(1);
          }
  });
  it('seal off removes the seal box; second logo only when given', async () => {
    const off = await render({ ...ALL_ON, sealEnabled: false }, 'individual');
    expect(names(off)).not.toContain('seal');
    expect(names(off)).toContain('logo2');
    const noImg = await render(ALL_ON, 'individual', false);
    expect(names(noImg)).not.toContain('logo2');
    expect(names(noImg)).not.toContain('logo');
  });
  it('headline override is used per type, others keep the default title', async () => {
    const w = await render({ headlines: { winner: 'Certificate of Excellence' } }, 'winner');
    const p = await render({ headlines: { winner: 'Certificate of Excellence' } }, 'individual');
    expect(names(w)).toContain('title');
    expect(w.bytes.length).not.toBe(p.bytes.length);
  });
  it('worst-case text at every limit, wide glyphs, all 5 certificate types: never overlaps', async () => {
    const worst: CertTemplateInput = {
      ...ALL_ON,
      signatories: Array.from({ length: 3 }, () => ({ name: 'W'.repeat(L.signatoryName), title: 'W'.repeat(L.signatoryTitle) })),
      headlines: Object.fromEntries(CERTIFICATE_TYPES.map((t) => [t, 'W'.repeat(L.headline)])),
      bodyText: '{members} {members} {event} {event} '.repeat(10).slice(0, L.bodyText),
      customFields: [
        { label: 'W'.repeat(24), value: 'W'.repeat(48) },
        { label: 'W'.repeat(24), value: 'W'.repeat(48) },
        { label: 'M'.repeat(6), value: 'W'.repeat(6) },
        { label: 'M', value: 'W' },
      ],
    };
    for (const t of CERTIFICATE_TYPES)
      for (const kind of ['individual', 'team20'] as const)
        for (const borderStyle of CERT_BORDER_STYLES) {
          const r = await render({ ...worst, borderStyle }, kind, true, t);
          expect(r.pages).toBe(1);
          if (r.grid) expect(r.grid.bottom).toBeLessThanOrEqual(ZONES.signatures.y);
        }
  });
  it('defaults (no template) still render the v5 certificate', async () => {
    const r = await render({}, 'individual', false);
    expect(r.pages).toBe(1);
    expect(names(r)).toContain('seal');
    expect(names(r)).not.toContain('bodytext');
  });
});
