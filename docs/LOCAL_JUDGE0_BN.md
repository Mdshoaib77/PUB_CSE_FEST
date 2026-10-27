# লোকাল Judge0 + MongoDB চালানোর নিয়ম (বাংলা)

Requirement #9 পুরো পূরণ করতে **আসল Judge0** লাগবে (mock শুধু টেস্টের জন্য, কোড চালায় না)।

## ধাপ
1. Docker Desktop (Linux/WSL2 ব্যাকএন্ড) চালু করুন।
2. প্রজেক্ট ফোল্ডারে: `docker compose up -d` (প্রথমবার কয়েক মিনিট লাগবে)।
3. ২০-৩০ সেকেন্ড পর: `curl http://localhost:2358/languages` — ভাষার লিস্ট এলে Judge0 ঠিক আছে।
4. `node scripts/judge-smoke.mjs` — প্রত্যাশিত ফল: `OK expected AC`, `WA`, `CE`, `TLE`, `RE` পাঁচটাই।
5. `apps/server/.env`-এ থাকবে: `JUDGE_ADAPTER=judge0`, `JUDGE0_BASE_URL=http://localhost:2358`, `MONGODB_URI=mongodb://127.0.0.1:27017/festhub`
6. `npm install` → `npm run seed -- --reset` → `npm run dev:server` ও `npm run dev:web`।
7. `npm test` (লোকাল Mongo-তে) — ৫০টি সার্ভার টেস্ট পাস হওয়া উচিত।

## cgroup সমস্যা
Workers ক্র্যাশ করে `cgroup` এরর দিলে (নতুন Docker/WSL2-এ হয়): Linux-এ কার্নেল প্যারামিটার `systemd.unified_cgroup_hierarchy=0` দিয়ে cgroup v1 চালু করুন, অথবা RapidAPI-এর Judge0 CE কী ব্যবহার করুন (`JUDGE0_BASE_URL`, `JUDGE0_API_KEY`, `JUDGE0_API_HOST` সেট করুন)।
