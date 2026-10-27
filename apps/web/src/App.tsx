import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import Protected from './components/Protected';
import type { Role } from '@festhub/shared';
import BrandLoader from './components/BrandLoader';
import { useAuth } from './lib/auth';

// Route-level code splitting keeps the first paint fast: each page (and its heavy deps like the QR scanner) loads on demand.
const Login = lazy(() => import('./pages/AuthPages').then((m) => ({ default: m.Login })));
const Register = lazy(() => import('./pages/AuthPages').then((m) => ({ default: m.Register })));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const Notifications = lazy(() => import('./pages/Notifications'));
const EventsList = lazy(() => import('./pages/Events').then((m) => ({ default: m.EventsList })));
const EventDetail = lazy(() => import('./pages/Events').then((m) => ({ default: m.EventDetail })));
const EventForm = lazy(() => import('./pages/EventForm'));
const ManageEvent = lazy(() => import('./pages/ManageEvent'));
const Volunteer = lazy(() => import('./pages/Volunteer'));
const CheckIn = lazy(() => import('./pages/CheckIn'));
const Judging = lazy(() => import('./pages/Judging'));
const ContestsList = lazy(() => import('./pages/Contests').then((m) => ({ default: m.ContestsList })));
const ContestPage = lazy(() => import('./pages/Contests').then((m) => ({ default: m.ContestPage })));
const ProblemsList = lazy(() => import('./pages/Practice').then((m) => ({ default: m.ProblemsList })));
const ProblemDetail = lazy(() => import('./pages/Practice').then((m) => ({ default: m.ProblemDetail })));
const Progress = lazy(() => import('./pages/Practice').then((m) => ({ default: m.Progress })));
const Setter = lazy(() => import('./pages/Setter'));
const AdminUsers = lazy(() => import('./pages/AdminUsers'));
const AdminAudit = lazy(() => import('./pages/AdminAudit'));
const AdminRoleRequests = lazy(() => import('./pages/AdminRoleRequests'));
const Certificates = lazy(() => import('./pages/Certificates'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const CommandCenter = lazy(() => import('./pages/CommandCenter'));
const Achievements = lazy(() => import('./pages/Achievements'));
const Verify = lazy(() => import('./pages/Verify'));
const Landing = lazy(() => import('./pages/Landing'));

/** Everyone except sponsor-only accounts: participant-side pages (QR pass, code, contests, practice) are not for external sponsors. */
const NON_SPONSOR: Role[] = ['admin', 'organiser', 'coordinator', 'participant', 'volunteer', 'judge'];

/**
 * `/` is the public university landing page for visitors and the unchanged Dashboard for signed-in users.
 * (Every other route keeps its original guard; only the anonymous view of `/` is new.)
 */
function Home() {
  const { user, loading } = useAuth();
  if (loading) return <BrandLoader fullscreen />;
  if (!user) return <Landing />;
  return (
    <Layout>
      <Dashboard />
    </Layout>
  );
}

export default function App() {
  return (
    <Suspense
      fallback={<BrandLoader fullscreen />}
    >
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/verify" element={<Verify />} />
        <Route path="/verify/:id" element={<Verify />} />
        <Route element={<Protected />}>
          <Route element={<Layout />}>
            {/* Role notifications link to /dashboard; the dashboard itself lives at "/". */}
            <Route path="dashboard" element={<Navigate to="/" replace />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="certificates" element={<Certificates />} />
            <Route path="events" element={<EventsList />} />
            <Route path="events/:id" element={<EventDetail />} />
            <Route element={<Protected roles={['organiser']} />}>
              <Route path="events/new" element={<EventForm />} />
              <Route path="events/:id/edit" element={<EventForm />} />
            </Route>
            <Route element={<Protected roles={['organiser', 'coordinator']} />}>
              <Route path="events/:id/manage" element={<ManageEvent />} />
            </Route>
            <Route element={<Protected roles={['organiser', 'coordinator']} />}>
            </Route>
            <Route element={<Protected roles={['volunteer', 'coordinator', 'organiser']} />}>
              <Route path="volunteer" element={<Volunteer />} />
            </Route>
            <Route path="leaderboard" element={<Leaderboard />} />
            <Route path="achievements" element={<Achievements />} />
            <Route element={<Protected roles={['organiser']} />}>
              <Route path="command-center" element={<CommandCenter />} />
            </Route>
            <Route element={<Protected roles={NON_SPONSOR} />}>
              <Route path="checkin" element={<CheckIn />} />
            </Route>
            <Route element={<Protected roles={['judge']} />}>
              <Route path="judging" element={<Judging />} />
            </Route>
            <Route element={<Protected roles={NON_SPONSOR} />}>
              <Route path="contests" element={<ContestsList />} />
            </Route>
            <Route element={<Protected roles={NON_SPONSOR} />}>
              <Route path="contests/:id" element={<ContestPage />} />
            </Route>
            <Route element={<Protected roles={NON_SPONSOR} />}>
              <Route path="problems" element={<ProblemsList />} />
            </Route>
            <Route element={<Protected roles={NON_SPONSOR} />}>
              <Route path="problems/:id" element={<ProblemDetail />} />
            </Route>
            <Route element={<Protected roles={NON_SPONSOR} />}>
              <Route path="progress" element={<Progress />} />
            </Route>
            <Route element={<Protected roles={['judge', 'organiser']} />}>
              <Route path="setter" element={<Setter />} />
            </Route>
            <Route element={<Protected roles={['organiser']} />}>
              <Route path="admin/users" element={<AdminUsers />} />
              <Route path="admin/audit" element={<AdminAudit />} />
              <Route path="admin/role-requests" element={<AdminRoleRequests />} />
            </Route>
            <Route path="*" element={<div className="card">Page not found.</div>} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
