/** Express helpers around the shared CSV/PDF builders (S4). Usage in a route:
 *    sendCsv(res, 'attendees', rows, [{ header: 'Name', value: 'name' }, ...]);
 *    sendPdf(res, 'attendees', rows, columns, { title: 'Attendees' });
 */
import type { Response } from 'express';
import { exportFileName, toCsv, toPdf, type ExportColumn, type PdfOptions } from '@festhub/shared';

export { toCsv, toPdf, type ExportColumn, type PdfOptions };

export function sendCsv<T>(res: Response, name: string, rows: readonly T[], columns: readonly ExportColumn<T>[]): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(name, 'csv')}"`);
  res.send(toCsv(rows, columns));
}

export function sendPdf<T>(res: Response, name: string, rows: readonly T[], columns: readonly ExportColumn<T>[], opts: PdfOptions): void {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(name, 'pdf')}"`);
  res.send(Buffer.from(toPdf(rows, columns, opts)));
}
