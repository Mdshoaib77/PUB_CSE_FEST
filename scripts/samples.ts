/**
 * Renders docs/samples/*.pdf with the certificate renderer.
 *   npx tsx --tsconfig scripts/samples.tsconfig.json scripts/samples.ts          (real pdfkit when installed)
 *   FESTHUB_PDFKIT_STUB=1 npx tsx --tsconfig scripts/samples.tsconfig.json scripts/samples.ts   (offline stub)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderCertificateKit, type CertificatePdfInput } from '../apps/server/src/services/certificatePdf';

const out = resolve(process.cwd(), 'docs/samples') + '/'; // run from the repo root
mkdirSync(out, { recursive: true });
const base: CertificatePdfInput = {
  certId: 'FH-7K3M-Q9XA-2D5T-4H',
  type: 'participation',
  recipientName: 'Ada Lovelace',
  eventTitle: 'Poster Design Competition',
  eventDate: new Date('2026-11-02T10:00:00Z'),
  signatureText: 'Organizing Committee, PUB FestHub',
  verifyUrl: 'http://localhost:5173/verify/FH-7K3M-Q9XA-2D5T-4H',
  venue: 'Main Auditorium',
  signatories: [
    { name: 'Md. Rabiul Islam', title: 'Convener, Contest Sub Committee' },
    { name: 'Prof. Dr. Chitta Ranjan Misra', title: 'Vice Chancellor, PUB' },
  ],
};
const NAMES = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Katherine Johnson', 'Linus Torvalds', 'Margaret Hamilton', 'Dennis Ritchie', 'Barbara Liskov', 'Donald Knuth', 'Radia Perlman', 'Edsger Dijkstra', 'Frances Allen', 'Ken Thompson', 'Shafi Goldwasser', 'Tim Berners-Lee', 'Sophie Wilson', 'Guido van Rossum', 'Anita Borg', 'Bjarne Stroustrup', 'Hedy Lamarr'];
const team = (n: number, extra: Partial<CertificatePdfInput> = {}): CertificatePdfInput => ({ ...base, ...extra, teamName: 'Team Byte Rangers', recipientName: 'Team Byte Rangers', members: NAMES.slice(0, n) });
const jobs: [string, CertificatePdfInput][] = [
  ['individual', base],
  ['winner', { ...base, type: 'winner', certId: 'FH-2B8N-W4RC-6J1P-9K', positionLabel: '1st Place - Poster Design Competition' }],
  ['runner-up', { ...base, type: 'runner_up', certId: 'FH-5T2V-H7QD-3M8Z-1F', positionLabel: '2nd Place - Poster Design Competition' }],
  ['team-of-6', team(6)],
  ['team-of-20', team(20, { type: 'winner', positionLabel: '1st Place - Poster Design Competition' })],
];
(async () => {
  for (const [name, input] of jobs) {
    const r = await renderCertificateKit(input);
    writeFileSync(`${out}${name}.pdf`, r.bytes);
    console.log(name, r.pages, r.grid ? JSON.stringify(r.grid) : '');
  }
})();
