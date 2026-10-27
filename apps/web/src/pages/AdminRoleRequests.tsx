import { useState } from 'react';
import { motion } from 'framer-motion';
import { Check, UserCheck, X } from 'lucide-react';
import { JUDGE_DESIGNATION_LABELS, ROLE_LABELS, type JudgeDesignation, type RoleRequestStatus } from '@festhub/shared';
import { api } from '../lib/api';
import { fmt, useAct, useGet } from '../lib/hooks';
import { inboxPath, useRefreshRoleRequests, type RoleRequestRow } from '../lib/roleRequests';
import { Avatar, Badge, EmptyState, PageHeader, Query, Tabs, useConfirm } from '../components/ui';

const TABS = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
] as const;
const EMPTY: Record<RoleRequestStatus, string> = {
  pending: 'No pending requests',
  approved: 'No approved requests yet',
  rejected: 'No rejected requests',
};
const designation = (d: string | null) => (d ? (JUDGE_DESIGNATION_LABELS[d as JudgeDesignation] ?? d) : '—');

export default function AdminRoleRequests() {
  const confirm = useConfirm();
  const refresh = useRefreshRoleRequests();
  const [tab, setTab] = useState<RoleRequestStatus>('pending');
  const list = useGet<RoleRequestRow[]>(inboxPath(tab));
  const approve = useAct((id: string) => api.post(`/role-requests/${id}/approve`), { ok: 'Role approved', invalidate: [], onDone: refresh });
  const reject = useAct(({ id, rejectReason }: { id: string; rejectReason: string }) => api.post(`/role-requests/${id}/reject`, rejectReason ? { rejectReason } : {}), {
    ok: 'Request rejected',
    invalidate: [],
    onDone: refresh,
  });

  const onApprove = (r: RoleRequestRow) =>
    confirm({
      title: `Approve ${ROLE_LABELS[r.role]} role?`,
      message: `${r.user?.name ?? 'This user'} will get the ${ROLE_LABELS[r.role]} role. Their other roles stay.`,
      tone: 'primary',
      confirmText: 'Approve',
      cancelText: 'Cancel',
      run: () => approve.mutateAsync(r.id),
    });
  const onReject = (r: RoleRequestRow) => {
    let text = '';
    return confirm({
      title: `Reject ${ROLE_LABELS[r.role]} request?`,
      message: (
        <span className="block">
          <span className="block">{r.user?.name ?? 'The user'} is told the request was rejected and can ask again after 24 hours.</span>
          <label className="mt-3 block">
            <span className="label">Reason (optional)</span>
            <input className="input mt-1" maxLength={500} placeholder="Shown to the user" onChange={(e) => (text = e.target.value.trim())} />
          </label>
        </span>
      ),
      tone: 'danger',
      confirmText: 'Reject',
      cancelText: 'Cancel',
      run: () => reject.mutateAsync({ id: r.id, rejectReason: text }),
    });
  };

  const actions = (r: RoleRequestRow) =>
    r.status === 'pending' ? (
      <div className="flex gap-2">
        <button className="btn-primary btn-sm" disabled={approve.isPending || reject.isPending} onClick={() => void onApprove(r)}>
          <Check size={14} /> Approve
        </button>
        <button className="btn-danger-ghost btn-sm" disabled={approve.isPending || reject.isPending} onClick={() => void onReject(r)}>
          <X size={14} /> Reject
        </button>
      </div>
    ) : (
      <span className="text-xs text-slate-500">{r.status === 'rejected' && r.rejectReason ? `Reason: ${r.rejectReason}` : fmt(r.decidedAt)}</span>
    );

  return (
    <>
      <PageHeader title="Role requests" sub="Review who asked to become a judge or coordinator." />
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      <Query q={list}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState icon={UserCheck} title={EMPTY[tab]} hint={tab === 'pending' ? 'New requests show up here and in your notifications.' : undefined} />
          ) : (
            <>
              <div className="card hidden overflow-x-auto p-0 md:block">
                <table className="min-w-full divide-y">
                  <thead>
                    <tr>
                      <th className="th">Person</th>
                      <th className="th">Role</th>
                      <th className="th">Designation</th>
                      <th className="th">Employee ID</th>
                      <th className="th">Requested</th>
                      <th className="th">{tab === 'pending' ? 'Actions' : 'Decision'}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((r) => (
                      <tr key={r.id}>
                        <td className="td">
                          <div className="flex items-center gap-2.5">
                            <Avatar name={r.user?.name ?? '?'} size={32} />
                            <div className="min-w-0">
                              <div className="truncate font-medium">{r.user?.name ?? 'Deleted user'}</div>
                              <div className="truncate text-xs text-slate-500">{r.user?.email ?? ''}</div>
                            </div>
                          </div>
                        </td>
                        <td className="td">{ROLE_LABELS[r.role]}</td>
                        <td className="td">{r.role === 'judge' ? designation(r.designation) : '—'}</td>
                        <td className="td">{r.role === 'judge' ? (r.employeeId ?? '—') : '—'}</td>
                        <td className="td whitespace-nowrap">{fmt(r.createdAt)}</td>
                        <td className="td">{actions(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="space-y-3 md:hidden">
                {rows.map((r) => (
                  <motion.li key={r.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="card space-y-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={r.user?.name ?? '?'} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">{r.user?.name ?? 'Deleted user'}</div>
                        <div className="truncate text-xs text-slate-500">{r.user?.email ?? ''}</div>
                      </div>
                      <Badge value={r.status} />
                    </div>
                    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
                      <dt className="text-slate-500">Role</dt>
                      <dd>{ROLE_LABELS[r.role]}</dd>
                      {r.role === 'judge' && (
                        <>
                          <dt className="text-slate-500">Designation</dt>
                          <dd>{designation(r.designation)}</dd>
                          <dt className="text-slate-500">Employee ID</dt>
                          <dd className="break-all">{r.employeeId ?? '—'}</dd>
                        </>
                      )}
                      <dt className="text-slate-500">Requested</dt>
                      <dd>{fmt(r.createdAt)}</dd>
                    </dl>
                    {actions(r)}
                  </motion.li>
                ))}
              </ul>
            </>
          )
        }
      </Query>
    </>
  );
}
