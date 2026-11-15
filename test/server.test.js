import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Checker } from '../src/checker.js';
import { loadIdentity } from '../src/keys.js';
import { ReportLog } from '../src/reportLog.js';
import { createHttpServer } from '../src/server.js';

const CONFIG = { intervalMs: 60_000, reportLimit: 100, maxReportLimit: 1000 };

async function withServer(t, { seed = 2 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-server-'));
  const identity = loadIdentity(null);
  const reportLog = new ReportLog({
    filePath: join(dir, 'reports.jsonl'),
    privateKey: identity.privateKey,
    publicKey: identity.publicKey,
  });
  reportLog.load();
  for (let i = 0; i < seed; i += 1) {
    reportLog.append(
      { target: 'a.example', url: 'https://a.example', reachable: true, latencyMs: 100, chainId: '0x38', blockHeight: 100 + i, error: null },
      'healthy',
    );
  }
  const checker = new Checker({
    targets: [{ name: 'a.example', url: 'https://a.example' }],
    thresholds: { slowMs: 2000, downFailures: 2, stallChecks: 3 },
    targetDelayMs: 0,
    requestTimeoutMs: 1000,
    backoffMs: 1000,
    fetchFn: async () => { throw new Error('no network in server tests'); },
    sleepFn: async () => {},
  });
  const server = createHttpServer({
    reportLog,
    checker,
    publicKeyPem: identity.publicKeyPem,
    stableIdentity: false,
    config: CONFIG,
    startedAt: '2026-11-15T00:00:00.000Z',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base, identity, reportLog };
}

test('GET /health returns ok:true', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('GET /public-key returns the PEM public key', async (t) => {
  const { base, identity } = await withServer(t);
  const res = await fetch(`${base}/public-key`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.equal(await res.text(), identity.publicKeyPem);
});

test('GET /api/status reports service, identity, and targets', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/api/status`);
  const body = await res.json();
  assert.equal(body.service, 'validator-watchdog');
  assert.equal(body.stableIdentity, false);
  assert.equal(body.reportCount, 2);
  assert.match(body.keyFingerprint, /^[0-9a-f]{16}$/);
  assert.equal(body.targets.length, 1);
  assert.equal(body.targets[0].name, 'a.example');
  assert.equal(body.targets[0].status, 'unknown'); // No cycle has run.
});

test('GET /api/reports returns newest first and honors limit', async (t) => {
  const { base } = await withServer(t, { seed: 3 });
  const res = await fetch(`${base}/api/reports?limit=2`);
  const { entries } = await res.json();
  assert.deepEqual(entries.map((e) => e.seq), [2, 1]);
  const entry = entries[0];
  for (const field of ['seq', 'timestamp', 'target', 'url', 'reachable', 'latencyMs', 'chainId', 'blockHeight', 'status', 'prevHash', 'hash', 'signature']) {
    assert.ok(field in entry, `missing field ${field}`);
  }
});

test('GET /api/reports/:seq returns one entry, 404 when missing', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/api/reports/1`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).entry.seq, 1);
  const missing = await fetch(`${base}/api/reports/99`);
  assert.equal(missing.status, 404);
});

test('GET / renders a dashboard with the target table', async (t) => {
  const { base } = await withServer(t);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /Validator Watchdog/);
  assert.match(html, /a\.example/);
  assert.match(html, /\/public-key/);
  assert.match(html, /not zkVerify proofs/);
});

test('unknown routes 404, non-GET methods 405', async (t) => {
  const { base } = await withServer(t);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 405);
});
