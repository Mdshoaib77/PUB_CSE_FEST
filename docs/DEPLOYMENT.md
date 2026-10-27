# Deployment guide (instructions only — **no deployment was performed or verified** by the author of this document)

Suggested hosting: MongoDB Atlas (database), Render or Railway (API, needs WebSocket support), Vercel or Netlify (web). Any equivalents work.

## 1. MongoDB Atlas

1. Create a free cluster, a database user, and allow the API host's IPs (or `0.0.0.0/0` for a demo).
2. Copy the SRV connection string into the API's `MONGODB_URI` (include the db name, e.g. `/festhub`).
3. Transactions/replica-set features are **not** required by this app.

## 2. API (Render example)

- Root directory: repo root. Build: `npm ci && npm run build -w @festhub/server`. Start: `npm run start -w @festhub/server`. Node >= 20.
- Environment (hosting dashboard only — never commit): `NODE_ENV=production`, `PORT` (provided), `MONGODB_URI`, `JWT_ACCESS_SECRET`, `QR_TOKEN_SECRET` (random 48+ bytes each), `CLIENT_ORIGIN=https://<your-web-domain>` (comma-separate multiple), `JUDGE_ADAPTER=judge0`, `JUDGE0_BASE_URL`, `JUDGE0_API_KEY`, `JUDGE0_API_HOST` (or `JUDGE0_AUTH_TOKEN`).
- The server throws at start if required secrets are missing in production or if `JUDGE_ADAPTER=mock`.
- Cookies: in production the refresh cookie is `Secure; SameSite=None`, so web and API must both be served over HTTPS. `trust proxy` is enabled for hosts that terminate TLS.
- Health check: `GET /api/v1/health`.

## 3. Web (Vercel/Netlify)

- Root directory `apps/web` (or repo root with build `npm ci && npm run build -w @festhub/web`, output `apps/web/dist`).
- Environment: `VITE_API_BASE_URL=https://<api-domain>/api/v1`, `VITE_SOCKET_URL=https://<api-domain>`.
- Add an SPA fallback rewrite to `/index.html` (Netlify `_redirects`: `/* /index.html 200`; Vercel `rewrites`).

## 4. Seed demo data (synthetic only)

`MONGODB_URI=<atlas uri> npm run seed -- --reset` (**--reset wipes the database**). Accounts and password are printed; see README.

## 5. Judge0

See `docs/JUDGE0.md`. Keep the key only in the API environment.

## 6. Local setup (no cloud)

`docker run -d -p 27017:27017 mongo:7`, copy both `.env.example` files to `.env`, `npm install`, `npm run seed`, `npm run dev:server`, `npm run dev:web` (open http://localhost:5173). Judging needs Judge0 credentials; everything else works without.
