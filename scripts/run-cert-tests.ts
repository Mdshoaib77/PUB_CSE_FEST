/** Offline runner: node-free vitest shim + pdfkit stub. `npx tsx --tsconfig scripts/samples.tsconfig.json scripts/run-cert-tests.ts` (from the repo root). */
import { run } from './pure-test-shim/vitest-shim';
import '../apps/server/src/tests/cert-layout.test';
run();
