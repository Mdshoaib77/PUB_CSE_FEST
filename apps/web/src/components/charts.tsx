/** S16 tiny dependency-free charts (inline SVG / CSS) that follow the dark-mode utilities. */
export function BarList({ rows, unit = '', empty = 'No data yet' }: { rows: { label: string; value: number }[]; unit?: string; empty?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="space-y-2" role="list">
      {rows.map((r) => (
        <li key={r.label} className="text-sm">
          <div className="mb-0.5 flex justify-between gap-2"><span className="truncate">{r.label}</span><span className="font-medium tabular-nums">{r.value}{unit}</span></div>
          <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-700" aria-hidden><div className="h-2 rounded-full bg-gradient-to-r from-brand-600 to-brand-800" style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** Line + area chart of a daily series (oldest first). */
export function Sparkline({ points, label }: { points: { day: string; count: number }[]; label: string }) {
  const W = 300, H = 70, P = 4;
  const max = Math.max(1, ...points.map((p) => p.count));
  const x = (i: number) => P + (points.length < 2 ? 0 : (i / (points.length - 1)) * (W - 2 * P));
  const y = (v: number) => H - P - (v / max) * (H - 2 * P);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.count).toFixed(1)}`).join(' ');
  const total = points.reduce((n, p) => n + p.count, 0);
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-20 w-full" role="img" aria-label={`${label}: ${total} in the last ${points.length} days`}>
        {points.length > 0 && <path d={`${line} L${x(points.length - 1).toFixed(1)},${H - P} L${x(0).toFixed(1)},${H - P} Z`} className="fill-brand-500/15" />}
        <path d={line} fill="none" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="stroke-brand-500" />
      </svg>
      <figcaption className="text-xs text-slate-500">{label}: {total} in the last {points.length} days (peak {max === 1 && total === 0 ? 0 : max}/day)</figcaption>
    </figure>
  );
}

/** Two-part progress bar, e.g. received of pledged. */
export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div>
      <div className="h-3 rounded-full bg-slate-100 dark:bg-slate-700" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}><div className="h-3 rounded-full bg-gradient-to-r from-emerald-500 to-teal-400" style={{ width: `${pct}%` }} /></div>
      <div className="mt-1 text-xs text-slate-500">{label}: {pct}%</div>
    </div>
  );
}
