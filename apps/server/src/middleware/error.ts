import { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  const e = err as { code?: number; name?: string; message?: string };
  if (e?.code === 11000) {
    return res.status(409).json({ success: false, error: { code: 'DUPLICATE', message: 'This record already exists' } });
  }
  if (e?.name === 'CastError' || e?.name === 'ValidationError') {
    return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid data' } });
  }
  // Never echo internal errors (they might contain hidden test data) to the client.
  if (process.env.DEBUG_ERRORS) console.error(err);
  logger.error('Unhandled error', { path: req.path, name: e?.name, msg: process.env.DEBUG_ERRORS ? e?.message : undefined });
  res.status(500).json({ success: false, error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
