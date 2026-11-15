// Validator Watchdog entrypoint: wire config, identity, report log, checker
// loop, and HTTP server. No host binding (Railway-compatible); PORT from env.
import { join } from 'node:path';
import { Checker } from './checker.js';
import { loadConfig } from './config.js';
import { loadIdentity } from './keys.js';
import { ReportLog } from './reportLog.js';
import { createHttpServer } from './server.js';

const config = loadConfig();
const startedAt = new Date().toISOString();

const identity = loadIdentity(config.privateKeyPem);
if (identity.stableIdentity) {
  console.log(JSON.stringify({ event: 'identity', mode: 'stable', note: 'signing with configured WATCHDOG_PRIVATE_KEY' }));
} else {
  console.log(JSON.stringify({
    event: 'identity',
    mode: 'ephemeral',
    note: 'no WATCHDOG_PRIVATE_KEY set: fresh keypair generated at boot; reports from this boot verify only against this boot public key',
  }));
}

const reportLog = new ReportLog({
  filePath: join(config.dataDir, 'reports.jsonl'),
  privateKey: identity.privateKey,
  publicKey: identity.publicKey,
  onWarning: (message) => console.log(JSON.stringify({ event: 'report_log_warning', message })),
});
const loaded = reportLog.load();
console.log(JSON.stringify({ event: 'report_log_loaded', ...loaded }));

const checker = new Checker({
  targets: config.targets,
  thresholds: {
    slowMs: config.slowMs,
    downFailures: config.downFailures,
    stallChecks: config.stallChecks,
  },
  targetDelayMs: config.targetDelayMs,
  requestTimeoutMs: config.requestTimeoutMs,
  backoffMs: config.backoffMs,
});

const server = createHttpServer({
  reportLog,
  checker,
  publicKeyPem: identity.publicKeyPem,
  stableIdentity: identity.stableIdentity,
  config,
  startedAt,
});

let cycleRunning = false;
async function runCycle() {
  if (cycleRunning) return; // Never overlap cycles; a slow cycle delays the next.
  cycleRunning = true;
  try {
    const observations = await checker.runCycle();
    for (const obs of observations) {
      const entry = reportLog.append(obs, obs.status);
      console.log(JSON.stringify({
        event: 'observation',
        seq: entry.seq,
        target: obs.target,
        status: obs.status,
        reachable: obs.reachable,
        latencyMs: obs.latencyMs,
        blockHeight: obs.blockHeight,
      }));
    }
    if (observations.length === 0) {
      console.log(JSON.stringify({ event: 'cycle_empty', note: 'all targets in backoff' }));
    }
  } catch (error) {
    console.log(JSON.stringify({ event: 'cycle_error', error: String(error?.message ?? error) }));
  } finally {
    cycleRunning = false;
  }
}

server.listen(config.port, async () => {
  console.log(JSON.stringify({
    event: 'listening',
    port: config.port,
    targets: config.targets.map((t) => t.name),
    intervalMs: config.intervalMs,
  }));
  await runCycle();
  const timer = setInterval(runCycle, config.intervalMs);
  timer.unref?.();
  const shutdown = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
});
