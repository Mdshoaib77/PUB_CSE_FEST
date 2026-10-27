import { describe, expect, it } from 'vitest';
import { generateCertificateId, normalizeCertificateId, ordinal, qrMatrix, verifyCertificateId } from '@festhub/shared';
import { renderCertificatePdf } from '../services/certificatePdf';

const bytes = (seed: number) => Uint8Array.from({ length: 12 }, (_, i) => (i * 31 + seed * 17) & 255);

describe('certificate id (pure, no DB)', () => {
  it('is deterministic for the same entropy and has the FH-XXXX-XXXX-XXXX-CC shape', () => {
    const a = generateCertificateId(bytes(1));
    expect(a).toBe(generateCertificateId(bytes(1)));
    expect(a).toMatch(/^FH-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/);
    expect(generateCertificateId(bytes(2))).not.toBe(a);
  });
  it('needs enough entropy', () => {
    expect(() => generateCertificateId(new Uint8Array(5))).toThrow();
  });
  it('verifies its own output, tolerates case/spacing/look-alikes, rejects typos', () => {
    const id = generateCertificateId(bytes(3));
    expect(verifyCertificateId(id)).toEqual({ ok: true, id });
    expect(verifyCertificateId(id.toLowerCase().replace(/-/g, ' ')).ok).toBe(true);
    expect(normalizeCertificateId(id.replace(/0/g, 'O'))).toBe(id);
    for (let i = 3; i < id.length; i++) {
      if (id[i] === '-') continue;
      const other = id[i] === '2' ? '3' : '2';
      expect(verifyCertificateId(id.slice(0, i) + other + id.slice(i + 1)).ok).toBe(false);
    }
    expect(verifyCertificateId('nonsense')).toEqual({ ok: false, reason: 'format' });
    expect(verifyCertificateId(42).ok).toBe(false);
  });
  it('ordinal', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 102].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '102nd']);
  });
});

describe('qr + certificate pdf (pure)', () => {
  it('qrMatrix returns a square, finder-patterned matrix and grows with the text', () => {
    const small = qrMatrix('hello');
    const big = qrMatrix('https://example.test/verify/FH-1234-5678-9ABC-6V' + 'x'.repeat(80));
    expect(small.length).toBe(21);
    expect(big.length).toBeGreaterThan(small.length);
    expect(small.every((row) => row.length === small.length)).toBe(true);
    expect([small[0][0], small[0][6], small[6][0], small[6][6], small[3][3]]).toEqual([true, true, true, true, true]);
    expect(() => qrMatrix('x'.repeat(300))).toThrow();
  });
  it('renders a one-page PDF, with and without the revoked stamp', () => {
    const base = {
      certId: 'FH-1234-5678-9ABC-6V',
      type: 'winner' as const,
      recipientName: 'Ada (Lovelace) \\ Ünï',
      eventTitle: 'Poster Design Competition',
      eventDate: new Date('2026-11-02T10:00:00Z'),
      positionLabel: '1st Place - Poster Design Competition',
      signatureText: 'Organizing Committee',
      verifyUrl: 'http://localhost:5173/verify/FH-1234-5678-9ABC-6V',
    };
    const ok = Buffer.from(renderCertificatePdf(base)).toString('latin1');
    const revoked = Buffer.from(renderCertificatePdf({ ...base, revoked: true })).toString('latin1');
    for (const s of [ok, revoked]) {
      expect(s.startsWith('%PDF-1.4')).toBe(true);
      expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
      expect(s).toContain('/Count 1');
      const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
      expect(s.slice(xref, xref + 4)).toBe('xref');
    }
    expect(ok).not.toContain('REVOKED');
    expect(revoked).toContain('REVOKED');
    expect(ok).toContain('FH-1234-5678-9ABC-6V');
  });
});
