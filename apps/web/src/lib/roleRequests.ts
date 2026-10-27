import { useQueryClient } from '@tanstack/react-query';
import type { RequestableRole, RoleRequestStatus } from '@festhub/shared';
import { useGet } from './hooks';

/** Shape returned by /role-requests (inbox, with `user`) and /role-requests/me. `employeeId` is only sent to organisers/admins and the owner. */
export interface RoleRequestRow {
  id: string;
  userId: string;
  role: RequestableRole;
  status: RoleRequestStatus;
  designation: string | null;
  employeeId?: string | null;
  decidedAt: string | null;
  rejectReason: string | null;
  createdAt: string | null;
  user?: { id: string; name: string; email: string } | null;
}

const KEY = '/role-requests';
export const inboxPath = (status: RoleRequestStatus) => `${KEY}?status=${status}`;
export const MY_REQUESTS = `${KEY}/me`;

/** Organiser badge count. `enabled` keeps non-staff users from calling the organiser-only endpoint. */
export const usePendingRoleCount = (enabled: boolean) => {
  const q = useGet<RoleRequestRow[]>(enabled ? inboxPath('pending') : null, { refetchInterval: 60_000 });
  return q.data?.length ?? 0;
};

/** Refetch every role-request list (inbox tabs, badge, my requests). */
export const useRefreshRoleRequests = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith(KEY) });
};
