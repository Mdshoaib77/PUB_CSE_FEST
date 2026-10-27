/**
 * Dependency-free QR Code generator (S5): byte mode, error-correction level M, versions 1-10 (up to 213 bytes), mask 0.
 * `qrMatrix(text)` -> square boolean matrix (true = dark module). Pure and synchronous.
 * Structure follows ISO/IEC 18004 (finder/timing/alignment patterns, BCH format + version info, Reed-Solomon over GF(256)).
 */

// [total codewords, EC codewords per block, [[blockCount, dataCodewordsPerBlock], ...]] for level M
const M_TABLE: Record<number, [number, [number, number][]]> = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

// GF(256), primitive polynomial 0x11D
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsRemainder(data: number[], ecLen: number): number[] {
  let gen = [1];
  for (let i = 0; i < ecLen; i++) {
    const next = new Array<number>(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gmul(gen[j], EXP[i]);
    }
    gen = next;
  }
  const rem = new Array<number>(ecLen).fill(0);
  for (const b of data) {
    const f = b ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let j = 0; j < ecLen; j++) rem[j] ^= gmul(gen[j + 1], f);
  }
  return rem;
}

function utf8(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

function encodeData(bytes: number[], version: number, dataCap: number): number[] {
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; out.length < dataCap; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = utf8(text);
  let version = 0;
  let dataCap = 0;
  for (let v = 1; v <= 10; v++) {
    const [ec, groups] = M_TABLE[v];
    void ec;
    dataCap = groups.reduce((a, [n, d]) => a + n * d, 0);
    const need = 4 + (v < 10 ? 8 : 16) + bytes.length * 8;
    if (need <= dataCap * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('qrMatrix: text too long (max 213 bytes)');
  const [ecLen, groups] = M_TABLE[version];
  const data = encodeData(bytes, version, dataCap);

  // split into blocks, add EC, interleave
  const blocks: { d: number[]; e: number[] }[] = [];
  let pos = 0;
  for (const [n, len] of groups)
    for (let i = 0; i < n; i++) {
      const d = data.slice(pos, pos + len);
      pos += len;
      blocks.push({ d, e: rsRemainder(d, ecLen) });
    }
  const all: number[] = [];
  const maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) all.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) all.push(b.e[i]);

  const size = version * 4 + 17;
  const mod: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const setFn = (x: number, y: number, dark: boolean) => {
    mod[y][x] = dark;
    fn[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(x, y, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const ap = ALIGN[version];
  for (let i = 0; i < ap.length; i++)
    for (let j = 0; j < ap.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === ap.length - 1) || (i === ap.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(ap[i] + dx, ap[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  const formatBits = (mask: number) => {
    const d = (0b00 << 3) | mask; // level M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((d << 10) | rem) ^ 0x5412;
  };
  const drawFormat = (mask: number) => {
    const b = formatBits(mask);
    const bit = (i: number) => ((b >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6));
    setFn(8, 8, bit(7));
    setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  // place codewords (zig-zag), then mask 0
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[y][x] && k < all.length * 8) {
          mod[y][x] = ((all[k >>> 3] >>> (7 - (k & 7))) & 1) !== 0;
          k++;
        }
      }
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && (x + y) % 2 === 0) mod[y][x] = !mod[y][x];
  drawFormat(0);
  return mod;
}
