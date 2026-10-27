import { isDeepStrictEqual } from 'node:util';
type T = { name: string; fn: () => unknown };
const tests: T[] = []; let prefix: string[] = [];
export const describe = (n: string, f: () => void) => { prefix.push(n); f(); prefix.pop(); };
export const it: any = (n: string, fn: () => unknown) => tests.push({ name: [...prefix, n].join(' > '), fn });
it.each = (rows: any[]) => (n: string, fn: (v: any) => unknown) => rows.forEach((r) => tests.push({ name: [...prefix, n.replace('%i', String(r))].join(' > '), fn: () => fn(r) }));
const fmt = (v: unknown) => { try { return JSON.stringify(v); } catch { return String(v); } };
function mk(actual: any, neg = false): any {
  const chk = (ok: boolean, msg: string) => { if (neg ? ok : !ok) throw new Error((neg ? 'NOT ' : '') + msg); };
  const m: any = {
    toBe: (e: any) => chk(Object.is(actual, e), `expected ${fmt(actual)} toBe ${fmt(e)}`),
    toEqual: (e: any) => e?.asymmetricMatch ? chk(e.asymmetricMatch(actual), `expected ${fmt(actual)} toEqual arrayContaining`) : chk(isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(e))), `expected ${fmt(actual)} toEqual ${fmt(e)}`),
    toBeGreaterThanOrEqual: (e: number) => chk(actual >= e, `expected ${actual} >= ${e}`),
    toBeLessThanOrEqual: (e: number) => chk(actual <= e, `expected ${actual} <= ${e}`),
    toBeDefined: () => chk(actual !== undefined, 'expected value to be defined'),
    toBeUndefined: () => chk(actual === undefined, `expected ${fmt(actual)} toBeUndefined`),
    toHaveLength: (e: number) => chk(actual?.length === e, `expected length ${actual?.length} toBe ${e}`),
    toBeGreaterThan: (e: number) => chk(actual > e, `expected ${actual} > ${e}`),
    toBeLessThan: (e: number) => chk(actual < e, `expected ${actual} < ${e}`),
    toContain: (e: any) => chk(actual.includes(e), `expected ${fmt(actual)} toContain ${fmt(e)}`),
    toMatch: (re: RegExp) => chk(re.test(actual), `expected ${fmt(actual)} toMatch ${re}`),
    toBeInstanceOf: (c: any) => chk(actual instanceof c, `expected instance of ${c.name}`),
    toMatchObject: (e: any) => chk(Object.entries(e).every(([k, v]) => isDeepStrictEqual(actual?.[k], v)), `expected ${fmt(actual)} toMatchObject ${fmt(e)}`),
    toThrow: (c?: any) => { let t: any; try { actual(); } catch (x) { t = x; } chk(!!t && (!c || (c instanceof RegExp ? c.test(String(t.message)) : t instanceof c)), `expected function to throw ${c?.name ?? c ?? ''}`); },
  };
  m.not = neg ? m : mk(actual, true);
  m.rejects = { toMatchObject: async (e: any) => { let r: any; try { await actual; } catch (x) { r = x; } chk(!!r && Object.entries(e).every(([k, v]) => r[k] === v), `expected rejection ${fmt(e)}, got ${r?.code ?? r}`); }, toBeInstanceOf: async (c: any) => { let r: any; try { await actual; } catch (x) { r = x; } chk(r instanceof c, 'expected rejection instance'); } };
  return m;
}
export const expect: any = (a: any) => mk(a);
expect.arrayContaining = (items: any[]) => ({ asymmetricMatch: (a: any[]) => items.every((i) => a.includes(i)) });
export async function run() { let f = 0; for (const t of tests) { try { await t.fn(); console.log('  ok  ', t.name); } catch (e: any) { f++; console.log('  FAIL', t.name, '\n      ', e.message); } } console.log(`\n${tests.length - f}/${tests.length} passed`); process.exit(f ? 1 : 0); }
