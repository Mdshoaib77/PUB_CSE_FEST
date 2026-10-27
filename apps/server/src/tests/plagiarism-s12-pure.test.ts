import { describe, expect, it } from 'vitest';
import { matchingBlocks, tokenize, tokenizeWithLines } from '../services/plagiarism';

const A = '#include <stdio.h>\nint main(){\n  int n; scanf("%d",&n);\n  int s=0;\n  for(int i=0;i<n;i++){ int x; scanf("%d",&x); if(x>0) s+=x*2; else s-=1; }\n  printf("%d", s);\n  return 0;\n}\n';
const B = '#include <stdio.h>\n/* mine */\nint helper(int q){ return q*q+1; }\nint main()\n{\n  int count;\n  scanf("%d",&count);\n  int total = 0;\n  for (int k=0;k<count;k++)\n  {\n    int v; scanf("%d",&v);\n    if (v>0) total+=v*9; else total-=4;\n  }\n  printf("%d", total);\n  return 0;\n}\n';

describe('matching blocks (S12)', () => {
  it('token stream with lines is the same stream as tokenize()', () => {
    const t = tokenizeWithLines(A, 'c');
    expect(t.tokens).toEqual(tokenize(A, 'c'));
    expect(t.lines.length).toBe(t.tokens.length);
    expect(t.lines[0]).toBe(0);
  });
  it('renamed / reformatted copy: the shared code is highlighted on both sides, the extra helper and comment are not', () => {
    const v = matchingBlocks(A, B, 'c');
    expect(v.blocks).toBe(1);
    const mark = (lines: { text: string; block: number | null }[], needle: string) => lines.find((l) => l.text.includes(needle))!.block;
    expect(mark(v.a, 'scanf("%d",&n)')).toBe(1);
    expect(mark(v.b, 'scanf("%d",&count)')).toBe(1);
    expect(mark(v.b, 'helper')).toBe(null);
    expect(mark(v.b, '/* mine */')).toBe(null);
    expect(v.a.length).toBe(A.split('\n').length);
  });
  it('unrelated code has no blocks; starter code is not highlighted', () => {
    expect(matchingBlocks('x = 1\nprint(x)\n', 'def f(a, b):\n    return a * b + 7\n', 'python').blocks).toBe(0);
  });
});
