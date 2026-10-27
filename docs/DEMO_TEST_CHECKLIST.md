# Pre-recording / pre-evaluation checklist (tick each before recording)

**Environment**

- [ ] `npm run seed -- --reset` run on the demo database; `npm run dev:server` + `npm run dev:web` (or deployed URLs) up; `/api/v1/health` ok.
- [ ] Judge0 reachable: **Real judge smoke test** — as participant1 submit the sample solution (Python `a,b=map(int,input().split());print(a+b)`) to contest problem A; expect **AC**. Submit `print(0)`; expect **WA**. Submit a syntax error; expect **CE**. (This has NOT been verified by the authors of this repo yet.)
- [ ] The local fallback is ready (internet may be unreliable at evaluation): local MongoDB + local server.
      **Workflows**
- [ ] Organiser: create/edit/publish/cancel event; activities; clash message appears for same-venue overlap.
- [ ] Registration: individual, waiting list order, cancellation promotes next, approval, team invite accept/reject, deadline and capacity errors, duplicate registration error.
- [ ] Volunteer: availability, assignment, double-booking blocked, replacement approved by coordinator only, attendance, tasks, issue with resolution.
- [ ] QR: participant code, operator scan OK, second scan rejected, revoked code rejected, ineligible (cancelled) rejected.
- [ ] Judging: entry versions, judge sees only assigned entries, out-of-range score rejected, results draft → approved, participants cannot see draft.
- [ ] Contest: before start problems locked, running submit, after end submit blocked, scoreboard frozen after freeze time, organiser reveal, practice opens after end, editorial locked until end.
- [ ] Security: open a protected page logged out (redirect), call an organiser API as participant (403), try another user's submission (404), hidden tests not in any participant response (DevTools network).
- [ ] Mobile width (375px) walk-through of login, events, contest page.
      **Artifacts**
- [ ] Screenshots saved to `docs/screenshots/` and referenced in README. [ ] Demo video (5–10 min) uploaded; link at the top of README.
