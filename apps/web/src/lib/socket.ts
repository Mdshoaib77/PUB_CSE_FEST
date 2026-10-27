import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import { getToken, refreshSession } from './api';

let socket: Socket | null = null;
export function getSocket() {
  const url = (import.meta.env.VITE_SOCKET_URL as string | undefined) || undefined;
  if (!socket) {
    // `auth` is a function, so every (re)connect sends the CURRENT access token.
    socket = io(url, { auth: (cb) => cb({ token: getToken() }), autoConnect: true, transports: ['websocket', 'polling'] });
    // The server rejects an expired token during the handshake and socket.io does not retry that by itself:
    // refresh the session, then connect again, otherwise live updates would silently die after ~15 minutes.
    const s = socket;
    s.on('connect_error', async (err) => {
      if (err.message === 'unauthorized' && (await refreshSession())) s.connect();
    });
  }
  return socket;
}
/** Must run on login/logout: the server joins the per-user room at handshake time, so a reused socket would keep the PREVIOUS user's room. */
export function resetSocket() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}

/** Subscribe to nudges; data always comes back through authorised REST endpoints (the freeze stays server-side). */
export function useLive(rooms: string[], onEvent: Record<string, () => void>) {
  useEffect(() => {
    const s = getSocket();
    rooms.forEach((r) => s.emit('join', r));
    const handlers = Object.entries(onEvent).map(([ev, fn]) => {
      const h = () => fn();
      s.on(ev, h);
      return [ev, h] as const;
    });
    return () => handlers.forEach(([ev, h]) => s.off(ev, h));
  }, [rooms.join(',')]);
}

/** Keep every cache that shows notification state in sync with pushes from the server (this tab and other tabs). */
export function useNotificationSocket(onNew?: (message: string) => void) {
  const qc = useQueryClient();
  useEffect(() => {
    const s = getSocket();
    const refresh = () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith('/notifications') });
    const dash = () => qc.invalidateQueries({ queryKey: ['/me/dashboard'] });
    const onNewNote = (p: { message?: string }) => {
      refresh();
      dash();
      if (p?.message) onNew?.(p.message);
    };
    const onSync = () => {
      refresh();
      dash();
    };
    s.on('notification:new', onNewNote);
    s.on('notification:sync', onSync);
    return () => {
      s.off('notification:new', onNewNote);
      s.off('notification:sync', onSync);
    };
  }, [qc]);
}
