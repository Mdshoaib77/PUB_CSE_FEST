import mongoose from 'mongoose';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app';
import { User } from '../models';

export const app = createApp();
export const TEST_DB = process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/festhub_test';

export async function connect() {
  await mongoose.connect(TEST_DB);
  await mongoose.connection.dropDatabase();
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
}
export async function disconnect() {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

let n = 0;
export async function makeUser(roles: string[], extra: Record<string, unknown> = {}) {
  n += 1;
  const email = `u${n}_${Date.now()}@test.local`;
  const u = await User.create({ name: `User ${n}`, email, passwordHash: await bcrypt.hash('Password123', 4), roles, ...extra });
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: 'Password123' });
  return { id: u.id as string, email, token: res.body.data.accessToken as string };
}
export const auth = (t: { token: string }) => ({ Authorization: `Bearer ${t.token}` });
export const hours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
export const api = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, who?: { token: string }, body?: unknown) => {
  const r = request(app)[method](`/api/v1${url}`);
  if (who) r.set(auth(who));
  return body ? r.send(body as object) : r;
};
