import http from 'http';
import mongoose from 'mongoose';
import { createApp } from './app';
import { env } from './config/env';
import { initSocket } from './sockets/io';
import { resumeQueued } from './services/judgeService';
import { logger } from './utils/logger';
import { runMigrations } from './services/migrations';

async function main() {
  await mongoose.connect(env.mongoUri);
  await runMigrations();
  const server = http.createServer(createApp());
  initSocket(server);
  server.listen(env.port, () => logger.info(`FestHub API listening on :${env.port} (judge adapter: ${env.judgeAdapter})`));
  await resumeQueued(); // pick up submissions that were queued when the process stopped
}
main().catch((e) => {
  logger.error('fatal', { message: (e as Error).message });
  process.exit(1);
});
