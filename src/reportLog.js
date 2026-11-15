// Signed, hash-chained report log.
//
// Every observation becomes one entry. Entries chain: each entry carries
// prevHash (the SHA-256 of the previous entry's canonical bytes) and an
// Ed25519 signature over its own canonical bytes. Anyone with the public key
// from GET /public-key can recompute the chain and every signature offline
// (see scripts/verify.js, which reimplements this independently).
//
// Canonical bytes: JSON.stringify of a fixed-order object WITHOUT the hash
// and signature fields. Field order is part of the format — changing it
// invalidates every signature, so it is defined once, here, and mirrored in
// scripts/verify.js. The verify script's end-to-end test guards agreement.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicKeyFromPem, signBytes, verifySignature } from './keys.js';

export const GENESIS_PREV_HASH = 'GENESIS';

const CANONICAL_FIELDS = [
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

export function canonicalBytes(entry) {
  const ordered = {};
  for (const field of CANONICAL_FIELDS) {
    ordered[field] = entry[field] ?? null;
  }
  return Buffer.from(JSON.stringify(ordered), 'utf8');
}

export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Pure verification: recompute the chain and every signature. Returns a list
// of failures; an empty list means the log is intact.
export function verifyChain(entries, publicKey) {
  const failures = [];
  let expectedPrev = GENESIS_PREV_HASH;
  let expectedSeq = 0;
  for (const entry of entries) {
    const where = `seq ${entry?.seq ?? '?'}`;
    if (entry?.seq !== expectedSeq) {
      failures.push({ seq: entry?.seq ?? null, reason: `sequence break at ${where}: expected ${expectedSeq}` });
    }
    if (entry?.prevHash !== expectedPrev) {
      failures.push({ seq: entry?.seq ?? null, reason: `prevHash mismatch at ${where}` });
    }
    const bytes = canonicalBytes(entry ?? {});
    const hash = hashBytes(bytes);
    if (entry?.hash !== hash) {
      failures.push({ seq: entry?.seq ?? null, reason: `hash mismatch at ${where} (entry content altered)` });
    }
    if (typeof entry?.signature !== 'string' || !verifySignature(publicKey, bytes, entry.signature)) {
      failures.push({ seq: entry?.seq ?? null, reason: `signature invalid at ${where}` });
    }
    expectedPrev = entry?.hash ?? expectedPrev;
    expectedSeq = (entry?.seq ?? expectedSeq) + 1;
  }
  return failures;
}

export class ReportLog {
  constructor({ filePath, privateKey, publicKey, onWarning = () => {} }) {
    this.filePath = filePath;
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.onWarning = onWarning;
    this.entries = [];
  }

  // Load the persisted log, keeping only the valid prefix. A corrupt or
  // tampered tail is dropped from memory (and reported) rather than trusted;
  // new entries chain from the last valid entry.
  load() {
    if (!existsSync(this.filePath)) {
      this.entries = [];
      return { loaded: 0, dropped: 0 };
    }
    const lines = readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
    const parsed = [];
    let malformed = 0;
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        malformed += 1;
      }
    }
    const failures = verifyChain(parsed, this.publicKey);
    let kept = parsed;
    if (failures.length > 0) {
      // Keep the longest valid prefix: truncate at the first failing entry.
      const firstBadSeq = Math.min(...failures.map((f) => (typeof f.seq === 'number' ? f.seq : Infinity)));
      kept = parsed.filter((e) => typeof e.seq === 'number' && e.seq < firstBadSeq);
      this.onWarning(
        `report log failed verification (${failures.length} problem(s), first at seq ${firstBadSeq}); ` +
          `keeping ${kept.length} valid entr${kept.length === 1 ? 'y' : 'ies'} and chaining from there`,
      );
    }
    if (malformed > 0) {
      this.onWarning(`dropped ${malformed} malformed line(s) from report log`);
    }
    this.entries = kept;
    return { loaded: kept.length, dropped: parsed.length - kept.length + malformed };
  }

  append(observation, status) {
    const prev = this.entries[this.entries.length - 1];
    const entry = {
      seq: this.entries.length,
      timestamp: new Date().toISOString(),
      target: observation.target,
      url: observation.url,
      reachable: observation.reachable,
      latencyMs: observation.latencyMs,
      chainId: observation.chainId,
      blockHeight: observation.blockHeight,
      status,
      error: observation.error ?? null,
      prevHash: prev ? prev.hash : GENESIS_PREV_HASH,
    };
    const bytes = canonicalBytes(entry);
    entry.hash = hashBytes(bytes);
    entry.signature = signBytes(this.privateKey, bytes);
    mkdirSync(join(this.filePath, '..'), { recursive: true });
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    this.entries.push(entry);
    return entry;
  }

  listNewestFirst(limit) {
    return [...this.entries].reverse().slice(0, limit);
  }

  get(seq) {
    return this.entries.find((e) => e.seq === seq) ?? null;
  }

  verify() {
    return verifyChain(this.entries, this.publicKey);
  }
}

export { publicKeyFromPem };
