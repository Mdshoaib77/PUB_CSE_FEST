import { Router, type Request } from 'express';
import { z } from 'zod';
import { validateLeaderboardConfig, TIE_BREAKS, type ExportColumn } from '@festhub/shared';
import { Event, LeaderboardSetting } from '../models';
import { hasRole, isStaff, requireAuth, requireRole } from '../middleware/auth';
import { notFound, unprocessable } from '../utils/errors';
import { ok, oid, parse, wrap } from '../utils/http';
import { log_action } from '../utils/audit';
import { sendCsv } from '../utils/exporters';
import { exportFileName } from '@festhub/shared';
import { PDF_COLORS, pdfDate, renderTablePdf, toneForRank, type TableRow } from '../services/brandedPdf';
import { enrichLeaderboardRows } from '../services/leaderboardView';
import { buildLeaderboard, getSettings, type LeaderboardEntryRow } from '../services/leaderboard';

/**
 * S15 per-event leaderboard. Mounted at /api/v1; every route authenticates itself.
 *   GET /events/:id/leaderboard         settings + one row per participant with the full score breakdown
 *   GET /events/:id/leaderboard.csv|.pdf   the same table as a download
 *   PUT /events/:id/leaderboard/config  organiser/admin: weights, plagiarism penalty, tie-break, published
 * Staff (organiser, coordinator, judge, admin) always see it. Everyone else gets 404 until an organiser publishes it,
 * then sees the same transparent breakdown. Scores are computed on every request, never stored.
 */
const r = Router();

async function access(req: Request, eventId: string) {
  const ev = await Event.findById(eventId).select('title');
  if (!ev) throw notFound('Event not found');
  const settings = await getSettings(eventId);
  if (!hasRole(req.user, 'organiser', 'coordinator', 'judge') && !settings.published) throw notFound('The leaderboard has not been published yet');
  return { ev, settings };
}

r.get(
  '/events/:id/leaderboard',
  requireAuth,
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    const { ev } = await access(req, id);
    const lb = await buildLeaderboard(id);
    const rows = await enrichLeaderboardRows(lb.rows, id, req.user!.id, isStaff(req.user));
    ok(res, { ...lb, rows, event: { id, title: ev.title }, canConfigure: hasRole(req.user, 'organiser') });
  }),
);

const fmt = (v: number | null) => (v === null ? '' : v);
const columns: ExportColumn<LeaderboardEntryRow>[] = [
  { header: 'Rank', value: (x) => (x.rank === null ? '' : x.tied ? `${x.rank} (tie)` : x.rank), width: 0.7 },
  { header: 'Participant', value: 'name', width: 2.2 },
  { header: 'Judge %', value: (x) => fmt(x.judgePercent), width: 0.9 },
  { header: 'Judge pts', value: (x) => fmt(x.judgePoints), width: 0.9 },
  { header: 'AI %', value: (x) => fmt(x.aiPercent), width: 0.8 },
  { header: 'AI pts', value: (x) => fmt(x.aiPoints), width: 0.8 },
  { header: 'Base', value: (x) => fmt(x.base), width: 0.8 },
  { header: 'Confirmed plagiarism pairs', value: 'confirmedPairs', width: 1.2 },
  { header: 'Penalty', value: (x) => (x.penalty ? -x.penalty : 0), width: 0.8 },
  { header: 'Final', value: (x) => fmt(x.final), width: 0.8 },
];

for (const ext of ['csv', 'pdf'] as const) {
  r.get(
    `/events/:id/leaderboard.${ext}`,
    requireAuth,
    wrap(async (req, res) => {
      const id = oid(req.params.id);
      const { ev } = await access(req, id);
      const lb = await buildLeaderboard(id);
      const name = `leaderboard-${ev.title}`;
      if (ext === 'csv') return sendCsv(res, name, lb.rows, columns);
      const rows = await enrichLeaderboardRows(lb.rows, id, req.user!.id, false);
      const P = (v: number | null) => (v === null ? '-' : `${v}%`);
      const tableRows: TableRow[] = rows.map((x) => {
        const tone = toneForRank(x.rank);
        const podium = x.rank !== null && x.rank <= 3;
        return {
          tint: podium ? tone.soft : undefined,
          stripe: podium ? tone.fill : undefined,
          cells: [
            { text: x.rank === null ? '-' : String(x.rank), align: 'center', badge: { fill: tone.fill, color: PDF_COLORS.white }, sub: x.tied ? 'tie' : undefined },
            { text: x.name, bold: true, sub: x.kind === 'team' ? `Team${x.members.length ? ` - ${x.members.join(', ')}` : ''}` : 'Individual' },
            { text: P(x.judgePercent), color: PDF_COLORS.brand, bold: true, sub: x.judgePoints === null ? 'no score yet' : `${x.judgePoints} pts, ${x.judgeScores} score${x.judgeScores === 1 ? '' : 's'}` },
            { text: P(x.aiPercent), color: PDF_COLORS.violet, bold: true, sub: x.aiPoints === null ? 'no score yet' : `${x.aiPoints} pts, ${x.feedbackCount} feedback` },
            { text: P(x.base), bold: true },
            x.confirmedPairs ? { text: `-${x.penalty}`, color: PDF_COLORS.red, bold: true, sub: `${x.confirmedPairs} confirmed pair${x.confirmedPairs === 1 ? '' : 's'}` } : { text: 'none', color: PDF_COLORS.muted },
            { text: P(x.final), bold: true, align: 'right', color: x.rank === 1 ? '#7a5a0c' : PDF_COLORS.ink, bar: x.final === null ? undefined : { value: x.final, color: tone.fill } },
          ],
        };
      });
      const bytes = await renderTablePdf({
        landscape: true,
        brandLine: 'FestHub | Leaderboard',
        title: ev.title,
        subtitle: `Leaderboard  |  ${rows.length} participant${rows.length === 1 ? '' : 's'}  |  Generated ${pdfDate(new Date())}`,
        columns: [
          { header: 'Rank', width: 0.7, align: 'center' },
          { header: 'Participant', width: 3.2 },
          { header: 'Judge score', width: 1.3 },
          { header: 'AI-suggested', width: 1.3 },
          { header: 'Base', width: 0.8 },
          { header: 'Plagiarism', width: 1.2 },
          { header: 'Final', width: 1.1, align: 'right' },
        ],
        rows: tableRows,
        emptyText: 'Nothing to rank yet.',
        footerLeft: `FestHub leaderboard - ${ev.title}`,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${exportFileName(name, 'pdf')}"`);
      res.send(Buffer.from(bytes));
    }),
  );
}

const configBody = z.object({
  judgeWeight: z.number().min(0).max(100),
  aiWeight: z.number().min(0).max(100),
  penaltyPerPair: z.number().min(0).max(100),
  maxPenalty: z.number().min(0).max(100),
  tieBreak: z.enum(TIE_BREAKS),
  published: z.boolean().optional(),
});

r.put(
  '/events/:id/leaderboard/config',
  requireAuth,
  requireRole('organiser'),
  wrap(async (req, res) => {
    const id = oid(req.params.id);
    if (!(await Event.exists({ _id: id }))) throw notFound('Event not found');
    const b = parse(configBody, req.body);
    const errs = validateLeaderboardConfig(b);
    if (errs.length) throw unprocessable(errs.join('; '), { errors: errs });
    const before = await getSettings(id);
    const doc = await LeaderboardSetting.findOneAndUpdate(
      { eventId: id },
      { $set: { ...b, published: b.published ?? before.published, updatedBy: req.user!.id } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await log_action(req.user, 'leaderboard.config', { type: 'Event', id }, { before, after: { ...b, published: doc.published } }, req);
    ok(res, await getSettings(id));
  }),
);

export default r;
