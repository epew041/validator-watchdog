// Configuration for the Validator Watchdog. Everything comes from the
// environment with documented defaults; nothing here is a secret.

export const DEFAULT_TARGETS = [
  'https://bsc-dataseed.binance.org/',
  'https://ethereum.publicnode.com',
  'https://polygon.publicnode.com',
];

// Thresholds for status classification. Each one is documented because the
// classification is only as honest as the thresholds behind it.
export const DEFAULTS = {
  // One full check cycle every 60s by default.
  intervalMs: 60_000,
  // Delay between consecutive targets inside one cycle. Checks are strictly
  // sequential: this spacing is what keeps public endpoints from seeing a
  // burst. Never batch or parallelise the RPC calls.
  targetDelayMs: 1000,
  // Per-request timeout for a single JSON-RPC call.
  requestTimeoutMs: 10_000,
  // A successful check slower than this is "degraded". Exactly at the
  // threshold still counts as healthy (strictly-greater comparison).
  slowMs: 2000,
  // Consecutive failed checks before a target is "down". One failure alone
  // is "degraded" (a single miss can be a blip; two in a row is a signal).
  downFailures: 2,
  // Consecutive successful checks at the same height that count as "stalled"
  // — but only while at least one other target advanced in the same window.
  // A chain that simply produces no blocks is not "stalled" by our measure.
  stallChecks: 3,
  // How long to leave a target alone after it answers HTTP 429. We stop and
  // back off; we never hammer a rate-limited endpoint.
  backoffMs: 60_000,
  // Default number of report entries returned by GET /api/reports.
  reportLimit: 100,
  // Hard cap for ?limit= on GET /api/reports.
  maxReportLimit: 1000,
};

function parseIntEnv(name, fallback, min) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, value);
}

function nameForUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function parseTargets(raw) {
  const list = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const urls = list.length > 0 ? list : [...DEFAULT_TARGETS];
  return urls.map((url) => ({ name: nameForUrl(url), url }));
}

export function loadConfig(env = process.env) {
  return {
    port: parseIntEnv('PORT', 3000, 1),
    dataDir: env.WATCHDOG_DATA_DIR || 'data',
    targets: parseTargets(env.WATCHDOG_TARGETS),
    intervalMs: parseIntEnv('WATCHDOG_INTERVAL_MS', DEFAULTS.intervalMs, 5000),
    targetDelayMs: parseIntEnv('WATCHDOG_TARGET_DELAY_MS', DEFAULTS.targetDelayMs, 0),
    requestTimeoutMs: parseIntEnv(
      'WATCHDOG_REQUEST_TIMEOUT_MS',
      DEFAULTS.requestTimeoutMs,
      1000,
    ),
    slowMs: parseIntEnv('WATCHDOG_SLOW_MS', DEFAULTS.slowMs, 0),
    downFailures: parseIntEnv('WATCHDOG_DOWN_FAILURES', DEFAULTS.downFailures, 1),
    stallChecks: parseIntEnv('WATCHDOG_STALL_CHECKS', DEFAULTS.stallChecks, 2),
    backoffMs: parseIntEnv('WATCHDOG_BACKOFF_MS', DEFAULTS.backoffMs, 0),
    reportLimit: parseIntEnv('WATCHDOG_REPORT_LIMIT', DEFAULTS.reportLimit, 1),
    maxReportLimit: DEFAULTS.maxReportLimit,
    privateKeyPem: env.WATCHDOG_PRIVATE_KEY || null,
  };
}
