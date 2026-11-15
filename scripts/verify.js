// Offline verification for Validator Watchdog reports.
//
// Usage: node scripts/verify.js [baseUrl]   (default: http://localhost:3000)
//
// Fetches the public key and the full report log, then independently
// recomputes the hash chain and verifies every Ed25519 signature. This
// script deliberately reimplements the canonical format instead of importing
// the server code, so a bug in the server's signing path cannot hide behind
// shared code. An end-to-end test proves the two implementations agree.
//
// Exit 0: every entry verified. Exit 1: any tamper, break, or fetch failure.
import { createHash, createPublicKey, verify } from 'node:crypto';

const FIELDS = [
  'seq',
  'timestamp',
  'target',
  'url',
  'reachable',
  'latencyMs',
  'chainId',
  'blockHeight',
  'status',
  'error',
  'prevHash',
];

function canonicalBytes(entry) {
  const ordered = {};
  for (const field of FIELDS) ordered[field] = entry[field] ?? null;
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

export async function verifyRemote(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  const pem = await fetchText(`${base}/public-key`);
  const publicKey = createPublicKey(pem);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('public key is not Ed25519');
  }
  const { entries } = await fetchJson(`${base}/api/reports?limit=1000`);
  const chronological = [...entries].reverse(); // API returns newest first.

  const failures = [];
  let expectedPrev = 'GENESIS';
  let expectedSeq = 0;
  for (const entry of chronological) {
    const problems = [];
    if (entry.seq !== expectedSeq) problems.push(`expected seq ${expectedSeq}`);
    if (entry.prevHash !== expectedPrev) problems.push('prevHash mismatch');
    const bytes = canonicalBytes(entry);
    if (entry.hash !== createHash('sha256').update(bytes).digest('hex')) {
      problems.push('hash mismatch (content altered)');
    }
    let sigOk = false;
    try {
      sigOk = verify(null, bytes, publicKey, Buffer.from(entry.signature, 'base64'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) problems.push('signature invalid');
    if (problems.length > 0) failures.push({ seq: entry.seq, problems });
    expectedPrev = entry.hash;
    expectedSeq = entry.seq + 1;
  }
  return { checked: chronological.length, failures, keyFingerprint: createHash('sha256').update(pem).digest('hex').slice(0, 16) };
}

const invokedDirectly = process.argv[1]?.endsWith('verify.js') ?? false;
if (invokedDirectly) {
  const baseUrl = process.argv[2] ?? 'http://localhost:3000';
  try {
    const { checked, failures, keyFingerprint } = await verifyRemote(baseUrl);
    console.log(`checked ${checked} report entr${checked === 1 ? 'y' : 'ies'} against key ${keyFingerprint} at ${baseUrl}`);
    if (failures.length === 0) {
      console.log('OK: hash chain intact, all signatures valid');
      process.exit(0);
    }
    for (const f of failures) console.log(`FAIL seq ${f.seq}: ${f.problems.join('; ')}`);
    console.log(`TAMPER DETECTED: ${failures.length} entr${failures.length === 1 ? 'y' : 'ies'} failed verification`);
    process.exit(1);
  } catch (error) {
    console.log(`ERROR: ${error?.message ?? error}`);
    process.exit(1);
  }
}
