import { NextFunction, Request, RequestHandler, Response } from 'express';
import mongoose from 'mongoose';
import { z, ZodTypeAny } from 'zod';
import { badRequest, notFound } from './errors';

export const ok = (res: Response, data: unknown, status = 200, meta?: Record<string, unknown>) =>
  res.status(status).json({ success: true, data, ...(meta ? { meta } : {}) });

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'Validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export function oid(id: unknown, what = 'id'): string {
  const s = String(id ?? '');
  if (!mongoose.isValidObjectId(s)) throw notFound(`Invalid ${what}`);
  return s;
}
