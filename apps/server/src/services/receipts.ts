/** Payment receipt files (S7). PRIVATE: stored under uploads/.private/receipts (dot-dir => denied by the static handler) and only served through an authenticated route. PDF/JPG/PNG, magic-byte checked, size limited, random names. */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { env } from '../config/env';
import { AppError, badRequest } from '../utils/errors';

export const RECEIPT_DIR = path.join(env.uploadDir, '.private', 'receipts');
export const RECEIPT_MAX = Math.min(env.maxImageBytes, 5 * 1024 * 1024);
const SAFE = /^[a-f0-9]{24}\.(pdf|jpg|png)$/;
export const RECEIPT_MIME = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' } as const;

export const receiptUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: RECEIPT_MAX, files: 1, fields: 0 } });

export function detectReceipt(b: Buffer): 'pdf' | 'jpg' | 'png' | null {
  if (b.length < 16) return null;
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}
export async function saveReceipt(buf: Buffer): Promise<{ file: string; mime: string }> {
  const ext = detectReceipt(buf);
  if (!ext) throw badRequest('Upload a PDF, JPG or PNG file.');
  await fs.promises.mkdir(RECEIPT_DIR, { recursive: true });
  const file = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(RECEIPT_DIR, file), buf, { flag: 'wx' });
  return { file, mime: RECEIPT_MIME[ext] };
}
export async function removeReceipt(file?: string | null) {
  if (file && SAFE.test(file)) await fs.promises.unlink(path.join(RECEIPT_DIR, file)).catch(() => undefined);
}
export async function readReceipt(file?: string | null): Promise<Buffer | null> {
  if (!file || !SAFE.test(file)) return null;
  return fs.promises.readFile(path.join(RECEIPT_DIR, file)).catch(() => null);
}
export function mapReceiptError(e: unknown): unknown {
  const code = (e as { code?: string })?.code;
  if (code === 'LIMIT_FILE_SIZE') return new AppError(413, 'FILE_TOO_LARGE', `Receipt is too large. The limit is ${Math.round(RECEIPT_MAX / 1048576)} MB.`);
  if (code === 'LIMIT_UNEXPECTED_FILE' || code === 'LIMIT_FILE_COUNT') return badRequest('Upload exactly one file in the "file" field');
  if ((e as { name?: string })?.name === 'MulterError') return badRequest('Upload failed');
  return e;
}
