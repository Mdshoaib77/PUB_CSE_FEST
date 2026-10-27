import path from 'path';
import multer from 'multer';
import { AppError, badRequest } from '../utils/errors';
import { LANGUAGE_EXTENSIONS, type PlagiarismLanguage } from './plagiarism';

/** Safe upload limits for code files: one small text file, in memory only (never written to disk), extension allow-list, no binary. */
export const CODE_MAX_BYTES = 200 * 1024;
export const codeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: CODE_MAX_BYTES, files: 1, fields: 10, fieldSize: CODE_MAX_BYTES } });

export function mapCodeUploadError(err: unknown): Error {
  const code = (err as { code?: string })?.code;
  if (code === 'LIMIT_FILE_SIZE' || code === 'LIMIT_FIELD_VALUE') return new AppError(413, 'FILE_TOO_LARGE', `Code is too large (max ${CODE_MAX_BYTES / 1024} KB).`);
  if (code === 'LIMIT_FILE_COUNT' || code === 'LIMIT_UNEXPECTED_FILE') return badRequest('Upload a single file in the "file" field.');
  return err instanceof Error ? err : badRequest('Upload failed');
}

/** Decode + validate an uploaded file: allowed extension for the language, valid UTF-8, no NUL bytes, not empty. */
export function readCodeFile(file: { originalname?: string; buffer: Buffer }, lang: PlagiarismLanguage): { code: string; fileName: string } {
  const base = path.basename(String(file.originalname ?? '')).replace(/[^\w.\- ]+/g, '_').slice(0, 80);
  const ext = path.extname(base).toLowerCase();
  if (!LANGUAGE_EXTENSIONS[lang].includes(ext)) throw badRequest(`A ${lang} file must end in ${LANGUAGE_EXTENSIONS[lang].join(', ')}.`);
  if (file.buffer.length === 0) throw badRequest('The file is empty.');
  if (file.buffer.length > CODE_MAX_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', `Code is too large (max ${CODE_MAX_BYTES / 1024} KB).`);
  if (file.buffer.includes(0)) throw badRequest('That looks like a binary file, not source code.');
  let code: string;
  try {
    code = new TextDecoder('utf-8', { fatal: true }).decode(file.buffer);
  } catch {
    throw badRequest('The file must be UTF-8 text.');
  }
  return { code: code.replace(/^\uFEFF/, ''), fileName: base };
}

export function validatePasted(code: string): string {
  if (code.includes('\u0000')) throw badRequest('Code must not contain NUL characters.');
  if (!code.trim()) throw badRequest('Code is empty.');
  if (Buffer.byteLength(code, 'utf8') > CODE_MAX_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', `Code is too large (max ${CODE_MAX_BYTES / 1024} KB).`);
  return code;
}
