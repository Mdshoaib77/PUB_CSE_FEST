import type { Server as HttpServer } from 'http';
import { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

let io: Server | null = null;

export function initSocket(server: HttpServer) {
  io = new Server(server, { cors: { origin: env.clientOrigins, credentials: true } });
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (token) {
        const p = jwt.verify(token, env.jwtAccessSecret) as jwt.JwtPayload;
        socket.data.userId = p.sub;
        socket.join(`user:${p.sub}`);
      }
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    // Public rooms carry only non-sensitive nudges; clients re-fetch via authorised REST endpoints.
    socket.on('join', (room: string) => {
      if (/^(event|contest):[a-f0-9]{24}$/.test(room)) socket.join(room);
    });
  });
  return io;
}
export const emitTo = (room: string, event: string, payload: unknown) => {
  io?.to(room).emit(event, payload);
};
