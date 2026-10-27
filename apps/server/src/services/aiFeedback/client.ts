import { env } from '../../config/env';
import { logger } from '../../utils/logger';

/** S13: minimal Anthropic Messages API client (plain fetch). Key/model come ONLY from env; missing either = disabled. */
export type AiState = { enabled: true; model: string } | { enabled: false; reason: string };
export function aiState(): AiState {
  if (!env.anthropic.apiKey) return { enabled: false, reason: 'ANTHROPIC_API_KEY is not set' };
  if (!env.anthropic.model) return { enabled: false, reason: 'ANTHROPIC_MODEL is not set' };
  return { enabled: true, model: env.anthropic.model };
}

export class AiError extends Error {
  constructor(public code: 'DISABLED' | 'TIMEOUT' | 'RATE_LIMITED' | 'UPSTREAM' | 'BAD_RESPONSE' | 'AUTH', message: string, public status?: number) { super(message); }
}

export interface CallOptions {
  apiKey?: string; model?: string; baseUrl?: string; timeoutMs?: number; maxRetries?: number; maxTokens?: number;
  fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; random?: () => number; baseDelayMs?: number;
}

/** Delay before retry n (0-based): honours Retry-After (seconds, capped 30 s), else 500 ms x 2^n + jitter, capped 15 s. Pure. */
export function backoffMs(attempt: number, retryAfter?: string | null, base = 500, random: () => number = Math.random): number {
  const ra = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(ra) && ra >= 0) return Math.min(30000, ra * 1000);
  return Math.min(15000, base * 2 ** attempt + Math.floor(random() * base));
}
const retryable = (status: number) => status === 429 || status === 529 || status >= 500;

export async function callAnthropic(system: string, user: string, o: CallOptions = {}): Promise<{ text: string; model: string; inputTokens?: number; outputTokens?: number; attempts: number }> {
  const apiKey = o.apiKey ?? env.anthropic.apiKey, model = o.model ?? env.anthropic.model;
  if (!apiKey || !model) throw new AiError('DISABLED', 'AI feedback is not configured.');
  const f = o.fetchImpl ?? fetch, sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = Math.max(0, o.maxRetries ?? env.anthropic.maxRetries), timeout = o.timeoutMs ?? env.anthropic.timeoutMs;
  const url = `${(o.baseUrl ?? env.anthropic.baseUrl).replace(/\/+$/, '')}/v1/messages`;
  const body = JSON.stringify({ model, max_tokens: o.maxTokens ?? env.anthropic.maxOutputTokens, system, messages: [{ role: 'user', content: user }] });
  let last: AiError = new AiError('UPSTREAM', 'AI request failed.');
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let wait: number | null = null;
    try {
      const res = await f(url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body });
      if (res.ok) {
        const j = (await res.json()) as { content?: { type?: string; text?: string }[]; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
        const text = (j.content ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
        if (!text) throw new AiError('BAD_RESPONSE', 'The AI returned no text.');
        return { text, model: j.model ?? model, inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens, attempts: attempt + 1 };
      }
      if (res.status === 401 || res.status === 403) throw new AiError('AUTH', 'The AI service rejected the API key.', res.status);
      last = new AiError(res.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM', res.status === 429 ? 'The AI service is rate limiting requests.' : `The AI service returned ${res.status}.`, res.status);
      if (!retryable(res.status)) throw last;
      wait = backoffMs(attempt, res.headers.get('retry-after'), o.baseDelayMs, o.random);
    } catch (e) {
      if (e instanceof AiError) { if (e.code === 'AUTH' || e.code === 'BAD_RESPONSE' || !retryable(e.status ?? 500)) throw e; last = e; }
      else { last = (e as Error).name === 'AbortError' ? new AiError('TIMEOUT', 'The AI request timed out.') : new AiError('UPSTREAM', 'Could not reach the AI service.'); wait = backoffMs(attempt, null, o.baseDelayMs, o.random); }
    } finally { clearTimeout(timer); }
    if (attempt < retries && wait !== null) { logger.warn('anthropic retry', { attempt: attempt + 1, code: last.code, status: last.status }); await sleep(wait); }
  }
  throw last;
}
