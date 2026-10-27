import { describe, expect, it } from 'vitest';
import { csvField, exportFileName, toCsv, toPdf } from '@festhub/shared';

const cols = [
  { header: 'Name', value: 'name' as const, width: 2 },
  { header: 'Note', value: 'note' as const },
];

describe('export helpers (no DB)', () => {
  it('escapes CSV fields and guards formulas', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField(-5)).toBe('-5');
    expect(csvField(null)).toBe('');
  });
  it('builds CSV with BOM and CRLF', () => {
    const out = toCsv([{ name: 'Ann', note: 'x\ny' }], cols);
    expect(out.startsWith('\uFEFFName,Note\r\n')).toBe(true);
    expect(out).toContain('Ann,"x\ny"');
    expect(toCsv([], cols, { bom: false })).toBe('Name,Note\r\n');
  });
  it('builds a valid-looking multi-page PDF', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ name: `Row ${i} (é) ☃`, note: 'n' }));
    const bytes = toPdf(rows, cols, { title: 'T', subtitle: 'S' });
    const s = Buffer.from(bytes).toString('latin1');
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(Number(/\/Count (\d+)/.exec(s)![1])).toBeGreaterThan(1);
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe('xref');
    expect(toPdf([], cols, { title: 'Empty' }).length).toBeGreaterThan(100);
  });
  it('sanitises file names', () => {
    expect(exportFileName('My Report/../x.csv', 'pdf')).toBe('My-Report-..-x.pdf');
    expect(exportFileName('', 'csv')).toBe('export.csv');
  });
});
