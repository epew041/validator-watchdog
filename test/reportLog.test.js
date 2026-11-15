import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadIdentity } from '../src/keys.js';
import { GENESIS_PREV_HASH, ReportLog, canonicalBytes, hashBytes, verifyChain } from '../src/reportLog.js';

function makeLog() {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-log-'));
  const identity = loadIdentity(null);
  const log = new ReportLog({
    filePath: join(dir, 'reports.jsonl'),
    privateKey: identity.privateKey,
    publicKey: identity.publicKey,
  });
  return { dir, identity, log };
}

function observation(overrides = {}) {
  return {
    target: 'example.org',
    url: 'https://example.org',
    reachable: true,
    latencyMs: 120,
    chainId: '0x38',
    blockHeight: 100,
    error: null,
    ...overrides,
  };
}

test('appended entries chain and verify', () => {
  const { identity, log } = makeLog();
  const a = log.append(observation({ blockHeight: 100 }), 'healthy');
  const b = log.append(observation({ blockHeight: 101 }), 'healthy');
  assert.equal(a.seq, 0);
  assert.equal(a.prevHash, GENESIS_PREV_HASH);
  assert.equal(b.seq, 1);
  assert.equal(b.prevHash, a.hash);
  assert.equal(b.hash, hashBytes(canonicalBytes(b)));
  assert.deepEqual(verifyChain(log.entries, identity.publicKey), []);
  assert.deepEqual(log.verify(), []);
});

test('tampering with entry content is detected', () => {
  const { identity, log } = makeLog();
  log.append(observation({ blockHeight: 100 }), 'healthy');
  log.append(observation({ blockHeight: 101 }), 'healthy');
  const tampered = structuredClone(log.entries);
  tampered[1].blockHeight = 999;
  const failures = verifyChain(tampered, identity.publicKey);
  assert.ok(failures.some((f) => f.reason.includes('hash mismatch')));
  assert.ok(failures.some((f) => f.reason.includes('signature invalid')));
});

test('tampering with a signature is detected', () => {
  const { identity, log } = makeLog();
  log.append(observation(), 'healthy');
  const tampered = structuredClone(log.entries);
  tampered[0].signature = Buffer.from('forged').toString('base64');
  const failures = verifyChain(tampered, identity.publicKey);
  assert.ok(failures.some((f) => f.reason.includes('signature invalid')));
});

test('breaking the hash chain is detected', () => {
  const { identity, log } = makeLog();
  log.append(observation(), 'healthy');
  log.append(observation(), 'healthy');
  const tampered = structuredClone(log.entries);
  tampered[1].prevHash = '0'.repeat(64);
  const failures = verifyChain(tampered, identity.publicKey);
  assert.ok(failures.some((f) => f.reason.includes('prevHash mismatch')));
});

test('entries signed by another key fail verification', () => {
  const { log } = makeLog();
  const other = loadIdentity(null);
  log.append(observation(), 'healthy');
  const failures = verifyChain(log.entries, other.publicKey);
  assert.ok(failures.some((f) => f.reason.includes('signature invalid')));
});

test('log persists and reloads with the chain intact', () => {
  const { dir, identity, log } = makeLog();
  log.append(observation({ blockHeight: 100 }), 'healthy');
  log.append(observation({ blockHeight: 101 }), 'degraded');
  const filePath = join(dir, 'reports.jsonl');
  const lines = readFileSync(filePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);

  const reloaded = new ReportLog({ filePath, privateKey: identity.privateKey, publicKey: identity.publicKey });
  const result = reloaded.load();
  assert.deepEqual(result, { loaded: 2, dropped: 0 });
  assert.deepEqual(reloaded.verify(), []);
  const next = reloaded.append(observation({ blockHeight: 102 }), 'healthy');
  assert.equal(next.seq, 2);
  assert.equal(next.prevHash, reloaded.entries[1].hash);
});

test('reload keeps only the valid prefix after tampering', () => {
  const { dir, identity, log } = makeLog();
  log.append(observation({ blockHeight: 100 }), 'healthy');
  log.append(observation({ blockHeight: 101 }), 'healthy');
  const filePath = join(dir, 'reports.jsonl');
  const lines = readFileSync(filePath, 'utf8').trim().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.blockHeight = 555; // Content altered after signing.
  writeFileSync(filePath, `${lines[0]}\n${JSON.stringify(tampered)}\n`, 'utf8');

  const warnings = [];
  const reloaded = new ReportLog({
    filePath,
    privateKey: identity.privateKey,
    publicKey: identity.publicKey,
    onWarning: (m) => warnings.push(m),
  });
  const result = reloaded.load();
  assert.equal(result.loaded, 1);
  assert.equal(result.dropped, 1);
  assert.equal(warnings.length, 1);
  assert.deepEqual(reloaded.verify(), []);
});

test('malformed lines are dropped with a warning', () => {
  const { dir, identity, log } = makeLog();
  log.append(observation(), 'healthy');
  const filePath = join(dir, 'reports.jsonl');
  appendFileSync(filePath, 'this is not json\n', 'utf8');
  const warnings = [];
  const reloaded = new ReportLog({
    filePath,
    privateKey: identity.privateKey,
    publicKey: identity.publicKey,
    onWarning: (m) => warnings.push(m),
  });
  const result = reloaded.load();
  assert.equal(result.loaded, 1);
  assert.equal(result.dropped, 1);
  assert.ok(warnings.some((w) => w.includes('malformed')));
});

test('listNewestFirst and get', () => {
  const { log } = makeLog();
  log.append(observation({ blockHeight: 100 }), 'healthy');
  log.append(observation({ blockHeight: 101 }), 'healthy');
  log.append(observation({ blockHeight: 102 }), 'healthy');
  assert.deepEqual(log.listNewestFirst(2).map((e) => e.seq), [2, 1]);
  assert.equal(log.get(1).blockHeight, 101);
  assert.equal(log.get(99), null);
});
