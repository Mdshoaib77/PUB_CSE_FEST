# ARCHITECTURE

## 1. Overview

Monorepo (npm workspaces): `apps/web` (React+TS+Vite+Tailwind), `apps/server` (Express+TS+Mongoose), `packages/shared` (Zod schemas + TS types used by both, so types stay consistent).

```
festhub/
  apps/server/src/{config,models,routes,controllers,services,services/judge,middleware,sockets,utils,seed,tests}
  apps/web/src/{api,components,features,pages,hooks,routes,lib}
  packages/shared/src   (zod schemas, enums, DTO types)
  docs/
```

Layering on server: route -> validate (zod) -> auth -> authorize(role/ownership) -> controller -> service (business rules, transactions) -> model.

## 2. Authentication and authorization

- Passwords: bcrypt (cost 12) or argon2. Never returned in responses (`select:false`).
- Access token: JWT, 15 min, sent as Bearer header. Refresh token: opaque random string, stored hashed in DB, sent as httpOnly+Secure+SameSite cookie, rotated on use; logout revokes it.
- Roles: `organiser | coordinator | participant | volunteer | judge`. A user has one primary role plus optional extra `roles[]` (a participant can also be a volunteer for a different event). Per-event roles (e.g. judge for a given competition) are enforced by assignment records, not just the global role.
- Middleware `requireAuth`, `requireRole(...roles)`, and ownership checks in services (e.g. "judge may only read entries assigned to them").
- Frontend route guards are for UX only; server is authoritative.
- Rate limit on login/register and on submissions (express-rate-limit), helmet, CORS allow-list.

## 3. Scheduling and clash detection

Two intervals overlap iff `a.start < b.end && b.start < a.end` (touching ends are NOT a clash).

- Venue clash: on create/update of an Activity/Round, query `Activity` with same `venueId`, status not cancelled, excluding self, matching overlap. Reject with 409 and a body listing conflicting items (title, time range, venue) and a suggestion ("next free slot after HH:MM" computed from the venue's sorted bookings).
- Volunteer overlap: on Shift assignment, query the volunteer's other assigned shifts overlapping the interval (across all events). Also check the volunteer's declared Availability covers the shift (warning or hard rule, configurable).
- Race safety: conflicts are checked immediately before the insert. Known limitation: two _simultaneous_ conflicting inserts could both pass the check (no unique slot index); acceptable for a single-organiser workflow and listed in PROJECT_HANDOFF.md.
- Readiness dashboard re-runs the same detector over the whole event to list existing conflicts.

## 4. Registration, teams, waiting list (as implemented)

- **Seats are rows, not counters.** A seat is a `Seat {eventId, seatNo, registrationId}` document with a **unique index on (eventId, seatNo)**. To register: (1) insert the `Registration` (unique `(eventId, subjectKey)` blocks duplicates), (2) try to insert `Seat` for the lowest free `seatNo <= capacity`. Two concurrent requests can never get the same seat number, so **capacity can never be exceeded**, even on a MongoDB deployment without transactions and regardless of read/modify/write timing. If no seat is free the registration stays `waitlisted`.
- Why not `findOneAndUpdate({confirmedCount:{$lt:capacity}},{$inc})`? On real MongoDB that is atomic and also fine; but while testing we found emulators (FerretDB) lose concurrent conditional increments (16 winners for 5 seats). The unique-index design is correct on every engine, so we chose it.
- Waitlist order = registration creation order (ObjectId). Position shown = number of waitlisted registrations created before it + 1.
- Cancel/reject of a seat holder: the `Seat` row is **transferred** to the first waitlisted registration (guarded state change `waitlisted -> confirmed|pending_approval`), so nobody can jump the queue; if nobody waits the seat row is deleted. Raising capacity runs `fillFreeSeats`.
- `subjectKey` is `u:<userId>` or `t:<teamId>`; on cancel/reject it is rewritten (`cancelled:<id>`) which frees the unique key so the person can register again, while history is kept.
- Teams: leader creates a team (event-scoped), invites by email; accepting inserts `TeamMember` (unique `(eventId,userId)` = one team per person per event) then verifies the size cap and rolls back if two accepts raced past it. Only the leader registers the team; the roster is locked while a registration is active. Capacity counts registrations (a team = 1 seat).
- Approval: `requiresApproval` events hold a seat as `pending_approval`; approve -> `confirmed`; reject releases the seat to the waitlist.
- No multi-document transactions are used anywhere, so a standalone MongoDB works (Atlas free tier also works).

## 5. Competition entries, rubric, results

- `Rubric` (per competition activity): criteria[{name,maxScore,weight}].
- `Entry` has `currentVersion`; each upload/edit creates an immutable `EntryVersion {entryId, version, files/links, notes, submittedAt}` (unique `(entryId,version)`; concurrent saves retry with the next number). No update/delete route for versions. Submissions after deadline rejected.
- `JudgeAssignment {entryId, judgeId}` unique; conflict-of-interest check (judge not member of the team).
- `Score {entryId, judgeId, versionScored, criterionScores[], feedback}`; unique `(entryId, judgeId)`; validated against rubric max. Judges can only read/write for assigned entries.
- Results: Organiser triggers `computeResults` (average of judges' weighted totals) -> `Result` in `draft`; organiser reviews and `approve` -> `official` and visible to participants. Every transition writes `AuditLog`.

## 6. Volunteers, QR, issues, readiness

- `Availability {userId, eventId, slots[]}`; `Shift {eventId, activityId, start, end, requiredCount, role}`; `ShiftAssignment`; `Task {shiftId?, title, assigneeId, status}`; `ReplacementRequest {assignmentId, requestedBy, proposedVolunteerId?, reason, status: pending|approved|rejected}` — coordinator approval swaps assignee atomically after re-running the overlap check.
- QR: token = signed JWT/HMAC `{regId|assignmentId, eventId, jti}` stored hashed in `CheckInToken` (status active|revoked). Scan endpoint (volunteer/coordinator only) verifies signature, status, event, eligibility (registration confirmed), then inserts `CheckIn` with unique `(eventId, subjectId)`; a duplicate insert -> 409 "already checked in at HH:MM by X". Records operator and timestamp.
- Issues: `{eventId, title, priority, status: open|in_progress|resolved, ownerId, comments[], resolution}`.
- Readiness: computed endpoint returning a checklist: uncovered shifts, activities with no judges (competitions), venue/volunteer conflicts, missing venue/schedule, unpublished event, open high-priority issues -> overall % and RAG status.

## 7. Programming contest and judge

**Judge0 only** compiles/runs one program against one stdin with limits and returns a status. The team builds everything else:

- Problem bank, statement, constraints, samples, **hidden test cases storage** (separate collection, never selected by participant queries), languages, tags, limits.
- Contest lifecycle, registration and eligibility, server-enforced start/end, submission cooldown.
- Submission queue and orchestration: for each test case create a Judge0 submission (batch endpoint), collect results (poll with backoff or callback webhook), stop at first failure (ICPC semantic) or run all, aggregate to one verdict.
- Verdict mapping from Judge0 status.id: 3->AC, 4->WA, 5->TLE, 6->CE, 7-12->RE, 13/14 (internal/exec format)->`JE` (judge error, retried, never counted as a penalty). Memory-limit exceeded surfaces as RE/MLE (documented).
- Idempotency: `Submission.judgeJobKey` unique; retries update the same Submission, scoring is recomputed from Submission rows so duplicates cannot double count.
- Scoring (ICPC): rank by solved desc, then total penalty asc, then time of last accepted asc. Per solved problem penalty = minutes (floor) from contest start to first AC + 20 * wrong attempts before that AC. CE and JE do not count as wrong attempts; attempts after first AC are ignored. Standings are always recomputed server-side from Submission rows (cached, invalidated on verdict).
- Freeze: contest has `freezeAt`. Public scoreboard computes from submissions with `submittedAt < freezeAt` only (+ participant's own rows shown as "pending" after freeze). Organiser/judge role may fetch the unfrozen board. Post-freeze verdicts are not pushed over Socket.IO to public rooms. `reveal` action (organiser) or contest end + `revealAt` unlocks the final board.
- Practice mode: after contest end (or for problems not in a live contest), submissions have `mode:'practice'` and are excluded from contest standings by query filter.
- Editorials: `Editorial {problemId, contestId?, content, releaseAt}`; API returns 403 until `now >= max(contest.endAt, releaseAt)`.
- Progress: aggregate accepted problems by tag and difficulty per user from practice+contest submissions.
- Hidden test case protection: `TestCase` is a separate model, `select:false` on data fields, only the judge service and setters/organisers load them; error messages and logs contain only test index and verdict.
- Judge adapter interface `JudgeAdapter { submit(); getResult(); }` with `Judge0Adapter` (prod) and `MockJudgeAdapter` (tests only, clearly labelled).

## 8. Real-time (Socket.IO)

Rooms: `event:{id}`, `contest:{id}`, `user:{id}` (auth handshake with JWT). Events: `announcement:new`, `notification:new`, `registration:promoted`, `submission:verdict` (to owner only), `scoreboard:update` (public room gets frozen-safe data only), `checkin:new`. Optional: everything works with polling fallback via TanStack Query refetch.

## 9. Conventions

- Response: `{ success, data, meta? }` / error `{ success:false, error:{code,message,details?} }`; HTTP codes: 400 validation, 401, 403, 404, 409 conflict, 422 business rule.
- Central `errorHandler`, `AppError`, pino logger (no secrets/test data in logs), request-id.
- Testing: Vitest + Supertest + mongodb-memory-server (replica set mode); web: Vitest + Testing Library. Key suites: auth/RBAC, capacity race (Promise.all of N registrations), clash detection, duplicate check-in, scoring edge cases, freeze leakage, editorial release.
- Env: see `.env.example` files. Node >= 20. Deploy: Vercel/Netlify (web), Render/Railway (server), MongoDB Atlas, Judge0 via RapidAPI/self-hosted.
