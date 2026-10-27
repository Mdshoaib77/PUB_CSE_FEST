import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { env } from '../config/env';
import { AppError, badRequest } from '../utils/errors';

export const EVENT_IMAGE_DIR = path.join(env.uploadDir, 'events');
export const EVENT_IMAGE_URL_PREFIX = '/uploads/events/';
const SAFE_NAME = /^[a-f0-9]{24}\.(jpg|png|webp|gif)$/;

/** Memory storage on purpose: nothing touches the disk until the bytes are proven to be a real image. */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxImageBytes, files: 1, fields: 0 },
});

/** Identify an image by its magic bytes. The client-supplied mimetype/extension is never trusted. SVG is intentionally unsupported (script injection). */
export function detectImageExt(b: Buffer): 'jpg' | 'png' | 'webp' | 'gif' | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

export async function saveEventImage(buf: Buffer): Promise<string> {
  const ext = detectImageExt(buf);
  if (!ext) throw badRequest('That file is not a supported image. Use JPG, PNG, WebP or GIF.');
  await fs.promises.mkdir(EVENT_IMAGE_DIR, { recursive: true });
  const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
  await fs.promises.writeFile(path.join(EVENT_IMAGE_DIR, name), buf, { flag: 'wx' });
  return `${EVENT_IMAGE_URL_PREFIX}${name}`;
}

/** Best-effort removal of a locally stored image. External URLs and anything not matching our own naming scheme are ignored. */
export async function removeEventImage(url?: string | null): Promise<void> {
  if (!url || !url.startsWith(EVENT_IMAGE_URL_PREFIX)) return;
  const name = url.slice(EVENT_IMAGE_URL_PREFIX.length);
  if (!SAFE_NAME.test(name)) return; // also blocks path traversal
  await fs.promises.unlink(path.join(EVENT_IMAGE_DIR, name)).catch(() => undefined);
}

/** Translate multer's own errors into our API error envelope. */
export function mapUploadError(e: unknown): unknown {
  const code = (e as { code?: string })?.code;
  if (code === 'LIMIT_FILE_SIZE') return new AppError(413, 'FILE_TOO_LARGE', `Image is too large. The limit is ${Math.round(env.maxImageBytes / 1048576)} MB.`);
  if (code === 'LIMIT_UNEXPECTED_FILE' || code === 'LIMIT_FILE_COUNT') return badRequest('Upload exactly one image in the "file" field');
  if ((e as { name?: string })?.name === 'MulterError') return badRequest('Upload failed');
  return e;
}
