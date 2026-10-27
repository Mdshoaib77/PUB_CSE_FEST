/** Client-side export: build a CSV/PDF from rows already in the browser and save it. (For server data use `api.download`.) */
import { exportFileName, toCsv, toPdf, type ExportColumn, type PdfOptions } from '@festhub/shared';

export type { ExportColumn, PdfOptions };

function save(data: BlobPart, type: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv<T>(name: string, rows: readonly T[], columns: readonly ExportColumn<T>[]): void {
  save(toCsv(rows, columns), 'text/csv;charset=utf-8', exportFileName(name, 'csv'));
}

export function downloadPdf<T>(name: string, rows: readonly T[], columns: readonly ExportColumn<T>[], opts: PdfOptions): void {
  save(toPdf(rows, columns, opts) as unknown as BlobPart, 'application/pdf', exportFileName(name, 'pdf'));
}
