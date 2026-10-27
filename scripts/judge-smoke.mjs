// Real-judge smoke test. Talks to Judge0 directly (no FestHub server, no dependencies).
// Usage: node scripts/judge-smoke.mjs [http://localhost:2358]
// Expected: AC, WA, CE, TLE, RE for the five programs below. Exit code 1 if any differs.
const base = (process.argv[2] ?? process.env.JUDGE0_BASE_URL ?? 'http://localhost:2358').replace(/\/$/, '');
const headers = { 'Content-Type': 'application/json' };
if (process.env.JUDGE0_AUTH_TOKEN) headers['X-Auth-Token'] = process.env.JUDGE0_AUTH_TOKEN;
if (process.env.JUDGE0_API_KEY) headers['X-RapidAPI-Key'] = process.env.JUDGE0_API_KEY;
if (process.env.JUDGE0_API_HOST) headers['X-RapidAPI-Host'] = process.env.JUDGE0_API_HOST;
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const MAP = { 3: 'AC', 4: 'WA', 5: 'TLE', 6: 'CE' };
const verdict = (id) => MAP[id] ?? (id >= 7 && id <= 12 ? 'RE' : `JE(${id})`);
const cases = [
  ['AC', 71, 'a,b=map(int,input().split())\nprint(a+b)', '2 3', '5'],
  ['WA', 71, 'print(0)', '2 3', '5'],
  ['CE', 54, 'int main( { return 0 }', '', ''],
  ['TLE', 71, 'while True:\n    pass', '', '', 2],
  ['RE', 71, 'print(1//0)', '', ''],
];
for (const [expect, lang, code, stdin, out, cpu = 2] of cases) {
  const r = await fetch(`${base}/submissions?base64_encoded=true&wait=false`, {
    method: 'POST', headers,
    body: JSON.stringify({ language_id: lang, source_code: b64(code), stdin: b64(stdin), expected_output: b64(out), cpu_time_limit: cpu, memory_limit: 128000 }),
  });
  if (!r.ok) { console.error('submit failed', r.status, await r.text()); process.exit(1); }
  const { token } = await r.json();
  let s;
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 1000));
    s = await (await fetch(`${base}/submissions/${token}?base64_encoded=true`, { headers })).json();
    if (s.status?.id > 2) break;
  }
  const got = verdict(s.status?.id);
  console.log(`${got === expect ? 'OK  ' : 'FAIL'} expected ${expect}, got ${got}`);
  if (got !== expect) process.exitCode = 1;
}
