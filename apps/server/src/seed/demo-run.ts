/** Standalone entry: `npm run seed:demo` (adds demo accounts + 3 demo events to an existing database, idempotent). */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { User, Event } from '../models';
import { seedDemo } from './demo';

async function main() {
  await mongoose.connect(env.mongoUri);
  await Promise.all([User.syncIndexes(), Event.syncIndexes()]);
  await seedDemo();
  await mongoose.disconnect();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
