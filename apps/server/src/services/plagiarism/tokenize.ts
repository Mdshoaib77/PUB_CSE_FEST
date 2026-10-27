/**
 * Offline tokenizer for the plagiarism engine (S11). Pure: no I/O, no dependencies.
 * Strips comments + whitespace and normalizes: identifiers -> `ID`, numbers -> `NUM`, strings/chars -> `STR`.
 * Keywords and operators are kept, so renamed variables / changed literals / reformatting do not change the token stream.
 */
export const PLAGIARISM_LANGUAGES = ['python', 'c', 'cpp', 'java', 'javascript'] as const;
export type PlagiarismLanguage = (typeof PLAGIARISM_LANGUAGES)[number];

const kw = (s: string) => new Set(s.split(/\s+/).filter(Boolean));
const C_KW = 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while';
const KEYWORDS: Record<PlagiarismLanguage, Set<string>> = {
  c: kw(C_KW),
  cpp: kw(`${C_KW} bool catch class delete explicit false friend namespace new operator private protected public template this throw true try typename using virtual nullptr constexpr override final`),
  java: kw('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record'),
  javascript: kw('async await break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while with yield'),
  python: kw('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'),
};

/** Longest first: the scanner tries 3, then 2, then 1 characters. */
const OPS3 = new Set(['<<=', '>>=', '...', '===', '!==', '**=', '//=', '>>>', '->*', '<=>']);
const OPS2 = new Set(['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '->', '::', '=>', '**', '//', ':=', '??', '?.']);

const isIdStart = (c: string) => /[A-Za-z_$\u0080-\uFFFF]/.test(c);
const isIdPart = (c: string) => /[A-Za-z0-9_$\u0080-\uFFFF]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

/** Hard cap so a hostile 200 KB file of single characters cannot make the engine do unbounded work. */
export const MAX_TOKENS = 60_000;

export function tokenize(code: string, lang: PlagiarismLanguage): string[] {
  return scan(code, lang);
}

/** Same stream as `tokenize`, plus the 0-based line (in the \r\n -> \n normalized text) each token starts on. Used by the side-by-side view. */
export function tokenizeWithLines(code: string, lang: PlagiarismLanguage): { tokens: string[]; lines: number[] } {
  const lines: number[] = [];
  return { tokens: scan(code, lang, lines), lines };
}

function scan(code: string, lang: PlagiarismLanguage, lines?: number[]): string[] {
  const out: string[] = [];
  const src = code.replace(/\r\n?/g, '\n');
  let lastPos = 0;
  let ln = 0;
  const n = src.length;
  const keywords = KEYWORDS[lang];
  const py = lang === 'python';
  const cLike = lang === 'c' || lang === 'cpp';
  let i = 0;
  let lineStart = true; // only whitespace seen so far on this line (for C preprocessor lines)
  const push = (t: string) => {
    if (out.length >= MAX_TOKENS) return;
    out.push(t);
    if (lines) {
      // every push happens before `i` moves past the token, so `i` is its start offset
      while (lastPos < i) if (src[lastPos++] === '\n') ln++;
      lines.push(ln);
    }
  };
  while (i < n && out.length < MAX_TOKENS) {
    const c = src[i]!;
    if (c === '\n') {
      lineStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    // ---- comments
    if (py ? c === '#' : c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (!py && c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    // ---- C preprocessor: `#include <x>` / `#define ...` -> one PP token for the whole directive head, rest skipped (line continuation aware)
    if (cLike && c === '#' && lineStart) {
      let j = i + 1;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) j++;
      let k = j;
      while (k < n && /[a-z]/i.test(src[k]!)) k++;
      const dir = src.slice(j, k);
      push(`#${dir}`);
      i = k;
      if (dir === 'include') {
        while (i < n && src[i] !== '\n') i++; // header names are not identifiers worth comparing
      } else {
        while (i < n && !(src[i] === '\n' && src[i - 1] !== '\\')) i++; // macro bodies: stay out (renamed macros are noise)
      }
      continue;
    }
    lineStart = false;
    // ---- strings
    if (py) {
      const m = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(src.slice(i, i + 6));
      if (m && (m[1]!.length === 0 || isQuoteAfterPrefix(src, i, m[1]!.length))) {
        const q = m[2]!;
        let j = i + m[0].length;
        const raw = /r/i.test(m[1]!);
        while (j < n) {
          if (src[j] === '\\' && !raw) j += 2;
          else if (src.startsWith(q, j)) {
            j += q.length;
            break;
          } else if (q.length === 1 && src[j] === '\n') break;
          else j++;
        }
        push('STR');
        i = Math.min(j, n);
        continue;
      }
    } else if (c === '"' || c === "'" || (c === '`' && lang === 'javascript')) {
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === c) {
          j++;
          break;
        } else if (src[j] === '\n' && c !== '`') break;
        else j++;
      }
      push('STR');
      i = Math.min(j, n);
      continue;
    }
    // ---- numbers
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j]!)) {
        if ((src[j] === 'e' || src[j] === 'E') && (src[j + 1] === '+' || src[j + 1] === '-')) j++;
        j++;
      }
      push('NUM');
      i = j;
      continue;
    }
    // ---- identifiers / keywords
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(src[j]!)) j++;
      const w = src.slice(i, j);
      push(keywords.has(w) ? w : 'ID');
      i = j;
      continue;
    }
    // ---- operators / punctuation
    const t3 = src.slice(i, i + 3);
    const t2 = src.slice(i, i + 2);
    if (OPS3.has(t3)) {
      push(t3);
      i += 3;
    } else if (OPS2.has(t2)) {
      push(t2);
      i += 2;
    } else {
      push(c);
      i++;
    }
  }
  return out;
}

/** `rb"..."`-style prefixes: the quote must come right after 1-2 prefix letters, otherwise `br` etc. would be an identifier. */
function isQuoteAfterPrefix(src: string, i: number, len: number): boolean {
  const q = src[i + len];
  return q === '"' || q === "'";
}

/** File extensions accepted on upload, per language (lower case, with dot). */
export const LANGUAGE_EXTENSIONS: Record<PlagiarismLanguage, string[]> = {
  python: ['.py'],
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.h'],
  java: ['.java'],
  javascript: ['.js', '.mjs', '.cjs'],
};
