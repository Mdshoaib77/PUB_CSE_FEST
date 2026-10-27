# PROJECT HANDOFF
**Current phase:** all phases (0–8) implemented in one session at the user's request; next work = *verification and hardening*, not new features.
**Node:** >= 20 (built/tested on 22). **Database:** MongoDB (no transactions required).

## What exists (inspected and tested)
All 10 official requirements have an implementation; see `REQUIREMENTS_MATRIX.md` for PASS/PARTIAL with evidence. 105 REST endpoints (`docs/API_CONTRACT.md`), 33 Mongoose models, React UI with ~20 pages.

## Test run results (actually executed in the build environment, 13 Oct 2026)
| Check | Result |
|---|---|
| `tsc --noEmit` (server + web) | 0 errors |
| ESLint (flat config) | 0 errors, 0 warnings |
| Prettier | applied to all files |
| Server tests (Vitest + Supertest): unit 12, API 19, contest 11, Judge0 protocol 8 | **50 / 50 passed** |
| Web tests (Vitest + Testing Library) | 3 / 3 passed |
| `npm run build` (esbuild server bundle, Vite web) | succeeded |
| Smoke test of the **production server bundle** (`NODE_ENV=production`): health, register, 401 on /auth/me, mock adapter refused | passed |
| Web bundle grep for secrets/hidden-test data | none found (only the setter form's field *name* `expectedOutput`) |

## Known bugs and limitations (read before relying on anything)
1. **Judge0 never tested live.** Adapter tested against a local stub; contest pipeline tested with the labelled mock. Verify with real credentials (see DEMO_TEST_CHECKLIST). Default language ids are assumptions for Judge0 CE.
2. **Tests ran on FerretDB 1.24 (SQLite), not real MongoDB.** The design avoids features FerretDB lacks (transactions, partial indexes, `findAndModify` with projections), but run `npm test` against real MongoDB/Atlas (`TEST_MONGODB_URI`) before submitting.
3. **Frontend not exercised in a real browser**: only type-check, build and 3 component tests. Layout/responsiveness, camera QR scanning (`html5-qrcode`), Socket.IO live updates in the browser, and every form's UX need a manual pass. No screenshots yet.
4. Announcement endpoint now has an API test (not yet run); UI-only flows still have none.
5. Roles are **global**, not per-event (any coordinator can manage any event).
6. ~~Check-then-insert races~~ **Patched (unverified):** venue bookings, volunteer assignments, shift capacity and replacement approvals now run inside `withLocks()` (`services/lock.ts`, unique-index mutex with a 10s lease). Concurrency tests added to `api.test.ts` but NOT yet run.
7. Judge queue is in-process (single API instance); re-queued on restart; no dead-letter queue. Many tests per problem × hosted Judge0 quota can be slow.
8. ~~QR tokens do not expire~~ **Patched (unverified):** tokens now expire after `QR_TOKEN_TTL_SEC` (default 45s); `CheckIn.tsx` refreshes them automatically; expired scans return `TOKEN_EXPIRED`. Still revocable. Refresh cookie needs HTTPS in production (`SameSite=None; Secure`).
9. Capacity counts registrations (a team = 1). Waitlist position is derived and shown at registration/refresh time.
10. Lists are not paginated (limits 50–500). No email/SMS notifications (in-app + Socket.IO only).
11. Hidden test data is sent to the judge service (inherent to hosted Judge0).
12. Optional features (certificates, sponsors, equipment, plagiarism, AI feedback) are **not** implemented.

## Important paths
`apps/server/src/{models/index.ts, services/{registration,clash,scoring,scoreboard,judgeService,readiness}.ts, services/judge/*, routes/*, seed/seed.ts, tests/*}` · `apps/web/src/{App.tsx, lib/*, pages/*}` · `packages/shared/src/index.ts`.

## Commands
Install `npm install` · dev `npm run dev:server` / `npm run dev:web` · seed `npm run seed -- --reset` · test `npm test` (needs MongoDB) · build `npm run build` · start `npm run start -w @festhub/server`.

## Setup steps required by the next session
1. Provide MongoDB (local or Atlas) and Judge0 credentials; copy `.env.example` files.
2. Run `npm test` against real MongoDB; fix anything FerretDB masked.
3. Run the **Real judge smoke test** and the full DEMO_TEST_CHECKLIST in a browser; take screenshots.
4. Fill README (video link, members, contributions) — placeholders are marked `<<< >>>`.

## Exact next recommended phase
**Phase 7-style verification pass on real infrastructure** (browser walkthrough per role, real MongoDB, real Judge0), then Phase 8 items that need a human: deployment (docs/DEPLOYMENT.md was written but **nothing was deployed**), demo video, screenshots, team contribution text. Do not add features before this; evaluators mark non-working features as not implemented.
