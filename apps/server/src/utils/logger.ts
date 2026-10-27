import { env } from '../config/env';
const fmt = (level: string, msg: string, meta?: unknown) => JSON.stringify({ t: new Date().toISOString(), level, msg, ...(meta ? { meta } : {}) });
export const logger = {
  info: (msg: string, meta?: unknown) => {
    if (!env.isTest) console.log(fmt('info', msg, meta));
  },
  warn: (msg: string, meta?: unknown) => {
    if (!env.isTest) console.warn(fmt('warn', msg, meta));
  },
  error: (msg: string, meta?: unknown) => {
    if (!env.isTest) console.error(fmt('error', msg, meta));
  },
};
