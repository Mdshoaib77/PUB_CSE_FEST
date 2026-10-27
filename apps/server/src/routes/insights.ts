import { Router } from 'express';
import { exportFileName } from '@festhub/shared';
import { User } from '../models';
import { requireAuth, requireRole } from '../middleware/auth';
import { ok, wrap } from '../utils/http';
import { pdfDate, renderPortfolioPdf } from '../services/brandedPdf';
import { buildCommandCenter } from '../services/commandCenter';
import { buildAchievements } from '../services/achievements';

/**
 * S16, mounted at /api/v1, each route authenticates itself.
 *   GET /command-center                      organiser/admin: live KPIs (registrations, sponsors, submissions, certificates)
 *   GET /me/achievements                     any signed-in user: own certificates, published feedback, rank/score per published event
 *   GET /me/achievements/portfolio.pdf       the same as a downloadable PDF
 */
const r = Router();

r.get('/command-center', requireAuth, requireRole('organiser'), wrap(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await buildCommandCenter());
}));

r.get('/me/achievements', requireAuth, wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  ok(res, await buildAchievements(req.user!.id));
}));

r.get('/me/achievements/portfolio.pdf', requireAuth, wrap(async (req, res) => {
  const a = await buildAchievements(req.user!.id);
  const me = await User.findById(req.user!.id).select('name');
  const name = me?.name ?? 'Participant';
  const bytes = await renderPortfolioPdf({
    name,
    generated: pdfDate(new Date()),
    brandLine: 'FestHub | Achievement portfolio',
    summary: { certificates: a.summary.certificates, results: a.summary.events, feedback: a.summary.feedback, bestRank: a.summary.bestRank },
    certificates: a.certificates.map((c) => ({
      title: c.positionLabel ?? c.typeLabel,
      badge: (c.positionLabel ? c.positionLabel.split(' - ')[0] : c.typeLabel) || c.typeLabel,
      rank: c.type === 'winner' ? 1 : c.type === 'runner_up' ? 2 : null,
      recipient: c.kind === 'team' ? `Team ${c.teamName ?? c.recipientName}` : c.recipientName,
      members: c.members,
      event: c.eventTitle,
      date: pdfDate(c.eventDate),
      id: c.id,
    })),
    results: a.results.map((x) => ({ event: x.eventTitle, participant: x.kind === 'team' ? `Team ${x.participant}` : x.participant, rank: x.rank, ranked: x.ranked, tied: x.tied, final: x.final, judge: x.judgePercent, ai: x.aiPercent, penalty: x.penalty })),
    feedback: a.feedback.map((f) => ({ event: f.eventTitle ?? 'Code feedback', points: f.points, maxPoints: f.maxPoints, percent: f.percent, summary: f.summary || (f.rating ? `Quality ${f.rating}/10` : ''), date: pdfDate(f.publishedAt) })),
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(`FestHub-Portfolio-${name}`, 'pdf')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(Buffer.from(bytes));
}));

export default r;
