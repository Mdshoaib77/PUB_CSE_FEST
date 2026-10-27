import net from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** No database needed: a tiny in-process SMTP server records what the mailer sends. */
let server: net.Server;
let port = 0;
const received: { from?: string; to?: string; data: string; auth?: string }[] = [];

beforeAll(async () => {
  server = net.createServer((s) => {
    const cur: { from?: string; to?: string; data: string; auth?: string } = { data: '' };
    let inData = false;
    let buf = '';
    s.write('220 fake ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push({ ...cur });
            s.write('250 queued\r\n');
          } else cur.data += `${line}\n`;
        } else if (/^EHLO/i.test(line)) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN/i.test(line)) {
          cur.auth = Buffer.from(line.slice(11), 'base64').toString();
          s.write('235 ok\r\n');
        } else if (/^MAIL FROM/i.test(line)) {
          cur.from = line;
          s.write('250 ok\r\n');
        } else if (/^RCPT TO/i.test(line)) {
          cur.to = line;
          s.write('250 ok\r\n');
        } else if (/^DATA/i.test(line)) {
          inData = true;
          s.write('354 go\r\n');
        } else if (/^QUIT/i.test(line)) s.end('221 bye\r\n');
        else s.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function load(env: Record<string, string>) {
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_TIMEOUT_MS']) delete process.env[k];
  Object.assign(process.env, env);
  const vi = (await import('vitest')).vi;
  vi.resetModules();
  return import('../services/mailer');
}

describe('optional e-mail (SMTP_*)', () => {
  it('does nothing and returns false when SMTP is not configured', async () => {
    const m = await load({});
    expect(m.mailEnabled()).toBe(false);
    expect(await m.sendMail({ to: 'a@b.test', subject: 'x', text: 'y' })).toBe(false);
  });

  it('delivers a message (AUTH PLAIN, base64 body, safe headers) to a reachable server', async () => {
    const m = await load({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_SECURE: 'false',
      SMTP_USER: 'u',
      SMTP_PASS: 'p',
      SMTP_FROM: 'FestHub <no-reply@festhub.test>',
    });
    expect(m.mailEnabled()).toBe(true);
    const ok = await m.sendMail({ to: 'vera@festhub.test', subject: 'Shift assigned\r\nBcc: evil@x.test', text: 'Hello ✓\n.\nline' });
    expect(ok).toBe(true);
    const got = received.at(-1)!;
    expect(got.auth).toBe('\0u\0p');
    expect(got.from).toContain('<no-reply@festhub.test>');
    expect(got.to).toContain('<vera@festhub.test>');
    expect(got.data).toContain('Subject: Shift assigned Bcc: evil@x.test'); // CR/LF stripped: no header injection
    expect(got.data).not.toMatch(/^Bcc:/m);
    const body = got.data.split('\n\n')[1] ?? got.data.split('\n').slice(8).join('');
    expect(Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')).toBe('Hello ✓\n.\nline');
  });

  it('fails silently (returns false, never throws) when the server is unreachable', async () => {
    const m = await load({ SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_FROM: 'a@b.test', SMTP_TIMEOUT_MS: '2000' });
    await expect(m.sendMail({ to: 'a@b.test', subject: 's', text: 't' })).resolves.toBe(false);
  });
});
