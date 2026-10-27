import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { roleSatisfies, type LoginInput, type RegisterInput, type Role } from '@festhub/shared';
import { api, request, setToken } from './api';
import { resetSocket } from './socket';

export interface User {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  department: string | null;
  batch: string | null;
}
interface Ctx {
  user: User | null;
  loading: boolean;
  login(i: LoginInput): Promise<void>;
  register(i: RegisterInput): Promise<void>;
  logout(): Promise<void>;
  has(...r: Role[]): boolean;
}
const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    // Restore the session from the httpOnly refresh cookie.
    request<{ user: User; accessToken: string }>('POST', '/auth/refresh', {}, false)
      .then((d) => {
        setToken(d.accessToken);
        setUser(d.user);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);
  const value = useMemo<Ctx>(
    () => ({
      user,
      loading,
      async login(i) {
        const d = await api.post<{ user: User; accessToken: string }>('/auth/login', i);
        resetSocket();
        setToken(d.accessToken);
        setUser(d.user);
      },
      async register(i) {
        const d = await api.post<{ user: User; accessToken: string }>('/auth/register', i);
        resetSocket();
        setToken(d.accessToken);
        setUser(d.user);
      },
      async logout() {
        try {
          await api.post('/auth/logout');
        } finally {
          resetSocket();
          setToken(null);
          setUser(null);
          qc.clear(); // never show the next person on this browser the previous person's cached data
        }
      },
      has: (...r) => !!user && roleSatisfies(user.roles, r),
    }),
    [user, loading, qc],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
export function useAuth() {
  const c = useContext(AuthCtx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
