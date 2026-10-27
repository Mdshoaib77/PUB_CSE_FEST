import { describe, expect, it } from 'vitest';
import { similarityOf, tokenize, fingerprint, winnow, ngramHashes } from '../services/plagiarism';

const C_A = `#include <stdio.h>
// sum positives doubled
int main(){ int n; scanf("%d",&n); int s=0; for(int i=0;i<n;i++){ int x; scanf("%d",&x); if(x>0) s+=x*2; else s-=1; } printf("%d\\n", s); return 0; }`;
const C_RENAMED = `#include <stdio.h>
/* different comment */
int main()
{
    int count;
    scanf("%d", &count);
    int total = 0;
    for (int idx = 0; idx < count; idx++)
    {
        int val;
        scanf("%d", &val);
        if (val > 0)
            total += val * 7;
        else
            total -= 9;
    }
    printf("%d\\n", total);
    return 0;
}`;
const C_OTHER = `#include <stdio.h>
int fib(int n){ return n<2?n:fib(n-1)+fib(n-2); }
int main(){ int n; scanf("%d",&n); for(int i=0;i<n;i++) printf("%d ", fib(i)); puts(""); return 0; }`;

describe('plagiarism tokenizer (S11)', () => {
  it('drops comments + whitespace, normalizes identifiers / numbers / strings', () => {
    expect(tokenize('int x = 10; // c\n/* b */ char* s = "hi";', 'c').join(' ')).toBe('int ID = NUM ; char * ID = STR ;');
    expect(tokenize('s = f"x{1}" + """doc\nstring""" # c\nx = 0x1F', 'python').join(' ')).toBe('ID = STR + STR ID = NUM');
    expect(tokenize('const a = `t ${x}`; // z', 'javascript').join(' ')).toBe('const ID = STR ;');
  });
  it('keeps keywords and operators, so structure still counts', () => {
    expect(tokenize('for (;;) { if (a >= b && c) break; }', 'java').join(' ')).toBe('for ( ; ; ) { if ( ID >= ID && ID ) break ; }');
  });
  it('is bounded for hostile input', () => {
    expect(tokenize('a '.repeat(200_000), 'python').length).toBeLessThanOrEqual(60_000);
    expect(() => tokenize('"unterminated /* ', 'c')).not.toThrow();
  });
});

describe('winnowing + similarity (S11)', () => {
  it('winnowing guarantees a shared run of w+k-1 tokens shares a fingerprint', () => {
    const k = 5, w = 4;
    const run = Array.from({ length: w + k - 1 }, (_, i) => `t${i}`);
    const a = winnow(ngramHashes(['x1', 'x2', 'x3', ...run, 'y1'], k), w);
    const b = winnow(ngramHashes(['p', 'q', ...run, 'z', 'z2', 'z3'], k), w);
    expect([...a].some((h) => b.has(h))).toBe(true);
  });
  it('renamed variables + changed literals + reformatting + comments => 100%', () => {
    const r = similarityOf(C_A, C_RENAMED, 'c');
    expect(r.similarity).toBe(100);
    expect(r.winnowScore).toBe(1);
    expect(r.jaccardScore).toBe(1);
  });
  it('different programs score clearly lower', () => {
    expect(similarityOf(C_A, C_OTHER, 'c').similarity).toBeLessThan(60);
  });
  it('python: renamed + reformatted copy is detected', () => {
    const a = 'import sys\n# read\ndef solve(arr):\n    total = 0\n    for v in arr:\n        if v % 2 == 0:\n            total += v * 3\n        else:\n            total -= 1\n    return total\nprint(solve(list(map(int, sys.stdin.read().split()))))';
    const b = 'import sys\ndef calc(numbers):\n  acc=0\n  for item in numbers:\n    if item%2==0: acc+=item*5\n    else: acc-=2\n  return acc\n\nprint(calc(list(map(int,sys.stdin.read().split()))))  # go';
    expect(similarityOf(a, b, 'python').similarity).toBe(100);
  });
  it('java: renamed class + variables + reformatting', () => {
    const a = 'public class A { public static void main(String[] a){ int x=1; for(int i=0;i<10;i++){ x+=i*2; } System.out.println(x);} }';
    const b = 'public class B {\n // hi\n public static void main(String[] args) {\n int total = 5;\n for (int k = 0; k < 99; k++) { total += k * 3; }\n System.out.println(total);\n }\n}';
    expect(similarityOf(a, b, 'java').similarity).toBe(100);
  });
  it('starter code is excluded: two students who only share the template are not similar', () => {
    const tpl = '#include <stdio.h>\nint main(){ int n; scanf("%d",&n);';
    const with_ = similarityOf(C_A, C_OTHER, 'c', [{ code: tpl }]);
    const without = similarityOf(C_A, C_OTHER, 'c');
    expect(with_.similarity).toBeLessThan(without.similarity);
    // code that is ONLY the template has nothing left to compare
    const onlyTpl = similarityOf(tpl + ' }', tpl + ' return 0; }', 'c', [{ code: tpl }]);
    expect(onlyTpl.similarity).toBeLessThan(30);
  });
  it('too-short code is "not comparable" rather than 100% similar', () => {
    const r = similarityOf('x = 1', 'x = 2', 'python');
    expect(r.comparable).toBe(false);
    expect(r.similarity).toBe(0);
  });
  it('is deterministic and symmetric', () => {
    expect(similarityOf(C_A, C_OTHER, 'c')).toEqual(similarityOf(C_A, C_OTHER, 'c'));
    expect(similarityOf(C_A, C_OTHER, 'c').similarity).toBe(similarityOf(C_OTHER, C_A, 'c').similarity);
    expect(fingerprint(C_A, 'c').prints.size).toBeGreaterThan(5);
  });
});
