import 'dotenv/config';
import path from 'path';

const isTest = process.env.NODE_ENV === 'test';
const isProd = process.env.NODE_ENV === 'production';

function required(name: string, fallbackForDev: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required env var ${name}`);
  return fallbackForDev;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isTest,
  isProd,
  port: Number(process.env.PORT ?? 5000),
  mongoUri: required('MONGODB_URI', 'mongodb://127.0.0.1:27017/festhub'),
  jwtAccessSecret: required('JWT_ACCESS_SECRET', 'dev-access-secret-change-me'),
  qrSecret: required('QR_TOKEN_SECRET', 'dev-qr-secret-change-me'),
  /** Check-in QR tokens are valid this many seconds; the client silently refreshes before expiry. */
  qrTokenTtlSec: Number(process.env.QR_TOKEN_TTL_SEC ?? 45),
  clientOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  judgeAdapter: (process.env.JUDGE_ADAPTER ?? 'judge0') as 'judge0' | 'mock',
  judge0: {
    baseUrl: process.env.JUDGE0_BASE_URL ?? '',
    apiKey: process.env.JUDGE0_API_KEY ?? '',
    apiHost: process.env.JUDGE0_API_HOST ?? '',
    authToken: process.env.JUDGE0_AUTH_TOKEN ?? '',
    pollIntervalMs: Number(process.env.JUDGE0_POLL_MS ?? 1000),
    pollTimeoutMs: Number(process.env.JUDGE0_POLL_TIMEOUT_MS ?? 30000),
    maxAttempts: Number(process.env.JUDGE_MAX_ATTEMPTS ?? 3),
  },
  /** Where uploaded event images are stored (mount a volume here in Docker). */
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? path.join(process.cwd(), 'uploads')),
  maxImageBytes: Number(process.env.MAX_IMAGE_MB ?? 5) * 1024 * 1024,
  /**
   * Refresh-token cookie policy. Production defaults are Secure + SameSite=None (web and API on different HTTPS origins).
   * Behind one reverse proxy (the bundled Docker setup) use COOKIE_SECURE=false COOKIE_SAMESITE=lax when serving plain http.
   */
  cookie: {
    secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
    sameSite: (process.env.COOKIE_SAMESITE ?? (isProd ? 'none' : 'lax')) as 'none' | 'lax' | 'strict',
  },
  /** Optional e-mail delivery. Everything below is inert unless SMTP_HOST is set; failures are swallowed (see services/mailer.ts). */
  smtp: {
    host: process.env.SMTP_HOST?.trim() ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    /** true = implicit TLS (port 465). false = plain connection upgraded with STARTTLS when the server offers it. */
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : Number(process.env.SMTP_PORT ?? 587) === 465,
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM?.trim() || process.env.SMTP_USER?.trim() || '',
    timeoutMs: Number(process.env.SMTP_TIMEOUT_MS ?? 10000),
  },
  /** Public web address used for links inside e-mails. */
  appUrl: (process.env.APP_URL ?? (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',')[0]).trim().replace(/\/+$/, ''),
  /** Text printed under the signature line of every NEW certificate (stored on the certificate, so later changes do not alter issued ones). */
  certSignatureText: (process.env.CERT_SIGNATURE_TEXT ?? 'Organizing Committee, PUB FestHub').trim().slice(0, 120),
  /** S13 AI feedback. Key ONLY from ANTHROPIC_API_KEY, model ONLY from ANTHROPIC_MODEL; either missing = feature disabled (app runs normally). */
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY?.trim() ?? '',
    model: process.env.ANTHROPIC_MODEL?.trim() ?? '',
    baseUrl: (process.env.ANTHROPIC_BASE_URL?.trim() || 'https://api.anthropic.com').replace(/\/+$/, ''),
    timeoutMs: Number(process.env.ANTHROPIC_TIMEOUT_MS ?? 60000),
    maxRetries: Number(process.env.ANTHROPIC_MAX_RETRIES ?? 3),
    maxInputChars: Number(process.env.ANTHROPIC_MAX_INPUT_CHARS ?? 24000),
    maxOutputTokens: Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS ?? 2000),
  },
  submissionCooldownSec: Number(process.env.SUBMISSION_COOLDOWN_SEC ?? 10),
};

if (isProd && env.judgeAdapter === 'mock') {
  throw new Error('JUDGE_ADAPTER=mock is not allowed in production');
}
