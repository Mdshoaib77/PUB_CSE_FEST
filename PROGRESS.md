# FestHub — PROGRESS

Working log for the staged build (S1–S17). Update the status table at the end of every stage.

## 1. Stack summary (inspected, no code changed)

| Area | Finding |
|---|---|
| Repo | npm workspaces monorepo `stackforge-festhub`: `apps/server`, `apps/web`, `packages/shared`. Node >= 20. |
| Server | Express 4 + TypeScript (tsx in dev, esbuild bundle to CJS for prod), Mongoose 8, Socket.IO 4, Zod, helmet, cors, cookie-parser, express-rate-limit, multer, bcryptjs, jsonwebtoken. |
| Database | **MongoDB** (not SQL). `MONGODB_URI`, default `mongodb://127.0.0.1:27017/festhub`. Tests use `TEST_MONGODB_URI` (default `.../festhub_test`, dropped on run). |
| Migrations | No migration CLI. Schemas are Mongoose; indexes are synced by the seed script (`syncIndexes()`); idempotent start-up migrations live in `apps/server/src/services/migrations.ts` and run from `src/index.ts` after connect. New "migrations" = add a function there. |
| Web | React 18 + TypeScript + Vite 5, Tailwind 3, React Router 6, TanStack Query 5, React Hook Form + Zod, framer-motion, lucide-react, qrcode.react, html5-qrcode, socket.io-client. Fonts: Figtree, Bricolage Grotesque. |
| Shared | `packages/shared/src/index.ts`: ROLES, enums, Zod schemas (register/login/event), `ApiEnvelope`. Imported as `@festhub/shared`. |
| Judge | Judge0 adapter (`services/judge/{judge0,mock,adapter,index}.ts`); mock only for tests, refused in production. |
| Realtime | Socket.IO (`sockets/io.ts`, `emitTo('user:<id>', ...)`; client `lib/socket.ts`). |
| Tests | Vitest + Supertest (server), Vitest + Testing Library (web). Lint: ESLint flat config; format: Prettier. |
| Deploy | `docker-compose.yml` (web nginx, server, mongo 7, self-hosted judge0), `docker.env.example`, `docs/DEPLOYMENT.md`. |

### Folders
- `apps/server/src`: `app.ts` (route mounting), `index.ts` (boot), `config/env.ts`, `middleware/{auth,error}.ts`, `models/index.ts` (all schemas in ONE file), `routes/*`, `services/*`, `sockets/io.ts`, `seed/seed.ts`, `tests/*`, `utils/{audit,errors,http,logger}.ts`. `controllers/` is empty (logic lives in routes + services).
- `apps/web/src`: `App.tsx` (lazy routes), `main.tsx` (providers), `components/*`, `pages/*`, `lib/{api,auth,hooks,notifications,socket}.ts(x)`. Empty dirs: `api/`, `features/`, `hooks/`, `routes/`. **Stray directory literally named `{lib,components,pages}`** under `apps/web/src` (brace-expansion accident) — empty, safe to delete later (not touched in S1).
- `packages/shared`, `docs/` (API_CONTRACT, ARCHITECTURE, DATABASE_DESIGN, REQUIREMENTS_MATRIX, DEPLOYMENT, JUDGE0, ...), `docker/`, `scripts/judge-smoke.mjs`.
- Other: `PROJECT_HANDOFF.md` (known bugs/limitations), `CHANGELOG.md`, `README.md`. A real `apps/server/.env` is present in the upload (keep out of version control).

### Auth
- Email + password (bcryptjs, cost 12). Access JWT (15 min, `JWT_ACCESS_SECRET`, payload `sub`, `roles`) sent as `Authorization: Bearer`; kept in memory on the client (`lib/api.ts`). Refresh token = httpOnly cookie, hashed in `RefreshToken` collection; `POST /auth/refresh`. Cookie policy via `COOKIE_SECURE` / `COOKIE_SAMESITE`.
- `middleware/auth.ts`: `requireAuth` (re-reads roles + `active` from DB on every request, so role changes apply immediately), `optionalAuth`, `requireRole(...roles)`, `hasRole`, `isStaff` (organiser|coordinator).
- Check-in QR tokens: signed with `QR_TOKEN_SECRET`, TTL `QR_TOKEN_TTL_SEC` (45 s), revocable (`CheckInToken`).
- Public sign-up may only choose `participant` or `volunteer`; staff roles granted by an organiser (`/admin/users`).

### Routing
- API: everything under `/api/v1` (`app.ts`). Mount order matters: `auth`, `users`, `events`, `uploads`, `contests` (before routers that call `r.use(requireAuth)` globally, to keep the public scoreboard public), `deletes`, `registrations`, `ops`, `judging`. Static uploads at `/uploads`. Health: `GET /api/v1/health`. Envelope: `{ success, data?, error?{code,message,details}, meta? }` via `utils/http.ts` (`ok`) and `utils/errors.ts`. Endpoint counts: auth 5, users 3, events 15, uploads 1, contests 31, deletes 21, registrations 19, ops 28, judging 14 (~137 handlers; docs say 105 REST endpoints).
- Web: `App.tsx` with `React.lazy` pages inside `<Protected>` (optionally `roles=[...]`) and `<Layout>`; nav groups defined in `components/Layout.tsx` (`GROUPS`, each item has optional `roles`). Vite dev proxy: `/api`, `/uploads`, `/socket.io` -> `localhost:5000`.

### UI conventions
- Tailwind with custom palette (`brand`, `ink`, `coral`, `sun`), fonts `font-sans` / `font-display`, shadows `glass|glow|lift`. Dark mode added in S4 (`darkMode: 'class'`, see 4d).
- Global CSS classes in `index.css`: `.btn`, `.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-danger-ghost`, `.btn-sm`, `.input`, `.card`, `.card-interactive`, `.badge`, `.skeleton`.
- Shared components in `components/ui.tsx`: `ToastProvider/useToast`, `ConfirmProvider/useConfirm`, `TrashButton`, `Spinner`, `Skeleton(List)`, `EmptyState`, `Empty`, `StatTile`, `AnimatedNumber`, `ErrorBox`, `PageHeader`, `Field`, `Badge`, `Card`, `Tabs`, `Query`, `Avatar`.
- Data fetching: TanStack Query + `lib/api.ts` (`request`, `ApiError`, `assetUrl`); forms: react-hook-form + zod resolvers; animation via framer-motion; icons from lucide-react.
- Server conventions: Zod validation in routes, `audit(actorId, action, entityType, entityId, meta)` from `utils/audit.ts`, `notify(userId, type, message, refs)` from `services/notify.ts` (writes `Notification` + Socket.IO `notification:new`), `withLocks()` in `services/lock.ts` for race-prone writes.

## 2. Existing roles / models / pages

**Roles (global, not per-event):** `admin` (S2), `organiser`, `coordinator`, `participant`, `volunteer`, `judge`, `sponsor` (S2). Labels via `ROLE_LABELS` (organiser = "Organizer").

**Models (49 after S15: + `LeaderboardSetting`; 48 after S13: + `ReviewRubric`, `Feedback`; 46 after S11: + `CodeSubmission`, `PlagiarismPair`, `PlagiarismSetting`, `StarterCode`; 42 after S9: + `Equipment`, `Allocation`; 40 after S7, unchanged in S8: + `Sponsor`, `SponsorEvent`, `Deliverable`, `SponsorPayment`; 36 after S6: + `CertificateTemplate`; 35 after S5: + `Certificate`; 34 after S2: + `Migration`; `Notification` gained `title`, `link` in S3; all in `apps/server/src/models/index.ts`):** User, RefreshToken, Venue, Event, Activity, Registration, Seat, Team, TeamMember, Invitation, Notification, Announcement, Availability, Shift, ShiftAssignment, Task, ReplacementRequest, CheckInToken, CheckIn, Issue, Rubric, Entry, EntryVersion, JudgeAssignment, Score, Result, AuditLog, Problem, TestCase, Contest, ContestRegistration, ContestTeam, Submission, Editorial, ResourceLock.
- `AuditLog`: `{actorId, action, entityType, entityId, meta, at}` (index on entityType+entityId). `Notification`: `{userId, type, message, refs, readAt}` + timestamps.

**Web pages / routes:**
| Route | Page | Access |
|---|---|---|
| `/login`, `/register` | AuthPages | public |
| `/` | Dashboard | any signed-in |
| `/notifications` | Notifications | any |
| `/events`, `/events/:id` | Events | any |
| `/events/new`, `/events/:id/edit` | EventForm | organiser |
| `/events/:id/manage` | ManageEvent | organiser, coordinator |
| `/volunteer` | Volunteer | volunteer, coordinator, organiser |
| `/checkin` | CheckIn (+CheckInDesk, QrScanner) | any |
| `/judging` | Judging | judge |
| `/contests`, `/contests/:id` | Contests | any |
| `/problems`, `/problems/:id`, `/progress` | Practice | any |
| `/setter` | Setter | judge, organiser |
| `/admin/users` | AdminUsers | organiser (admin) |
| `/admin/audit` | AdminAudit (S2) | organiser (admin) |
| `/certificates` | Certificates (S5): my certificates; organiser/coordinator also get the per-event manager | any signed-in |
| `/verify`, `/verify/:id` | Verify (S5) | **public** (no sign-in, no layout) |
| `/sponsors`, `/sponsors/:id` | Sponsors, SponsorDetail (S7/S8) | organiser, coordinator (read-only) |
| `/my-sponsorship` | SponsorPortal (S8) | sponsor |
| `/submit-code` | CodeSubmit (S12) | any signed-in |
| `/command-center` | CommandCenter (S16) | organiser (admin) |
| `/achievements` | Achievements (S16) | any signed-in |
| `/leaderboard` | Leaderboard (S15; `?event=<id>`) | any signed-in (staff always; participants once published) |
| `/plagiarism` | Plagiarism report (S12; was the S11 minimal page; `?pair=<id>` opens a pair) | organiser, admin, judge |
| `/equipment` | Equipment (S9 minimal → S10 full, tabs via `?tab=inventory\|request\|approvals\|desk\|timeline\|history`) | organiser, coordinator |
Other components: Layout, NotificationBell, EventCover, CoverPicker, Protected, ui.

**Seed accounts** (`npm run seed`, password `Password123`): admin@, sponsor@ (S2), organiser@, coordinator@, judge@, judge2@, volunteer1-3@, participant1-6@ `festhub.test`.

## 3. Exact commands

```bash
# install (repo root)
npm install

# env
cp .env.example apps/server/.env      # then edit secrets
cp apps/web/.env.example apps/web/.env   # optional in dev (Vite proxy)

# database: needs MongoDB running
docker run -d --name festhub-mongo -p 27017:27017 mongo:7

# "migrate": no CLI. Indexes + demo data via seed; start-up migrations run automatically on server boot
npm run migrate              # S2/S3: run pending run-once migrations (also run automatically on server boot)
npm run seed                 # add:  -- --reset   to drop DB and re-seed

# run (two terminals, or both at once)
npm run dev:server           # http://localhost:5000
npm run dev:web              # http://localhost:5173
npm run dev                  # both via concurrently

# quality
npm run typecheck && npm run lint && npm test     # tests need MongoDB (TEST_MONGODB_URI)

# production build / start
npm run build
npm run start -w @festhub/server

# docker (full stack incl. Judge0)
cp docker.env.example .env && docker compose up -d --build
docker compose --profile tools run --rm seed
```

## 4. Plan

| Stage | Scope | Status |
|---|---|---|
| S1 | Analysis, PROGRESS.md, .env.example | DONE |
| S2 | Roles + audit (extend roles/permissions, audit coverage and viewer) | **DONE** (typecheck + eslint clean; no automated tests added/run, see S2 notes) |
| S3 | Notifications (in-app + optional SMTP e-mail) | **DONE** (tsc + eslint clean; mailer verified against a fake SMTP server; vitest/DB tests not run, see S3 notes) |
| S4 | Dark mode + exports + seed additions | **DONE** (see 4d; not compiled/run in sandbox — no node_modules/MongoDB) |
| S5 | Certificates — backend (+ minimal UI: verify page, certificates page) | **DONE** (pure parts verified; server/DB code not compiled or run in sandbox, see 4e) |
| S6 | Certificates — UI + public verify page | **DONE** (see 4f; server/web code not compiled or run in sandbox — no node_modules/MongoDB) |
| S7 | Sponsors — backend (+ minimal UI) | **DONE** (see 4g; not compiled or run in sandbox — no node_modules/MongoDB) |
| S8 | Sponsors — UI + sponsor portal | **DONE** (see 4h; tsc/eslint clean for all S8 files; vitest/DB tests not run — no MongoDB in sandbox) |
| S9 | Equipment — backend | **DONE** (see 4i; pure conflict function tested and passing; DB tests written but not run — no MongoDB in sandbox) |
| S10 | Equipment — UI | **DONE** (see 4j; pure timeline function run and passing; typecheck/lint/vitest/UI not run — no node_modules/MongoDB/browser in sandbox) |
| S11 | Plagiarism engine | **DONE** (see 4k; engine + pure tests run and passing; server/DB/UI code syntax-checked only, not compiled against deps or run — no node_modules/MongoDB in sandbox) |
| S12 | Plagiarism UI | **DONE** (see 4l; matching-block engine run and passing; server/DB/web code syntax-checked only, not compiled against deps or run — no node_modules/MongoDB/browser in sandbox) |
| S13 | AI feedback — backend + rubric | **DONE** (see 4m; pure parts run and passing; server/DB/web code not compiled against deps or run — no node_modules/MongoDB in sandbox) |
| S14 | AI feedback — UI | **DONE** (see 4n; web/server code syntax-checked only, not compiled against deps or run — no node_modules/MongoDB/browser in sandbox) |
| S15 | Leaderboard | **DONE** (see 4o; pure scoring function run and passing 10/10; server/DB/web code syntax-checked only, not compiled against deps or run — no node_modules/MongoDB/browser in sandbox) |
| S16 | Command center + achievements | **DONE** (see 4p; pure helpers run and passing; server/DB/web code syntax-checked only, not compiled against deps or run — no node_modules/MongoDB/browser in sandbox) |
| S17 | Final polish + README | **DONE** (S17A guards/nav, S17B dark/mobile/states, S17C tests, S17D README + CHANGELOG; see 4q–4t) |
| V4-A | Certificates data/backend: team + contest certificates | **DONE** (see 4u; pure tests 21/21; server/DB code not compiled or run) |
| V5-D | Team certificate member grid (1-4 columns, up to 20) + tests + sample PDFs | **DONE** (see 4y; tests 26/26 offline with pdfkit stub; real pdfkit not run) |
| V6 | Certificate TEMPLATE customisation (themes, logos, 3 signatories, seal, border, font, headlines, body text, custom fields, live preview) | **DONE** (see 4z; pure tests 21/21 + all earlier pure suites with REAL pdfkit/vitest; DB/API tests written, NOT run — no MongoDB) |
| V7 | Premium web UI + exports: Leaderboard, My Achievements, My certificates, Verify, leaderboard + portfolio PDFs | **DONE** (see 4aa; pure PDF/helper tests pass with real pdfkit/vitest; web tsc + eslint + vite build clean; DB paths and browser NOT run) |

## 4b. S2 — Roles + audit log (done)

**Roles**
- `ROLES` in `packages/shared` now = admin, organiser, coordinator, participant, volunteer, judge, sponsor. `ROLE_LABELS` and `roleSatisfies(userRoles, allowed)` are exported from shared (client + server use the same rule).
- Rule: **admin satisfies any check that organiser satisfies** (superset). Requirement `requireRole('admin')` alone = admin only. No existing route or user changed behaviour (nobody had admin/sponsor before).
- Public sign-up is unchanged (`participant` / `volunteer` only); admin and sponsor can only be granted by an organiser/admin via `PATCH /users/:id/roles`; **only an admin may grant/revoke `admin`**, cannot remove own admin role, cannot delete an admin unless admin, last organiser/admin cannot be deleted.
- Seed adds `admin@festhub.test` and `sponsor@festhub.test`.
- Sponsor has no pages yet (portal comes in S7/S8).

**Server helpers**
- `middleware/auth.ts`: `requireRole(...roles)` (reusable guard, 401/403), `protect(...roles)` (= `[requireAuth, requireRole(...)]`), `requireAdmin`, `hasRole`, `isAdmin`, `isStaff` (admin now included via the superset rule).
- `utils/audit.ts`: `logAction(user, action, entity, details?, req?)` and alias **`log_action`**. `user` = `req.user` | id string | undefined; `entity` = `{type,id}` | `'Type:id'` | `'Type'`; secrets (password/token/secret/hash/cookie keys) are redacted, details capped (4000 chars), never throws. Legacy `audit(actorId, action, entityType, entityId, meta)` now delegates to it (all 23 existing call sites unchanged).
- `AuditLog` model extended: `actorName` (snapshot), `ip`, `action` max 80, indexes on `at`, `actorId+at`, `action+at` (+ existing entity index). New events: `auth.register`, `auth.login`, `auth.login_failed` (email + reason only), `user.roles` (now before/after), `audit.export`.
- `services/migrations.ts`: `Migration` model (run-once ledger), `MIGRATIONS[]` (append only), `runMigrations()` (called on boot in `index.ts`, and by `npm run migrate` -> `src/migrate.ts`). S2 migrations: `2026-10-s2-audit-log-indexes-and-actor-names`, `2026-10-s2-user-role-defaults`. `migrateProblemLanguages` still runs every boot (idempotent, test-covered).

**Routes (all under `/api/v1`, require admin or organiser)**
| Method | Path | Notes |
|---|---|---|
| GET | `/admin/audit` | query (Zod-validated): `q`, `actor`(ObjectId), `action` (exact, or prefix with `*`/trailing `.`), `entityType`, `entityId`, `from`, `to` (bare date = through end of day), `sort`=asc\|desc, `page`, `limit`(1–100). Returns `{items,page,limit,total,pages}` with actor name/email resolved |
| GET | `/admin/audit/facets` | distinct `actions`, `entityTypes` for dropdowns |
| GET | `/admin/audit/export.csv` | same filters, max 10 000 rows, UTF-8 BOM, formula-injection guard, itself audited |
Existing `GET /judging/...` audit listing by entity is untouched.

**Web**: page `/admin/audit` (`pages/AdminAudit.tsx`: search, action/entity/date filters, sort, page size, pagination, expandable details, Export CSV), nav item "Audit log", `api.download()` helper in `lib/api.ts`, `useAuth().has()` applies the admin-superset rule, AdminUsers shows role labels and disables the admin checkbox for non-admins.

**S2 notes / not done**
- No automated tests added and none run (no MongoDB in the build sandbox); `tsc` (server + web) and ESLint on changed files pass. Please run `npm test` and click through `/admin/audit` once.
- Audit calls were added only for auth + role changes + export; the 23 pre-existing call sites keep their action names. Wider coverage (e.g. event publish, registration, contest actions) can be added incrementally with `logAction`.
- Sponsor/admin-specific route guards for future features: use `requireRole('sponsor')` / `requireRole('admin')`.

## 4c. S3 — Notifications (done)

Most of the in-app machinery already existed (model, Socket.IO push, bell, page, read endpoints); S3 extended it without removing anything.

**Model** `Notification`: `userId, type (default 'general'), title (new, <=120), message, link (new, in-app path <=300), refs, readAt` + timestamps; indexes unchanged (`userId, readAt, createdAt`).

**Helpers** (`services/notify.ts`)
- **`notify(user, title, message, link?)`** — new spec helper. `user` = id | ObjectId | document | `{id}`. Trims/limits title (120) and message (1000); `link` accepted only if it is an in-app path (`/events/1`; `//x`, `http://…` are dropped). Creates the row, pushes `notification:new` (now with `title`, `link`) over Socket.IO, and e-mails a copy when SMTP is configured.
- `notifyTyped(userId, type, message, refs?)` — the v1 signature, **unchanged behaviour**; the 6 files that used `notify` now import it as `import { notifyTyped as notify }` so no call site changed. It derives `title` from `NOTICE_TITLES[type]` and `link` from `refs.eventId` (`/events/:id`) or `/volunteer` for shift/task/replacement.
- Also exported: `NOTICE_TITLES`, `safeLink`, `userIdOf`.
- `services/mailer.ts`: dependency-free SMTP client (implicit TLS, STARTTLS, AUTH PLAIN/LOGIN, base64 UTF-8 body, CR/LF stripped from headers). `mailEnabled()` is true only when `SMTP_HOST` and a from-address (`SMTP_FROM` or `SMTP_USER`) are set. `sendMail()` **never throws and returns false** on any failure/timeout (logged as a warning only); e-mail is fire-and-forget so it never delays or fails a request. No new npm package was added (lockfile untouched).

**Env** (all optional): `SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for 465), SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_TIMEOUT_MS (10000), APP_URL` (links in e-mails; defaults to first `CLIENT_ORIGIN`). `.env.example` now has SMTP lines **commented out** (previously a placeholder host was set, which would have been treated as enabled). `docker.env.example` and `docker-compose.yml` pass them through (empty = disabled).

**Routes** (existing, `/api/v1`, any signed-in user, own notifications only)
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications` | `limit` 1–100 (default 50), `skip` 0–10000, `unread=1`; bad values fall back to defaults (Zod `.catch`) |
| GET | `/notifications/unread-count` | exact count for the bell badge |
| POST | `/notifications/read-all` | optional `{upTo}` date |
| POST | `/notifications/:id/read` | |
| DELETE | `/notifications/:id`, `/notifications` | dismiss / clear all |

**Migration** `2026-10-s3-notification-title-link` (in `MIGRATIONS`; runs on boot or `npm run migrate`): backfills `title` from `type` for old rows, `link` from `refs.eventId`, and ensures indexes. Idempotent.

**Web**
- Bell (already in the navbar, `NotificationBell`): unread badge unchanged; panel now shows each item's title and opens `link` (falls back to the event). Opening the panel still marks items as seen (existing behaviour, covered by `features.test.tsx`).
- Page `/notifications` rewritten: All/Unread tabs, **Mark all read** button, per-item **Read** button, click an item = mark read + go to its link, dismiss, clear all, "Show more" (up to 100). The page no longer auto-marks everything as read on arrival (so mark-read is meaningful); the bell does.
- `lib/notifications.ts`: `Notice` gained `title`, `link`; new `noticeTarget()`.

**S3 notes / not done**
- Could not run Vitest here (sandbox lacks the platform's rollup/esbuild binaries) and there is no MongoDB. Checked instead: `tsc` (server+web) and ESLint on changed files = 0 problems; the mailer was exercised end to end against a throw-away fake SMTP server (AUTH, headers, base64 body, unreachable host -> false, unset -> false). Added `src/tests/mailer.test.ts` (no DB needed) — please run `npm test` once.
- Per-user e-mail preferences / digest are not implemented (all notifications are e-mailed when SMTP is on).
- New feature stages should call `notify(user, title, message, link)`.

## 4d. S4 — Dark mode, exports, demo seed (done)

**Dark mode + responsive (shared layout only)**
- `tailwind.config.js`: `darkMode: 'class'`. `index.html` has a tiny inline script that applies the saved theme before first paint (no flash); first visit follows the OS setting.
- `lib/theme.ts`: `useTheme()` -> `{theme,setTheme,toggle}`; saved in `localStorage['festhub-theme']` (`light|dark`), synced across tabs, safe if storage is blocked.
- `components/Layout.tsx`: sun/moon toggle in the top bar next to the bell. Responsive fixes: main area `min-w-0` + `overflow-x-hidden`, truncating mobile title, scrollable mobile drawer, tighter mobile padding.
- `index.css`: `.dark` block re-themes `.btn-ghost/.icon-btn/.input/.card/.glass-strong/.th/.skeleton` etc. and **remaps the light utilities pages already use** (`bg-white*`, `text-slate-*`, `border-white/*`, pastel status chips) so no page file was edited. Small-screen rules: media max-width, 16px inputs on phones, 40px min button height. No component logic changed.
- Not browser-tested: pages using unusual hard-coded colours (e.g. `bg-slate-900`, gradients, `text-gray-*` variants not listed) may need a `dark:` tweak — check visually.

**Export helpers** (no new npm package; pure TS in `packages/shared/src/exporters.ts`, exported from `@festhub/shared`)
- `toCsv(rows, columns, {bom?})`, `csvField()`: RFC-4180 quoting, CRLF, UTF-8 BOM (default), formula-injection guard (`= + - @` prefixed with `'`; real numbers untouched).
- `toPdf(rows, columns, {title, subtitle?, landscape?, footer?, fontSize?})` -> `Uint8Array`: valid PDF 1.4 (A4), title, shaded header, zebra rows, automatic pagination, "Page n of N" footer. Built-in Helvetica only: non-Latin characters (e.g. Bangla) print as `?`, long cells are truncated with `~`. Checked with `qpdf --check` / `pdfinfo` / `pdftotext`.
- `exportFileName(base, 'csv'|'pdf')` sanitises download names. Columns: `{header, value: 'prop' | (row)=>cell, width?}`.
- Server: `utils/exporters.ts` -> `sendCsv(res, name, rows, columns)`, `sendPdf(res, name, rows, columns, opts)`. Web: `lib/exporters.ts` -> `downloadCsv(...)`, `downloadPdf(...)` (browser-side from rows already loaded); use existing `api.download()` for server-generated files.
- The existing `/admin/audit/export.csv` was left untouched (works as before). No endpoint uses the new helpers yet; later stages will.
- Test added (no DB): `apps/server/src/tests/exporters.test.ts`.

**Seed** (`apps/server/src/seed/demo.ts`, idempotent, bcrypt cost 12)
- One account per role, e-mail `demo.<role>@festhub.test`, password **`Demo@12345`**; plus 3 published events: *Demo: Tech Talk — Building with APIs* (seminar), *Demo: Hack-a-thon Warm-up* (competition, capacity 5), *Demo: Git Workshop (approval required)*; venue *Demo Hall*.
- Runs automatically at the end of `npm run seed` (also when the DB already has users) and standalone with `npm run seed:demo`. Matches by e-mail/title, so re-running creates no duplicates. The older seed accounts (password `Password123`) are unchanged.

**Demo logins**

| Role | E-mail | Password |
|---|---|---|
| admin | demo.admin@festhub.test | Demo@12345 |
| organiser | demo.organiser@festhub.test | Demo@12345 |
| coordinator | demo.coordinator@festhub.test | Demo@12345 |
| participant | demo.participant@festhub.test | Demo@12345 |
| volunteer | demo.volunteer@festhub.test | Demo@12345 |
| judge | demo.judge@festhub.test | Demo@12345 |
| sponsor | demo.sponsor@festhub.test | Demo@12345 |

(Older accounts such as `organiser@festhub.test`, `participant1@festhub.test` use `Password123`.)

**Exact commands (fresh machine)**
```bash
npm install                                   # repo root
cp .env.example apps/server/.env              # edit secrets (JWT_ACCESS_SECRET, QR_TOKEN_SECRET, ...)
docker run -d --name festhub-mongo -p 27017:27017 mongo:7   # or any MongoDB 6+/7
npm run migrate                               # run-once start-up migrations + ledger
npm run seed                                  # indexes + sample data + demo accounts/events  (use `-- --reset` to wipe first)
npm run seed:demo                             # optional: only (re)add demo accounts/events
npm run dev                                   # API http://localhost:5000, web http://localhost:5173
# checks
npm run typecheck && npm run lint && npm test
```

**S4 notes / not done**
- Sandbox had no node_modules, network or MongoDB: nothing was compiled or run with the project toolchain (only the export helpers were exercised with tsx/qpdf). Please run `npm install && npm run typecheck && npm run lint && npm test`, then click through the toggle (desktop + phone width).
- No UI "Export" buttons were added to existing pages (out of scope); helpers are ready for S5+.

## 4e. S5 — Certificates (done)

**Model** `Certificate` (`models/index.ts`): `certId` (unique, `FH-XXXX-XXXX-XXXX-CC`), `eventId`, `userId`, `activityId?`, `type` (`participation | winner | runner_up | volunteer | organizer`), `status` (`valid | revoked`), `position?`, `positionLabel?` (e.g. "1st Place - Poster Round"), snapshots `recipientName / eventTitle / eventDate / signatureText` (a certificate keeps reading the same if the user/event changes or is deleted), `slotKey` (unique; see below), `issuedBy/issuedAt`, `revokedAt/By/Reason`, `replacesId` / `replacedById` (reissue chain). Indexes: `certId`, `slotKey`, `{eventId,type}`, `{userId,issuedAt}`.
- **One valid certificate per (event, person, type, activity)** is enforced by the unique `slotKey = "<event>:<user>:<type>:<activity>"`. Revoking replaces it with `x:<certId>` (frees the slot; same trick as `Registration.subjectKey`), so re-issuing works and double-click/parallel bulk runs cannot create duplicates.

**Pure functions** (`packages/shared/src/certificates.ts`, exported from `@festhub/shared`, no I/O, no randomness inside):
- `generateCertificateId(entropyBytes)` -> `FH-XXXX-XXXX-XXXX-CC`: 12 Crockford-base32 chars (60 bits) + 2 check chars (polynomial checksum mod 1021). Server feeds it `crypto.randomBytes(12)`.
- `verifyCertificateId(input)` -> `{ok, id?, reason?: 'format'|'checksum'}`; `normalizeCertificateId()` accepts lower case, spaces, missing dashes, O/I/L look-alikes. Exhaustively checked: every single-character typo is rejected. The check chars are a typo guard, **not** a signature: authenticity = the ID exists in the DB with status valid.
- Also exported: `CERTIFICATE_TYPES/STATUSES/TYPE_LABELS`, `ordinal()`, `CertificateVerification` type, and `qrMatrix(text)` (`shared/qr.ts`: dependency-free QR encoder, byte mode, ECC M, versions 1-10 = up to 213 bytes). The QR output was decoded back with OpenCV for 8 different lengths and from the rendered PDF.

**PDF** (`services/certificatePdf.ts`, `renderCertificatePdf(input)` -> bytes; pure; no npm package): A4 landscape, frame, "Certificate of <Type>", recipient (auto-shrinks long names), phrase per type, event name, position line, event date, signature line + signature text, QR code (vector) -> `<APP_URL>/verify/<id>`, ID + URL printed, optional diagonal REVOKED stamp. Helvetica only: characters outside Latin-1 (e.g. Bangla names) print as `?` — **known limitation**; fix = embed a TTF font later. Checked with `qpdf --check`, `pdftotext`, rendered PNG.

**Service** (`services/certificates.ts`)
- `recipientsFor(event, type, {attendedOnly})`: participation = confirmed registrations (team registrations expand to team members); with `attendedOnly` (default true) only people with a `CheckIn` (individual or via their team). winner / runner_up = rank 1 / rank 2 in **official** `Result`s of the event's activities (team ownerKeys expand to members; ties give several winners). volunteer = `ShiftAssignment` status `assigned` (and `attendance: present` when `attendedOnly`). organizer = the event creator (`createdBy`); other organizers via the manual endpoint (roles are global, there is no per-event staff list).
- `bulkGenerate` (idempotent: only fills gaps, reports `{created, skipped, byType}`), `issueCertificate`, `revokeCertificate`, `reissueCertificate` (revoke old -> issue new with fresh name/event details and a new ID -> old gets `replacedById`; rolls the old one back if issuing fails).
- `notify(user, title, message, '/certificates')` on issue / revoke / reissue (failures are swallowed); `logAction()` events: `certificate.bulk_generate`, `certificate.issue`, `certificate.revoke`, `certificate.reissue`.

**Routes** (`routes/certificates.ts`, mounted in `app.ts` next to `contests`, i.e. before routers with a global `requireAuth`; each route authenticates itself)
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/verify/:id` | **public**, rate-limited 60/min/IP | always HTTP 200 with `data.status` = `valid` / `revoked` / `not_found` (malformed and unknown IDs both give `not_found`). Returns recipient name, type, event, date, position, issue date (+ `revokedAt`, `replacedBy`); no user id/e-mail. `Cache-Control: no-store` |
| GET | `/certificates/mine` | signed-in | own certificates, newest first |
| GET | `/certificates/:id/download` | owner, organiser, coordinator | PDF. Revoked: staff only (stamped REVOKED), owner gets 409 |
| POST | `/certificates/:id/revoke` | organiser/admin | `{reason?}`; 409 if already revoked |
| POST | `/certificates/:id/reissue` | organiser/admin | `{reason?}`; 201 + new certificate; 409 if already reissued |
| GET | `/events/:eventId/certificates` | organiser, coordinator | `?type=&status=&limit=` (+ `meta.total`) |
| POST | `/events/:eventId/certificates/generate` | organiser/admin | `{types?: [...], attendedOnly?: true, signatureText?}`; refused (422) for draft/cancelled events |
| POST | `/events/:eventId/certificates` | organiser/admin | manual single: `{userId, type, position?, positionLabel?, signatureText?}`; 409 if a valid one exists |
`:id` accepts the canonical ID in any case. Env (optional): `CERT_SIGNATURE_TEXT` (default "Organizing Committee, PUB FestHub"; stored on each new certificate). QR/links use `APP_URL` (defaults to first `CLIENT_ORIGIN`) — **set `APP_URL` in production** or QR codes point at localhost.

**Migration** `2026-10-s5-certificates-collection-and-indexes` (`migrateCertificates`, in `MIGRATIONS`; runs on boot or `npm run migrate`): creates the collection + unique indexes and repairs rows without `slotKey` (no-op on a fresh install). Idempotent.

**Minimal UI** (web): public page `/verify/:id` (and `/verify` with an input box) showing valid / revoked / not found (revoked links to the replacement); page `/certificates` (nav item "Certificates"): everyone sees "My certificates" with PDF download; organiser/coordinator also get an event picker, bulk generate (type checkboxes + attended-only switch; organiser only), and a table with download / revoke / reissue. No other page was touched. For production the web server must serve `index.html` for `/verify/*` (the bundled nginx SPA fallback already does).

**Tests added**: `tests/certificates-pure.test.ts` (no DB: ID, QR, PDF) and `tests/certificates.test.ts` (DB: bulk idempotency, attended-only, official-results-only winners, verify valid/revoked/not found, download permissions, revoke 409s, reissue chain, notifications, audit, manual issue, draft refusal, migration).

**S5 notes / not done**
- Sandbox had no node_modules, network or MongoDB, so the server/web TypeScript, the new Vitest suites and the UI were **not compiled or run**. Verified for real: shared pure code compiles under `tsc --strict`; ID/QR/PDF were exercised with tsx, OpenCV and qpdf. Please run `npm install && npm run typecheck && npm run lint && npm test` and click through `/certificates` and `/verify/<id>` once.
- Not done: Bangla/Unicode names in PDFs (needs embedded font), contest-scoreboard winners (only judged-activity results count), bulk ZIP download, per-certificate e-mail attachments, certificate templates/logo upload, hiding recipient name on the public page.

## 4f. S6 — Certificates UI + verify page + template (done)

**Model** `CertificateTemplate` (one per event, unique `eventId`): `logoUrl`, `signatureImageUrl`, `signatureName`, `signatureTitle`, `primaryColor`, `accentColor` (`#rrggbb`), `updatedBy`. No migration needed (new collection; Mongoose creates it). Defaults apply when no row exists. The template is read **at render time**, so changes also affect PDFs of certificates already issued.

**Safe uploads** (`services/certTemplate.ts`): multipart field `file`, memory storage, **JPG/PNG only** (magic-byte check; client MIME/extension ignored; SVG/GIF/WebP refused), max **2 MB** (or `MAX_IMAGE_MB` if smaller), 1 file, random 24-hex names under `uploads/certs/`, old image deleted on replace/remove, path-traversal-safe name check. Errors: 400 wrong type, 413 too large. Organiser/admin only.

**PDF branding** (`certificatePdf.ts`, optional `brand` input; without it output is the same as S5): main/accent colours, logo (top-left), signature image above the line, signature name/title. JPEG embedded as-is; PNG (8-bit grey/RGB/RGBA, non-interlaced, <=4 MP) decoded + re-deflated with alpha as SMask. Unsupported/corrupt image -> certificate renders without it (never fails). Checked here with qpdf + rendered PNG (PNG with alpha, JPEG detection, junk bytes).

**New/changed routes** (`routes/certificates.ts`; all under `/api/v1`)
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/events/:eventId/certificates` | organiser/coordinator | **extended**: `q` (name or ID, regex-escaped), `type`, `status`, `page`, `pageSize` (<=200; `limit` still works); `meta` = `{total,page,pages,pageSize}`; `?paged=1` returns `{items,total,page,pages,pageSize}` in `data` (the web client uses this). Default response shape unchanged |
| GET | `/events/:eventId/certificates/export.csv` | organiser/coordinator | same filters, max 10 000 rows, BOM + formula guard (via `sendCsv`), audited `certificate.export` |
| GET / PUT | `/events/:eventId/certificate-template` | view: organiser/coordinator; PUT: organiser/admin | PUT validates colours, name/title <=80 chars; audited `certificate.template` |
| POST / DELETE | `/events/:eventId/certificate-template/logo` and `/signature` | organiser/admin | upload / remove image |
`GET /certificates/:id/download` now applies the template. Revoke / reissue / bulk generate / `mine` unchanged.

**Web**
- `/certificates` (organiser/coordinator section): event picker; **bulk generate** (type checkboxes, attended-only, confirm dialog); **template settings** card (logo + signature uploads with client-side type/size check, signature name/title, two colour pickers, save; coordinators see it read-only); list with **debounced search, type + status filters, server pagination (10/page), Download / Revoke (with optional reason) / Reissue**, **Export CSV**.
- "My certificates" (every signed-in user): cards with Download PDF (valid only), status chip, Verify link (unchanged from S5, already met the requirement).
- `/verify/:id` redesigned: status banner (valid green / revoked red / not found amber), recipient + event headline, detail rows (position, dates, ID, revoked date, replaced-by link), mono ID input with Enter-to-verify, no sign-in, no personal data beyond what S5 exposed, dark-mode friendly.

**Seed** (`seed/demo.ts`, runs with `npm run seed` / `npm run seed:demo`, idempotent): template for the Tech Talk and Hack-a-thon demo events; certificates: participation (demo.participant), volunteer (demo.volunteer), organizer (demo.organiser) for the Tech Talk; winner "1st Place - Demo Hack-a-thon" (demo.participant); plus one **revoked** sample (demo.volunteer, reason "Demo: issued by mistake") to demo the revoked verify page. IDs are visible on `/certificates` (log in as demo.organiser / demo.participant, password `Demo@12345`).

**Tests added**: `tests/certificates-s6.test.ts` (no-DB part: image sniffing, PNG embed in PDF; DB part: pagination/search/regex escaping/status filter/permissions, CSV, template CRUD + colour validation, upload rejection of fake-PNG and >2 MB, valid upload URL shape, download with template, logo removal).

**S6 notes / not done**
- Not compiled or run with the project toolchain (sandbox has no node_modules/MongoDB); only the image/PDF code was exercised (node + qpdf + rendered PNG). Please run `npm install && npm run typecheck && npm run lint && npm test`, then click through `/certificates` (upload a logo, generate, search, export) and `/verify/<id>`.
- Not done: live certificate preview in the settings card (PDF is the preview: Download), per-template signature for several signers, bulk ZIP download, Unicode (Bangla) names in PDFs (still Helvetica), a global (non-event) default template, deleting a template's images when the event is deleted (files stay in `uploads/certs/`).
- Web unit tests for the new pages were not added.

## 4g. S7 — Sponsors backend + minimal UI (done)

**Models** (`models/index.ts`, +4 = 40 total): `Sponsor` {company, contactName, email, phone, `tier` title|gold|silver|bronze|partner, `tierRank` (0..4, denormalised by a pre-validate hook so lists sort/paginate by tier in the DB), `contributionType` cash|in_kind|service, `amount`, `status` prospect→contacted→negotiating→confirmed→received, `nextFollowUpAt`, `reminderFor` (dedupe), notes, `ownerId` (gets reminders; defaults to creator), `userId` (optional sponsor portal login, for S8), createdBy}; `SponsorEvent` {sponsorId, eventId} (unique pair); `Deliverable` {sponsorId, eventId?, type logo|banner|social_post|booth|speaking_slot|tickets|certificate_mention|other, title, status pending|done, dueAt, doneAt}; `SponsorPayment` {sponsorId, eventId?, pledged, received, dueDate, receivedAt, note, receipt* fields, recordedBy}.

**Pure code** (`packages/shared/src/sponsors.ts`, exported from `@festhub/shared`, no I/O): constants/labels, `tierRank`, `compareSponsors`/`sortByTier` (tier then company, case-insensitive), `sponsorTotals(payments)` -> `{pledged, received, outstanding, overpaid}` (integer-cents arithmetic; outstanding = sum of per-payment max(0, pledged-received), so an over-payment never hides a shortfall elsewhere; junk/negative values count as 0), `totalsByTier(rows)` (all tiers, best first, `.grand`), `isForwardStatus`, `money`. Exercised with node (ordering + totals).

**Routes** (`routes/sponsors.ts`, mounted in `app.ts`; each route authenticates itself). Read = organiser/coordinator, write = organiser/admin.
| Method | Path | Notes |
|---|---|---|
| GET | `/sponsors` | `q, status, tier, eventId, followUp=due, page, pageSize(<=200)`; sorted tier -> company; each row has `totals`; `?paged=1` -> `{items,total,page,pages}` in data (meta also sent). Also triggers the throttled reminder run (not in tests) |
| GET | `/sponsors/summary` | grand totals, per-tier totals (best first), per-status counts, `dueFollowUps` |
| POST | `/sponsors/reminders/run` | send due reminders now (organiser) |
| POST / GET / PATCH / DELETE | `/sponsors`, `/sponsors/:id` | PATCH cannot change status; DELETE cascades links/deliverables/payments + receipt files |
| POST | `/sponsors/:id/status` | `{status}`; any move allowed (backwards flagged `direction:"backward"` in audit); atomic; 409 if unchanged/raced |
| POST / DELETE | `/sponsors/:id/events`, `/sponsors/:id/events/:eventId` | link/unlink (409 on duplicate); `GET /events/:eventId/sponsors` (tier order) |
| GET / POST | `/sponsors/:id/deliverables`; PATCH / DELETE `/deliverables/:id` | `done` sets `doneAt` |
| GET / POST | `/sponsors/:id/payments`; PATCH / DELETE `/payments/:id` | amounts >= 0, rounded to cents; `receivedAt` auto-set when received > 0 |
| POST / GET / DELETE | `/payments/:id/receipt` | upload (organiser), download (organiser/coordinator), remove |
**Receipts are private**: PDF/JPG/PNG only (magic-byte check; client MIME/extension ignored), max 5 MB (`MAX_IMAGE_MB` if smaller), random names, stored in `uploads/.private/receipts/` (dot-dir: denied by the static handler, plus an explicit 404 guard added in `app.ts` for `/uploads/.private`), served only through the authenticated route with `nosniff`, `attachment`, `no-store`; the stored file name is never returned by the API. Errors 400 / 413.
**Audit** (`logAction`): `sponsor.create|update|status|delete|event_link|event_unlink|deliverable_create|update|delete|payment_create|update|delete|receipt_upload|receipt_delete|reminders_run` (status: from/to/direction; payments: before/after amounts).

**Follow-up reminders** (`services/sponsorReminders.ts`): `sendFollowUpReminders()` finds open (not `received`) sponsors with `nextFollowUpAt` <= end of today, atomically claims each (`reminderFor` = that date, so **one reminder per scheduled date**, also under concurrent runs) and `notify()`s the owner (falls back to organisers/admins if the owner is gone) with link `/sponsors`; title "Sponsor follow-up due/overdue". Triggers: (1) on page load: `GET /sponsors` (fire-and-forget, at most once per 10 min per process); (2) manual `POST /sponsors/reminders/run`; (3) management command `npm run sponsors:remind` (root and server; cron-friendly). Changing the follow-up date re-arms it.

**Migration** `2026-10-s7-sponsors-collections-and-indexes` (`migrateSponsors`, in `MIGRATIONS`; runs on boot or `npm run migrate`): creates the 4 collections + indexes, backfills `status`, `tier`, `tierRank`. Idempotent.

**Minimal UI** (web): `/sponsors` (nav "Sponsors", organiser + coordinator; coordinator is read-only): totals tiles (pledged/received/outstanding/follow-ups due), add-sponsor form, status filter, tier-ordered table with inline status change, delete, pagination, "Send due reminders". No payments/deliverables/receipts/event-link screens yet (API only) — S8.

**Tests added**: `tests/sponsors-pure.test.ts` (no DB: ordering, totals, tiers, status direction, receipt sniffing) and `tests/sponsors.test.ts` (DB: permissions, validation, CRUD, tier order, status + audit, event links, deliverables, payments + audit + totals, receipt upload rejection/413/download/permissions/private path, cascade delete, reminders once-per-date + re-arm + done excluded, migration backfill/idempotence).

**S7 notes / not done**
- Not compiled or run with the project toolchain (no node_modules/MongoDB in the sandbox): only a syntax check of all changed files and a node run of the shared pure code. Please run `npm install && npm run typecheck && npm run lint && npm test`, then click through `/sponsors`.
- Not done (out of scope): demo seed data for sponsors, sponsor-role portal (`Sponsor.userId` is reserved), payments/deliverables/receipt screens, sponsor e-mail notifications, payment-due reminders, e-mail/CSV export of sponsors, web unit tests, docs/API_CONTRACT.md entries.

## 4h. S8 — Sponsors UI + sponsor portal (done)

**Server** (nothing existing changed except two additive edits: `/sponsors/export.csv` in `routes/sponsors.ts`, one `v1.use(sponsorPortal)` line in `app.ts`)
| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/sponsors/export.csv` | organiser/coordinator | same filters as `GET /sponsors` (`q,status,tier,eventId,followUp`), max 10 000 rows, BOM + formula guard via `sendCsv`, audited `sponsor.export`. Declared before `/sponsors/:id` |
| GET | `/events/:eventId/our-sponsors` | **public** (no sign-in) | sponsors linked to the event whose status is `confirmed` or `received`, ordered tier -> company; returns only `{id, company, tier, tierLabel}` (no contacts/amounts). 404 for unknown or `draft` events. `Cache-Control: public, max-age=60` |
| GET | `/sponsor-portal/me` | role `sponsor` only (organiser/admin do not pass) | **read-only** (GET only exists). Own sponsor found via `Sponsor.userId`; 404 if none linked. Returns tier/status/totals, deliverables, payments (no receipts, no notes, no e-mail), and `visibility` (public yes/no + per linked event whether it is shown) |
| PUT | `/sponsors/:id/portal-user` | organiser/admin | `{email}` links a user that has the `sponsor` role (404 otherwise, 409 if that user is linked to another sponsor); `{email:null}` unlinks. Audited `sponsor.portal_link` / `sponsor.portal_unlink` |
New code: `routes/sponsorPortal.ts`. The dashboard numbers/tier chart use the existing `GET /sponsors/summary` (S7) — no new endpoint.

**Web**
- `/sponsors` (`pages/Sponsors.tsx`, organiser write / coordinator read): **dashboard** tiles (pledged, received, outstanding, follow-ups due) + new **tier breakdown chart** (`TierChart`, pure CSS bars: received vs outstanding per tier); **debounced search** (company/contact/e-mail), **status + tier filters**, server **pagination** (15/page), **Export CSV** (respects current filters), company name links to the detail page. Add form, inline status change, delete, "Send due reminders" are unchanged.
- `/sponsors/:id` (`pages/SponsorDetail.tsx`): edit form (organiser; coordinator sees it disabled), event link/unlink, payments (add, edit received on blur, delete), deliverables (add, tick done, delete), portal-login link/unlink. Status is still changed from the list.
- `/my-sponsorship` (`pages/SponsorPortal.tsx`, role `sponsor`, nav item "My sponsorship"): tiles, visibility card, deliverables, payments. No buttons that change data.
- Event page (`pages/Events.tsx`, one `<OurSponsors/>` line before Announcements; `components/OurSponsors.tsx`): "Our Sponsors" card grouped by tier (Title largest ... Partner smallest); hidden when there are none.

**Seed** (`seed/demo.ts`, idempotent by company name; runs with `npm run seed` / `npm run seed:demo`): 6 demo sponsors across all tiers and statuses — *Demo Nova Bank* (title, linked to `demo.sponsor@festhub.test` for the portal), *Orbit Cloud* (gold), *Pixel Labs* (silver), *Byte Snacks* (bronze), *Campus Press* (partner, negotiating, follow-up in 3 days), *Green Cafe* (partner, prospect = not public); linked to the three demo events, with payments and deliverables. Log in as `demo.sponsor@festhub.test` / `Demo@12345` for the portal, `demo.organiser@festhub.test` for management; open a demo event to see "Our Sponsors".

**Tests added**: `tests/sponsors-s8.test.ts` (DB: public list order/privacy/draft 404, CSV permissions + filter, portal 404/403/link rules/own-data-only/no write access).

**S8 notes / not done**
- Ran here: `npm install`, `tsc` and ESLint. **Server typecheck reports 2 errors in `certificates.ts` / `services/certificates.ts` and web typecheck 1 error in `lib/exporters.ts`; all three are in S4–S6 files (not touched in S8; they look like TypeScript/`@types` version drift), no errors in S8 files.** Vitest and the UI were **not run** (no MongoDB/browser). Please run `npm run typecheck && npm run lint && npm test`, `npm run seed:demo`, then click through `/sponsors`, `/sponsors/:id`, an event page, and `/my-sponsorship`.
- Not done (out of scope): receipt upload/download screens, sponsor logos on the public section (names only), payment-due reminders, e-mail to sponsors, PDF export, API_CONTRACT.md entries, web unit tests.
- Sponsor visibility rule (public = `confirmed`/`received` + linked to a non-draft event) is a choice made in S8; change `PUBLIC_STATUSES` in `routes/sponsorPortal.ts` to adjust.

## 4i. S9 — Equipment backend + minimal UI (done)

**Models** (`models/index.ts`, +2 = 42 total): `Equipment` {item, category, totalQty, condition new|good|fair|poor, location, ownerId (defaults to creator; gets low-stock/damage notices), lowStockThreshold, `damagedQty`, `missingQty` (units permanently out of service, raised at check-in), createdBy}; `Allocation` {equipmentId, eventId?, activityId? (session), teamId? (at least one required; event is derived from session/team and cross-checked), startAt, endAt, qty, status requested|approved|rejected|checked_out|returned, note, requestedBy, decidedBy/At, decisionNote, checkedOutBy/At, checkedInBy/At, returnCondition ok|damaged|missing, returnedBadQty, returnNote}. Indexes: `equipmentId+startAt`, `equipmentId+status`, `eventId`, `status+startAt`.

**The one conflict function** (`packages/shared/src/equipment.ts`, exported from `@festhub/shared`; pure: no I/O, no clock, `now` is an argument): `checkEquipmentConflict({ totalQty, damagedQty?, missingQty?, existing[], request:{qty,startAt,endAt}, now, ignoreId? }) -> { ok, code?, message?, usableQty, availableQty, conflictingIds }`.
- Half-open ranges `[start, end)`: **back-to-back is allowed**; any overlap counts.
- Usable stock = total - damaged - missing (never < 0). **Damaged/missing reduce availability.**
- Only `approved` and `checked_out` hold stock (`requested/rejected/returned` do not). An **unreturned `checked_out` keeps holding stock until max(end, now)**.
- Quantity is checked at every instant of the window (sweep over start points): bookings that never coincide do not stack; overlapping ones add up.
- Codes: `INVALID_QTY`, `INVALID_RANGE`, `NO_USABLE_STOCK`, `OVER_TOTAL`, `INSUFFICIENT_STOCK`. Example message: "Only 3 of 10 usable units available between 2026-11-01 11:00 UTC and 2026-11-01 12:00 UTC: 7 already allocated in overlapping bookings. Requested 4." (adds ", N damaged or missing" when relevant). The API returns it as HTTP 409 `EQUIPMENT_CONFLICT` with `details {reason, usableQty, availableQty, conflictingIds}`.
- `services/equipment.ts#conflictFor()` only loads data and calls it; nothing else decides conflicts.

**Routes** (`routes/equipment.ts`, mounted in `app.ts`; each route authenticates itself). View/request/check-out/check-in = organiser, coordinator; manage items + approve/reject = organiser/admin.
| Method | Path | Notes |
|---|---|---|
| GET / POST | `/equipment` | list `?q=&category=&low=1&page=&pageSize=&paged=1` (rows have usableQty, inHandQty, availableNow, `low`); POST organiser |
| GET / PATCH / DELETE | `/equipment/:id` | PATCH cannot push damaged+missing above total or usable below units currently checked out (repairs: lower `damagedQty`/`missingQty`); DELETE refused (409) while any request/approval/check-out is open, otherwise removes history |
| GET | `/equipment/:id/availability` | `?startAt&endAt&qty` -> the pure function's result (never 409) |
| POST | `/equipment/:id/allocations` | **request**; early conflict check (409 + message); notifies the owner |
| GET | `/allocations` | `?status&equipmentId&eventId&page&pageSize&paged=1` |
| POST | `/allocations/:id/approve` | organiser; conflict **re-checked under a per-item lock** (`withLocks`), atomic requested->approved; parallel approvals of competing requests: exactly one wins |
| POST | `/allocations/:id/reject` | organiser; `{reason?}` |
| POST | `/allocations/:id/checkout` | approved -> checked_out (also refuses if units are physically still out from another allocation) |
| POST | `/allocations/:id/checkin` | checked_out -> returned; `{condition: ok|damaged|missing, badQty? (default = qty), note?}`; damaged/missing atomically raises the item's `damagedQty`/`missingQty` |
Every transition is atomic (`findOneAndUpdate` on the expected status; 409 otherwise). **notify()**: request -> owner; approve/reject/check-out/return -> requester; damaged/missing -> owner + requester; "Low stock" -> owner, only when free units cross down to the threshold. **log_action** (`logAction`): `equipment.create|update|delete`, `allocation.request|approve|reject|checkout|checkin`.

**Migration** `2026-10-s9-equipment-collections-and-indexes` (`migrateEquipment`, in `MIGRATIONS`; runs on boot or `npm run migrate`): creates both collections + indexes; backfills condition, damaged/missing counters, low-stock threshold, category, owner = creator, allocation status, `returnedBadQty` of damaged/missing returns. Idempotent.

**Minimal UI** (web): `/equipment` (nav "Equipment", organiser + coordinator): inventory table (usable/total, out now, free now, low-stock chip), add form + delete (organiser), request form (item, event, from/until, qty, note), allocations table with Approve/Reject (organiser), Check out, Return ok/damaged/missing. Full UI (session/team pickers, filters, calendar view, error detail display) = S10.

**Tests added**: `tests/equipment-pure.test.ts` (no DB, **10 tests, run and passing**: back-to-back, overlap, quantity sums, non-coinciding bookings, status filtering, damaged/missing, overdue check-out, ignoreId, purity) and `tests/equipment.test.ts` (DB: permissions, validation, full workflow, conflict message, damage reduces stock, low-stock notice, audit, delete rules, parallel-approval race, migration).

**S9 notes / not done**
- Ran here: `npm install`, `tsc`, ESLint (clean for all S9 files) and the pure Vitest suite. The DB suite and the UI were **not run** (no MongoDB/browser). Please run `npm run typecheck && npm run lint && npm test`, `npm run migrate`, then click through `/equipment`. Pre-existing type errors remain in S5/S6 files and `lib/exporters.ts` (see 4h); untouched.
- Not done (out of scope): demo equipment seed, cancel-by-requester, extending/rescheduling an allocation, equipment photos/QR labels, CSV export, per-team requester role (participants cannot request; only organiser/coordinator), docs/API_CONTRACT.md entries, web unit tests.
- Choices: requests do not reserve stock until approved; a still-checked-out item blocks stock past its end time; low-stock = units free right now (not time-windowed).

## 4j. S10 — Equipment UI (done)

**Web** (`pages/Equipment.tsx` = shell; parts in `pages/equipment/`; same route `/equipment`, tab kept in `?tab=`):
- **Inventory** (`Inventory.tsx`): search (item/location), category filter, "low stock only", server pagination (10/page), add + **edit** form (organiser; edit also sets damaged/missing counts), delete, per-row *Request* / *Timeline* shortcuts. Empty states for no data vs no matches.
- **Request** (`RequestForm.tsx`): item, event, optional **session** and **team** pickers (loaded per event), from/until, qty, note. Live availability line from the read-only availability endpoint (same pure function as the server), submit disabled when it says no; a server 409 shows the message plus the numbers (`conflictHint`). Picking a session pre-fills the times when empty.
- **Approvals** (`Approvals.tsx`): pending requests, each with a live "can be approved / cannot, because…" line; Approve (disabled when blocked), Reject with optional reason (organiser only; coordinators see "waiting"). Tab label shows the pending count.
- **Check-out / in** (`Desk` in `Approvals.tsx`): approved → *Check out*; checked-out list sorted by due date, **overdue badge**, check-in form (all good / damaged / missing + how many (1..qty) + note). Auto-refreshes every 30 s.
- **Timeline** (`Timeline.tsx`): per item, start date + 3/7/14/30 days; "free units over time" strip (red = none free, amber = at/below low-stock level, green = ok, black line = now), one bar per allocation (approved / checked out / requested-dashed / returned), legend, and a table underneath. Times are shown in the viewer's local zone.
- **History** (`History.tsx`): every allocation with who/when for request, decision (+note), check-out, check-in (+condition, bad units, note); filters item, status, start-date range; paginated (15/page); **Export CSV** (organiser) honours the same filters.
- **Low-stock / overdue alerts**: banner on top of the page (low-stock items link to their timeline; overdue returns link to the desk), "low stock" chip in the inventory table. Server-side notices to the owner from S9 are unchanged.

**Server additions** (`routes/equipment.ts`; nothing existing changed):
| Method | Path | Notes |
|---|---|---|
| GET | `/equipment/alerts` | `{ low[], overdue[] (checked out past endAt), pendingRequests }`; organiser, coordinator |
| GET | `/equipment/targets?eventId=` | `{ activities[], teams[] }` for the request pickers |
| GET | `/equipment/:id/timeline?from=&days=` | `{ equipment, from, to, now, allocations[], segments[] }`; default from = today 00:00 UTC, days 1–60 (default 14) |
| GET | `/allocations/history` | paged lifecycle log: `status, equipmentId, eventId, q (item name), from, to (on startAt), page, pageSize` |
| GET | `/allocations/export` | CSV of the same filters (max 20 000 rows, 19 columns, formula-injection-safe via `csvField`); organiser only; audited as `allocation.export` |
- **`buildAvailabilityTimeline()`** (`packages/shared/src/equipment.ts`, pure, no clock): splits a window into segments of constant use using the same holding rules as `checkEquipmentConflict` (only approved/checked_out hold stock; unreturned checked-out holds until `now`). 3 new tests in `tests/equipment-pure.test.ts`; the function itself was run here against the expected values (passing).

**Seed** (`seed/equipment.ts`, called from `seedDemo()` so both `npm run seed` and `npm run seed:demo` add it; idempotent per item name): 6 items (HD Projector, Extension Cord Strip, Wireless Microphone, Loaner Laptop, Banner Stand, Folding Table) with 14 allocations across statuses. Includes: a **low-stock** item (cords: 8 out, 4 free = threshold), an **overdue** mic, a damaged return and a missing return, a rejected request, and the **near-conflict** on *HD Projector* (4 owned, 1 damaged = 3 usable, tomorrow UTC): 09–11 ×2, 10–12 ×1, 11–13 ×2 (back-to-back, allowed), then two pending requests for the last free unit (12:00–14:00 and 12:30–13:30). Each is accepted alone; after approving one, approving the other returns the 409 message. Look at it in Timeline → HD Projector, and in Approvals (each request shows its live check).

**S10 notes / not done**
- Not run here (no node_modules/MongoDB/browser): `npm run typecheck`, `lint`, `test`, or the UI. Only the pure timeline function was executed, and the new files were syntax-checked with `tsc`. Please run `npm install && npm run typecheck && npm run lint && npm test`, then `npm run seed -- --reset` (or `seed:demo` on an existing DB) and click through all six tabs.
- No DB tests were added for the 5 new routes and no web unit tests; `docs/API_CONTRACT.md` not updated.
- Not done (out of scope): cancel/reschedule an allocation, participant/team-leader requests, drag-to-book on the timeline, PDF export, per-item history drill-down page.
- Pre-existing type errors in S5/S6 files and `lib/exporters.ts` (see 4h) untouched.

## 4k. S11 — Plagiarism engine (done)

**Engine** (`apps/server/src/services/plagiarism/`, pure, offline, no deps; own module): `tokenize.ts` (per-language scanner for python, c, cpp, java, javascript: strips comments + whitespace, identifiers -> `ID`, numbers -> `NUM`, strings/chars/templates -> `STR`, keywords + operators kept, C `#include`/macro bodies reduced to a directive token, hard cap 60 000 tokens) and `similarity.ts` (FNV-1a hashes of token k-grams, **winnowing** k=5, w=4, MOSS-style; token 3-gram **Jaccard**; score = 100 x (0.7 x fingerprint containment `shared/min(|A|,|B|)` + 0.3 x Jaccard), 1 decimal; "not comparable" (0) when either side is too short). Renamed variables, changed literals, reformatting and comments score 100% (tested for C, Python, Java). **Starter/template code**: `buildExclusion()` removes every k-gram / shingle that occurs in the template before winnowing.

**Models** (`models/index.ts`, +4): `CodeSubmission` {userId, eventId?, problemId?, `scopeKey` (`p:<problem>` else `e:<event>`), language (python|c|cpp|java|javascript), code (select:false), source paste|upload, fileName, sizeBytes, codeHash, optional `submissionId` link, `checkStatus` pending|running|done|failed, maxSimilarity}; `PlagiarismPair` {scopeKey, aId<bId (unique pair), users, similarity, winnowScore, jaccardScore, sharedPrints, **status clear|suspicious|confirmed**, `manual` (reviewer decision, never overwritten by re-runs/threshold changes), thresholdUsed, **notes[]**, reviewedBy/At}; `PlagiarismSetting` {scope global|event|problem, refId, suspiciousThreshold 10..100}; `StarterCode` {scopeKey, language, name, code}. Existing `Submission` (judge) was left untouched; `CodeSubmission.submissionId` is reserved to link them.

**Run check** (`services/plagiarismCheck.ts`): `checkSubmission(id)` compares one submission with the **latest code of every other user** in the same scope + language; `checkScope(scopeKey)` = all pairs; pairs < 10% are not stored. Status = `suspicious` when similarity >= threshold (resolution: problem -> event -> global -> default **70**), otherwise `clear`; `confirmed` only by a reviewer. `scheduleCheck()` / `scheduleScopeCheck()` run in an in-process serial background queue (after the HTTP response; `setImmediate` yields inside the loops; duplicates collapsed); `drainPlagiarismQueue()` for tests. **Auto-run after every submission.** `applyThreshold()` re-derives undecided pairs when a threshold changes.

**Safe uploads** (`services/codeIntake.ts`): multipart field `file`, memory only (never written to disk), 1 file, max 200 KB (413), extension allow-list per language, valid UTF-8, no NUL bytes; pasted code has the same size/NUL limits; max 20 submissions per user per scope + the usual cooldown (429).

**Routes** (`routes/plagiarism.ts`, each authenticates itself; review = organiser/judge (+admin), settings/starter code = organiser/admin): `POST /plagiarism/submissions` (multipart or JSON), `GET .../submissions/mine`, `GET .../submissions` (review), `GET .../submissions/:id` (owner or review), `POST .../submissions/:id/recheck`, `POST /plagiarism/check`, `GET /plagiarism/pairs`, `GET|PATCH /plagiarism/pairs/:id` (`status: clear|suspicious|confirmed|auto`, `note`), `POST .../pairs/:id/notes`, `GET|PUT /plagiarism/settings`, `GET|POST|DELETE /plagiarism/starter-code`. Audited: `plagiarism.submit|check|review|note|settings|starter_add|starter_delete`.

**Migration** `2026-10-s11-plagiarism-collections-and-indexes` (`migratePlagiarism`, appended to `MIGRATIONS`): creates collections + indexes, repairs missing `scopeKey`/`checkStatus`/pair `status`. Idempotent.

**Minimal UI**: `/plagiarism` ("Code similarity" nav): submit form (event, language, paste or load a file), my submissions with check status, and for reviewers a pair table with status dropdown. Full review UI (side-by-side diff, notes, threshold/starter-code screens) is S12.

**Tests added**: `tests/plagiarism-pure.test.ts` (tokenizer, winnowing guarantee, renamed/reformatted copies for C/Python/Java, template exclusion, short code, determinism) — **run here via a tiny shim, 11/11 pass**; `tests/plagiarism.test.ts` (DB: validation, paste + upload, upload rejections, auto-run, review, manual status survives re-run, thresholds, starter code, permissions, migration) — **written, not run** (no MongoDB).

**S11 notes / not done**
- Not compiled with the project toolchain or run against MongoDB (no node_modules/network/MongoDB in the sandbox). Only the engine passes `tsc --strict`; the other new files were syntax-checked. Please run `npm install && npm run typecheck && npm run lint && npm test`, then click through `/plagiarism`.
- Choices/limits: only same-language code is compared (no cross-language); the background job is an in-process queue, not a `worker_threads` worker (very large classes still cost CPU on the main process between yields); fingerprints are recomputed per run, not cached; judged contest/practice `Submission`s are NOT mirrored into `CodeSubmission` automatically (kept out to avoid touching the judge path); no registration check on submit; no notification to reviewers when a pair becomes suspicious; TypeScript/Go/etc. are not supported by the engine; no `docs/API_CONTRACT.md` entries; no web tests.

## 4l. S12 — Plagiarism UI (done)

**Web**
- `/submit-code` (`pages/CodeSubmit.tsx`, nav "Submit code", everyone): event (required) + optional problem + language (Python, C, C++, Java, JavaScript); **paste** or **upload / drag-and-drop** a file (read in the browser, sent as JSON; client checks the extension per language, 200 KB, NUL bytes; same limits as the server); size counter; "My submissions" with the check state (no similarity numbers shown to students).
- `/plagiarism` (`pages/Plagiarism.tsx`, nav "Plagiarism report", organiser/admin/judge): event filter ("All events" or one); **Run check** button + live status line (polls every 3 s: submissions checked, pairs, suspicious/confirmed, last run, spinner while the queue works; the button needs an event); **threshold control** (slider + number, Save / Remove override; organiser edits, judge read-only; shows which level is in use: event / global / default); **ranked pairs** (rank, students, language, similarity bar + %, status chip, status + min-% filters, 15/page, 8 s refresh); **Compare** opens the pair in place (also via `?pair=<id>`, which the notification links to).
- Pair review (`Detail`): similarity + fingerprint/shingle parts, buttons *Flag as suspicious*, *Confirm plagiarism*, *Mark clear*, *Back to automatic*, **side-by-side** (`pages/plagiarism/SideBySide.tsx`: two panes, line numbers, synced scrolling, matching blocks in the same colour on both sides, click a highlighted line to jump to its match, light + dark colours), and **review notes** (list + add).

**Server additions** (nothing existing removed)
- Engine: `tokenizeWithLines()` (same stream as `tokenize`, plus line numbers) and `matchingBlocks(codeA, codeB, lang, exclusion?)` -> per-line block ids for both sides (runs covered by k-grams shared by both; a line counts when >= half of its tokens are covered; blocks numbered in A order, same id on B; starter code not highlighted).
- `GET /plagiarism/pairs/:id/diff` (review): both sources as lines with block ids + pair summary. `GET /plagiarism/check/status?eventId|problemId` (review): counts by check state, pair counts, last check time, queue state, `running`.
- **log_action()** (`utils/audit.ts`): the review route now logs `plagiarism.flag`, `plagiarism.confirm`, `plagiarism.clear`, `plagiarism.unflag` (back to automatic) or `plagiarism.note`, each with from/to status, similarity, both user ids and the scope. (S11 logged all of these as `plagiarism.review`; old rows keep that name.) Submit/check/settings/starter-code audit actions unchanged.
- **notify()**: when a pair reaches `suspicious` (similarity >= threshold, not manually decided), `notifyHighSimilarity()` sends **one** in-app notice per pair, ever ("High code similarity", names + %, link `/plagiarism?pair=<id>`) to the event's creator when that is an active organiser/admin, otherwise to all active organisers/admins (max 20). Claimed atomically via the new `PlagiarismPair.notifiedAt` field (additive; no migration needed, existing rows have none), so re-runs, parallel runs and threshold changes never repeat it. Failures are logged, never fail a check.

**Seed** (`seed/plagiarism.ts`, called from `seedDemo()`, so `npm run seed` / `npm run seed:demo`; idempotent): five demo students (`demo.student1..5@festhub.test`, password `Demo@12345`) with Python submissions for "Demo: Hack-a-thon Warm-up": student1 original (even-sum/max, uploaded), **student2 copy** of it (comment + extra line + changed message; ~99.6%), student3 original (prime sieve), **student4 renamed-variables** version of the sieve (every identifier renamed, other layout/indent/comments; 100%), student5 original (memoised Fibonacci; <25% to the others). Pairs are computed at seed time, so `demo.organiser` sees two suspicious pairs and two notifications right away.

**Tests added**: `tests/plagiarism-s12-pure.test.ts` (no DB: lines match the token stream, shared blocks highlighted on both sides, helper/comment not highlighted, unrelated code has no blocks; **run here via a shim, 3/3 pass**) and `tests/plagiarism-s12.test.ts` (DB: single notice to the event's organiser and none on re-run, status endpoint + permissions, diff endpoint + permissions, flag/confirm audit rows, demo seed + idempotence; **written, not run**).

**S12 notes / not done**
- Not compiled with the project toolchain or run against MongoDB / in a browser (no node_modules, network, MongoDB in the sandbox): only the engine is `tsc --strict` checked; other new files were syntax-checked. Please run `npm install && npm run typecheck && npm run lint && npm test`, then `npm run seed:demo` and click through `/submit-code` and `/plagiarism` (log in as `demo.organiser@festhub.test`).
- The S11 page that mixed submit + review was split: participants now use `/submit-code`; `/plagiarism` is staff-only (judges can review and add notes; thresholds, starter code and "confirm" via the API remain as in S11: threshold + starter code organiser-only).
- Not done: starter-code management screen (API only), CSV/PDF export of the report, viewing/deleting a submission from the report, per-problem threshold UI (event/global only), line-level alignment of moved code, web tests, `docs/API_CONTRACT.md` entries. Event list on both pages uses `/events` as-is (no registration check on submit, as in S11).

## 4m. S13 — AI feedback backend + review rubrics (done)

**Models** (`models/index.ts`, +2 = 48): `ReviewRubric` {name, `scopeKey` (`p:<problem>` else `e:<event>`), eventId/problemId, criteria[{key, name, description, maxPoints 1..1000, weight 0..100}], active, createdBy; unique (scopeKey, name)}. Named `ReviewRubric` because the S-v1 judging `Rubric` (per activity) is untouched. `Feedback` {codeSubmissionId (**unique**: one per submission), userId (participant), eventId, problemId, rubricId, `status` draft|published, strengths[], issues[], suggestions[], quality{rating 1-10, summary}, complexity{time, space, notes}, `criterionScores[]` (snapshot of key/name/max/weight + score/comment, so rubric edits never change issued scores), `total{points, maxPoints, percent}` (percent = weighted), generation{source ai|manual, model, truncated, ok, warnings[], at}, editedBy/At, publishedBy/At}.

**Code** (`services/aiFeedback/`, own module): `rubric.ts` (pure: `normalizeCriteria`, `computeTotals`, `blankScores`), `prompt.ts` (pure `buildFeedbackPrompt` — takes ONE submission, has no parameter for anyone else's code; code fenced as untrusted data; `truncateCode` keeps head+tail, default 24 000 chars), `parse.ts` (pure `parseFeedbackResponse`/`extractJsonObject`: strips fences/prose, balanced-brace scan, clamps scores/rating, fills missing criteria with 0 + warnings, never throws, `ok:false` on garbage), `client.ts` (`aiState()`, `callAnthropic()` plain `fetch` to `/v1/messages`, no new npm dependency; AbortController timeout; retries 429/529/5xx/network with exponential backoff + jitter, honours `Retry-After`; 401/403/400 not retried; injectable fetch/sleep for tests), `index.ts` (`generateDraft`, `createBlankDraft`, `rubricFor`: active problem rubric first, else event rubric).

**Env**: `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` (both required; either missing = **disabled**: `GET /ai-feedback/status` says why, `generate` answers 503 `AI_DISABLED`, everything else incl. manual drafts works, app boots normally). Optional: `ANTHROPIC_TIMEOUT_MS` (60000), `ANTHROPIC_MAX_RETRIES` (3), `ANTHROPIC_MAX_INPUT_CHARS` (24000), `ANTHROPIC_MAX_OUTPUT_TOKENS` (2000), `ANTHROPIC_BASE_URL`. The key is never returned, logged or stored.

**Routes** (`routes/feedback.ts`, mounted in `app.ts`; each authenticates itself; staff = organiser/judge, admin counts as organiser)
| Method | Path | Notes |
|---|---|---|
| GET | `/ai-feedback/status` | `{enabled, model}` or `{enabled:false, reason}` |
| GET/POST | `/feedback-rubrics` | `?eventId|problemId`; POST `{eventId|problemId, name, criteria[]}` (exactly one scope; 409 duplicate name) |
| GET/PATCH/DELETE | `/feedback-rubrics/:id` | PATCH replaces criteria/name/active; delete keeps existing feedback (snapshot) |
| POST | `/ai-feedback/generate` | `{codeSubmissionId}` -> AI **draft** (201). Errors: 503 AI_DISABLED, 429 AI_RATE_LIMITED, 504 AI_TIMEOUT, 502 other; 409 if already published |
| POST | `/ai-feedback` | blank manual draft (409 if one exists) |
| GET | `/ai-feedback`, `/ai-feedback/:id` | staff; filters `eventId, problemId, codeSubmissionId, status, page, pageSize` |
| PATCH | `/ai-feedback/:id` | edit strengths/issues/suggestions/quality/complexity/per-criterion scores+comments; scores validated against max (422), **totals recomputed server-side**; published = 409 |
| POST | `/ai-feedback/:id/publish` | atomic draft->published (double click = 409, one notice); **`notify()`** participant (title "Feedback published", link `/feedback`) + **`log_action`** `feedback.publish` |
| POST | `/ai-feedback/:id/unpublish`, DELETE `/ai-feedback/:id` | audited |
| GET | `/my-feedback`, `/my-feedback/:id` | any signed-in user, **own + published only** (draft/other user's = 404); response omits model, warnings, editor ids |
Audit actions: `feedback.rubric_create|update|delete`, `feedback.generate|create|edit|publish|unpublish|delete`.

**Migration** `2026-10-s13-feedback-collections-and-indexes` (`migrateFeedback`, appended to `MIGRATIONS`; boot or `npm run migrate`): creates both collections + indexes, repairs missing `status`/`generation.source`/`active`/`scopeKey`. Idempotent.

**Minimal UI**: `/feedback` (`pages/Feedback.tsx`, nav "Code feedback"): participants see their published feedback cards; organiser/judge see the AI status banner and a submissions table with Generate / Blank draft / Publish / Unpublish. No rubric screens and no draft editor yet (API only) = S14.

**Tests**: `tests/feedback-pure.test.ts` (no DB: totals, prompt contains only the given code + truncation + fence safety, parser fallbacks, backoff, retry/429/401/timeout/network — **run here via a shim under `tsc --strict`, 15/15 pass**); `tests/feedback.test.ts` (DB: rubric CRUD/permissions, disabled state, manual draft, edit validation + totals, participants see nothing until published, publish notifies once + audit, injected-model generation sends only the submission's own code, migration idempotence — **written, not run**).

**S13 notes / not done**
- Not compiled against the project toolchain or run against MongoDB/a real Anthropic key (no node_modules/network/MongoDB in the sandbox). Please run `npm install && npm run typecheck && npm run lint && npm test`, set `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`, then try Generate on `/feedback` (log in as `demo.organiser@festhub.test`).
- Not done (S14/out of scope): rubric UI, draft editor UI, auto-generate on submit, batch generate, e-mail beyond the standard notify copy, per-user rate limit on generate, seed data for rubrics/feedback, `docs/API_CONTRACT.md` entries, web tests. Judged contest `Submission`s are not covered (feedback attaches to S11 `CodeSubmission`).
- Generation is synchronous inside the request (up to timeout x retries); fine for single drafts, would need a queue for batches.

## 4n. S14 — AI feedback UI (done)

**Web** (backend untouched except the seed; all endpoints are the S13 ones)
- `/feedback/rubrics` (`pages/FeedbackRubrics.tsx`, **organiser/admin**; linked from `/feedback`): pick event or problem, list its rubrics, create/edit/delete. Criteria rows = name, description, max points (1–1000), weight (0–100), add/remove (max 20), active checkbox. Client checks mirror the server limits; server errors (e.g. 409 duplicate name) show as toasts. Deleting keeps existing feedback (snapshot).
- `/feedback/review/:id` (`pages/FeedbackReview.tsx`, organiser/judge; `:id` = CodeSubmission id): submitted code (read-only), **Generate AI feedback** button — disabled with a visible explanation (and tooltip) when `GET /ai-feedback/status` says disabled (no key/model), also disabled once published; "Write by hand" creates a blank draft. Editor: strengths/issues/suggestions (one per line), quality 1–10 + summary, complexity time/space/notes, per-criterion score (validated 0..max) + comment, **draft/published badge**, AI-draft chip with model, warnings (unreadable reply, truncated code, clamped scores), **Save draft**, **Save & publish** (saves, then publishes; notification + audit come from the S13 endpoint), **Unpublish**. Published feedback is read-only until unpublished. Total is recalculated by the server on save.
- `/feedback` (`pages/Feedback.tsx`): staff list now links each submission to the review page ("Start"/"Open") with a status badge; participants see their **published** feedback cards (badge, total, quality, complexity, strengths/issues/suggestions, per-criterion scores). Drafts never reach participants (S13 `/my-feedback` filter).
- Routes registered lazily in `App.tsx` with `Protected` roles; no nav item added (entry points: existing "Code feedback" nav item → list → review / rubrics).

**Seed** (`seed/feedback.ts`, called from `seedDemo()`, so `npm run seed` / `npm run seed:demo`; idempotent): rubric *Demo: Code quality* (Correctness 10 ×3, Readability 5 ×1, Efficiency 5 ×2) on *Demo: Hack-a-thon Warm-up* and ONE hand-written **draft** feedback on `demo.student3`'s prime-sieve submission (scores 9/4/5, total computed by `computeTotals`). It stays a draft so no key is needed and the participant view starts empty: log in as `demo.organiser@festhub.test` (Demo@12345) → `/feedback` → Open → **Save & publish**, then log in as `demo.student3@festhub.test` to see it.

**Tests**: added a seed test (idempotent, draft, one per student) to `tests/feedback.test.ts` (**written, not run**). No web unit tests.

**S14 notes / not done**
- Not compiled with the project toolchain or run in a browser/MongoDB (no node_modules/network/MongoDB in the sandbox): only syntax-checked with the TypeScript transpiler. Please run `npm install && npm run typecheck && npm run lint && npm test`, `npm run seed:demo`, and click through `/feedback`, `/feedback/review/<id>`, `/feedback/rubrics`.
- Not done: a nav entry for rubrics, bulk generate, auto-generate on submit, event/problem names in the staff list (shows date + language), viewing a submission's author name, a participant page that also shows their own code next to the feedback, regenerate-with-merge (regenerate overwrites the draft), web tests, `docs/API_CONTRACT.md` entries.

## 4o. S15 — Leaderboard (done)

**Pure scoring** (`packages/shared/src/leaderboard.ts`, exported from `@festhub/shared`; no DB/DOM): `computeLeaderboard(inputs, config)`, `scoreParticipant`, `validateLeaderboardConfig`, `withDefaults`, `DEFAULT_LEADERBOARD_CONFIG` (judge 70, AI 30, penalty 10 per confirmed pair, cap 50, tie-break `judge`).
- `base = judge% x wJ + ai% x wA`, weights **re-normalised over the scores a participant actually has** (a missing AI score is left out, not counted as 0; weights are relative, 7:3 = 70:30). `penalty = min(maxPenalty, confirmedPairs x penaltyPerPair)`; `final = clamp(base - penalty, 0, 100)`, 2 decimals. Participants with no score are listed last, unranked.
- **Ties**: equal finals are split by `tieBreak` (`judge` | `ai` | `none`); still equal = **shared rank, next rank skipped (1,2,2,4)**. Output order is deterministic (name, then key). Rows carry `tied` / `brokeTie` flags. Invalid config (weights outside 0..100, both 0, bad tie-break) throws `RangeError`.

**Server**: model `LeaderboardSetting` {eventId unique, judgeWeight, aiWeight, penaltyPerPair, maxPenalty, tieBreak, published} (migration `2026-10-s15-leaderboard-settings-index`). `services/leaderboard.ts` gathers inputs **on every request, nothing is stored**:
- judge = mean of each Entry's judge `Score.percent`, then mean over the participant's entries in the event; AI-suggested = mean `Feedback.total.percent` of their code submissions in the event (**draft or published, AI or manual** — the S13 feedback score is the "AI-suggested score"); plagiarism = `PlagiarismPair` of the event with status **`confirmed`** only ("suspicious" never counts). **Both people in a confirmed pair are penalised** (the engine cannot tell who copied; an organiser can set penalty 0, or re-mark the pair `clear`).
- A participant is a person (`u:<id>`) or a team (`t:<id>`) when they belong to a team that has an Entry in the event (members' feedback averaged; pairs counted once per team).
- Routes (`routes/leaderboard.ts`, mounted in `app.ts`, each authenticates itself): `GET /events/:id/leaderboard` (settings + rows with full breakdown + `canConfigure`), `GET /events/:id/leaderboard.csv` and `.pdf` (shared `sendCsv`/`sendPdf`), `PUT /events/:id/leaderboard/config` (organiser/admin; 422 on invalid; audit `leaderboard.config` with before/after). Staff (organiser, coordinator, judge, admin) always see it; other users get 404 until `published`, then see the same transparent breakdown.

**Web**: `/leaderboard` (`pages/Leaderboard.tsx`, nav "Leaderboard", `?event=`): event picker (defaults to first), plain-language formula line with the event's current weights, table Rank (tie / tie-break chips) · Participant (team/individual, entries) · Judge % (points, weight share, number of judge scores) · AI % (points, share, feedback count) · Base · Plagiarism (−penalty, number of confirmed pairs) · Final (+ bar); CSV and PDF buttons; organiser-only settings panel (weights with live %, penalty, cap, tie-break, "visible to participants"), client checks mirror the server.

**Judge scoring form**: already exists (`/judging`, S-v1: judge sees only assigned entries, per-criterion scores validated against the rubric, `PUT /entries/:id/score` enforces assignment) — **not changed**.

**Seed** (`seed/leaderboard.ts`, from `seedDemo()`; `npm run seed` / `seed:demo`; idempotent): activity "Demo: Hack-a-thon Warm-up - Final Round" + rubric, 6 students x 1 entry scored by `demo.judge` and new `demo.judge2`, flagged demo AI feedback drafts (`model: demo-seed`), the copied pair student1/student2 **confirmed**, renamed pair student3/student4 stays suspicious. Expected board (default settings): S3 91.67 (#1) · S4 and S6 80.75 (**tie, both #2**) · S5 79.67 (#4) · S1 76.17 (86.17 − 10) · S2 72.33 (82.33 − 10). Log in as `demo.organiser@festhub.test` (Demo@12345) → Leaderboard.

**Tests**: `tests/leaderboard-pure.test.ts` (10 cases: weights, missing-score re-normalisation, penalty + cap + floor, unscored last, judge/AI tie-break, shared ranks 1,2,2,4, input-order independence, clamping, config validation) — **the same logic was run here via a transpile shim, 10/10 pass**; `tests/leaderboard.test.ts` (DB: breakdown numbers, staff vs participant access, organiser-only config + 422, publish opens it, CSV/PDF) — **written, not run**.

**S15 notes / not done**
- Not compiled with the project toolchain or run against MongoDB/browser (no node_modules/network/MongoDB in the sandbox): only syntax-checked. Please run `npm install && npm run typecheck && npm run lint && npm test`, `npm run seed:demo`, and open `/leaderboard`.
- Not done: official/frozen leaderboard snapshot, per-activity (round) leaderboards, penalty per participant override, showing the pair partner, live socket updates, `docs/API_CONTRACT.md` entries, web tests. Contest (ICPC) `Submission` scoreboards are separate and untouched.

## 4p. S16 — Command center + My achievements (done)

**Server** (`routes/insights.ts`, mounted in `app.ts`, each route authenticates itself; read-only, nothing stored, no new models/migrations):
| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/command-center` | organiser/admin | `services/commandCenter.ts` `buildCommandCenter()`: registrations (total, by status, 14-day trend, confirmed per event), sponsors (count by status, pledged / received / outstanding from `SponsorPayment`, overdue payments), equipment (item types, units in use now / usable, utilisation %, low-stock list, pending requests), submissions (code submissions, competition entries, flagged + confirmed plagiarism pairs, submissions in a flagged pair, pending checks), certificates (valid, revoked, valid by type). `Cache-Control: no-store`. |
| GET | `/me/achievements` | any signed-in | `services/achievements.ts`: own VALID certificates, own PUBLISHED feedback only, and rank/score per event **only for events whose leaderboard is published** (S15 rule kept; uses `buildLeaderboard`, matches the user or their team) + summary counts. |
| GET | `/me/achievements/portfolio.pdf` | any signed-in | one table PDF (Section / Item / Details / Result) via shared `toPdf` with certificates, results and feedback; works with nothing earned (single "nothing yet" row). |

Definitions: **in use now** = checked out, or approved and inside its time window; **utilisation** = in use / usable (damaged + missing excluded, 0 when nothing usable); **low stock** = threshold > 0 and free <= threshold (same rule as the S9 warning); **flagged** = plagiarism pair `suspicious` or `confirmed`.

**Web**: `/command-center` (`pages/CommandCenter.tsx`): 5 panels (Registrations, Sponsors, Equipment, Submissions, Certificates) + a Results link panel, KPI numbers and dependency-free charts (`components/charts.tsx`: `BarList`, `Sparkline`, `ProgressBar`, inline SVG/CSS, dark-mode aware); polls every 15 s ("live"); each panel's button links to `/events`, `/sponsors`, `/equipment`, `/plagiarism`, `/certificates`, `/leaderboard`. `/achievements` (`pages/Achievements.tsx`): summary tiles, results cards (link to the leaderboard), certificates (PDF download via the existing `/certificates/:id/download`, Verify link), published feedback cards (link to `/feedback`), **Download portfolio PDF** button; friendly empty states.

**Nav** (`Layout.tsx` GROUPS, role-filtered): Command center (organiser/admin), My achievements (everyone), Leaderboard (everyone, S15), Feedback rubrics (organiser/admin; was reachable only from `/feedback` before), plus all earlier entries. Every page added in S5-S16 now has a nav link for the roles that may open it (`/verify` is public and `/feedback/review/:id`, `/sponsors/:id`, `/events/:id/...` are reached from their list pages).

**Tests**: `tests/command-center-pure.test.ts` (equipment in-use/utilisation/low-stock/caps, daily counts) — **same logic run here via a transpile shim, all checks pass**; `tests/insights.test.ts` (DB: organiser-only, KPI numbers, achievements show only own valid certificates and published feedback, rank appears only after the leaderboard is published, portfolio PDF + 401) — **written, not run**.

**S16 notes / not done**
- Not compiled with the project toolchain or run against MongoDB/browser (no node_modules/network/MongoDB in the sandbox): syntax-checked only. Please run `npm install && npm run typecheck && npm run lint && npm test`, `npm run seed:demo`, then open `/command-center` as `demo.organiser@festhub.test` and `/achievements` as `demo.participant@festhub.test` (certificates). To see results/feedback there: publish the Hack-a-thon leaderboard (Leaderboard -> "Visible to participants") and publish a feedback draft, then log in as `demo.student3@festhub.test`.
- Not done: per-event filter and date range on the command center, socket push instead of 15 s polling, drill-down from a chart bar, registrations by activity, portfolio with the participant's own code, shareable public portfolio link, web tests, `docs/API_CONTRACT.md` entries. No seed changes in S16 (existing demo data feeds the command center).

## 4q. S17A — Role-guard + nav review (done)

Reviewed every web route (`App.tsx`) against the server guards (`requireRole`) and the nav (`Layout.tsx` `GROUPS`). Admin satisfies every `organiser` check (`roleSatisfies`), so admin pages/links work for Admin and Organizer alike, as on the server.

**Fixes**
- Sponsor-only accounts could open participant pages (`/checkin`, `/submit-code`, `/feedback`, `/contests`, `/contests/:id`, `/problems`, `/problems/:id`, `/progress`): now wrapped in `<Protected roles={NON_SPONSOR}>` in `App.tsx` (`NON_SPONSOR` = every role except sponsor).
- Nav: the same six links are hidden from sponsor-only users (`Layout.tsx`); the Dashboard "My QR pass" button is hidden for them too. Sponsors now see: Dashboard, Events, My achievements, Certificates, My sponsorship, Leaderboard.

**Checked, no change needed**: organiser-only pages (events/new, edit, command-center, feedback/rubrics, admin/users, admin/audit), organiser+coordinator (manage event, sponsors, equipment), volunteer desk, judge-only `/judging`, organiser+judge (plagiarism, feedback review, setter), sponsor-only `/my-sponsorship`. Every nav link and in-page `Link` target resolves to a route; role-gated buttons (Create event, Rubrics) are gated like their routes. Web guards match or are stricter than the API.

**Not done / notes**: no node_modules or network here, so only the edited files were syntax-checked (TypeScript transpile, OK); the app was not started. Run `npm install && npm run typecheck && npm run dev` to confirm. Dashboard panels for sponsor-only accounts were not reviewed.

## 4r. S17B — Dark mode, mobile, list states (done)

**Dark mode** (`index.css`, appended block): added remaps for utilities that pages use but the S4 block missed: `bg-slate-200/300`, `bg-orange/violet-50/100`, `bg-red-50/80`, `hover:bg-slate-100`, `hover:bg-white/90`, `focus:bg-white`, `border-red/amber/green/emerald/brand-200..300`, text `red-500/800/900`, `rose-600`, `amber-600/900`, `orange-700/800`, `emerald-600/900`, `green-600/900`, `blue/sky-800`, `violet-700/800`, `slate-300`; table header/row separators and `hr`. (Fixes dark-on-dark alert/chip text and light progress tracks/boxes.)

**Mobile**: global `overflow-x: hidden` on html/body, `pre` scrolls inside itself, long code wraps; smaller table font/cell padding under 640 px; `.btn-sm` min height 36 px; new `.table-scroll` helper. The one table without a scroll wrapper (feedback criterion table in `Feedback.tsx`) is now wrapped; staff submissions table has a min width and scrolls. 28 `flex ... justify-between` rows (lists with action buttons, headers) got `flex-wrap` (+`gap-2` where missing) so buttons no longer overlap on narrow screens.

**List states** (loading skeleton / error box / empty state): `Feedback.tsx` (staff list + "mine"), `FeedbackRubrics.tsx`, `FeedbackReview.tsx` (feedback + code errors), `AdminUsers.tsx` (empty search), `EntryPanel.tsx` (loading/error). All other pages already had loading, error and empty handling (audited by script + read; `Query`, `SkeletonList`, `ErrorBox`, `EmptyState` from `ui.tsx`).

**Notes**: no node_modules/network/browser here: changed files were only syntax-checked (TypeScript transpile OK), nothing was viewed in a browser at 375 px or in dark mode. Please spot-check `/events/:id/manage`, `/certificates`, `/equipment`, `/leaderboard` on a phone width and in dark mode, then `npm run typecheck && npm run lint`. The blanket `flex-wrap` change may slightly alter a few headers on desktop only if content is too wide.

## 4s. S17C — Core algorithm tests (done)

**New suite** `apps/server/src/tests/s17c-core.test.ts` (31 tests, pure: no MongoDB, no network, no real AI calls):
- **Plagiarism engine**: identical ≈ 100 %, renamed variables ≥ 80 %, different program < 35 %, comments/whitespace ignored ≥ 95 %, symmetric.
- **Equipment conflicts**: overlap over stock rejected (names clashing booking), overlap within stock OK, more than total rejected, back-to-back allowed (both sides), 1 h overlap rejected, rejected/returned bookings hold no stock.
- **Certificate ID / verification**: valid, revoked, not found, typo/bad checksum/junk -> not found, lower-case/spaces accepted.
- **Leaderboard math**: 70/30 default, penalty 10/pair capped at 50, floor 0, missing AI score left out, shared ranks 1,2,2,4, judge / AI / none tie-breaks, unscored last, invalid config throws.
- **AI prompt builder / parser**: prompt content + untrusted-data wording, truncation marker, parse clean / fenced / prose-wrapped replies, clamping + warnings, garbage never throws, **mocked `fetch`** (retry on 500 then success, no key = DISABLED, 401 not retried), backoff.

**Code change (tiny, for testability)**: new pure `verificationVerdict(rawId, found)` in `packages/shared/src/certificates.ts`; `GET /verify/:id` now uses it (same behaviour: unknown/malformed = `not_found`, non-valid = `revoked`).

**Run once**: vitest is not installed in the sandbox, so the suite was bundled with esbuild against a tiny vitest-compatible shim (`scripts/pure-test-shim/`): **31/31 passed**. The first run had 4 failures that were test bugs (wrong field `.percent` instead of `.similarity`; two badly designed leaderboard tie cases) - fixed in the tests; no engine code needed fixing.

**How to run tests**
```
npm install
npm test                                   # everything (DB tests need MongoDB: TEST_MONGODB_URI)
npm test -w apps/server -- s17c-core       # just this suite, no DB needed
```
(Other pure suites: `*-pure.test.ts`.) Not run with the real vitest/MongoDB here, and the web app has no new tests.

## 4t. S17D — README + CHANGELOG (done)

Docs only, no code changes. Root `README.md` rewritten: feature list, exact setup commands (install, migrate, seed, run, tests, Docker), `.env.example` explained (incl. `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` and `SMTP_*`), demo credentials for every role (`demo.<role>@festhub.test` / `Demo@12345`, classic seed `Password123`), a short how-to per feature, an **Innovation** section (8 one-liners), docs index and honest known limitations. `CHANGELOG.md` finalised with a 2.0.0 entry (S2–S17) and a verification-status note. The team table, demo video link, screenshots and team-contribution placeholders are still for the team to fill in. `docs/API_CONTRACT.md` was **not** updated with the S2–S16 endpoints (they are documented per stage in this file).

## 4v. v5 step A — pdfkit certificate renderer, plain content (done, partly verified)

**Scope:** `services/certLayout.ts` (new), `services/certificatePdf.ts` (additive), `apps/server/package.json` (+`pdfkit` `^0.15.0`, +`@types/pdfkit` dev), `tests/cert-layout.test.ts` (new). Route, web, models, templates: untouched.

- **Layout engine** (`certLayout.ts`): A4 landscape 842 x 595, 36 pt safe margin, y grows downward. Fixed zones (height budget in pt): header 56, title 62, recipient 84, body 110, members 60, signatures 105, footer 46 (= 523). `fitText` = shrink in 0.5 pt steps to a 9 pt minimum -> word wrap (largest size that fits the zone height) -> ellipsis (`...`) on the last line. Measures through `doc.widthOfString` / `doc.heightOfString` (any object with `font/fontSize/widthOfString/heightOfString`). `placeInZone` returns the real text bounding box; `assertNoOverlap(boxes)` throws if two boxes intersect (touching is fine) or a box leaves the safe margin.
- **Renderer** (`certificatePdf.ts`): `CertificatePdfInput` extended with `teamName?`, `members?`, `venue?`, `signatories?: {name,title,imageBuf?}[]`, `logoBuf?`. New `renderCertificateKit(input) -> Promise<{bytes, boxes, pages}>` and `renderCertificatePdfKit(input) -> Promise<Uint8Array>`. Standard fonts only (Times / Helvetica), one page, PLAIN: border, org line, title, recipient (or team name), position, event, date + venue, up to 3 signatories (optional signature images), team member names line, footer certificate ID + verify URL. Revoked = faint red REVOKED stamp. Layout is computed and checked with `assertNoOverlap` BEFORE anything is drawn. pdfkit is loaded lazily (`await import('pdfkit')`).
- **IMPORTANT decision:** pdfkit is asynchronous, while the existing `renderCertificatePdf(input): Uint8Array` is synchronous and used by `routes/certificates.ts` and 2 existing test files (they assert PDF-1.4 text/xref). To break nothing, **`renderCertificatePdf` is unchanged (legacy dependency-free renderer; it accepts the new input fields but ignores them)**. The pdfkit renderer is the new Promise-returning entry. Switching the download route to it (`await renderCertificatePdfKit(...)`, passing `teamName`, `members`, `venue`, `signatories`, `logoBuf`) is a one-line follow-up.
- **Not done on purpose:** themes, seal, QR, member grid, decoration; the route is not switched.
- **Verified here:** layout engine (shrink/wrap/ellipsis/overlap, full zone set with a long name and long event title) run with `tsx` against a fake measurer: passes; all new/changed TS files transpile without syntax errors.
- **NOT verified (no network, no node_modules in the sandbox):** `npm install` (so `package-lock.json` is NOT updated: run `npm install` once), pdfkit itself, tsc, ESLint, the vitest run. `tests/cert-layout.test.ts` (2 pure tests with a fake measurer + 3 pdfkit renders: normal name, very long name, team of 3; each asserts 1 page and no overlap) has therefore never been executed against real pdfkit. Run `npm install && npm run typecheck && npm test`. If `@types/pdfkit` complains about `doc.widthOfString`/`bufferedPageRange` typings, adjust the cast in `renderCertificateKit`.

## 4w. v5 step B — certificate decoration (done, partly verified)

**Scope:** only `services/certificatePdf.ts` (+ tests added to `tests/cert-layout.test.ts`). `certLayout.ts`, zones, route, web, models: untouched. The legacy synchronous `renderCertificatePdf` is still unchanged.

- **Decoration** (`drawDecoration`, runs before any text; vector only, solid light tints, no transparency): fine vertical-stripe pattern + 24-petal rosette watermark clipped to the inner frame; gradient bands (primary -> accent -> primary) in the top (y 33-40) and bottom (y 554-561) gutters; nested right-triangle stripes in both bottom corners (below y 505, clear of signatures); three layered frames (5 pt primary, 1.6 pt accent, 0.6 pt primary); four corner ornaments (ring, diamond, arc, edge arrows; all within 45 pt of the corner); flourish line + diamond under the title. Revoked stamp is now an outlined red word (no transparency).
- **Look copied from the reference:** light vertical pinstripes, bold serif title, coloured recipient, diagonal corner stripes at the bottom. The reference's logos, signatures, QR/seal are NOT done (later steps).
- **Text:** zones and boxes unchanged; only colours changed (recipient and org line = primary, position label = darkened accent, title = ink, rest = muted) and the title size request went 32 -> 40 pt (still fitted by the engine, so it shrinks if needed). No text below 9 pt.
- **Themes:** `CERT_THEMES` = royal (#1e3a8a / #c9a227, Royal Blue & Gold), emerald (#065f46 / #c9a227), sunset (#c2410c / #e8890c), violet (#5b21b6 / #c026d3). `resolveCertPalette(brand)`: `brand.theme` wins; else a primaryColor+accentColor pair equal to a preset selects it (so a template can store a theme as its two hex colours); else the custom hex colours are used as they are, with tints derived (missing/invalid -> royal values). The template default (#4f46e5 / #d94c33) therefore renders as a "custom" indigo/coral look. No template/model/UI change: there is no theme picker yet.
- **Verified here:** the whole renderer, every theme, custom colours and the revoked path run to completion against a stub pdfkit (no exceptions, 1 page, `assertNoOverlap` passes); palette mapping checked. **NOT verified:** real pdfkit output, how it looks (no PDF was rendered or viewed), `tsc`, ESLint, vitest. Please run `npm install && npm run typecheck && npm test`, then render each theme and look at it (expect to tune stripe/triangle sizes).

## 4x. v5 step C — seal, logo, signatories, QR footer, revoked watermark (done, partly verified)

**Scope:** `services/certificatePdf.ts` (pdfkit renderer only), `services/certLayout.ts` (zone height budget only), tests appended to `tests/cert-layout.test.ts`. Legacy sync `renderCertificatePdf`, route, web, models untouched; the route still does not use the pdfkit renderer.

- **Zone budget** (sum still 523): header 56, title 62, recipient 84, body 110, **members 52 (was 60), signatures 98 (was 105), footer 61 (was 46)** to make room for the QR.
- **Seal** (`drawSeal`, box `seal`, 48 x 50 pt, top right of the header, mirrors the logo): gold = winner, silver = runner-up, brand primary (accent ribbon) = participation / volunteer / organizer. Scalloped medal, inner ring, star, two ribbon tails. Vector.
- **Logo** (`logoBuf`): fixed 120 x 44 box top left, fitted with `doc.image(..., {fit})`; skipped when missing or when pdfkit cannot read the image.
- **Signatories:** up to 3, empty ones (no name, title or image) are skipped, the rest are evenly spaced and centred; image box 120 x 40, rule, name (11 pt bold), title (9.5 pt, max 2 lines). With none given: the old single default signature line.
- **Footer:** vector QR (`qrMatrix`, existing shared generator, 2-module quiet zone on a white 50 pt plate; skipped if the URL is too long for the generator) + `Certificate ID: ...` + `Verify at <url>` (9 pt, wraps to 2 lines, never ellipsised unless extreme); the group is centred and sits clear of the bottom corner stripes.
- **Revoked:** outlined red diagonal REVOKED, centred with the measured text width (not transparent).
- **Tests added** (`cert-layout.test.ts`, each asserts 1 page + `assertNoOverlap`): winner with logo + 3 signatories, runner-up without logo/signatories, participation/volunteer/organizer, empty signatory skipped, revoked, long verify URL.
- **Verified here:** the full renderer ran against a stub pdfkit for winner, runner-up, participation team, empty signatory, revoked, long URL, URL too long for QR, and extreme-length text: 1 page, no overlap, expected boxes present; all changed files transpile. **NOT verified:** real pdfkit, whether the QR actually scans (module size is about 1.2-1.4 pt, check a printed copy), how seal/ribbon look, `tsc`, ESLint, vitest. Run `npm install && npm run typecheck && npm test` and open each PDF.
- **Still to do:** switch `routes/certificates.ts` to `await renderCertificatePdfKit(...)` (pass teamName, members, venue, signatories, logoBuf, brand/theme), theme picker in the template UI, member grid.

## 4y. v5 step D — team certificate member grid (done, partly verified)

**Scope:** `services/certLayout.ts`, `services/certificatePdf.ts` (pdfkit renderer only), tests appended to `tests/cert-layout.test.ts`, `docs/samples/`, `scripts/` helpers. Legacy `renderCertificatePdf`, route, web, models: untouched. **Individual certificates are unchanged** (same zones, same code path; a test checks they get no grid).

- **Team layout** (`TEAM_ZONES`, used only when `teamName` is set): recipient 78, body 92, **members 76** (was 52), same 523 total, so **signatures (y 400) and footer (y 498) sit exactly where they do on individual certificates**. Team name stays large (38 pt Times-Bold, up to 2 lines); the body stacks under the real event-title height (title gets 35 pt when a position line follows).
- **Member block**: "Team members" label + `layoutMemberGrid()` (pure, in `certLayout.ts`): ALL names, leader first (row-major, leader top-left), 1-4 columns: 1-3 names -> 1, 4-8 -> 2, 9-14 -> 3, 15-20 -> 4 as the preferred start. It picks the largest font (12 -> 9 pt, 0.5 steps) that fits the zone with no cut name, adding columns when needed; if names still do not fit it cuts them with `...` at 9 pt using the fewest columns. Grid height is capped at the members zone, so it can never touch the signature zone. Above 20 names the last cell says `+N more` (never happens within the 20-member limit). Result also exposes `grid {cols, rows, size, bottom, ellipsised, hidden, limit}` and one box per member (`member0..`) for `assertNoOverlap`.
- **Tests** (`cert-layout.test.ts`, +11): pure grid tests with the fake measurer (counts 1..20 list all names in order, font shrinks / columns grow, very long names stay >= 9 pt and above the signature zone, > 20 names), and pdfkit renders of teams of **2, 6, 12, 20**, a team of 20 with very long member names + long team name + long event title, and a team of 20 with position/logo/3 signatories/revoked: each asserts `pages == 1`, `assertNoOverlap`, grid bottom <= signature zone top, member boxes above / signature boxes below that line.
- **Verified here:** full `cert-layout.test.ts` = **26/26 passing** via the offline runner (`scripts/run-cert-tests.ts`: vitest shim + `scripts/pdfkit-stub`); generated PDFs pass `qpdf --check`, `pdfinfo` = 1 page; `pdftoppm` was available, team-of-6 and team-of-20 were converted to PNG and looked at (grid centred, 4 columns x 5 rows at 9 pt for 20, clear of signatures and QR). The vitest shim got `it.each`, `toHaveLength`, `toBeLessThanOrEqual`, `toBeDefined`, `toBeUndefined`, regex `toThrow`, `arrayContaining`.
- **NOT verified:** real pdfkit (not installable offline) - **`docs/samples/*.pdf` come from the stub** (solid instead of gradient bands, no images), so look again after `npm install`; real vitest, `tsc`, ESLint; `package-lock.json` still lacks pdfkit. The real `heightOfString` may differ slightly from the stub's 1.155 em (grid has about 2 pt of slack at 20 members / 9 pt).
- **Still to do:** switch `routes/certificates.ts` download to `renderCertificatePdfKit` (pass `teamName`, `members` from `Certificate.recipients`, leader first, `venue`, `signatories`, `logoBuf`, brand/theme), theme picker, Bangla/Unicode fonts.
- Run offline: `npx tsx --tsconfig scripts/samples.tsconfig.json scripts/run-cert-tests.ts` and `.../samples.ts` (see `docs/samples/README.md`).

## 4z. v6 — certificate template customisation (done, partly verified)

**Scope:** only the template: `CertificateTemplate` model, `services/certTemplate.ts`, the template part of `routes/certificates.ts`, the pdfkit renderer options, `components/CertTemplateEditor.tsx` (replaces the template block of `pages/Certificates.tsx`), one migration. Issuing, eligibility, verify, slot keys, the legacy `renderCertificatePdf`: untouched.

**Model / API (one template per event, backward compatible)**
- New optional fields: `theme` (royal|emerald|sunset|violet|custom), `logo2Url`, `signatories[3] {name,title,imageUrl}`, `sealEnabled`, `borderStyle` (classic|modern|minimal), `fontStyle` (serif|sans), `headlines` (per certificate type, '' = default), `bodyText` (placeholders `{name} {team} {members} {event} {position} {date} {venue}`), `customFields` (up to 4 label+value). Old documents lack them and read as defaults (`templateView()`); the legacy `signatureName/Title/ImageUrl` still work and mirror signatory 1 (both in responses and in the legacy PUT body).
- Migration `2026-10-v6-certificate-template-options` (`migrateCertTemplatesV6`): copies the legacy signatory into `signatories[0]` and writes the new defaults; only rows without `signatories`, so re-running changes nothing. Not required for correctness (reads fall back).
- Endpoints (organiser for writes, organiser/coordinator for GET): `GET|PUT|DELETE /events/:id/certificate-template` (DELETE = reset: removes the document and every image file), `POST|DELETE .../logo | logo2 | signatory-1..3` (`signature` = signatory-1, kept), **`POST .../preview`** body `{sample: individual|team3|team8|winner, template?: <same shape as PUT, unsaved edits>}` -> `application/pdf` (inline, no-store, rate limited, nothing saved).
- **Download now uses the pdfkit renderer** (`renderCertificatePdfKit`) with the template, team name + members (leader first), venue and all options; if it ever throws it falls back to the legacy renderer (logged). Contest certificates (no event) use the default template (before, `getTemplate('undefined')` would have been queried).

**Limits (server-side, `packages/shared/src/certTemplate.ts`, also used for `maxLength` in the UI):** signatory name 40, title 80, 3 signatories; headline 50; body text 280 (rendered text capped at 600); custom field label 24 + value 48, max 4 and 150 characters in total; colours `#rrggbb`; enums strict; unknown `{placeholders}` are rejected; control characters/newlines are stripped; unknown body keys are ignored. Uploads unchanged: JPG/PNG only, magic bytes, 2 MB, random names. Everything also passes through the layout engine (shrink -> wrap -> ellipsis) and `assertNoOverlap` BEFORE drawing, so even legacy/over-long stored values cannot overlap.

**Renderer:** theme via `brand.theme`/colours; border = classic (unchanged v5 look) / modern (bold frame, bands, corner stripes) / minimal (one hairline frame); font = Times or Helvetica; seal on/off; second logo top right (header text keeps clear of it); up to 3 signatories (existing); headline override per type; custom body replaces the phrase/event/position/date block; custom fields: individual = one column each in the free members zone, **team = two compact lines at the bottom of the header** (the members zone is needed for the grid).

**UI** (`CertTemplateEditor`, event manager page): theme chips + custom colours, border/font segmented controls, seal toggle, 2 logo slots, 3 signatory cards (image, name, title with counters), 5 headline inputs, body textarea + placeholder buttons, custom fields (add/remove, total counter), Save (disabled when unchanged/invalid), **Reset to default** (confirm), unsaved-changes hint. **Live preview** = real PDF from the preview endpoint (blob URL in `<object>` with `<iframe>` fallback, debounced 450 ms, stale responses ignored, errors shown inline), sample switch Individual / Team of 3 / Team of 8 / Winner, "Open full size" link. Mobile: Edit/Preview tabs under `lg`, side by side from `lg`; dark mode through the existing `.card/.input/.btn` remaps. Read-only for coordinators (no preview).

**Tests**
- `tests/cert-template-v6.test.ts` (21, pure, **real pdfkit**): every limit at/over by one, counts, enums, colours, unknown placeholders, half-filled fields, control chars, `templateView` for old documents + clipping, `mergeTemplateInput`; placeholder replacement (all tokens, repeats, empty values, no re-expansion, cap); renders with ALL options on for individual / team 3 / team 8 / winner / team 20 (1 page, `assertNoOverlap`, inside the page, expected boxes), all theme x border x font combinations, seal off, headline override, worst-case (limit-length wide glyphs, all 5 types, 3 borders), defaults.
- `tests/cert-template-v6-api.test.ts` (DB: round trip, limits -> 400, legacy body, uploads incl. fake PNG, preview for the 4 samples, reset, migration idempotency): **written, NOT run (no MongoDB here)**.
- Run here: `cert-layout` 26, `cert-template-v6` 21, `certificates-pure` 6, `certificates-v4-pure` 21, `s17c-core` 31 = **105 passed** with real vitest 2.1.9 and real pdfkit (`npm install` worked in this session, `package-lock.json` now includes pdfkit). Web `tsc` clean, `vite build` OK, server esbuild OK, ESLint clean on every touched file (1 pre-existing error in `services/aiFeedback/prompt.ts`), `tsc` on the server shows only the pre-existing mongoose typing errors.
- Looked at rendered PNGs (classic/serif individual, modern/sans winner, minimal team of 3, custom-body team of 8): clean. `docs/samples/v6/` = real-pdfkit samples (`scripts/cert-template-samples.ts`).

**NOT verified:** the editor in a real browser (no browser here: layout at 375 px, dark mode, how each browser shows a PDF in `<object>`; Android Chrome usually cannot embed PDFs, hence the "Open full size" link), every DB-backed test (S6/v4/v6 API tests), real image embedding of logos/signatures through the new route (tests embed a 1x1 PNG only), Bangla/Unicode text (standard fonts: non-Latin characters print as `?`, noted in the UI).
**Not done (on purpose):** per-certificate overrides, org name ("PUB FestHub" header is still fixed text), template copy between events, custom fonts.

## 4aa. v7 — premium Leaderboard / Achievements / Certificates / Verify + branded PDFs (done, partly verified)

**Scope:** web `pages/Leaderboard.tsx`, `pages/Achievements.tsx`, `pages/Certificates.tsx` (only the "My certificates" block), `pages/Verify.tsx`; new `components/CertificateCard.tsx`, `lib/certView.ts`; server `routes/leaderboard.ts` (rows + PDF), `routes/insights.ts` (portfolio PDF), `services/achievements.ts` (additive fields), new `services/brandedPdf.ts` and `services/leaderboardView.ts`. Untouched: scoring, models, certificate issuing/rendering/templates, other exports, the manager part of Certificates.tsx, CSV.

**Server**
- `brandedPdf.ts` (pdfkit, Helvetica, theme colours brand `#223d9c` / ink / gold): `renderTablePdf` (branded gradient header with event name, optional note, gradient table header repeated on every page, per-cell wrapping with measured row heights so nothing is cut, rank badges, bars, "Page n of N") and `renderPortfolioPdf` (A4 portrait, summary tiles, certificate / result / feedback cards, page-break aware). Standard fonts: non-Latin characters print as `?` (as in the certificates).
- `leaderboardView.ts` `enrichLeaderboardRows`: adds `members` (team members, leader first), `isMine` (own person row or own team) and `certificate` (best VALID certificate of the row; staff = organiser/coordinator/admin get it for every row, everyone else only for their own row, matching who may call `GET /certificates/:id/download`; judges therefore see no button for others).
- `GET /events/:id/leaderboard` returns the enriched rows (all old fields kept). `.pdf` uses `renderTablePdf` (A4 landscape); `.csv` unchanged.
- `GET /me/achievements`: certificates also carry `kind, recipientName, teamName, members`. `GET /me/achievements/portfolio.pdf` uses `renderPortfolioPdf`, file name `FestHub-Portfolio-<name>.pdf`.

**Web**
- `CertificateCard` (+ `CertPreviewModal`): gradient by position (gold / silver / bronze / brand), team name + member chips (first 6, "+N more"), badge, event, date, ID, Valid/Revoked chip. Preview fetches the real PDF from `/certificates/:id/download` into a modal (Esc / backdrop / X, loading, error + retry, "Open full size" for browsers that cannot embed PDFs); Download saves as `FestHub-Certificate-<event>-<name>.pdf` (client-side name; the server header name is unchanged). Revoked cards show no Preview/Download.
- Leaderboard: podium (ties stack in one place, missing places left out, stacked 1-2-3 on phones), medal badges, team members under the team name, breakdown table (desktop) / cards (phones), per-row Certificate button, busy states on CSV/PDF, error box for the event list.
- Achievements: summary tiles, certificate cards, rank cards (medal colours), published feedback cards, portfolio button with busy state; empty states for all three sections.
- Verify: gradient status hero, team name + all members (leader tagged), dark mode, skeleton while loading, retry on error.

**Tests run here (real vitest 2.1.9 + real pdfkit):** `branded-pdf-v7` 4, `cert-layout` 26, `cert-template-v6` 21, `certificates-pure` 6, `certificates-v4-pure` 21, `s17c-core` 31 = **109 passed**; web `certView.test.ts` 2 passed. `tsc` (web) clean, ESLint clean on all touched files, `vite build` OK, server `tsc` shows no errors in touched files (only the pre-existing mongoose typing errors elsewhere). Rendered sample PDFs (20-row leaderboard over 2 pages, 9-certificate portfolio over 2 pages, empty portfolio) were converted to PNG and looked at: no overlaps or cut text.

**NOT verified:** no MongoDB and no browser here. Not run: `enrichLeaderboardRows` and the changed routes against a real DB (existing `leaderboard.test.ts` / `insights.test.ts` only check status + `%PDF`, which still hold by design), the certificate-button visibility rules end to end, the pages at 375 px / in dark mode / in each browser's PDF embed (Android Chrome usually cannot embed: "Open full size" is the fallback). No new DB test was written for the enrichment.
**Not done:** a public portfolio link, live leaderboard updates, Bangla/Unicode text in the new PDFs.

## 5. Notes for later stages
- Add new Mongoose models to `models/index.ts` (single-file convention) and sync indexes; add start-up migrations in `services/migrations.ts`.
- New routers: create in `routes/`, mount in `app.ts` (mind the public-vs-`requireAuth` ordering comment).
- Reuse `logAction()` (alias `log_action`; legacy `audit()` still works) and `notify()`; reuse `ui.tsx` components and `.btn/.card/.input` classes; register pages lazily in `App.tsx` and nav in `Layout.tsx` `GROUPS`.
- Dark mode (S4, done): new pages should use the shared classes (`.card`, `.input`, `.btn*`) and common slate/white utilities — they are remapped under `.dark` in `index.css`. For new custom colours add a `dark:` variant.
- Certificates (S5, done): issue via `issueCertificate()` / `bulkGenerate()`; PDF via `renderCertificatePdf()`; verification via `verifyCertificateId()` + `GET /verify/:id`. Sponsors (S7) could reuse the PDF/QR code (`qrMatrix`).
- Exports (S4, done): use `sendCsv`/`sendPdf` (server `utils/exporters.ts`) or `downloadCsv`/`downloadPdf` (web `lib/exporters.ts`); S5 certificates can reuse `toPdf` or extend it.
- AI feedback (S13/S14) needs a new dep or plain `fetch` (e.g. @anthropic-ai/sdk) — none installed yet. E-mail (S3) needs no dependency.
- Known limitations carried over: see `PROJECT_HANDOFF.md` (Judge0 not verified live, tests ran on FerretDB, UI not browser-tested, global roles, in-process judge queue, no pagination).

## 6. Real venues update (done, not run)

- `seed/seed.ts`, `seed/demo.ts`: venues are Main Auditorium (300), Room NB-408 (60), Room NB-407 (60), building "NB Building". No "Demo Hall" / "Computer Lab 1" / "Seminar Room 2" remains in code, tests or docs except as the old names inside the migration's rename table. `Demo:` event titles untouched.
- `services/migrations.ts`: `migrateRealVenues` (run-once entry `2026-10-real-venues-rename`, also safe to re-run) — rename in place, or repoint events/activities + delete the old venue when the target exists.
- `web/src/pages/EventForm.tsx`: dropdown label "name (capacity N)"; inline add-venue (name + optional capacity).
- Not verified: no install/tsc/vitest/browser run in this session (no node_modules). Please run `npm run build` / `npm test` and `npm run migrate` on an existing DB. ManageEvent's venue dropdown still shows names only.

## 7. Team invitations v2 (done, partly verified)

- **Server:** pure rules in `services/invite-rules.ts` (expiry, `checkInvite`, `checkAnswer`, `planAttach`, `canResend`, slot keys); DB/mail helpers in `services/invites.ts` (`sendInviteEmail`, `attachEmailInvites`, `liveInviteFilter`, `inviteLink`); routes in `routes/registrations.ts` (send, list, resend, cancel, `/me/invitations`, accept, reject); `routes/auth.ts` calls `attachEmailInvites` after register and login (never throws).
- **Model/migration:** `Invitation` fields + sparse-unique `slotKey` (`<teamId>:u:<userId>` or `<teamId>:e:<email>`, same pattern as `Certificate.slotKey`, no partial indexes so FerretDB is fine). Migration `2026-10-team-invitations-v2` (run `npm run migrate` or just restart).
- **Web:** `pages/Events.tsx` (invitee banner, leader pending list with Resend / Cancel / Copy link, `?invite=` redirect on the list page), `components/Protected.tsx` keeps the query string in the post-login redirect.
- **Verified:** the 13 pure tests pass with the vitest shim; changed files have no syntax errors.
- **NOT verified:** no `npm install`, full type-check, real vitest/Mongo run, SMTP delivery or browser test in this session. The existing `api.test.ts` team test (403 non-leader, 404 not your invite, 422 full, 409 already in team) was kept compatible by design, but run `npm test` and `npm run build` first.
- **Notes:** the invite link only works for the invited e-mail/account. An e-mail-only invite is attached at register/login (or on first accept click). Resend after expiry renews it; re-inviting a declined/cancelled person reuses the same row. Not done: a link-only "open" invite (no e-mail), docs/API_CONTRACT.md entries for the new endpoints.

## 8. Contest team invitations (done, partly verified)

- **Server:** model `ContestTeamInvitation` (`models/index.ts`, `slotKey` unique per team + invitee like event invitations); pure rules `services/contest-invite-rules.ts` (re-exports the shared expiry / answer / attach / cooldown helpers from `invite-rules.ts`, adds `checkContestInvite`); DB + mail helpers `services/contest-invites.ts` (limiter, `sendContestInviteEmail`, `attachContestInvites`, expiry sweep); routes in `routes/contests.ts` (after the join route); `routes/auth.ts` attaches contest invites after register / login; `services/cascade.ts` cleans up. No migration needed (new collection).
- **Web:** `pages/Contests.tsx` `TeamPanel`: "Invite teammates" box (e-mail, Send invite, Copy invite link), pending list with Resend / Cancel, invitee banner with Accept / Decline, `?join=CODE` pre-fills the join box, `?join` / `?invite` open the team tab.
- **Expiry:** pending invites past 14 days are flipped to `expired` lazily (leader list, invitee list, answer attempt); Resend revives them.
- **Verified:** 7 pure tests pass with the vitest shim; changed files have no syntax errors.
- **NOT verified:** no `npm install`, full type-check, real vitest/Mongo run, SMTP delivery or browser test here. No API (DB) tests were added for the new endpoints. Run `npm run build` and `npm test` first.
- **Notes:** invitations are allowed until the contest ends (same as the join code); removing members stays locked once the contest starts. The invite link with the join code works for anyone who has it (like the code itself); the e-mail link only works for the invited address. Not done: docs/API_CONTRACT.md entries.

## 4u. v4 step A — team + contest certificates (data/backend only, done)

**Scope:** `packages/shared/src/certificates.ts`, `models/index.ts` (Certificate), `services/certificates.ts`, `routes/certificates.ts`, `services/migrations.ts`, `services/achievements.ts` (one query), `seed/demo.ts`. PDF design and web UI untouched.

**Model** `Certificate` additions: `kind` ('individual'|'team', default individual), `teamId`, `teamName`, `contestId`, `recipients[{userId,name}]` (snapshot, leader first; one entry for individuals). `eventId` now optional (contest without event). Team cert: `userId` = leader, `recipientName` = team name. Extra indexes `recipients.userId`, `{contestId,type}`.

**Slot keys** (`certificateSlotKey`, pure): individual event `<event>:<user>:<type>:<activity>` (unchanged), team event `<event>:t:<team>:<type>:<activity>`, contest `c:<contest>:u|t:<id>:<type>`. Revoke -> `x:<certId>` (unchanged).

**Eligibility** (`subjectsFor`, `contestSubjectsFor`): event participation / winner / runner-up are team-aware (`Registration.teamId`, Result `ownerKey` `t:`); with attendedOnly a team counts as present if ANY member checked in; the snapshot still lists ALL members. Winner/runner-up come from official `Result` rankings (unchanged rule) with label `"<ordinal> Place - <activity title>"`. Contest: participation from `ContestRegistration` (TEAM mode grouped by team), winner/runner-up from `buildScoreboard(privileged)` rank 1/2 via `pickPlacings` (0-solved rows get nothing; a tie for 1st leaves no 2nd). Contest bulk requires the contest to have ended (422). Types allowed for contests: participation, winner, runner_up.

**API**: `GET /certificates/mine` (userId OR member), download allowed for any member, `GET /verify/:id` via pure `buildVerification` (adds `kind, teamName, members, contestTitle`), `GET /contests/:id/certificates`, `POST /contests/:id/certificates/generate`, event list search/`kind` filter, CSV Team/Members. `notify()` goes to EVERY member on issue / revoke / reissue; `logAction` kept (`certificate.bulk_generate` now also for `Contest`). Reissue of a team cert keeps the original snapshot.

**Migration** `migrateCertificatesV4` (`2026-10-v4-certificates-kind-team-contest`): `kind='individual'` + one-person `recipients` where missing; never touches `slotKey`. Old per-member participation certificates of team events stay as they are (no auto-merge); re-running bulk on such an event would add the team certificate next to them.

**Seed** (`seedTeamAndContestCertificates`): "Demo Team Alpha" participation (3 members: demo.student1-3), "Demo Team Bravo" runner-up (5 members: demo.student1-5), existing individual winner (demo.participant), contest runner-up for demo.student2 in a finished "Demo: CodeStorm Mini Contest". Demo teams are snapshots (fixed ids, no Team rows).

**Tests:** `tests/certificates-v4-pure.test.ts` (slot uniqueness team vs individual, snapshot, position labels, placings, verify output): **21/21 pass** here via a tiny vitest shim; shared file passes `tsc --strict`. `tests/certificates-v4.test.ts` (DB: team bulk idempotency, mine for all members, verify, revoke/reissue, contest bulk, migration) **written, not run**.

**NOT verified / TODO:** no `npm install`, server/web typecheck, lint, real vitest or MongoDB in the sandbox: please run `npm run typecheck && npm run lint && npm test` and `npm run migrate && npm run seed`. Web needs a follow-up step: `pages/Certificates.tsx` / `Verify.tsx` should show team name + members (API already returns them; today a team cert shows the team name as recipient), contest generate buttons, PDF layout for team members (PDF still prints `recipientName` only).


## 9. Final review (festhub-final2) - done by reading, not run

Role guards, nav, invites, certificate routes and PDF text safety reviewed (no bug found that needed a code change); README section 5a and CHANGELOG 3.0.0 written. Not run: npm install, pdfkit stress renders, npm test, browser. Next person: run `npm install && npm run typecheck && npm test`, then render `scripts/cert-template-samples.ts` and look at the PNGs.

## 10. Contest certificates in the web UI (festhub-final3) — written, not run

- **Web `pages/Certificates.tsx`:** staff (organiser/coordinator/admin) get a top switch "Event" | "Programming contest" (`?contest=<id>` opens contest mode with that contest preselected). Event mode is unchanged. Contest mode (`ContestManage`): contest selector (`GET /contests`), type checkboxes (participation / winner / runner-up), optional signature text, "Generate certificates" (organiser/admin only; disabled until the contest has ended, with a hint; toast "N created, M skipped"), search + type + status filters, paged table (recipient/team, members, type, position, ID, status), Download / Revoke / Reissue (existing endpoints), Export CSV. One-line note that contest certificates use the default template. Loading/empty/error states via `Query` / `EmptyState`.
- **"Design the default template" link: skipped** — no page exists for the default template (the editor is per event only).
- **Server `routes/certificates.ts`:** added `GET /contests/:id/certificates/export.csv` (organiser/coordinator, same filters/style as the event export; Team + Members columns).
- **Web `pages/Contests.tsx`:** `ContestCertActions` under the banner — organiser/admin: "Certificates" link to `/certificates?contest=<id>`; participants / team members: "Your certificate" button(s) when `GET /certificates/mine` has a valid one with this `contestId`.
- **My certificates / My achievements:** no code change needed — both APIs already return contest certificates with team name + members (`recipients.userId` match), and the download route allows every member; `CertificateCard` shows team name + members.
- **NOT verified:** no workspace install in the sandbox (`@festhub/shared` unresolved, so tsc output is noise), no lint, vitest, MongoDB or browser run. Please run `npm install && npm run typecheck && npm run lint && npm test` and click through contest mode. No new tests added for the CSV route.

## 11. Venue management (festhub-final4) — partly verified

- **Server:** `services/venue-rules.ts` (pure zod: name trim 2–80; capacity + building optional, ''/null = not set and dropped; capacity int 1–100000; case-insensitive duplicate helpers). `POST /venues` (`routes/events.ts`) is now organiser/admin only (was organiser+coordinator), validates with that schema, returns **409** on a duplicate name (case-insensitive check + E11000 fallback), no hard-coded building. `DELETE /venues/:id` (`routes/deletes.ts`) is now organiser/admin only, any venue incl. the 3 defaults; existing cascade `deleteVenue` unsets `venueId` on events/activities (nothing is left pointing to a missing venue); audit row `venue.delete` added. Model: `name`/`building` trimmed.
- **Defaults:** the 3 venues are created only by `seed/seed.ts` (and `seed/demo.ts` if "Main Auditorium" is missing — seed script only). Nothing at server start; `migrateRealVenues` only renames old demo names if they exist, never creates.
- **Web:** `lib/venue.ts` (`venueLabel` -> "name (capacity N)" or just "name"), `components/VenueManager.tsx` ("Manage venues": add form with optional capacity/building + inline errors incl. duplicates, list with trash + confirm via `useDelete`, warning that events/activities are unlinked). Used in `EventForm.tsx` (replaces the old inline add; shown to organiser/admin only; new venue is auto-selected) and in `ManageEvent.tsx` (Venues card, organiser/admin only; dropdown uses `venueLabel`). No other page prints venue capacity; venue name is the only thing shown elsewhere (event list/detail, schedule, certificates).
- **Tests:** `tests/venue-rules.test.ts` (6, pass here in an isolated vitest run); `features.test.ts`: existing venue-delete test updated (coordinator now 403, organiser 200) + new API test (optional capacity, trimming, 409, 403, 400) — **not run** (needs MongoDB).
- **NOT verified:** no `npm install`/typecheck/lint/full vitest/browser in this sandbox. Run `npm install && npm run typecheck && npm run lint && npm test`.
- **Behaviour change to note:** coordinators can no longer add/delete venues (they could before).

## 12. Contest registration, deadline, venue and labels (festhub-step2c) — partly verified

- **Create form:** programming contests now have an optional **registration deadline** (must be before the start) and an optional **venue** (dropdown of `/venues`, with the same "Manage venues" box as events). Both are shown to participants on the banner (contest list + contest page) and can be changed or cleared later in Contest -> Admin -> "Registration deadline & venue" (`PATCH /contests/:id` accepts `registrationDeadline` / `venueId`, `null` clears). After the deadline, solo register, create team, join team, accept invite and register team all return 422 "Registration for this contest is closed" (no deadline = open until the contest ends).
- **Individual contests:** unchanged, "Register" registers straight away.
- **Team contests:** creating a team no longer registers it. The team is a draft until the LEADER presses **Register team** (`POST /contests/:id/teams/:teamId/register`, needs the minimum number of members, leader only, atomic). Only registered teams see the problems, can submit, appear on the scoreboard, the public team list, the participant count and get participation certificates. Leader can **Cancel registration** before the contest starts (`DELETE .../register`). A registered team cannot drop below the minimum size (422). `registeredAt` on `ContestTeam`; `registered` / `registeredAt` in `myTeam`.
- **Migration** `2026-10-contest-team-registration`: every existing contest team is grandfathered in as registered (at its creation time), so nothing already running breaks. Seed team "Null Pointers" is registered.
- **Organiser:** new **Registrations** tab on the contest page (organiser + coordinator): `GET /contests/:id/registrations` (individual: name, e-mail, department/batch, time; team: team, members with e-mail and leader, size, status registered/draft), search and CSV export. Organisers/coordinators also see draft teams in `GET /contests/:id/teams`.
- **Problem labels:** "My submissions" (contest) and the admin "All submissions" table now show the contest label (A, B, C) and title instead of the last 4 characters of the id (`problemLabel`, `problemTitle`, admin also `userName`). Problem buttons use the same labels.
- **Tests:** `contest-registration-pure.test.ts` (4, pass here); `contest-team.test.ts` updated for the register step + 4 new DB tests (deadline/venue, draft team rules, min-size/cancel/deadline, organiser list + labels) — **written, not run** (no MongoDB here).
- **Verified here:** `npm install`, server `tsc` (no new errors in the touched files; some older errors in other files were already there), web `tsc` clean, eslint clean on the touched files. **NOT verified:** DB tests, browser click-through. One older web test (`features.test.tsx` judge sign-up payload) fails and is unrelated to this change.

