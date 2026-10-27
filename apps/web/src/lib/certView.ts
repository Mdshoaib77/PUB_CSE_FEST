/** v7: pure helpers shared by the certificate cards (Achievements, My certificates, Leaderboard) + the browser-side blob helpers. */
import { requestBlob } from './api';

export interface CertLike {
  id: string;
  type: string;
  typeLabel: string;
  eventTitle: string;
  eventDate: string;
  positionLabel?: string | null;
  issuedAt?: string;
  status?: 'valid' | 'revoked';
  kind?: 'individual' | 'team';
  recipientName?: string;
  teamName?: string | null;
  /** names, or `{ name }` objects (as /certificates/mine returns them) */
  members?: (string | { name: string })[];
}
export type CertTone = 'gold' | 'silver' | 'bronze' | 'brand';

export const certMembers = (c: Pick<CertLike, 'members'>): string[] => (c.members ?? []).map((m) => (typeof m === 'string' ? m : m.name)).filter(Boolean);
export const isTeamCert = (c: CertLike) => c.kind === 'team';
/** Team name for a team certificate, otherwise the individual's name. */
export const certHolder = (c: CertLike): string => (isTeamCert(c) ? (c.teamName ?? c.recipientName ?? 'Team') : (c.recipientName ?? 'Participant'));

/** Short badge text: "1st Place", "Runner-up", "Participation"... (position label is "<ordinal> Place - <activity>"). */
export const certBadge = (c: Pick<CertLike, 'positionLabel' | 'typeLabel'>): string => (c.positionLabel ? c.positionLabel.split(' - ')[0] : c.typeLabel) || c.typeLabel;

export function certTone(c: Pick<CertLike, 'type' | 'positionLabel'>): CertTone {
  const p = (c.positionLabel ?? '').toLowerCase();
  if (c.type === 'winner' || p.startsWith('1st')) return 'gold';
  if (c.type === 'runner_up' || p.startsWith('2nd')) return 'silver';
  if (p.startsWith('3rd')) return 'bronze';
  return 'brand';
}

const slug = (s: string, max: number, fallback: string) => {
  const t = s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return t || fallback;
};
/** `FestHub-Certificate-<event>-<name>.pdf` - letters, digits and dashes only, each part length-capped. */
export const certFileName = (eventTitle: string, name: string) => `FestHub-Certificate-${slug(eventTitle, 40, 'Event')}-${slug(name, 40, 'Participant')}.pdf`;

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Fetch the real certificate PDF (the same bytes the server's download route returns). */
export const fetchCertPdf = (id: string) => requestBlob('GET', `/certificates/${encodeURIComponent(id)}/download`);

/** Download with the friendly file name. */
export async function downloadCert(c: CertLike & { eventTitle: string }, nameOverride?: string) {
  const blob = await fetchCertPdf(c.id);
  saveBlob(blob, certFileName(c.eventTitle, nameOverride ?? certHolder(c)));
}
