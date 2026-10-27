import express from 'express';
import fs from 'fs';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error';
import { ok } from './utils/http';
import auth from './routes/auth';
import users from './routes/users';
import roleRequests from './routes/roleRequests';
import events from './routes/events';
import registrations from './routes/registrations';
import ops from './routes/ops';
import judging from './routes/judging';
import contests from './routes/contests';
import uploads from './routes/uploads';
import deletes from './routes/deletes';
import admin from './routes/admin';
import certificates from './routes/certificates';
import sponsors from './routes/sponsors';
import sponsorPortal from './routes/sponsorPortal';
import plagiarism from './routes/plagiarism';
import feedback from './routes/feedback';
import leaderboard from './routes/leaderboard';
import insights from './routes/insights';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  // uploaded covers are embedded by the web app, which may live on another origin in production
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: env.clientOrigins, credentials: true }));
  app.use(express.json({ limit: '3mb' }));
  app.use(cookieParser());
  fs.mkdirSync(env.uploadDir, { recursive: true });
  app.use('/uploads/.private', (_q, res) => res.status(404).end()); // receipts etc. are served only through authenticated routes
  app.use('/uploads', express.static(env.uploadDir, { maxAge: '7d', index: false, dotfiles: 'deny', setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
  app.get('/api/v1/health', (_q, res) => ok(res, { status: 'ok', time: new Date() }));
  const v1 = express.Router();
  v1.use('/auth', auth);
  v1.use('/users', users);
  v1.use('/role-requests', roleRequests);
  v1.use('/admin', admin);
  v1.use(events);
  v1.use(uploads);
  v1.use(contests); // mounted BEFORE routers that call r.use(requireAuth) globally, so its public scoreboard stays public
  v1.use(certificates); // public GET /verify/:id + per-route auth; also before the routers that require auth globally
  v1.use(sponsors); // S7: each route authenticates itself
  v1.use(plagiarism); // S11: each route authenticates itself
  v1.use(feedback); // S13: each route authenticates itself
  v1.use(leaderboard); // S15: each route authenticates itself
  v1.use(insights); // S16: command center + my achievements, each route authenticates itself
  v1.use(sponsorPortal); // S8: public GET /events/:id/our-sponsors, sponsor portal, portal-user link
  v1.use(deletes); // every DELETE endpoint added by the universal-delete pass (each route authenticates itself)
  v1.use(registrations);
  v1.use(ops);
  v1.use(judging);
  app.use('/api/v1', v1);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
