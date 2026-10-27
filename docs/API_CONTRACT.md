# API CONTRACT (v1) — implemented

Base: `/api/v1`. JSON only. Auth: `Authorization: Bearer <access token>` (15 min); refresh via httpOnly cookie `refresh_token` (`POST /auth/refresh`).

**Envelope** — success: `{ "success": true, "data": ..., "meta"?: ... }`; error: `{ "success": false, "error": { "code", "message", "details"? } }`.
**Status codes** — 400 validation (`details` lists field errors) · 401 not signed in · 403 forbidden (role/ownership) · 404 not found (also used to avoid revealing hidden resources) · 409 conflict/duplicate (venue clash, already checked in, double-booking…) · 422 business-rule violation · 429 submission cooldown · 500 internal (never contains internal detail).
**Role aliases used in the table** — staff = organiser + coordinator; setter = judge + organiser. "auth" = any signed-in user; further ownership checks (own entry, own registration, assigned judge…) are enforced in the handler.
**Realtime (Socket.IO)** — handshake `auth.token`; rooms `user:<id>` (private), `event:<id>`, `contest:<id>` (join by request). Events: `notification:new`, `announcement:new`, `checkin:new`, `submission:verdict` (owner only), `scoreboard:update` (payload is only `{contestId}`; clients re-fetch the freeze-aware REST endpoint, so a frozen board can never leak through a socket).

## Endpoints (generated from the route files — 107 rows incl. header)

| Method | Path                                        | Source           | Access                                                |
| ------ | ------------------------------------------- | ---------------- | ----------------------------------------------------- |
| POST   | `/api/v1/auth/register`                     | auth.ts          | public (rate-limited)                                 |
| POST   | `/api/v1/auth/login`                        | auth.ts          | public (rate-limited)                                 |
| POST   | `/api/v1/auth/refresh`                      | auth.ts          | refresh cookie                                        |
| POST   | `/api/v1/auth/logout`                       | auth.ts          | refresh cookie                                        |
| GET    | `/api/v1/auth/me`                           | auth.ts          | auth                                                  |
| GET    | `/api/v1/problems`                          | contests.ts      | auth                                                  |
| POST   | `/api/v1/problems`                          | contests.ts      | auth; roles: judge, organiser                         |
| PATCH  | `/api/v1/problems/:id`                      | contests.ts      | auth; roles: judge, organiser                         |
| PUT    | `/api/v1/problems/:id/testcases`            | contests.ts      | auth; roles: judge, organiser                         |
| GET    | `/api/v1/problems/:id/testcases`            | contests.ts      | auth; roles: judge, organiser                         |
| GET    | `/api/v1/problems/:id`                      | contests.ts      | auth                                                  |
| POST   | `/api/v1/contests`                          | contests.ts      | auth; roles: organiser                                |
| PATCH  | `/api/v1/contests/:id`                      | contests.ts      | auth; roles: organiser                                |
| GET    | `/api/v1/contests`                          | contests.ts      | auth                                                  |
| GET    | `/api/v1/contests/:id`                      | contests.ts      | auth                                                  |
| POST   | `/api/v1/contests/:id/register`             | contests.ts      | auth                                                  |
| POST   | `/api/v1/contests/:id/teams/:teamId/register` | contests.ts    | auth (team leader)                                    |
| DELETE | `/api/v1/contests/:id/teams/:teamId/register` | contests.ts    | auth (team leader / organiser, before the start)      |
| GET    | `/api/v1/contests/:id/registrations`        | contests.ts      | organiser, coordinator                                |
| GET    | `/api/v1/contests/:id/problems`             | contests.ts      | auth                                                  |
| POST   | `/api/v1/contests/:id/submissions`          | contests.ts      | auth                                                  |
| GET    | `/api/v1/contests/:id/submissions/me`       | contests.ts      | auth                                                  |
| GET    | `/api/v1/contests/:id/submissions`          | contests.ts      | auth; roles: judge, organiser                         |
| GET    | `/api/v1/submissions/:id`                   | contests.ts      | auth                                                  |
| POST   | `/api/v1/submissions/:id/rejudge`           | contests.ts      | auth; roles: judge, organiser                         |
| GET    | `/api/v1/contests/:id/scoreboard`           | contests.ts      | public                                                |
| GET    | `/api/v1/contests/:id/scoreboard/full`      | contests.ts      | auth; roles: judge, organiser                         |
| POST   | `/api/v1/contests/:id/reveal`               | contests.ts      | auth; roles: organiser                                |
| POST   | `/api/v1/problems/:id/practice-submissions` | contests.ts      | auth                                                  |
| GET    | `/api/v1/me/submissions`                    | contests.ts      | auth                                                  |
| GET    | `/api/v1/me/progress`                       | contests.ts      | auth                                                  |
| PUT    | `/api/v1/problems/:id/editorial`            | contests.ts      | auth; roles: judge, organiser                         |
| GET    | `/api/v1/problems/:id/editorial`            | contests.ts      | auth                                                  |
| GET    | `/api/v1/venues`                            | events.ts        | auth                                                  |
| POST   | `/api/v1/venues`                            | events.ts        | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/events`                            | events.ts        | optional auth                                         |
| GET    | `/api/v1/events/:id`                        | events.ts        | optional auth                                         |
| POST   | `/api/v1/events`                            | events.ts        | auth; roles: organiser                                |
| PATCH  | `/api/v1/events/:id`                        | events.ts        | auth; roles: organiser                                |
| POST   | `/api/v1/events/:id/publish`                | events.ts        | auth; roles: organiser                                |
| POST   | `/api/v1/events/:id/cancel`                 | events.ts        | auth; roles: organiser                                |
| GET    | `/api/v1/events/:id/registrations`          | events.ts        | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/events/:id/activities`             | events.ts        | auth                                                  |
| POST   | `/api/v1/events/:id/activities`             | events.ts        | auth; roles: organiser, coordinator                   |
| PATCH  | `/api/v1/activities/:id`                    | events.ts        | auth; roles: organiser, coordinator                   |
| DELETE | `/api/v1/activities/:id`                    | events.ts        | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/events/:id/schedule/conflicts`     | events.ts        | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/events/:id/readiness`              | events.ts        | auth; roles: organiser, coordinator                   |
| PUT    | `/api/v1/activities/:id/rubric`             | judging.ts       | auth; roles: organiser                                |
| GET    | `/api/v1/activities/:id/rubric`             | judging.ts       | auth                                                  |
| POST   | `/api/v1/activities/:id/entries`            | judging.ts       | auth                                                  |
| PUT    | `/api/v1/entries/:id`                       | judging.ts       | auth                                                  |
| GET    | `/api/v1/entries/:id/versions`              | judging.ts       | auth                                                  |
| GET    | `/api/v1/activities/:id/entries`            | judging.ts       | auth                                                  |
| POST   | `/api/v1/entries/:id/judges`                | judging.ts       | auth; roles: organiser                                |
| DELETE | `/api/v1/entries/:id/judges/:judgeId`       | judging.ts       | auth; roles: organiser                                |
| GET    | `/api/v1/me/assigned-entries`               | judging.ts       | auth; roles: judge                                    |
| PUT    | `/api/v1/entries/:id/score`                 | judging.ts       | auth; roles: judge                                    |
| POST   | `/api/v1/activities/:id/results/compute`    | judging.ts       | auth; roles: organiser                                |
| POST   | `/api/v1/activities/:id/results/approve`    | judging.ts       | auth; roles: organiser                                |
| GET    | `/api/v1/activities/:id/results`            | judging.ts       | auth                                                  |
| GET    | `/api/v1/audit`                             | judging.ts       | auth; roles: organiser                                |
| PUT    | `/api/v1/me/availability/:eventId`          | ops.ts           | auth; roles: volunteer, organiser, coordinator        |
| GET    | `/api/v1/me/availability/:eventId`          | ops.ts           | auth                                                  |
| GET    | `/api/v1/events/:id/availability`           | ops.ts           | auth; roles: organiser, coordinator                   |
| POST   | `/api/v1/events/:id/shifts`                 | ops.ts           | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/events/:id/shifts`                 | ops.ts           | auth                                                  |
| POST   | `/api/v1/shifts/:id/assign`                 | ops.ts           | auth; roles: coordinator, organiser                   |
| DELETE | `/api/v1/assignments/:id`                   | ops.ts           | auth; roles: coordinator, organiser                   |
| GET    | `/api/v1/me/shifts`                         | ops.ts           | auth                                                  |
| POST   | `/api/v1/assignments/:id/attendance`        | ops.ts           | auth; roles: organiser, coordinator                   |
| POST   | `/api/v1/assignments/:id/replacement`       | ops.ts           | auth                                                  |
| GET    | `/api/v1/events/:id/replacements`           | ops.ts           | auth; roles: organiser, coordinator                   |
| POST   | `/api/v1/replacements/:id/approve`          | ops.ts           | auth; roles: coordinator, organiser                   |
| POST   | `/api/v1/replacements/:id/reject`           | ops.ts           | auth; roles: coordinator, organiser                   |
| POST   | `/api/v1/events/:id/tasks`                  | ops.ts           | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/events/:id/tasks`                  | ops.ts           | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/me/tasks`                          | ops.ts           | auth                                                  |
| PATCH  | `/api/v1/tasks/:id/complete`                | ops.ts           | auth                                                  |
| POST   | `/api/v1/events/:id/announcements`          | ops.ts           | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/events/:id/announcements`          | ops.ts           | auth                                                  |
| POST   | `/api/v1/events/:id/issues`                 | ops.ts           | auth; roles: organiser, coordinator, volunteer, judge |
| GET    | `/api/v1/events/:id/issues`                 | ops.ts           | auth; roles: organiser, coordinator, volunteer, judge |
| PATCH  | `/api/v1/issues/:id`                        | ops.ts           | auth; roles: organiser, coordinator, volunteer, judge |
| POST   | `/api/v1/issues/:id/comments`               | ops.ts           | auth; roles: organiser, coordinator, volunteer, judge |
| GET    | `/api/v1/me/checkin-token/:eventId`         | ops.ts           | auth                                                  |
| POST   | `/api/v1/checkin/scan`                      | ops.ts           | auth; roles: volunteer, coordinator, organiser        |
| POST   | `/api/v1/checkin/tokens/:id/revoke`         | ops.ts           | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/events/:id/checkin-tokens`         | ops.ts           | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/events/:id/attendance`             | ops.ts           | auth; roles: organiser, coordinator                   |
| POST   | `/api/v1/events/:id/register`               | registrations.ts | auth                                                  |
| DELETE | `/api/v1/registrations/:id`                 | registrations.ts | auth                                                  |
| POST   | `/api/v1/registrations/:id/approve`         | registrations.ts | auth; roles: organiser, coordinator                   |
| POST   | `/api/v1/registrations/:id/reject`          | registrations.ts | auth; roles: organiser, coordinator                   |
| GET    | `/api/v1/me/registrations`                  | registrations.ts | auth                                                  |
| POST   | `/api/v1/events/:id/teams`                  | registrations.ts | auth                                                  |
| GET    | `/api/v1/teams/:id`                         | registrations.ts | auth                                                  |
| POST   | `/api/v1/teams/:id/invitations`             | registrations.ts | auth                                                  |
| GET    | `/api/v1/me/invitations`                    | registrations.ts | auth                                                  |
| POST   | `/api/v1/invitations/:id/accept`            | registrations.ts | auth                                                  |
| POST   | `/api/v1/invitations/:id/reject`            | registrations.ts | auth                                                  |
| DELETE | `/api/v1/teams/:id/members/:userId`         | registrations.ts | auth                                                  |
| GET    | `/api/v1/notifications`                     | registrations.ts | auth                                                  |
| POST   | `/api/v1/notifications/read-all`            | registrations.ts | auth                                                  |
| POST   | `/api/v1/notifications/:id/read`            | registrations.ts | auth                                                  |
| GET    | `/api/v1/me/dashboard`                      | registrations.ts | auth                                                  |
| GET    | `/api/v1/users/`                            | users.ts         | auth; roles: organiser, coordinator                   |
| PATCH  | `/api/v1/users/:id/roles`                   | users.ts         | auth; roles: organiser                                |
