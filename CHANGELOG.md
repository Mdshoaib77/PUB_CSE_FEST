# CHANGELOG



## Unreleased (festhub-step2c)
- Contests: the registration deadline is now required when creating a contest (API returns 400 without it; it can be moved but not cleared). Older contests without one still work.
- Leaderboard: removed the explanatory texts and the weights/penalty/tie-break settings from the page; the organiser panel keeps only "Visible to participants" + Save. Scoring itself is unchanged. "Podium" is now "Top 3 Winners". The PDF export no longer prints the formula note.
- Removed the Equipment feature (pages, API, models, seed data, command-center panel, tests).
- Contests: optional registration deadline and venue (create form, Admin tab, shown on the banner). Registration closes at the deadline for every way of joining.
- Team contests: creating a team no longer registers it; the leader registers a complete team (`POST /contests/:id/teams/:teamId/register`, `DELETE` to cancel). Drafts cannot see problems, submit or appear on the scoreboard. Migration grandfathers existing teams as registered.
- Organiser/coordinator: `GET /contests/:id/registrations` + Registrations tab with search and CSV export.
- Contest submissions show the problem label (A, B, C) and title instead of an id fragment (`problemLabel`, `problemTitle`; admin list also `userName`).
- Tests: `contest-registration-pure.test.ts`, `contest-team.test.ts` updated and extended.

## Unreleased (festhub-final15)
- `POST /entries/:id/judges` now notifies the judge (`type: judging`, link `/judging?event=<eventId>`): `You were assigned to judge "<entry>" (<team>) in "<event>"`. `DELETE /entries/:id/judges/:judgeId` sends a matching "unassigned" notice only when an assignment was actually removed. Failed assignments (409/422/403) send nothing; a notification failure never fails the request.
- `GET /me/assigned-entries` also returns `eventId`, `eventTitle` and `teamName` (null for individual entries).
- Judging page: entries grouped by event and activity, header shows event, activity and "scored X of Y"; event filter and `?event=` support; team name on each entry.
- Test: `judge-notify.test.ts`.

## Unreleased (festhub-final14)
- `GET /events/:id/registrations` now returns `team.members[]` (`userId`, `name`, `isLeader`, plus `email` for organiser/admin only; coordinators get no emails) and `team.memberCount` for team registrations. Individual rows unchanged.
- Organiser Registrations tab: team rows show team name, member count and an expandable roster with a Leader badge and member name/email (stacked, mobile-friendly).
- Test: `registrations-members.test.ts`.

## Unreleased (festhub-final12)
- Results now carry the owner name: `POST /activities/:id/results/compute` stores `ownerName` (team name, or the user's name for individual entries) in `rankings`; `GET /activities/:id/results` returns `{ rank, title, ownerName, percent }` and resolves the name at read time for results computed earlier (`null` if the team/user no longer exists).
- Organiser Judging tab: results table with Rank, Team name, Entry title, Score %. Participant "Official results" box shows the team name too.
- Test: `results-owner.test.ts`.

## Unreleased (festhub-final4)
- Venues: add custom venues (name required, capacity and building optional, duplicate names -> 409) and delete any venue from "Manage venues" in the event form and event management; organiser/admin only (server-enforced). Dropdown shows "name (capacity N)" only when a capacity exists.
- Deleting a venue unlinks it from events/activities (existing cascade) and is audited.

## Unreleased (festhub-final3)
- Certificates page: "Event" | "Programming contest" switch with contest selector, generate (after contest end), filters, paged table, download / revoke / reissue and CSV export for contest certificates.
- API: `GET /contests/:id/certificates/export.csv`.
- Contest page: organiser "Certificates" link (`/certificates?contest=<id>`) and participant "Your certificate" button.

## 3.0.0 - final review and docs (festhub-final2)

**Reviewed (read-only audit, no behaviour change)**
- Role guards: certificate download only for the recipient, a team member or staff (revoked = staff only); revoke/reissue/generate/template-save need organiser; `/verify/:id` is the only public certificate route. Event and contest invitations can only be listed, answered or cancelled by the invitee (id or e-mail) or the team leader (staff may list).
- Navigation and routes for Contests, Certificates, Achievements, Leaderboard and `/verify` exist and match the role menus; syntax check of all 191 TS/TSX files: 0 errors.
- Certificate PDF text: every string (name, team, members, venue, position, signatories, custom fields, body text, verify URL) goes through `safe()`, so non-Latin characters become `?` and cannot crash the renderer; the renderer falls back to the legacy PDF writer if pdfkit fails.

**Changed**
- README: new section 5a (venues, event and contest team invites, copy code / copy link / e-mail, team and contest certificates, template designer, A4 landscape "actual size" printing, non-Latin names, demo accounts) and extended Known limitations.

**Not verified here:** no `npm install` (no network), so pdfkit stress renders (1-20 members, long names, missing logo/signature), `npm test` and the browser UI were not run in this session.

## 2.9.0 — premium Leaderboard, My Achievements, Certificates, Verify + branded PDFs (v7)

**Added**
- Leaderboard: top-3 podium (gold / silver / bronze, ties share a place), medal rank badges, team rows show the team name plus member names (leader first), "You" marker, full score breakdown kept (table on desktop, one card per participant on phones). "Certificate" button per row: staff see it for every row, participants only on their own row (own team counts).
- Leaderboard PDF: A4 landscape, branded header with the event name, gradient table header, colour-coded columns, rank badges, final-score bars, wrapped cells (nothing cut off), repeated header, "Page n of N" on every page.
- My Achievements and My certificates: premium gradient certificate cards (team name + members, or the individual; position badge; event; date; certificate ID) with Preview (modal showing the real PDF) and Download PDF (`FestHub-Certificate-<event>-<name>.pdf`); rank/result cards and published-feedback cards.
- Portfolio PDF redesigned (A4 portrait): same theme colours, summary tiles, certificate / result / feedback cards, wrapped text, page numbers.
- Public `/verify/<id>`: premium look, team name and every team member, dark mode, loading skeleton and retry on error.
- `GET /events/:id/leaderboard` rows gained `members`, `isMine`, `certificate`; `GET /me/achievements` certificates gained `kind`, `recipientName`, `teamName`, `members` (additive).
- Tests: `branded-pdf-v7.test.ts` (real pdfkit: A4 sizes, pagination, empty case), `lib/certView.test.ts` (file names, tones).

**Changed**
- The leaderboard and portfolio PDFs now use the pdfkit renderer (`services/brandedPdf.ts`) instead of the generic table writer. CSV exports, the shared `toPdf` and all other exports are unchanged.

**Not verified:** DB-backed paths (row enrichment, role visibility of the certificate button), the pages in a real browser (dark mode, 375 px). See PROGRESS.md 4aa.

## 2.8.0 — certificate template customisation (v6)

**Added**
- Template (one per event): 4 themes + custom colours, main + optional second logo, up to 3 signatories (image, name, position), seal on/off, border style (classic / modern / minimal), font style (serif / sans), headline override per certificate type, custom body text with `{name} {team} {members} {event} {position} {date} {venue}`, up to 4 custom fields (label + value).
- Server-side length limits on every text field (shared with the UI), unknown placeholders rejected, uploads still JPG/PNG + magic bytes + 2 MB.
- `POST /events/:id/certificate-template/preview` (real PDF with sample data and unsaved edits), `DELETE /events/:id/certificate-template` (reset), `logo2` and `signatory-1..3` image endpoints.
- Template editor with live PDF preview (sample switch: individual / team of 3 / team of 8 / winner), Reset to default, dark mode and mobile layout.
- Idempotent migration `2026-10-v6-certificate-template-options`.
- Tests: validation limits, placeholders, renders with all options on (no overlap, real pdfkit); DB/API tests written (not run).

**Changed**
- The certificate download now renders with the pdfkit renderer and the template (team name, members, venue, all options); on any render error it falls back to the previous renderer.
- Old templates keep working: legacy `signatureName/Title/ImageUrl` mirror signatory 1 and the old PUT body is still accepted.

**Not verified:** DB-backed tests and the editor in a browser (see PROGRESS.md 4z).

## 2.7.0 — team certificate member grid (v5 step D)

**Added** (pdfkit renderer only)
- Team certificates: large team name, then a "Team members" block listing ALL members (leader first) in a grid of 1-4 columns that adapts to the count (up to 20). The grid shrinks its font (12 -> 9 pt) and adds columns before it can reach the signature zone; extra-long names are cut with "...".
- `layoutMemberGrid()`, `TEAM_ZONES`, `zonesFor()` in `certLayout.ts`; `renderCertificateKit` also returns `grid`.
- Tests: teams of 2, 6, 12, 20 and very long names (1 page, no overlap, grid above the signatures).
- `docs/samples/`: individual, winner, runner-up, team of 6, team of 20 (PDF) + 2 PNG previews; offline helpers in `scripts/` (pdfkit stub, sample + test runners).

**Unchanged**
- Individual certificates, legacy `renderCertificatePdf`, the download route. Samples were rendered with the pdfkit stub, not real pdfkit.

## 2.6.0 — seal, logo, signatories, QR footer, revoked watermark (v5 step C)

**Added** (pdfkit renderer only)
- Medal/ribbon seal: gold (winner), silver (runner-up), brand colour (participation, volunteer, organizer).
- Logo in a fixed top-left box; up to 3 centred, evenly spaced signatories with image, name and title (empty ones skipped).
- Footer with a vector QR code, certificate ID and "Verify at <url>".
- Diagonal outlined REVOKED watermark for revoked certificates.
- Tests: winner, runner-up, other types, with/without logo and signatures, empty signatory, revoked, long URL (1 page, no overlap).

**Changed**
- Layout zone budget: members 52, signatures 98, footer 61 (total unchanged).

**Unchanged**
- Legacy `renderCertificatePdf` and the download route.

## 2.5.0 — certificate decoration + 4 themes (v5 step B)

**Added** (pdfkit renderer only, `services/certificatePdf.ts`)
- Vector decoration: layered border frames, corner ornaments, gradient top/bottom bands, light pinstripe pattern and rosette watermark, bottom corner stripes, title flourish. Print-friendly: solid light tints, no transparency, no text under 9 pt.
- Themes `royal` (Royal Blue & Gold), `emerald` (Emerald & Gold), `sunset`, `violet` via `CERT_THEMES` / `resolveCertPalette`; mapped from `brand.theme` or from a template's primaryColor/accentColor pair; any other hex colours keep working.
- Tests for theme mapping and one-page/no-overlap renders of every theme.

**Changed**
- Title is requested at 40 pt (fitted by the layout engine); text colours follow the palette; REVOKED stamp is outlined instead of semi-transparent.

**Unchanged**
- Text zones and layout engine, the legacy `renderCertificatePdf`, the download route. No seal, QR, logo, signature or member grid yet.

## 2.4.0 — pdfkit certificate renderer, plain content (v5 step A)

**Added**
- `services/certLayout.ts`: layout engine for A4 landscape (842 x 595 pt, 36 pt safe margin) with fixed vertical zones (header, title, recipient, body, members, signatures, footer); text is measured with pdfkit (`widthOfString` / `heightOfString`), shrunk to a 9 pt minimum, then wrapped, then ellipsised; returns the boxes it used. `assertNoOverlap(boxes)` throws on intersecting boxes or a box outside the safe margin.
- `renderCertificateKit` / `renderCertificatePdfKit` in `services/certificatePdf.ts`: one-page pdfkit PDF (standard Times/Helvetica fonts), plain content only. `CertificatePdfInput` gained optional `teamName`, `members`, `venue`, `signatories`, `logoBuf`.
- `pdfkit` (+ `@types/pdfkit`) in `apps/server/package.json`. Run `npm install`.
- Tests: `tests/cert-layout.test.ts` (normal name, very long name, team of 3: 1 page, no overlap; pure layout tests).

**Unchanged**
- `renderCertificatePdf` (synchronous, dependency-free) and the download route still behave exactly as before; the new renderer is a separate async entry and is not wired in yet. No themes, seal, QR or member grid in this step.

## 2.3.0 — team + contest certificates (data/backend only)

**Added**
- **Team certificates:** a TEAM event gets ONE certificate per team (`kind: 'team'`, `teamId`, `teamName`, `recipients` = snapshot of every member, leader first). The snapshot never changes afterwards. `userId` = leader and `recipientName` = team name, so old code paths and the unchanged PDF still work. Individual events keep one certificate per person (`kind: 'individual'`).
- **Contest certificates:** participation for every registered person (INDIVIDUAL) or team (TEAM); winner / runner-up from the final, unfrozen scoreboard (rank 1 / 2, nothing for rows with 0 solved). `contestId` set, `positionLabel` e.g. "1st Place - <Contest name>".
- **Position labels** are always filled for winner / runner-up (events, contests, manual issue).
- **Bulk generation** per event (team-aware) and per contest, idempotent through `slotKey` (team slot = team, contest slots prefixed `c:`).
- **Every member** sees the team certificate in `GET /certificates/mine`, can download it, and is notified on issue / revoke / reissue; `GET /verify/:id` returns `kind`, `teamName`, `members`, `contestTitle`.
- Endpoints: `GET /contests/:id/certificates`, `POST /contests/:id/certificates/generate`. Event list search now also matches team and member names, `?kind=` filter, CSV gets Team / Members columns.
- Migration `2026-10-v4-certificates-kind-team-contest` (idempotent): old documents get `kind: 'individual'` and a one-person `recipients` snapshot; `slotKey` untouched.
- Seed: team certificate with 3 members, team certificate with 5 members, individual winner (existing), contest runner-up.
- Tests: `certificates-v4-pure.test.ts` (21 DB-free tests), `certificates-v4.test.ts` (DB).

**Changed**
- `Certificate.eventId` is optional (a contest without an event). `reissue` of a team certificate keeps the member snapshot.
- PDF design, web UI: not touched in this step.

## 2.2.0 — contest team invitations

**Added** (programming-contest teams; the join code, its Copy button and the "Join a team" box are unchanged)
- **Invite by e-mail (leader only):** new `ContestTeamInvitation` model (status pending / accepted / declined / cancelled / expired, 14-day expiry). A real e-mail goes out through `services/mailer.ts` when SMTP is configured (silently skipped otherwise) plus an in-app notification. An unregistered e-mail is stored and attached automatically when that person registers or logs in.
- **Copy invite link:** `/contests/<id>?join=<CODE>` opens the team tab with the code pre-filled, so the invitee only presses Join. E-mail links (`?invite=<id>`) open the same tab with an Accept / Decline banner.
- **Leader list** of pending invitations with Resend (renews 14 days, 30 s cooldown) and Cancel; **invitee banner** with Accept / Decline.
- Endpoints: `POST|GET /contests/:id/teams/:teamId/invitations`, `POST .../:invId/resend`, `DELETE .../:invId`, `GET /contests/:id/invitations/mine`, `POST /contests/:id/invitations/:invId/accept|decline`.
- Rules: contest must still be open, team size max (same atomic seat guard as the join code), one team per contest, duplicate / max-20-pending checks, judges/setters/linked-event eligibility, invitation sends rate-limited (30 per hour per user); `log_action` on send, resend, cancel, accept, decline, attach; leader and invitee are notified on accept / decline.
- Tests: `tests/contest-invites-pure.test.ts` (7 DB-free tests).

**Changed**
- Disbanding a team, deleting a contest or purging a user also removes its invitations. `Protected` keeps the query string through the login redirect (done in 2.1.0).

## 2.1.0 — team invitations v2

**Added**
- **E-mail invitations:** `POST /teams/:id/invitations` now sends a real e-mail (subject, team, event, inviter, accept link `${APP_URL}/events?invite=<id>`) through `services/mailer.ts` when SMTP is configured; silently skipped when it is not (the in-app notification still works).
- **Invite people without an account:** an unknown e-mail is stored as a pending invitation (`inviteeEmail`) and attached automatically when that person registers or logs in with that address (they get a notification); it can also be accepted straight from the link.
- **Leader tools:** `GET /teams/:id/invitations` (pending list), `POST /teams/:id/invitations/:invId/resend` (renews expiry, 30 s cooldown) and `DELETE /teams/:id/invitations/:invId` (cancel); the event page shows them with Resend, Cancel and **Copy link** buttons.
- **Invitee banner** with Accept / Decline on the event page; `/events?invite=<id>` redirects to the right event (and survives the login redirect).
- Rules: invitations expire after 14 days; team size max, one team per event, roster lock, duplicate-invite and max-20-pending checks; invitation sends/resends are rate-limited (30 per hour per user).
- `log_action` on `invitation.send|resend|cancel|accept|reject|attach`; leader and invitee are notified on accept and decline.
- Tests: `tests/invites-pure.test.ts` (13 DB-free tests: full team, duplicate, expired, unknown-e-mail attach, cooldown).

**Changed**
- `Invitation` gained `inviteeEmail`, `expiresAt`, `lastSentAt`, `slotKey` and status `cancelled`; `inviteeId` is optional. New run-once migration `2026-10-team-invitations-v2` drops the old unique `(teamId, inviteeId)` index, backfills `slotKey`, and gives pending invitations a fresh 14-day expiry.
- `/me/invitations` and the dashboard count hide expired invitations and now include e-mail-only invites for your address; the banner matches by event id instead of title.

## 2.0.1 — real venues

**Changed**
- Seed + demo data now use the real venues **Room NB-408** (60), **Main Auditorium** (300) and **Room NB-407** (60), building "NB Building". The old "Demo Hall", "Computer Lab 1" and "Seminar Room 2" are gone from seed code. Event titles starting with `Demo:` are unchanged.
- New idempotent migration `2026-10-real-venues-rename` (`services/migrations.ts`): renames Demo Hall → Main Auditorium, Computer Lab 1 → Room NB-408, Seminar Room 2 → Room NB-407 in place (events keep their `venueId`); if the target already exists, events/activities are repointed to it and the old venue is deleted.
- Event form: venue dropdown shows "name (capacity N)"; organizers/coordinators can add a new venue inline ("+ Add new venue", uses the existing `POST /venues`).

## 2.0.0 — final release (stages S2–S17)

**Added**
- **Roles + audit log (S2):** `admin` and `sponsor` roles (admin satisfies every organizer check), shared `roleSatisfies`, wider audit coverage and viewer.
- **Notification center (S3):** in-app + live notifications, optional SMTP e-mail copies (`SMTP_*`).
- **Dark mode + exports (S4):** theme toggle, CSV/PDF export helpers, demo seed with one account per role (`demo.<role>@festhub.test`, password `Demo@12345`).
- **Certificates (S5–S6):** checksummed IDs, bulk/manual issue, PDF with QR, revoke / reissue, public `/verify/:id`.
- **Sponsors + sponsor portal (S7–S8):** tiers, payments, deliverables, reminders, receipts; sponsors see only their own sponsorship.
- **Equipment (S9–S10):** inventory, allocation with overlap/quantity conflict detection (back-to-back allowed), approvals, check-out/return, availability timeline, low-stock alerts.
- **Plagiarism (S11–S12):** token-based winnowing engine (renames, comments and whitespace ignored), report, side-by-side matching blocks, review workflow.
- **AI feedback (S13–S14):** rubric-based drafts via the Anthropic API (env-only key, retries/timeouts, safe parser), staff review/publish, rubric editor; disabled cleanly when no key.
- **Leaderboard (S15):** judge + AI score, plagiarism penalty, tie-breaks (ranks 1,2,2,4), CSV/PDF, optional publishing to participants.
- **Command center + My achievements (S16):** live organizer KPIs and charts; certificates, results, published feedback and portfolio PDF for each user.

**Changed / fixed (S17)**
- **S17A:** sponsor-only accounts can no longer open participant pages (check-in, submit code, feedback, contests, practice, progress); nav and Dashboard hide those links for them. All other web route guards verified against the API.
- **S17B:** dark-mode colour remaps for utilities that were unreadable, mobile table/flex-wrap fixes, loading/error/empty states on feedback, rubrics, review, users and entry panels.
- **S17C:** new DB-free core suite `s17c-core.test.ts` (31 tests: plagiarism, equipment conflicts, certificate verification, leaderboard maths, mocked AI prompt/parser/client); small pure helper `verificationVerdict` now used by `GET /verify/:id` (same behaviour).
- **S17D:** README rewritten (features, setup, env, demo accounts, how-tos, innovation); changelog finalised.

**Verification status**
- Run and passing in the build sandbox: shared/pure logic (leaderboard, equipment conflicts, certificate IDs, plagiarism engine, AI prompt/parse/client with mocked fetch).
- Not run there: `npm install`, typecheck, lint, the Vitest/MongoDB suites, the web UI in a browser, a live Judge0, the real Anthropic API, a real SMTP server. Run `npm run typecheck && npm run lint && npm test` and click through each feature.

## 1.2.0 — scanner fallback, contest banners, team contests, 10 languages

- Check-in: new `QrScanner` starts cameras by deviceId (fixes laptops, where `facingMode: 'environment'` was turned into an `exact` constraint and failed), camera picker, clear error messages. New `CheckInDesk` adds a manual "Submit Code" field under the viewport; used on Check-in and Volunteer pages. Participants get a stable 8-character registration code (`manualCode`); `POST /checkin/scan` accepts a QR token or that code.
- Contests: `bannerImage`, `description`, `mode` (`INDIVIDUAL` | `TEAM`), `teamSize`. Glassmorphic banner on list, contest page and organiser Admin tab (banner editor).
- Team contests (ICPC): `ContestTeam`, endpoints `POST /contests/:id/teams`, `POST /contests/:id/teams/join`, `GET /contests/:id/teams`, `DELETE /contests/:id/teams/:teamId[/members/:userId]`. Team scoreboard, per-problem solved/attempt stats, first-solve marker. Membership locks at contest start; minimum team size enforced on submit.
- Languages: C, C++, Java, Python 3, JavaScript, TypeScript, Go, C#, Rust, PHP. Judge0 CE 1.13.x default ids; `GET /judge/languages` (organiser) verifies them against your Judge0; `JUDGE0_LANGUAGE_IDS` overrides. Startup migration widens legacy four-language problems.
- Editor starts empty in every language (no starter templates); drafts are kept per language.
- Tests: 75 server tests (12 new). Not yet exercised in a real browser/camera or against a live Judge0.

## 1.1.0 — universal delete, smart notifications, event covers, premium UI, Docker
- **Universal delete.** Every resource can now be deleted with a confirmation modal and an instant (optimistic) UI update that rolls back with the server's reason if refused: events, activities, venues, announcements, issues and issue comments, tasks, shifts, volunteer assignments, replacement requests, availability, check-ins, QR codes, teams, invitations, entries, judge assignments, scores, rubrics, results, problems, editorials, contests, submissions, notifications and users. All deletes are authorised on the server, cascade through `services/cascade.ts` (no orphans), and are guarded where deleting would corrupt data (official results, problems used by a contest, last organiser). Events, contests, problems, results and users are audit-logged. Activity and assignment "delete" are now real deletes (previously soft-cancel; the old assignment soft-cancel also blocked re-assigning the same volunteer because of the unique key).
- **Notifications.** The bell badge is a server-side count (`GET /notifications/unread-count`), exact beyond the 50-item list cap. Opening the bell or the Notifications page marks what was shown as read (`POST /notifications/read-all {upTo}` so a notification arriving mid-view stays unread), clears the badge instantly, and syncs other tabs over Socket.IO.
- **Fixed:** the shared Socket.IO client kept the previous user's identity after logout/login (no live notifications for the next user), never recovered after the 15-minute access token expired, and logout left the previous user's data in the query cache.
- **Event cover images.** `POST /uploads/event-image` (organiser, multipart, 5 MB, validated by magic bytes, SVG refused, random filenames) or an external image URL; new `imageUrl` on events; replaced/deleted covers are removed from disk. Hero treatment on the event page, cover cards in the list, thumbnails on the dashboard, generated gradient fallback when there is no image.
- **UI.** Redesigned login/register (glass, gradients, parallax, live validation, strength meter), new app shell, animated tabs/toasts/modals/counters, page transitions, top progress bar, lazy-loaded routes, self-hosted fonts, reduced-motion support.
- **Docker.** `docker compose up` now runs web (nginx) + API + MongoDB + Judge0 with an `uploads` volume; see `docker.env.example`. The server build now bundles `@festhub/shared` (the old build only worked on Node versions that strip TypeScript types). New env vars: `UPLOAD_DIR`, `MAX_IMAGE_MB`, `COOKIE_SECURE`, `COOKIE_SAMESITE`, `VITE_SHOW_DEMO`.
- Tests: 63 server (9 new) and 9 web (7 new).
## 1.0.0 — full implementation (Phases 0–8 delivered in one session)
- Foundation: monorepo, auth (bcrypt, 15-min JWT + rotating httpOnly refresh cookie), server-side RBAC with live role re-read, validation, error envelope, seed script, shared zod schemas.
- Events, activities, venues; registration with unique-index seats, FIFO waiting list, approvals, cancellations, teams and invitations.
- Scheduling clash detection; volunteers (availability, shifts, replacements, attendance, tasks); announcements; issues; readiness dashboard.
- QR check-in with signed, revocable tokens and duplicate protection; versioned entries, rubric judging, organiser-approved results, audit log.
- Programming contests: problem bank, hidden tests, Judge0 adapter + labelled mock adapter, queue with retries, verdict mapping, ICPC scoring, freeze/reveal, practice mode, editorials, progress.
- React UI for all roles; docs; 53 automated tests.
- Design change found during testing: seat capacity moved from a conditional `$inc` counter to unique-indexed `Seat` rows (a MongoDB-compatible emulator lost concurrent updates; the new design is engine-independent).
- Bug found by tests and fixed: global `requireAuth` in an earlier-mounted router made the public scoreboard return 401.
## 0.0.0 — Phase 0 blueprint and scaffold

## Premium UI pass
- New design system (navy/royal blue/ivory + gold accent, Source Serif 4 headings), solid cards/buttons, dark-mode remaps.
- Public landing page at `/` for visitors (real `GET /events` data); signed-in users still get the Dashboard at `/`.
- University-branded login/register panel (decorative fake data removed); `BrandMark` placeholder until `apps/web/src/assets/brand/pub-logo.(svg|png)` is added.
- Fixes: web type errors (Plagiarism.tsx, lib/exporters.ts) and circular `@apply` in dark-mode CSS that broke `vite build`.
