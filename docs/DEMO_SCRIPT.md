# Demo script (target 8 minutes) — use the seeded data (`npm run seed -- --reset`), password `Password123`

Prepare: API + web running, two browsers/profiles (organiser, participant), Judge0 configured (or say honestly that judging uses the configured judge service).

| Time | Role                               | Show                                                                                                                                                                           |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0:00 | —                                  | 30-second overview: problem C5, stack, "Judge0 runs code; we built the contest logic".                                                                                         |
| 0:30 | organiser@                         | Events list → create an event (form validation) → add venue + activity → **create an overlapping activity at the same venue and show the actionable clash message** → publish. |
| 1:45 | participant1@                      | Register; open “Git Workshop” (capacity 2, approval) → show waiting list position; cancel one registration as staff and show the **automatic promotion + notification**.       |
| 2:45 | participant2@ + 3@                 | Team event: create team, invite by email, accept, register team.                                                                                                               |
| 3:30 | coordinator@                       | Readiness tab (uncovered shifts, missing judges) → assign volunteer; try double-booking to show the conflict message; approve a replacement request.                           |
| 4:30 | participant1@ + volunteer1@        | Show QR; operator scans (paste token); scan again → **duplicate rejected**.                                                                                                    |
| 5:15 | participant@ / judge@ / organiser@ | Poster competition: entry v1 → v2 (history kept); judge scores only the assigned entry; organiser computes + approves results; participants then see official results.         |
| 6:15 | participant1@                      | Contest “PUB CodeStorm”: problems, submit (AC then WA), live scoreboard; show freeze banner (organiser unfrozen view vs public).                                               |
| 7:15 | participant1@                      | After contest: practice mode, editorial locked/unlocked, progress by topic.                                                                                                    |
| 7:45 | judge@                             | Hidden test cases visible only to setter; show participant API has none. Close with limitations (see README).                                                                  |
