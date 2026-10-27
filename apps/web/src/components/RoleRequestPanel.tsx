import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Hourglass, ShieldCheck, ShieldX, UserPlus } from 'lucide-react';
import { JUDGE_DESIGNATIONS, JUDGE_DESIGNATION_LABELS, REQUESTABLE_ROLES, ROLE_LABELS, ROLE_REQUEST_COOLDOWN_HOURS, type JudgeDesignation, type RequestableRole } from '@festhub/shared';
import { api, errMsg } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAct, useGet } from '../lib/hooks';
import { MY_REQUESTS, useRefreshRoleRequests, type RoleRequestRow } from '../lib/roleRequests';
import { Card, ErrorBox, Field, Skeleton } from './ui';

const HOUR = 3_600_000;
/** Latest request per role (the API returns newest first). */
const latestPerRole = (rows: RoleRequestRow[]) => {
  const m = new Map<RequestableRole, RoleRequestRow>();
  for (const r of rows) if (!m.has(r.role)) m.set(r.role, r);
  return m;
};

/** Pending / rejected notices for the signed-in user + the "Request a role" form. Renders nothing for roles that can't be requested. */
export default function RoleRequestPanel() {
  const { user } = useAuth();
  const mine = useGet<RoleRequestRow[]>(MY_REQUESTS);
  const refresh = useRefreshRoleRequests();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<RequestableRole>('judge');
  const [designation, setDesignation] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [err, setErr] = useState('');

  const send = useAct(
    () => api.post('/role-requests', role === 'judge' ? { role, designation, employeeId: employeeId.trim() } : { role }),
    {
      ok: 'Request sent. An organiser will review it.',
      invalidate: [],
      onDone: () => {
        refresh();
        setOpen(false);
        setDesignation('');
        setEmployeeId('');
        setErr('');
      },
    },
  );

  if (!user) return null;
  if (mine.isLoading) return <Skeleton className="mb-6 h-14 w-full rounded-2xl" />;
  if (mine.error) return <div className="mb-6"><ErrorBox error={mine.error} /></div>;

  const latest = latestPerRole(mine.data ?? []);
  const available = REQUESTABLE_ROLES.filter((r) => !user.roles.includes(r) && latest.get(r)?.status !== 'pending');
  const banners = [...latest.values()].filter((r) => {
    if (user.roles.includes(r.role)) return false; // already granted: nothing to explain
    if (r.status === 'pending') return true;
    // keep a rejection visible for the cooldown window only, so the dashboard doesn't nag forever
    return r.status === 'rejected' && !!r.decidedAt && Date.now() - new Date(r.decidedAt).getTime() < ROLE_REQUEST_COOLDOWN_HOURS * HOUR * 7;
  });
  const pick = available.includes(role) ? role : available[0];

  const submit = () => {
    if (!pick) return;
    if (pick === 'judge' && (!designation || !employeeId.trim())) return setErr('Designation and employee ID are required for judges.');
    setErr('');
    send.mutate();
  };

  if (!banners.length && !available.length) return null;
  return (
    <div className="mb-6 space-y-3">
      {banners.map((r) =>
        r.status === 'pending' ? (
          <div key={r.id} role="status" className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <Hourglass size={18} className="mt-0.5 shrink-0" />
            <span>
              <b>Your {ROLE_LABELS[r.role]} request is pending organiser approval.</b> You will get a notification when it is decided.
            </span>
          </div>
        ) : (
          <div key={r.id} role="status" className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
            <ShieldX size={18} className="mt-0.5 shrink-0" />
            <span>
              <b>Your {ROLE_LABELS[r.role]} request was rejected.</b>
              {r.rejectReason ? <> Reason: {r.rejectReason}</> : null}
              {r.decidedAt && Date.now() - new Date(r.decidedAt).getTime() < ROLE_REQUEST_COOLDOWN_HOURS * HOUR ? ` You can request again after ${new Date(new Date(r.decidedAt).getTime() + ROLE_REQUEST_COOLDOWN_HOURS * HOUR).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.` : ''}
            </span>
          </div>
        ),
      )}
      {available.length > 0 && (
        <Card className="!p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-slate-600">
              <ShieldCheck size={18} className="text-brand-600" /> Want to help run the fest as a judge or coordinator?
            </div>
            <button className="btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <UserPlus size={14} /> {open ? 'Close' : 'Request a role'}
            </button>
          </div>
          <AnimatePresence initial={false}>
            {open && pick && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Field label="Role">
                    <select className="input" value={pick} onChange={(e) => { setRole(e.target.value as RequestableRole); setErr(''); }}>
                      {available.map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </option>
                      ))}
                    </select>
                  </Field>
                  {pick === 'judge' && (
                    <>
                      <Field label="Designation">
                        <select className="input" value={designation} onChange={(e) => setDesignation(e.target.value)}>
                          <option value="">Select…</option>
                          {JUDGE_DESIGNATIONS.map((d) => (
                            <option key={d} value={d}>
                              {JUDGE_DESIGNATION_LABELS[d as JudgeDesignation]}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Employee ID">
                        <input className="input" maxLength={40} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} autoComplete="off" />
                      </Field>
                    </>
                  )}
                </div>
                {(err || send.error) && <p className="mt-3 text-sm font-medium text-red-600" role="alert">{err || errMsg(send.error)}</p>}
                <div className="mt-4 flex justify-end">
                  <button className="btn-primary btn-sm" disabled={send.isPending} onClick={submit}>
                    {send.isPending ? 'Sending…' : 'Send request'}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </Card>
      )}
    </div>
  );
}
