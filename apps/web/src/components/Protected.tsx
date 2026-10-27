import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '@festhub/shared';
import { useAuth } from '../lib/auth';
import BrandLoader from './BrandLoader';

/** UX guard only: the API enforces the same rules on the server. */
export default function Protected({ roles }: { roles?: Role[] }) {
  const { user, loading, has } = useAuth();
  const loc = useLocation();
  if (loading) return <BrandLoader fullscreen />;
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (roles && !has(...roles))
    return (
      <div className="card text-sm" role="alert">
        You don’t have access to this page.
      </div>
    );
  return <Outlet />;
}
