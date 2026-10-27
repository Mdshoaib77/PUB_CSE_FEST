import crypto from 'crypto';
import { ResourceLock } from '../models';
import { AppError } from '../utils/errors';

/**
 * Named mutex built on a unique index (no multi-document transactions needed, so it works on
 * MongoDB, Atlas and FerretDB). A check-then-insert on a venue / volunteer / shift is only safe
 * while holding that resource's lock, otherwise two simultaneous requests can both pass the
 * overlap check. Locks carry a short lease so a crashed process can never block a resource forever.
 */
const LEASE_MS = 10_000;
const WAIT_MS = 8_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquire(key: string, owner: string) {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const now = new Date();
    try {
      await ResourceLock.create({ key, owner, expiresAt: new Date(now.getTime() + LEASE_MS) });
      return;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
      await ResourceLock.deleteOne({ key, expiresAt: { $lt: now } }); // reap an expired lease, then retry
    }
    if (Date.now() > deadline) throw new AppError(409, 'BUSY', 'Another change to the same venue/volunteer is in progress. Please retry in a moment.');
    await sleep(10 + Math.random() * 30);
  }
}

/** Runs `fn` while holding every lock in `keys` (acquired in sorted order, so no deadlocks). */
export async function withLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID();
  const held: string[] = [];
  try {
    for (const k of [...new Set(keys)].sort()) {
      await acquire(k, owner);
      held.push(k);
    }
    return await fn();
  } finally {
    if (held.length) await ResourceLock.deleteMany({ key: { $in: held }, owner }).catch(() => undefined);
  }
}
