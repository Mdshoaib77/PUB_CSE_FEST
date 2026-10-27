import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from './lib/auth';
import { ToastProvider } from './components/ui';
import { Login } from './pages/AuthPages';
import Protected from './components/Protected';
import { request } from './lib/api';

const wrap = (ui: React.ReactNode, path = '/') =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <AuthProvider>{ui}</AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => vi.restoreAllMocks());

describe('web app', () => {
  it('redirects unauthenticated users from protected routes to /login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ success: false, error: { code: 'UNAUTHORIZED', message: 'no session' } }) }),
    );
    wrap(
      <Routes>
        <Route path="/login" element={<div>login page</div>} />
        <Route element={<Protected />}>
          <Route path="/secret" element={<div>secret</div>} />
        </Route>
      </Routes>,
      '/secret',
    );
    await waitFor(() => expect(screen.getByText('login page')).toBeInTheDocument());
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });
  it('login form validates input before calling the API', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ success: false, error: { code: 'UNAUTHORIZED', message: 'x' } }) });
    vi.stubGlobal('fetch', f);
    wrap(<Login />);
    await waitFor(() => expect(f).toHaveBeenCalledTimes(1)); // session restore attempt only
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/valid email/i)).toBeInTheDocument();
    expect(f).toHaveBeenCalledTimes(1); // no login request was sent
  });
  it('API client unwraps errors from the envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, status: 409, json: async () => ({ success: false, error: { code: 'CONFLICT', message: 'Venue clash at Hall' } }) }),
    );
    await expect(request('POST', '/events/1/activities', {})).rejects.toMatchObject({ status: 409, message: 'Venue clash at Hall' });
  });
});
