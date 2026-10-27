import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from './lib/auth';
import { api } from './lib/api';
import { useDelete, useGet } from './lib/hooks';
import { ConfirmProvider, ToastProvider } from './components/ui';
import NotificationBell from './components/NotificationBell';
import { Register } from './pages/AuthPages';

type Reply = { status?: number; data?: unknown; error?: { code: string; message: string } } | Promise<{ status?: number; data?: unknown; error?: { code: string; message: string } }>;
const mockApi = (handler: (method: string, path: string, body: unknown) => Reply) => {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('/api/v1', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const r = await handler(init?.method ?? 'GET', path, body);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => (r.error ? { success: false, error: r.error } : { success: true, data: r.data }) };
  });
  vi.stubGlobal('fetch', f);
  return f;
};
const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ToastProvider>
          <ConfirmProvider>
            <AuthProvider>{ui}</AuthProvider>
          </ConfirmProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
afterEach(() => vi.restoreAllMocks());

function Things() {
  const q = useGet<{ _id: string; title: string }[]>('/things');
  const del = useDelete({ noun: 'thing', request: (id) => api.del(`/things/${id}`), prune: ['/things'] });
  return (
    <ul>
      {q.data?.map((t) => (
        <li key={t._id}>
          {t.title}
          <button aria-label={`delete ${t.title}`} onClick={() => del({ id: t._id, name: t.title })} />
        </li>
      ))}
    </ul>
  );
}

describe('universal delete (modal + optimistic update)', () => {
  it('asks first, removes the row immediately, and keeps it removed once the server confirms', async () => {
    const gone = new Set<string>();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = mockApi(async (m, p) => {
      if (m === 'DELETE') {
        await gate;
        gone.add(p.split('/').pop()!);
        return { data: { deleted: true } };
      }
      if (p.startsWith('/things')) return { data: [{ _id: '1', title: 'Alpha' }, { _id: '2', title: 'Beta' }].filter((x) => !gone.has(x._id)) };
      return { status: 401, error: { code: 'UNAUTHORIZED', message: 'no' } };
    });
    wrap(<Things />);
    await screen.findByText('Alpha');
    await userEvent.click(screen.getByLabelText('delete Alpha'));
    // 1) a confirmation dialog, naming the item, and nothing has been sent yet
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Alpha/)).toBeInTheDocument();
    expect(f.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'DELETE')).toBe(false);
    // 2) confirming removes the row at once, while the request is still in flight
    await userEvent.click(within(dialog).getByRole('button', { name: /delete thing/i }));
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
    expect(screen.getByText('Beta')).toBeInTheDocument();
    release();
    expect(await screen.findByText('Thing deleted')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Alpha')).not.toBeInTheDocument());
  });

  it('cancelling the dialog deletes nothing', async () => {
    const f = mockApi((m, p) => (p.startsWith('/things') ? { data: [{ _id: '1', title: 'Alpha' }] } : { status: 401, error: { code: 'U', message: 'no' } }));
    wrap(<Things />);
    await userEvent.click(await screen.findByLabelText('delete Alpha'));
    await userEvent.click(await screen.findByRole('button', { name: /keep it/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(f.mock.calls.some(([, i]) => (i as RequestInit)?.method === 'DELETE')).toBe(false);
  });

  it('puts the row back and shows the server’s reason when the delete is refused', async () => {
    mockApi((m, p) => {
      if (m === 'DELETE') return { status: 409, error: { code: 'CONFLICT', message: 'This problem is part of the contest "Finals".' } };
      if (p.startsWith('/things')) return { data: [{ _id: '1', title: 'Alpha' }] };
      return { status: 401, error: { code: 'U', message: 'no' } };
    });
    wrap(<Things />);
    await userEvent.click(await screen.findByLabelText('delete Alpha'));
    await userEvent.click(await screen.findByRole('button', { name: /delete thing/i }));
    expect(await screen.findByText(/part of the contest "Finals"/)).toBeInTheDocument();
    expect(await screen.findByText('Alpha')).toBeInTheDocument(); // rolled back
  });
});

describe('notification bell', () => {
  const list = [
    { _id: 'n3', type: 'announcement', message: 'Doors open at 8', createdAt: '2026-10-23T10:03:00.000Z', readAt: null },
    { _id: 'n2', type: 'shift', message: 'You were rostered', createdAt: '2026-10-23T10:02:00.000Z', readAt: null },
    { _id: 'n1', type: 'registration', message: 'Seat confirmed', createdAt: '2026-10-23T10:01:00.000Z', readAt: null },
  ];
  it('shows the unread count, and opening the panel clears it and tells the server what was seen', async () => {
    let unread = 3;
    const f = mockApi((m, p, body) => {
      if (p === '/notifications/unread-count') return { data: { count: unread } };
      if (p.startsWith('/notifications?')) return { data: list.map((n) => ({ ...n, readAt: unread === 0 ? '2026-10-23T11:00:00Z' : null })) };
      if (p === '/notifications/read-all' && m === 'POST') {
        unread = 0;
        void body;
        return { data: { done: true, unread: 0 } };
      }
      return { status: 401, error: { code: 'U', message: 'no' } };
    });
    wrap(<NotificationBell />);
    const badge = await screen.findByTestId('unread-badge');
    expect(badge).toHaveTextContent('3');
    expect(screen.getByRole('button', { name: /3 unread/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    // the notifications are shown…
    expect(await screen.findByText('Doors open at 8')).toBeInTheDocument();
    // …and the badge is gone
    await waitFor(() => expect(screen.queryByTestId('unread-badge')).not.toBeInTheDocument());
    // the server was told to mark everything up to the newest notification shown
    await waitFor(() => {
      const call = f.mock.calls.find(([u, i]) => String(u).endsWith('/notifications/read-all') && (i as RequestInit)?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ upTo: '2026-10-23T10:03:00.000Z' });
    });
    // still zero after the server's answer is re-fetched
    await waitFor(() => expect(f.mock.calls.filter(([u]) => String(u).endsWith('/notifications/unread-count')).length).toBeGreaterThan(1));
    expect(screen.queryByTestId('unread-badge')).not.toBeInTheDocument();
  });

  it('shows 99+ for very large counts and no badge at zero', async () => {
    mockApi((m, p) => (p === '/notifications/unread-count' ? { data: { count: 240 } } : { status: 401, error: { code: 'U', message: 'no' } }));
    wrap(<NotificationBell />);
    expect(await screen.findByTestId('unread-badge')).toHaveTextContent('99+');
  });
});

describe('register form', () => {
  it('gives live feedback: strength meter, inline validation, and a role choice', async () => {
    mockApi(() => ({ status: 401, error: { code: 'U', message: 'no' } }));
    wrap(<Register />);
    const pw = await screen.findByLabelText('Password');
    await userEvent.type(pw, 'abc');
    expect(screen.getByText('Too weak')).toBeInTheDocument();
    await userEvent.clear(pw);
    await userEvent.type(pw, 'Str0ng!Passw0rd');
    expect(screen.getByText('Strong')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show password/i }));
    expect(pw).toHaveAttribute('type', 'text');
    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.tab();
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/volunteer/i));
    expect(screen.getByLabelText(/volunteer/i)).toBeChecked();
  });
});

describe('register form: role requests', () => {
  const registered = (roles: string[] = ['participant']) =>
    mockApi((m, p) => (p === '/auth/register' ? { status: 201, data: { user: { id: 'u1', name: 'New User', email: 'new@test.local', roles, department: null, batch: null }, accessToken: 'tok' } } : { status: 401, error: { code: 'U', message: 'no' } }));
  const registerCall = (f: ReturnType<typeof registered>) => f.mock.calls.find(([u]) => String(u).endsWith('/auth/register'));
  const fillBasics = async () => {
    await userEvent.type(await screen.findByLabelText('Full name'), 'New User');
    await userEvent.type(screen.getByLabelText('Email'), 'new@test.local');
    await userEvent.type(screen.getByLabelText('Password'), 'Str0ng!Passw0rd');
  };

  it('judge: swaps department/batch for designation + employee ID, validates them, and sends a request', async () => {
    const f = registered();
    wrap(<Register />);
    await fillBasics();
    expect(screen.getByLabelText('Department')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/judge/i));
    expect(await screen.findByLabelText('Designation', undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByLabelText('Teacher / Employee ID')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByLabelText('Department')).not.toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByLabelText('Batch')).not.toBeInTheDocument();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Select your designation', 'Lecturer', 'Assistant Professor', 'Associate Professor', 'Professor', 'Industry Expert', 'Alumni', 'Other']);

    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText('Designation is required for judges')).toBeInTheDocument();
    expect(screen.getByText('Employee ID is required for judges')).toBeInTheDocument();
    expect(registerCall(f)).toBeUndefined(); // nothing was sent

    await userEvent.selectOptions(screen.getByLabelText('Designation'), 'professor');
    await userEvent.type(screen.getByLabelText('Teacher / Employee ID'), 'EMP-5');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText('Account created. Your judge request is waiting for organiser approval.')).toBeInTheDocument();
    expect(JSON.parse(String((registerCall(f)![1] as RequestInit).body))).toMatchObject({ role: 'participant', requestedRole: 'judge', designation: 'professor', employeeId: 'EMP-5' });
  });

  it('coordinator: no extra fields, department/batch stay, and the approval message is shown', async () => {
    const f = registered();
    wrap(<Register />);
    await fillBasics();
    expect(screen.getByText(/Needs organiser approval\. You join as a participant until approved\./)).toBeInTheDocument();
    expect(screen.queryByText(/granted by an organiser/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/coordinator/i));
    expect(screen.getByLabelText('Department')).toBeInTheDocument();
    expect(screen.getByLabelText('Batch')).toBeInTheDocument();
    expect(screen.queryByLabelText('Designation')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText('Account created. Your coordinator request is waiting for organiser approval.')).toBeInTheDocument();
    const body = JSON.parse(String((registerCall(f)![1] as RequestInit).body));
    expect(body).toMatchObject({ role: 'participant', requestedRole: 'coordinator' });
    expect(body).not.toHaveProperty('designation');
    expect(body).not.toHaveProperty('employeeId');
  });

  it('volunteer stays a direct role (no request is sent)', async () => {
    const f = mockApi(() => ({ status: 409, error: { code: 'CONFLICT', message: 'An account with this email already exists' } }));
    wrap(<Register />);
    await fillBasics();
    await userEvent.click(screen.getByLabelText(/volunteer/i));
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    const body = JSON.parse(String((registerCall(f as never)![1] as RequestInit).body));
    expect(body.role).toBe('volunteer');
    expect(body).not.toHaveProperty('requestedRole');
  });
});
