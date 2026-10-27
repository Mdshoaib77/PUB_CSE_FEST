# IMPLEMENTATION ROADMAP (original plan; all phases were later implemented in one session — see PROJECT_HANDOFF.md)

| Phase                                                                                                                             | Target                      | Content                                        |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ---------------------------------------------- |
| 1 Foundation/Auth/RBAC                                                                                                            | 14–15 Oct                   | scaffold, auth, roles, shell, seed, tests      |
| 2 Events/Registration                                                                                                             | 16–18 Oct                   | events, teams, waitlist, capacity race tests   |
| 5 Contest + Judge (pulled forward, parallel by 2 members)                                                                         | 16–22 Oct                   | problem bank, Judge0 adapter, scoring, freeze  |
| 3 Scheduling/Volunteers                                                                                                           | 19–21 Oct                   | clash detection, shifts, readiness             |
| 4 QR + judging                                                                                                                    | 21–23 Oct                   | QR, versions, rubric, results                  |
| 6 Practice/Editorials                                                                                                             | 23–24 Oct                   | practice, editorial, progress                  |
| 7 Integration/QA                                                                                                                  | 25–27 Oct                   | full verification, matrix PASS/PARTIAL/FAIL    |
| 8 Release                                                                                                                         | 27–29 Oct (before 11:59 AM) | deploy, README with demo video link, checklist |
| Note: the prompt pack runs phases sequentially; with ~16 days, run Phase 5 in parallel with 2–3 on a separate branch, then merge. |

## High-risk items (build/de-risk first)

1. Judge0 access and key (get RapidAPI key or self-host NOW; test hello-world submission on day 1).
2. Mongo transactions need a replica set (use Atlas from day 1).
3. Waitlist/capacity race conditions.
4. Scoreboard freeze leakage via Socket.IO or alternate endpoints.
5. Hidden test case leakage.
6. Integration drift between 5 people: shared Zod types, small PRs, daily merge.

## Mandatory vs optional

Mandatory: all 10 official requirements. Optional: certificates, sponsor tracking, equipment, plagiarism, AI feedback. Add none until Phase 7 passes.
Evaluation reminder: every feature is tested live by evaluators, all members must explain code, commit messages after deadline must start with `fix:`/`ui:`; README needs demo video link, feature status table, sample logins per role.
