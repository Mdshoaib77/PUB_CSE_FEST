import net from 'net';
import tls from 'tls';
import os from 'os';
import { once } from 'events';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * Minimal dependency-free SMTP client (implicit TLS, STARTTLS, AUTH PLAIN/LOGIN) so e-mail needs no new package.
 * Optional by design: with no SMTP_HOST nothing is attempted, and every failure resolves to `false` instead of throwing.
 */
export const mailEnabled = () => !!env.smtp.host && !!env.smtp.from;

const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const addr = (s: string) => /<([^<>\s]+)>/.exec(s)?.[1] ?? clean(s);
const encHeader = (s: string) => {
  const c = clean(s);
  return /^[\x20-\x7e]*$/.test(c) ? c : `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`;
};

class Conn {
  buf = '';
  closed = false;
  err?: Error;
  private waiters: (() => void)[] = [];
  constructor(public sock: net.Socket) {
    this.attach(sock);
  }
  attach(s: net.Socket) {
    this.sock = s;
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      this.buf += d;
      this.wake();
    });
    s.on('error', (e) => {
      this.err = e;
      this.wake();
    });
    s.on('close', () => {
      this.closed = true;
      this.wake();
    });
  }
  private wake() {
    this.waiters.splice(0).forEach((f) => f());
  }
  /** Resolves with one complete (possibly multi-line) SMTP reply. */
  async reply(): Promise<{ code: number; text: string }> {
    for (;;) {
      if (this.err) throw this.err;
      const lines = this.buf.split('\r\n');
      const i = lines.slice(0, -1).findIndex((l) => /^\d{3}( |$)/.test(l));
      if (i >= 0) {
        this.buf = lines.slice(i + 1).join('\r\n');
        return { code: Number(lines[i].slice(0, 3)), text: lines.slice(0, i + 1).join('\n') };
      }
      if (this.closed) throw new Error('SMTP connection closed');
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  async cmd(line: string, ok: number[]) {
    this.sock.write(`${line}\r\n`);
    const r = await this.reply();
    if (!ok.includes(r.code)) throw new Error(`SMTP ${r.code} after ${line.split(' ')[0]}`);
    return r;
  }
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

async function deliver(m: Mail): Promise<void> {
  const { host, port, secure, user, pass, from } = env.smtp;
  const sock: net.Socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  const c = new Conn(sock);
  try {
    let r = await c.reply();
    if (r.code !== 220) throw new Error(`SMTP greeting ${r.code}`);
    const helo = clean(os.hostname()) || 'localhost';
    let ehlo = await c.cmd(`EHLO ${helo}`, [250]);
    if (!secure && /STARTTLS/i.test(ehlo.text)) {
      await c.cmd('STARTTLS', [220]);
      c.sock.removeAllListeners('data');
      const t = tls.connect({ socket: c.sock, servername: host });
      await once(t, 'secureConnect');
      c.attach(t);
      ehlo = await c.cmd(`EHLO ${helo}`, [250]);
    }
    if (user) {
      if (/AUTH[^\n]*PLAIN/i.test(ehlo.text)) await c.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`).toString('base64')}`, [235]);
      else {
        await c.cmd('AUTH LOGIN', [334]);
        await c.cmd(Buffer.from(user).toString('base64'), [334]);
        await c.cmd(Buffer.from(pass).toString('base64'), [235]);
      }
    }
    await c.cmd(`MAIL FROM:<${addr(from)}>`, [250]);
    await c.cmd(`RCPT TO:<${addr(m.to)}>`, [250, 251]);
    await c.cmd('DATA', [354]);
    const body = (
      Buffer.from(m.text, 'utf8')
        .toString('base64')
        .match(/.{1,76}/g) ?? []
    ).join('\r\n');
    const msg = [
      `From: ${clean(from)}`,
      `To: ${clean(m.to)}`,
      `Subject: ${encHeader(m.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\r\n');
    r = await c.cmd(`${msg}\r\n.`, [250]);
    sock.write('QUIT\r\n');
  } finally {
    c.sock.destroy();
  }
}

/** Send one plain-text e-mail. Returns true on success; never throws; does nothing when SMTP is not configured. */
export async function sendMail(m: Mail): Promise<boolean> {
  if (!mailEnabled()) return false;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([deliver(m), new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error('SMTP timeout')), env.smtp.timeoutMs)))]);
    return true;
  } catch (e) {
    logger.warn('email not sent', { message: (e as Error).message });
    return false;
  } finally {
    clearTimeout(timer);
  }
}
