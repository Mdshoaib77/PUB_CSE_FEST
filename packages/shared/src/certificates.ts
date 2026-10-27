/**
 * Certificate constants + PURE helpers (S5): no I/O, no randomness inside (entropy is passed in), so they run
 * identically on the server and in the browser and are trivial to test.
 *
 * ID format:  FH-XXXX-XXXX-XXXX-CC
 *   - 12 payload characters from the Crockford base-32 alphabet (no I L O U), i.e. 60 bits of entropy
 *   - 2 check characters (a polynomial checksum mod 1021) that catch every single-character typo and
 *     virtually all swapped neighbours, so mistyped IDs are rejected before any database lookup.
 * The check characters are NOT a secret/signature: authenticity = "the ID exists in the database and is valid".
 */

export const CERTIFICATE_TYPES = ['participation', 'winner', 'runner_up', 'volunteer', 'organizer'] as const;
export type CertificateType = (typeof CERTIFICATE_TYPES)[number];
export const CERTIFICATE_STATUSES = ['valid', 'revoked'] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const CERTIFICATE_TYPE_LABELS: Record<CertificateType, string> = {
  participation: 'Participation',
  winner: 'Winner',
  runner_up: 'Runner-up',
  volunteer: 'Volunteer',
  organizer: 'Organizer',
};

export const CERT_ID_PREFIX = 'FH';
export const CERT_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 symbols
const PAYLOAD_LEN = 12;
const MOD = 1021; // prime < 1024 = 32*32, so the checksum fits in two base-32 characters

function checksum(payload: string): string {
  let h = 0;
  for (const ch of payload) h = (h * 37 + CERT_ID_ALPHABET.indexOf(ch) + 1) % MOD;
  return CERT_ID_ALPHABET[h >> 5] + CERT_ID_ALPHABET[h & 31];
}
const group = (p: string, c: string) => `${CERT_ID_PREFIX}-${p.slice(0, 4)}-${p.slice(4, 8)}-${p.slice(8, 12)}-${c}`;

/** Build an ID from at least 12 random bytes (pass `crypto.randomBytes(12)` / `crypto.getRandomValues`). Same bytes -> same ID. */
export function generateCertificateId(entropy: ArrayLike<number>): string {
  if (entropy.length < PAYLOAD_LEN) throw new Error(`generateCertificateId needs at least ${PAYLOAD_LEN} bytes of entropy`);
  let p = '';
  for (let i = 0; i < PAYLOAD_LEN; i++) p += CERT_ID_ALPHABET[Number(entropy[i]) & 31]; // 256 % 32 === 0, so no modulo bias
  return group(p, checksum(p));
}

/** Tolerant normaliser: trims, upper-cases, drops spaces/dashes, maps Crockford look-alikes (O->0, I/L->1) and re-inserts the dashes. Returns '' when the shape is wrong. */
export function normalizeCertificateId(input: unknown): string {
  if (typeof input !== 'string' || input.length > 64) return '';
  let s = input.trim().toUpperCase().replace(/[\s-]+/g, '');
  if (!s.startsWith(CERT_ID_PREFIX)) return '';
  s = s.slice(CERT_ID_PREFIX.length).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== PAYLOAD_LEN + 2 || [...s].some((c) => !CERT_ID_ALPHABET.includes(c))) return '';
  return group(s.slice(0, PAYLOAD_LEN), s.slice(PAYLOAD_LEN));
}

export interface CertificateIdCheck {
  ok: boolean;
  /** Canonical form (only when ok). */
  id?: string;
  reason?: 'format' | 'checksum';
}
/** Pure verification of an ID's shape + check characters (no database). */
export function verifyCertificateId(input: unknown): CertificateIdCheck {
  const id = normalizeCertificateId(input);
  if (!id) return { ok: false, reason: 'format' };
  const flat = id.replace(/-/g, '').slice(CERT_ID_PREFIX.length);
  return checksum(flat.slice(0, PAYLOAD_LEN)) === flat.slice(PAYLOAD_LEN) ? { ok: true, id } : { ok: false, reason: 'checksum' };
}

/** "1st", "2nd", "3rd", "4th", "11th" ... */
export function ordinal(n: number): string {
  const v = n % 100;
  const s = ['th', 'st', 'nd', 'rd'];
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Public verification payload returned by GET /verify/:id. */
export interface CertificateVerification {
  status: 'valid' | 'revoked' | 'not_found';
  id?: string;
  type?: CertificateType;
  typeLabel?: string;
  recipientName?: string;
  /** v4: 'team' certificates carry the team name and every member (leader first). Absent on old clients' data = individual. */
  kind?: CertificateKind;
  teamName?: string;
  members?: string[];
  contestTitle?: string;
  eventTitle?: string;
  eventDate?: string;
  positionLabel?: string;
  issuedAt?: string;
  revokedAt?: string;
  /** Present on a revoked certificate that was replaced by a reissue. */
  replacedBy?: string;
}

/**
 * Pure verdict used by GET /verify/:id: a malformed/mistyped ID or an unknown certificate is `not_found`,
 * otherwise `valid` or `revoked` (anything that is not `valid` counts as revoked).
 */
export function verificationVerdict(rawId: unknown, found: { status: string } | null | undefined): CertificateVerification['status'] {
  if (!verifyCertificateId(rawId).ok || !found) return 'not_found';
  return found.status === 'valid' ? 'valid' : 'revoked';
}

// ---------------------------------------------------------------------------------------------------------------------
// v4: team certificates, contest certificates, slot keys, position labels, verify payload. All PURE (no I/O).
// ---------------------------------------------------------------------------------------------------------------------

export const CERTIFICATE_KINDS = ['individual', 'team'] as const;
export type CertificateKind = (typeof CERTIFICATE_KINDS)[number];

/** One person on a certificate (snapshot: the name stays as it was when the certificate was issued). */
export interface CertificateRecipient {
  userId: string;
  name: string;
}

/**
 * Snapshot of a team's members: LEADER FIRST, then the other members in the order given, no duplicates (by user id),
 * entries without a name are dropped. The result is stored on the certificate and never recomputed.
 */
export function snapshotRecipients(leaderId: string, members: CertificateRecipient[]): CertificateRecipient[] {
  const seen = new Set<string>();
  const out: CertificateRecipient[] = [];
  const add = (m: CertificateRecipient) => {
    const id = String(m.userId);
    if (seen.has(id) || !m.name?.trim()) return;
    seen.add(id);
    out.push({ userId: id, name: m.name.trim() });
  };
  const lead = members.find((m) => String(m.userId) === String(leaderId));
  if (lead) add(lead);
  for (const m of members) add(m);
  return out;
}

export interface SlotInput {
  /** Event id; '' / undefined for a contest that is not linked to an event. */
  eventId?: unknown;
  contestId?: unknown;
  kind?: CertificateKind;
  /** individual -> user id; team -> team id */
  subjectId: unknown;
  type: string;
  activityId?: unknown;
}

/**
 * Uniqueness key of "one VALID certificate per subject, scope, type (and activity)".
 *  - individual, event:   `<event>:<user>:<type>:<activity>`            (unchanged since S5, so old rows keep their slots)
 *  - TEAM, event:         `<event>:t:<team>:<type>:<activity>`           (one slot per TEAM, whoever is on it)
 *  - individual, contest: `c:<contest>:u:<user>:<type>`
 *  - TEAM, contest:       `c:<contest>:t:<team>:<type>`
 * Revoking replaces the key with `x:<certId>` (done by the service), which frees the slot for a reissue.
 */
export function certificateSlotKey(i: SlotInput): string {
  const team = i.kind === 'team';
  if (i.contestId) return `c:${i.contestId}:${team ? 't' : 'u'}:${i.subjectId}:${i.type}`;
  return team ? `${i.eventId ?? ''}:t:${i.subjectId}:${i.type}:${i.activityId ?? ''}` : `${i.eventId ?? ''}:${i.subjectId}:${i.type}:${i.activityId ?? ''}`;
}

/** "1st Place - <title>" / "2nd Place - <title>". Never empty (falls back to "Event" for a blank title). */
export function positionLabelFor(position: number, title: string): string {
  return `${ordinal(position)} Place - ${title?.trim() || 'Event'}`;
}
/** Label for a certificate type: winner/runner-up always get "<ordinal> Place - <title>" (an explicit label wins); other types have none. */
export function defaultPositionLabel(type: string, title: string, position?: number, explicit?: string): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  if (type === 'winner') return positionLabelFor(position ?? 1, title);
  if (type === 'runner_up') return positionLabelFor(position ?? 2, title);
  return undefined;
}

export interface PlacingRow {
  rank: number;
  solved?: number;
  /** subject id (person or team) */
  id: string;
}
/**
 * Winner / runner-up of a final contest scoreboard: rows with rank 1 (winner) and rank 2 (runner-up); teams tied on rank share it.
 * Rows that solved nothing never get a place. If two rows tie for 1st, nobody is rank 2 (standard competition ranking).
 */
export function pickPlacings(rows: PlacingRow[]): { winner: PlacingRow[]; runner_up: PlacingRow[] } {
  const ok = rows.filter((r) => (r.solved ?? 1) > 0);
  return { winner: ok.filter((r) => r.rank === 1), runner_up: ok.filter((r) => r.rank === 2) };
}

/** Shape of a stored certificate that the verify page needs. */
export interface VerifiableCertificate {
  certId: string;
  status: string;
  type: string;
  kind?: string | null;
  recipientName: string;
  teamName?: string | null;
  recipients?: { name: string }[] | null;
  eventTitle: string;
  eventDate: Date | string;
  contestTitle?: string | null;
  positionLabel?: string | null;
  issuedAt?: Date | string | null;
  revokedAt?: Date | string | null;
  replacedById?: string | null;
}
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : undefined);

/** Public verification payload for a stored certificate: team certificates show the team name and ALL members (leader first). */
export function buildVerification(c: VerifiableCertificate): CertificateVerification {
  const team = c.kind === 'team';
  const revoked = c.status !== 'valid';
  return {
    status: revoked ? 'revoked' : 'valid',
    id: c.certId,
    type: c.type as CertificateType,
    typeLabel: CERTIFICATE_TYPE_LABELS[c.type as CertificateType],
    recipientName: c.recipientName,
    kind: team ? 'team' : 'individual',
    ...(team ? { teamName: c.teamName ?? c.recipientName, members: (c.recipients ?? []).map((r) => r.name) } : {}),
    ...(c.contestTitle ? { contestTitle: c.contestTitle } : {}),
    eventTitle: c.eventTitle,
    eventDate: new Date(c.eventDate).toISOString(),
    positionLabel: c.positionLabel ?? undefined,
    issuedAt: iso(c.issuedAt),
    ...(revoked ? { revokedAt: iso(c.revokedAt), replacedBy: c.replacedById ?? undefined } : {}),
  };
}
