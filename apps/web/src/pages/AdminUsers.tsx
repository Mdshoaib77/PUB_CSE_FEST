import { useState } from 'react';
import { ROLES, ROLE_LABELS, type Role } from '@festhub/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAct, useDelete, useGet } from '../lib/hooks';
import { EmptyState, PageHeader, Query, TrashButton } from '../components/ui';

interface U {
  id: string;
  name: string;
  email: string;
  roles: Role[];
}
export default function AdminUsers() {
  const { user: me } = useAuth();
  const [q, setQ] = useState('');
  const list = useGet<U[]>(`/users?q=${encodeURIComponent(q)}`);
  const set = useAct(({ id, roles }: { id: string; roles: Role[] }) => api.patch(`/users/${id}/roles`, { roles }), {
    ok: 'Roles updated',
    invalidate: [`/users?q=${encodeURIComponent(q)}`],
  });
  const del = useDelete({ noun: 'user', request: (id) => api.del(`/users/${id}`), prune: ['/users'], invalidate: ['/users'] });
  return (
    <>
      <PageHeader title="Users & roles" sub="Grant staff roles. Changes apply immediately on the server." />
      <input className="input mb-3 max-w-sm" placeholder="Search name or email" aria-label="Search users" value={q} onChange={(e) => setQ(e.target.value)} />
      <Query q={list}>
        {(us) => us.length === 0 ? <EmptyState title="No users found" hint="Try a different search." /> : (
          <div className="card overflow-x-auto p-0">
            <table className="min-w-full divide-y">
              <thead>
                <tr>
                  <th className="th">User</th>
                  <th className="th">Roles</th>
                  <th className="th w-12">
                    <span className="sr-only">Delete</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {us.map((u) => (
                  <tr key={u.id}>
                    <td className="td">
                      {u.name}
                      <div className="text-xs text-slate-500">{u.email}</div>
                    </td>
                    <td className="td">
                      <div className="flex flex-wrap gap-3">
                        {ROLES.map((r) => (
                          <label key={r} className="flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              checked={u.roles.includes(r)}
                              disabled={r === 'admin' && !me?.roles.includes('admin')}
                              title={r === 'admin' && !me?.roles.includes('admin') ? 'Only an admin can change the admin role' : undefined}
                              onChange={(e) => {
                                const roles = e.target.checked ? [...u.roles, r] : u.roles.filter((x) => x !== r);
                                if (roles.length) set.mutate({ id: u.id, roles });
                              }}
                            />
                            {ROLE_LABELS[r]}
                          </label>
                        ))}
                      </div>
                    </td>
                    <td className="td">
                      {u.id !== me?.id && (
                        <TrashButton
                          label={`Delete user ${u.name}`}
                          onClick={() =>
                            del({
                              id: u.id,
                              name: u.name,
                              typeToConfirm: 'DELETE',
                              warning:
                                'Their registrations are cancelled (seats are released), and their team memberships, shifts, notifications and submissions are deleted.',
                            })
                          }
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Query>
    </>
  );
}
