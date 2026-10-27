/** Run pending migrations without starting the API:  npm run migrate */
import mongoose from 'mongoose';
import { env } from './config/env';
import { runMigrations } from './services/migrations';

(async () => {
  await mongoose.connect(env.mongoUri);
  const ran = await runMigrations();
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'No pending migrations.');
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
