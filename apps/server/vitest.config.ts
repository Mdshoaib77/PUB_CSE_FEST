import os from 'os';
import path from 'path';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
    env: { NODE_ENV: 'test', JUDGE_ADAPTER: 'mock', JWT_ACCESS_SECRET: 'test-secret', QR_TOKEN_SECRET: 'test-qr', SUBMISSION_COOLDOWN_SEC: '0', UPLOAD_DIR: path.join(os.tmpdir(), 'festhub-test-uploads') },
  },
});
