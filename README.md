# PUB FestHub — Campus Event, Competition and Coding Contest Operations Platform

> **Demo video (mandatory):** `<<< PASTE 5–10 MIN VIDEO LINK HERE >>>`

**Problem:** C5 – PUB FestHub · **Team:** StackForge · PUB CSE Fest-26 Hackathon

| Member | Student ID | Role / main contribution |
|---|---|---|
| `<<< fill in >>>` | `<<< >>>` | `<<< be honest; see docs/TEAM_TASKS.md >>>` |
| `<<< fill in >>>` | `<<< >>>` | `<<< >>>` |
| `<<< fill in >>>` | `<<< >>>` | `<<< >>>` |

One platform that runs a department fest end to end: events and registration, scheduling, volunteers, QR check-in, judging, a built-in programming contest, and the "after the fest" layer — certificates, sponsors, equipment, plagiarism checks, AI-assisted code feedback, an auto-ranking leaderboard, a command center and a personal achievements page.

**Stack:** React 18 + TypeScript + Vite + Tailwind · React Router, TanStack Query · Node 20+ / Express / TypeScript · MongoDB + Mongoose · Socket.IO · Judge0 (external) · Vitest, ESLint, Prettier. npm-workspaces monorepo: `apps/server`, `apps/web`, `packages/shared`.

> **Honest status.** Much of the later work (S2–S17) was written in a sandbox with no `node_modules`, no MongoDB and no browser. Pure logic (scoring, conflicts, plagiarism, IDs, AI parsing) was executed and passes; server/DB/UI code was syntax-checked only. Run the quality commands below and click through each feature before submitting. See `PROGRESS.md` for per-stage notes and `PROJECT_HANDOFF.md` for known limitations.

---

## 1. Features

**Core (v1)**
- Events with activities, eligibility, deadlines, limits, venues; individual and team registration, invitations, approval, cancellation, FIFO waiting list
- Venue-clash and volunteer-overlap detection; volunteer availability, shifts, coordinator-approved replacements, tasks
- QR check-in (signed, short-lived, revocable tokens + manual code), announcements, issues, readiness dashboard
- Judging: versioned entries, judge assignment, rubrics, organiser-approved results
- Programming contests: problem bank, hidden tests, ICPC scoring, scoreboard freeze, practice mode, editorials, progress (code runs on **Judge0**, never on our server)

**Added in later stages**
| Area | What it does |
|---|---|
| Roles + audit log (S2) | Admin / Organizer / Coordinator / Participant / Volunteer / Judge / Sponsor, enforced on the server; searchable audit trail |
| Notification center (S3) | In-app bell + page, live via Socket.IO; optional e-mail copy over SMTP |
| Dark mode + exports (S4) | Theme toggle; CSV and PDF export on list pages |
| Certificates (S5–S6) | Bulk/manual issue, PDF with QR, revoke / reissue, public `/verify/:id` |
| Sponsors + portal (S7–S8) | Sponsor records, tiers, payments, deliverables, reminders; sponsors see only their own sponsorship |
| Plagiarism (S11–S12) | Token-based winnowing engine; report with side-by-side view; suspicious / confirmed / clear review |
| AI feedback (S13–S14) | Rubric-based feedback drafts (Anthropic API) reviewed by staff, then published to the student; works by hand when AI is off |
| Leaderboard (S15) | Judge + AI score, plagiarism penalty, tie-breaks, CSV/PDF, optional publishing |
| Command center + achievements (S16) | Live organiser KPIs; participant certificates, results, feedback and a portfolio PDF |

---

## 2. Setup (exact commands)

Requires **Node >= 20** and **MongoDB** (e.g. `docker run -d -p 27017:27017 mongo:7`, or Atlas).

```bash
# 1. install (root; installs all workspaces)
npm install

# 2. configure
cp .env.example apps/server/.env          # then edit secrets (see section 3)
cp apps/web/.env.example apps/web/.env    # defaults are fine for local dev (Vite proxy)

# 3. migrate (run-once data migrations; they also run automatically when the server boots)
npm run migrate

# 4. seed demo data
npm run seed -- --reset      # WIPES the database, then seeds accounts + sample data + demo data
#   or, on an existing database (idempotent, only adds what is missing):
npm run seed:demo

# 5. run
npm run dev                  # server http://localhost:5000 + web http://localhost:5173
#   or separately: npm run dev:server   /   npm run dev:web

# 6. quality + tests
npm run typecheck && npm run lint
npm test                     # server + web; server DB tests need MongoDB at TEST_MONGODB_URI (that DB is dropped)
npm test -w @festhub/server -- s17c-core   # only the DB-free core-algorithm suite

# production build / start
npm run build
npm run start -w @festhub/server
```

**Docker (web + API + MongoDB + Judge0):**
```bash
cp docker.env.example .env          # set JWT_ACCESS_SECRET and QR_TOKEN_SECRET (one-liner is in the file)
docker compose up -d --build        # web http://localhost:8080
docker compose --profile tools run --rm seed
```

---

## 3. Environment (`.env.example` explained)

Copy `.env.example` to `apps/server/.env` (Docker: `docker.env.example` → `.env`). Everything marked optional can stay empty.

| Variable(s) | Needed? | Meaning |
|---|---|---|
| `MONGODB_URI`, `TEST_MONGODB_URI` | yes | Main database; the test database is **dropped on every test run** |
| `JWT_ACCESS_SECRET`, `QR_TOKEN_SECRET`, `QR_TOKEN_TTL_SEC` | yes (change them) | Signing secrets for login tokens and check-in QR codes. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `CLIENT_ORIGIN`, `COOKIE_SECURE`, `COOKIE_SAMESITE` | yes | CORS allow-list and cookie flags (set `COOKIE_SECURE=true` behind HTTPS) |
| `JUDGE_ADAPTER`, `JUDGE0_*`, `SUBMISSION_COOLDOWN_SEC` | only for contest judging | Judge0 endpoint/keys. `JUDGE_ADAPTER=mock` gives labelled fake verdicts for demos |
| **`SMTP_HOST`**, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `APP_URL` | optional | **E-mail copies of notifications.** Leave `SMTP_HOST` unset = e-mail off; in-app notifications always work; delivery failures are only logged. `SMTP_SECURE=true` = implicit TLS (465), false = STARTTLS (587). `APP_URL` is the base for links in e-mails |
| **`ANTHROPIC_API_KEY`**, `ANTHROPIC_MODEL` | optional | **AI code feedback.** Key and model come only from the environment. If either is empty the feature is *disabled*: the app runs normally and staff can still write feedback by hand. Tuning: `ANTHROPIC_TIMEOUT_MS`, `ANTHROPIC_MAX_RETRIES`, `ANTHROPIC_MAX_INPUT_CHARS`, `ANTHROPIC_MAX_OUTPUT_TOKENS`. Never put the key in the web app |
| `CERT_SIGNATURE_TEXT` | optional | Text printed under the signature line on certificates (ASCII/Latin-1) |
| `UPLOAD_DIR`, `MAX_IMAGE_MB` | optional | Where uploads (covers, logos, receipts) are stored and the image size limit |
| `VITE_API_BASE_URL`, `VITE_SOCKET_URL`, `VITE_SHOW_DEMO` | optional | Web build settings; `VITE_SHOW_DEMO=false` hides the demo-login chips |

---

## 4. Demo credentials

Two seeds are created by `npm run seed -- --reset`.

**Demo seed — one account per role, password `Demo@12345`**

| Role | Email |
|---|---|
| Admin | `demo.admin@festhub.test` |
| Organizer | `demo.organiser@festhub.test` |
| Coordinator | `demo.coordinator@festhub.test` |
| Judge | `demo.judge@festhub.test` (second judge: `demo.judge2@festhub.test`) |
| Participant | `demo.participant@festhub.test` (students with scored work: `demo.student1` … `demo.student6@festhub.test`) |
| Volunteer | `demo.volunteer@festhub.test` |
| Sponsor | `demo.sponsor@festhub.test` (linked to "Demo Nova Bank") |

**Classic seed — password `Password123`:** `admin@`, `organiser@`, `coordinator@`, `judge@`, `judge2@`, `sponsor@`, `volunteer1@`–`volunteer3@`, `participant1@`–`participant6@` (all `@festhub.test`).

Handy: log in as `demo.organiser` for the Command center and Leaderboard; `demo.student3` for My achievements after publishing the leaderboard and a feedback draft.

---

## 5. How-to, feature by feature

- **Events & registration** — Organizer: *Events → New event*, add activities. Participant: open an event → *Register* (team events: create/join a team). Full events put you on the waiting list.
- **Check-in** — Participant: *QR check-in* shows a short-lived QR + manual code. Volunteer/Coordinator/Organizer: *Volunteer desk* or *QR check-in* → scan or type the code.
- **Judging** — Organizer assigns judges to an activity; Judge: *Judging* → score entries per rubric criterion; Organizer approves results.
- **Contests & practice** — *Contests* (timed, ICPC scoreboard with freeze), *Practice* (problem bank), *Problem setting* (judge/organizer).
- **Notifications** — bell in the top bar; *Notifications* page; add SMTP to also get e-mails.
- **Certificates** — Organizer: *Certificates* → generate for an event (participation/winner/volunteer…), revoke/reissue; anyone can check `/verify/<id>`; people download their own.
- **Sponsors** — Organizer/Coordinator: *Sponsors* → add sponsor, tier, payments, deliverables. Sponsor user: *My sponsorship* (own data only).
- **Plagiarism** — Participants send code via *Submit code*; Organizer/Judge: *Plagiarism report* → run check, open a pair side by side, mark suspicious/confirmed/clear.
- **AI feedback** — Organizer/Judge: *Code feedback* → open a submission → *Generate AI feedback* (needs `ANTHROPIC_*`) or *Write by hand* → edit → *Publish*. Rubrics: *Feedback rubrics*. Students see only published feedback.
- **Leaderboard** — *Leaderboard* → pick an event; Organizer sets "visible to participants" (scoring uses the fixed formula); export CSV/PDF.
- **Command center** — Organizer/Admin: live registrations, sponsors, submissions and certificates panels (refreshes every 15 s).
- **My achievements** — everyone: certificates, published results/feedback, *Download portfolio PDF*.
- **Admin** — *Users & roles* (grant roles), *Audit log*. Dark mode toggle is in the top bar.

### 5a. Venues, team invites and certificate design (v1-v7 additions)

**Venues.** The seed creates three real venues: *Main Auditorium* (300), *Room NB-408* (60) and *Room NB-407* (60), building "NB Building". Organizer: *Events -> New event / Edit* -> **Venue** dropdown (shows `name (capacity N)`); if a venue is missing use the inline *add venue* box. On an existing database run `npm run migrate`: old venue names are renamed in place, so events keep their venue.

**Team invites - team events** (*Events* -> open a team event):
1. The leader creates a team, then types a teammate's e-mail -> *Send invite*. An in-app notification is created and, if `SMTP_HOST` is set, a real e-mail is sent (link = `APP_URL/events?invite=<id>`). Without SMTP nothing is lost: use **Copy link** and send it yourself.
2. If the e-mail has no account yet, the invite waits and attaches automatically when that person registers or logs in with the same e-mail.
3. The invited person sees an **Accept / Decline** banner. The leader sees pending invites with **Resend** and **Cancel**. Invites expire after 14 days; team size max, one team per event and a rate limit are enforced; the roster locks once the team is registered.

**Team invites - programming contests** (*Contests* -> open a team contest -> *Team* tab):
- **Join code:** the leader sees the code with a **Copy** button; teammates paste it into *Join with code*.
- **Invite link:** *Copy invite link* opens the contest with the code pre-filled (`/contests/<id>?join=<CODE>`), the user only presses *Join*.
- **E-mail invite:** same flow as team events (Send / Resend / Cancel, Accept / Decline, 14-day expiry, unregistered e-mails are attached later).

**Certificates for teams and contests.** One certificate per team lists the team name and *all* members (snapshot, leader first); individual events print the person's name; winner / runner-up show the position text; programming contests issue participation / winner / runner-up from the final scoreboard. Every team member can download the team certificate; `/verify/<id>` shows the team and all members.

**Designing a template** (*Certificates* -> pick the event -> template editor): theme (Royal Blue & Gold, Emerald & Gold, Sunset, Violet or custom colours), border style, font style, seal on/off, logos (JPG/PNG), up to 3 signatories (image + name + position), headline per certificate type, custom body text with `{name} {team} {members} {event} {position} {date} {venue}` and up to 4 custom fields. The **live preview** renders the real PDF with sample data (individual / team of 3 / team of 8 / winner). Every text has a length limit and the layout engine shrinks, wraps or ellipsises text, so elements never overlap.

**Downloading and printing.** Pages are **A4 landscape (842 x 595 pt)**. Open the PDF -> Print -> paper A4, orientation landscape, scale **"Actual size" / 100 % (not "Fit to page")**, margins "None" or "Default". Use high-quality / colour printing and, for best results, 120-160 gsm paper.

**Non-Latin names (Bangla etc.).** The PDFs use the standard Helvetica/Times fonts (Latin-1 only), so a character outside Latin-1 is printed as `?` instead of crashing the PDF. Bangla names therefore need a Unicode font, which is **not bundled** (see Known limitations). Use the English spelling of names on certificates until a font is added.

**Demo accounts for these features** (password `Demo@12345`): `demo.organiser@festhub.test` (venues, templates, bulk generate, plagiarism, leaderboard); `demo.student1@festhub.test` ... `demo.student5@festhub.test` (members of the seeded team certificates *Demo Team Alpha* (3 members) and *Demo Team Bravo* (5 members); use two of them in two browsers to try team invites); `demo.student2@festhub.test` (contest runner-up certificate); `demo.participant@festhub.test` (individual winner certificate); `demo.sponsor@festhub.test` (sponsor portal only).

---

### 5b. Role requests (judge / coordinator)

- Sign-up (or **Request a role** on the dashboard) lets a user ask for **Judge** (designation + employee ID) or **Coordinator** (no fields). Calls `POST /role-requests`; one pending request per role, 24 h wait after a rejection.
- Organisers/admins review them at **Admin → Role requests** (`/admin/role-requests`): Pending / Approved / Rejected tabs, a sidebar badge with the pending count, Approve, and Reject with an optional reason. Approving adds the role and keeps existing ones.
- The requester sees a banner on the dashboard while the request is pending, and the reason after a rejection. Notifications open `/admin/role-requests` (organisers) and `/dashboard` (requester; redirects to `/`).

## 6. Innovation

- **Command Center** — one live page replaces five spreadsheets, so organisers see registrations, money, stock, flagged code and certificates at a glance.
- **Auto-ranking leaderboard** — combines judge score, AI-suggested score and a plagiarism penalty with transparent maths and deterministic tie-breaks, so rankings are fast, fair and explainable.
- **Notification center** — in-app + live + optional e-mail keeps volunteers, judges and participants informed without manual messaging.
- **RBAC with sponsor portal** — server-enforced roles (admin ⊇ organizer) and an external sponsor role that sees only its own sponsorship, so partners get self-service without touching internal data.
- **Audit log** — every sensitive action (role changes, deletes, config, revocations) is recorded with who/what/before/after, giving accountability for a multi-person fest.
- **My Achievements + portfolio PDF** — certificates, results and feedback in one place and one downloadable PDF turn fest participation into a student's portfolio.
- **Dark mode + exports** — theme support and CSV/PDF everywhere make the app usable at night-time events and fit offline reporting.
- **Seed / demo data** — idempotent demo accounts per role and ready-made scenarios (scored hack-a-thon, copied code, sponsors) let anyone evaluate every feature in minutes.

---

## 7. Architecture & docs

`docs/ARCHITECTURE.md`, `DATABASE_DESIGN.md`, `API_CONTRACT.md` (S2–S16 endpoints are described in `PROGRESS.md`, not yet in the contract), `JUDGE0.md`, `DEPLOYMENT.md`, `REQUIREMENTS_MATRIX.md`, `DEMO_SCRIPT.md`, `SUBMISSION_CHECKLIST.md`, `TEAM_TASKS.md`; staged build log: `PROGRESS.md`; history: `CHANGELOG.md`.

```
apps/server/src  config models routes services middleware sockets seed tests
apps/web/src     lib components pages
packages/shared  roles, enums, zod schemas and pure logic (leaderboard, certificates) shared by both apps
```

## 8. Known limitations

- **Non-Latin characters in PDFs** (Bangla, Arabic, CJK...) print as `?` because no Unicode font is bundled. To add Bangla: put a TTF (e.g. Noto Sans Bengali) in `apps/server/assets/fonts/` and register it in `certificatePdf.ts` / `brandedPdf.ts` (not done).
- The v1-v7 additions (venues, invites, team certificates, pdfkit renderer, editor, premium UI) were reviewed by reading the code and by unit tests; they were **not** run against a real MongoDB or in a browser in the last review session.
- E-mail invites are matched by the e-mail address typed at registration (e-mail ownership is not verified).

Judge0 not verified against a live instance; server tests historically ran on FerretDB, not real MongoDB; UI not browser-tested (including dark mode and phone widths); roles are global, not per event; in-process judge queue; no pagination on some lists; AI feedback never run against the real API (client tested with mocked `fetch`). Details: `PROJECT_HANDOFF.md`, `PROGRESS.md`.

## 9. Screenshots / team contribution

`<<< add images from docs/screenshots/ >>>`

`<<< Each member: what you built and can explain. Write only what is true. >>>`
