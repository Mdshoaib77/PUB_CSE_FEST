/**
 * S12 demo code submissions for the plagiarism report. Idempotent: nothing is created when the demo students already have a
 * submission in the scope. Event: "Demo: Hack-a-thon Warm-up". Language: Python. Five students (demo.student1..5@festhub.test):
 *   student1  ORIGINAL   even-sum / max statistics
 *   student2  COPIED     student1's code, one comment + one extra line + a changed message (near-verbatim copy)  -> high similarity
 *   student3  ORIGINAL   prime sieve
 *   student4  RENAMED    student3's sieve with every variable/function renamed, other layout, other comments    -> high similarity
 *   student5  ORIGINAL   Fibonacci with memoisation (unrelated to the others)                                  -> low similarity
 * Pairs are computed directly with checkScope(); organisers get one "High code similarity" notification per suspicious pair.
 */
import bcrypt from 'bcryptjs';
import { CodeSubmission, Event, User } from '../models';
import { checkScope, scopeKeyOf, sha256 } from '../services/plagiarismCheck';
import { DEMO_PASSWORD } from './demo';

const STATS = `import sys

def read_numbers():
    data = sys.stdin.read().split()
    return [int(x) for x in data]

def summarize(values):
    even_total = 0
    biggest = values[0]
    for v in values:
        if v % 2 == 0:
            even_total += v
        if v > biggest:
            biggest = v
    return even_total, biggest

nums = read_numbers()
evens, top = summarize(nums)
print("sum of evens:", evens)
print("maximum:", top)
`;

const STATS_COPY = `import sys

# read all the numbers from stdin
def read_numbers():
    data = sys.stdin.read().split()
    return [int(x) for x in data]

def summarize(values):
    even_total = 0
    biggest = values[0]
    for v in values:
        if v % 2 == 0:
            even_total += v
        if v > biggest:
            biggest = v
    return even_total, biggest

nums = read_numbers()
evens, top = summarize(nums)
count = len(nums)
print("sum of evens:", evens)
print("maximum is", top)
`;

const SIEVE = `def sieve(limit):
    is_prime = [True] * (limit + 1)
    is_prime[0] = False
    if limit >= 1:
        is_prime[1] = False
    i = 2
    while i * i <= limit:
        if is_prime[i]:
            for j in range(i * i, limit + 1, i):
                is_prime[j] = False
        i += 1
    return [n for n in range(2, limit + 1) if is_prime[n]]

n = int(input())
primes = sieve(n)
print(len(primes))
print(" ".join(str(p) for p in primes))
`;

const SIEVE_RENAMED = `# Eratosthenes
def find_primes(upper):
  flags = [True] * (upper + 1)
  flags[0] = False
  if upper >= 1:
    flags[1] = False
  k = 2
  while k * k <= upper:
    if flags[k]:
      for m in range(k * k, upper + 1, k):
        flags[m] = False
    k += 1
  return [x for x in range(2, upper + 1) if flags[x]]


limit = int(input())
found = find_primes(limit)
print(len(found))
print(" ".join(str(q) for q in found))
`;

const FIB = `import sys
sys.setrecursionlimit(10000)
cache = {0: 0, 1: 1}

def fib(k):
    if k not in cache:
        cache[k] = fib(k - 1) + fib(k - 2)
    return cache[k]

count = int(input())
row = []
for idx in range(count):
    row.append(str(fib(idx)))
print(",".join(row))
`;

export async function seedPlagiarism(log: (m: string) => void = console.log): Promise<{ submissions: number; pairs: number }> {
  const ev = await Event.findOne({ title: 'Demo: Hack-a-thon Warm-up' });
  if (!ev) return { submissions: 0, pairs: 0 };
  const scopeKey = scopeKeyOf({ eventId: ev.id })!;
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const students: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const email = `demo.student${i}@festhub.test`;
    const u = (await User.findOne({ email })) ?? (await User.create({ name: `Demo Student ${i}`, email, roles: ['participant'], department: 'CSE', batch: '2023', passwordHash }));
    students.push(u.id);
  }
  if (await CodeSubmission.exists({ scopeKey, userId: students[0] })) return { submissions: 0, pairs: 0 };
  const plan: [number, string, string | undefined][] = [
    [0, STATS, 'stats.py'], // upload
    [1, STATS_COPY, undefined], // pasted copy
    [2, SIEVE, undefined],
    [3, SIEVE_RENAMED, 'sieve_final.py'],
    [4, FIB, undefined],
  ];
  const t0 = Date.now() - plan.length * 600_000;
  let n = 0;
  for (const [i, code, file] of plan) {
    await CodeSubmission.create({
      userId: students[i], eventId: ev._id, scopeKey, language: 'python', code, source: file ? 'upload' : 'paste', fileName: file,
      sizeBytes: Buffer.byteLength(code, 'utf8'), codeHash: sha256(code), submittedAt: new Date(t0 + n * 600_000),
    });
    n++;
  }
  const pairs = await checkScope(scopeKey);
  log(`Demo seed: ${n} code submission(s) for "${ev.title}" (1 copied pair, 1 renamed-variables pair, 1 unrelated original); ${pairs} pair(s) stored. Review at /plagiarism as demo.organiser.`);
  return { submissions: n, pairs };
}
