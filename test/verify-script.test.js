// End-to-end: scripts/verify.js against a live server (intact log -> exit 0)
// and against a tampered log served by a fake server (exit non-zero).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Checker } from '../src/checker.js';
import { loadIdentity } from '../src/keys.js';
import { ReportLog } from '../src/reportLog.js';
import { createHttpServer } from '../src/server.js';

const execFileAsync = promisify(execFile);
const VERIFY_SCRIPT = fileURLToPath(new URL('../scripts/verify.js', import.meta.url));

async function startRealServer(t) {
  const dir = mkdtempSync(join(tmpdir(), 'watchdog-verify-'));
  const identity = loadIdentity(null);
  const reportLog = new ReportLog({
    filePath: join(dir, 'reports.jsonl'),
    privateKey: identity.privateKey,
    publicKey: identity.publicKey,
  });
  reportLog.load();
  reportLog.append(
    { target: 'a.example', url: 'https://a.example', reachable: true, latencyMs: 90, chainId: '0x38', blockHeight: 100, error: null },
    'healthy',
  );
  reportLog.append(
    { target: 'a.example', url: 'https://a.example', reachable: true, latencyMs: 95, chainId: '0x38', blockHeight: 101, error: null },
    'healthy',
  );
  const checker = new Checker({
    targets: [{ name: 'a.example', url: 'https://a.example' }],
    thresholds: { slowMs: 2000, downFailures: 2, stallChecks: 3 },
    targetDelayMs: 0,
    requestTimeoutMs: 1000,
    backoffMs: 1000,
    fetchFn: async () => { throw new Error('no network'); },
    sleepFn: async () => {},
  });
  const server = createHttpServer({
    reportLog, checker, publicKeyPem: identity.publicKeyPem, stableIdentity: false,
    config: { intervalMs: 60_000, reportLimit: 100, maxReportLimit: 1000 },
    startedAt: '2026-11-15T00:00:00.000Z',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}`, identity, entries: reportLog.entries };
}

test('verify script exits 0 on an intact log (proves script/server agreement)', async (t) => {
  const { base } = await startRealServer(t);
  const { stdout } = await execFileAsync('node', [VERIFY_SCRIPT, base]);
  assert.match(stdout, /checked 2 report entries/);
  assert.match(stdout, /OK: hash chain intact, all signatures valid/);
});

test('verify script exits non-zero on a tampered log', async (t) => {
  const { identity, entries } = await startRealServer(t);
  const tampered = structuredClone(entries);
  tampered[1].blockHeight = 9999; // Alter content after signing.
  const fake = createServer((req, res) => {
    if (req.url === '/public-key') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(identity.publicKeyPem);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ entries: [...tampered].reverse() }));
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => fake.close(resolve)));
  const base = `http://127.0.0.1:${fake.address().port}`;
  await assert.rejects(execFileAsync('node', [VERIFY_SCRIPT, base]), (error) => {
    assert.notEqual(error.code, 0);
    assert.match(error.stdout, /TAMPER DETECTED/);
    assert.match(error.stdout, /seq 1/);
    return true;
  });
});

test('verify script exits non-zero when the server is unreachable', async () => {
  await assert.rejects(
    execFileAsync('node', [VERIFY_SCRIPT, 'http://127.0.0.1:9']),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stdout, /ERROR/);
      return true;
    },
  );
});
