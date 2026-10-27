# Judge0 integration — configuration, limits, failure modes

**What Judge0 does for us:** compiles and runs ONE program against ONE stdin inside its own sandbox, with CPU/memory limits, and reports a status. **What the team built around it** (all in this repo): problem bank and hidden test storage, contest lifecycle and server-side timing, the submission queue and retries, running every test case and aggregating to one verdict, verdict mapping, ICPC scoring, standings recalculation, scoreboard freeze/reveal, practice mode, editorial release, progress and audit trail. Submitted code is **never executed on the Express server**.

## Configuration (server environment only — never `VITE_*`)

| Variable                                                         | Meaning                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `JUDGE_ADAPTER`                                                  | `judge0` (default) or `mock` (tests only; the server refuses to start with `mock` when `NODE_ENV=production`) |
| `JUDGE0_BASE_URL`                                                | e.g. `https://judge0-ce.p.rapidapi.com` or your self-hosted URL                                               |
| `JUDGE0_API_KEY`, `JUDGE0_API_HOST`                              | RapidAPI pair, sent as `X-RapidAPI-Key` / `X-RapidAPI-Host`                                                   |
| `JUDGE0_AUTH_TOKEN`                                              | self-hosted instance with auth enabled, sent as `X-Auth-Token`                                                |
| `JUDGE0_LANGUAGE_IDS`                                            | JSON override of language ids                                                                                 |
| `JUDGE0_POLL_MS`, `JUDGE0_POLL_TIMEOUT_MS`, `JUDGE_MAX_ATTEMPTS` | polling interval, per-test timeout, retries on outage                                                         |

## Language identifiers (defaults, Judge0 CE) — **verify on your instance with `GET /languages`**

`c` 50 · `cpp` 54 · `java` 62 · `python` 71. If your instance differs, set `JUDGE0_LANGUAGE_IDS`.

## Flow

1. `POST /contests/:id/submissions` (or practice) validates role, registration, **server-clock** timing, language and cooldown, stores `Submission{status:'queued'}` and returns 202.
2. The in-process queue (3 parallel jobs) loads the hidden test cases (`select:false` fields, only here) and calls `POST {base}/submissions?base64_encoded=true&wait=false` per test with `cpu_time_limit` (problem time limit) and `memory_limit` (KB), then polls `GET /submissions/:token` until `status_id > 2`.
3. First non-AC test stops the run (ICPC semantics). Mapping: 3→AC, 4→WA, 5→TLE, 6→CE, 7–12→RE, 13/14/unknown→**JE** (judge error: never counted as an attempt or penalty).
4. Finalisation is a guarded update (`status:'running'` only), so retries/duplicate jobs cannot overwrite a final verdict. `Idempotency-key` semantics: the client's `idempotencyKey` is hashed into the unique `judgeJobKey`, so a retried request returns the same submission.

## Limits and assumptions

- Time/memory limits are _passed to_ Judge0; enforcement and its maximums are Judge0's (hosted plans cap CPU time and memory and rate-limit requests; one submission = (#tests) Judge0 submissions, so a 20-test problem under the free RapidAPI quota will be slow — use a self-hosted instance for the demo or keep test counts small).
- Hidden inputs/expected outputs are sent to the judge service over HTTPS (inherent to using a hosted judge). Use self-hosted Judge0 if that matters.
- Polling is used (no callbacks), so the API needs outbound HTTPS to the judge only.
- The queue is in-memory. Queued/running submissions are re-enqueued on server start (`resumeQueued`). Single API instance assumed.

## Failure modes

| Failure                                        | Behaviour                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Judge0 down / 5xx / unreachable / poll timeout | retried up to `JUDGE_MAX_ATTEMPTS` with backoff, then verdict **JE**; organiser/setter can **rejudge** (`POST /submissions/:id/rejudge`, audited) |
| Credentials missing                            | `JudgeUnavailableError` → JE (visible in logs, not to users)                                                                                      |
| Compile error                                  | CE on first test, not penalised                                                                                                                   |
| Server restart mid-judging                     | jobs re-queued on start                                                                                                                           |

## How it was verified

`apps/server/src/tests/judge0.test.ts` runs the **production adapter** against a local HTTP stub implementing Judge0's REST shape (headers, base64 payload, limits, polling, status mapping, outage, timeout). `contest.test.ts` exercises the full pipeline using the **explicitly named MOCK adapter** (`services/judge/mock.ts`). **Not yet run against a real Judge0 service** — do this once with real credentials (see DEMO_TEST_CHECKLIST.md, step "Real judge smoke test").
