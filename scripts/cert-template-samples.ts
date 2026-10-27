/** Renders v6 template sample PDFs with the REAL pdfkit: `npx tsx scripts/cert-template-samples.ts [outDir]` (default docs/samples/v6). */
import fs from 'fs';
import path from 'path';
import { renderCertificateKit } from '../apps/server/src/services/certificatePdf';
import { defaultTemplate, mergeTemplateInput, sampleCertificate, templateToPdfInput } from '../apps/server/src/services/certTemplate';

const out = process.argv[2] ?? path.join(__dirname, '..', 'docs', 'samples', 'v6');
fs.mkdirSync(out, { recursive: true });
const EV = { title: 'PUB CSE Fest-26 Hackathon', date: new Date(Date.UTC(2026, 10, 12)), venue: 'Main Auditorium' };
const FULL = {
  theme: 'emerald' as const,
  borderStyle: 'classic' as const,
  fontStyle: 'serif' as const,
  sealEnabled: true,
  signatories: [
    { name: 'Md. Rabiul Islam', title: 'Convener, Contest Sub Committee' },
    { name: 'Md. Palash Tai', title: 'President, PUPC, Head, Dept. of CSE' },
    { name: 'Prof. Dr. Chitta Ranjan Misra', title: 'Vice Chancellor, PUB' },
  ],
  headlines: { participation: 'Certificate of Participation', winner: 'Certificate of Excellence' },
  customFields: [
    { label: 'Organized by', value: 'Dept. of CSE, PUB' },
    { label: 'Awarded at', value: 'Main Auditorium' },
    { label: 'Motto', value: 'Build. Break. Learn.' },
  ],
};
const cases: [string, Parameters<typeof mergeTemplateInput>[1], 'individual' | 'team3' | 'team8' | 'winner'][] = [
  ['default-individual', {}, 'individual'],
  ['full-individual-classic-serif', FULL, 'individual'],
  ['full-winner-modern-sans', { ...FULL, theme: 'royal', borderStyle: 'modern', fontStyle: 'sans' }, 'winner'],
  ['full-team3-minimal', { ...FULL, theme: 'violet', borderStyle: 'minimal' }, 'team3'],
  [
    'full-team8-sunset-custombody',
    {
      ...FULL,
      theme: 'sunset',
      bodyText: 'This certificate is proudly presented to {name} ({members}) in recognition of {position} in {event}, held on {date} at {venue}.',
    },
    'team8',
  ],
];
(async () => {
  for (const [name, input, kind] of cases) {
    const v = mergeTemplateInput(defaultTemplate(), input);
    const r = await renderCertificateKit(
      templateToPdfInput(v, { sigBufs: [] }, sampleCertificate(kind, EV, 'https://festhub.example/verify/FH-SAMPLE-PREVIEW')),
    );
    fs.writeFileSync(path.join(out, `${name}.pdf`), r.bytes);
    console.log(name, r.pages, 'page(s)');
  }
})();
