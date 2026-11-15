// Checker tests use a MOCKED fetch only. No live network calls in tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Checker } from '../src/checker.js';

const T = { slowMs: 2000, downFailures: 2, stallChecks: 3 };
const TARGETS = [
  { name: 'a.example', url: 'https://a.example' },
  { name: 'b.example', url: 'https://b.example' },
];

// Controllable clock: the mock fetch advances `now` to simulate latency.
function makeClock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms) => { now += ms; }, set: (v) => { now = v; } };
}

function jsonResponse(result, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
}

// behavior: { [url]: { chainId, heights: [...], latencyPerCall, fail, status } }
// heights shift per eth_blockNumber call; when exhausted, the last repeats.
function makeMockFetch(behavior, clock, callLog) {
  const counters = new Map();
  return async (url, options) => {
    const { method } = JSON.parse(options.body);
    callLog.push(`${url} ${method}`);
    const cfg = behavior[url] ?? {};
    clock.advance(cfg.latencyPerCall ?? 100);
    if (cfg.status) return { ok: false, status: cfg.status, json: async () => ({}) };
    if (cfg.fail) throw new Error(cfg.fail);
    if (cfg.rpcError) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }) };
    }
    if (method === 'eth_chainId') return jsonResponse(cfg.chainId ?? '0x38');
    const n = counters.get(url) ?? 0;
    counters.set(url, n + 1);
    const heights = cfg.heights ?? [100];
    const height = heights[Math.min(n, heights.length - 1)];
    return jsonResponse(`0x${height.toString(16)}`);
  };
}

function makeChecker(behavior, { clock = makeClock(), callLog = [], ...overrides } = {}) {
  return new Checker({
    targets: TARGETS,
    thresholds: T,
    targetDelayMs: 0,
    requestTimeoutMs: 5000,
    backoffMs: 60_000,
    fetchFn: makeMockFetch(behavior, clock, callLog),
    sleepFn: async () => {},
    nowFn: clock.now,
    ...overrides,
  });
}

test('successful cycle parses chain id and height, measures latency', async () => {
  const clock = makeClock();
  const checker = makeChecker({ 'https://a.example': {}, 'https://b.example': { chainId: '0x1' } }, { clock });
  const [a, b] = await checker.runCycle();
  assert.equal(a.reachable, true);
  assert.equal(a.chainId, '0x38');
  assert.equal(a.blockHeight, 100);
  assert.equal(a.latencyMs, 200); // Two calls x 100ms simulated.
  assert.equal(a.status, 'healthy');
  assert.equal(b.chainId, '0x1');
});

test('calls are strictly sequential in target order', async () => {
  const callLog = [];
  const checker = makeChecker({}, { callLog });
  await checker.runCycle();
  assert.deepEqual(callLog, [
    'https://a.example eth_chainId',
    'https://a.example eth_blockNumber',
    'https://b.example eth_chainId',
    'https://b.example eth_blockNumber',
  ]);
});

test('slow target is degraded; boundary latency stays healthy', async () => {
  const slow = makeChecker({ 'https://a.example': { latencyPerCall: 1500 } });
  const [a] = await slow.runCycle();
  assert.equal(a.latencyMs, 3000);
  assert.equal(a.status, 'degraded');

  const boundary = makeChecker({ 'https://a.example': { latencyPerCall: 1000 } });
  const [b] = await boundary.runCycle();
  assert.equal(b.latencyMs, 2000);
  assert.equal(b.status, 'healthy');
});

test('one failure degrades, second consecutive failure is down, recovery resets', async () => {
  const behavior = { 'https://a.example': { fail: 'boom' } };
  const checker = makeChecker(behavior);
  let [a] = await checker.runCycle();
  assert.equal(a.reachable, false);
  assert.equal(a.status, 'degraded');
  assert.equal(a.error, 'boom');
  [a] = await checker.runCycle();
  assert.equal(a.status, 'down');
  delete behavior['https://a.example'].fail;
  [a] = await checker.runCycle();
  assert.equal(a.reachable, true);
  assert.equal(a.status, 'healthy');
});

test('JSON-RPC error response counts as a failed check', async () => {
  const checker = makeChecker({ 'https://a.example': { rpcError: true } });
  const [a] = await checker.runCycle();
  assert.equal(a.reachable, false);
  assert.match(a.error, /JSON-RPC error/);
});

test('HTTP 429 backs off the target: skipped next cycle, retried after backoff', async () => {
  const clock = makeClock();
  const behavior = { 'https://a.example': { status: 429 } };
  const checker = makeChecker(behavior, { clock, backoffMs: 5000 });
  let obs = await checker.runCycle();
  assert.equal(obs.find((o) => o.target === 'a.example').error, 'rate limited (HTTP 429)');
  // Only 400ms of simulated time passed; backoff is 5000ms.
  obs = await checker.runCycle();
  assert.deepEqual(obs.map((o) => o.target), ['b.example']); // a skipped.
  const snap = checker.snapshot().find((t) => t.name === 'a.example');
  assert.ok(snap.backoffUntil);
  // Move past the backoff; the target is checked again.
  clock.advance(6000);
  delete behavior['https://a.example'].status;
  obs = await checker.runCycle();
  assert.ok(obs.some((o) => o.target === 'a.example' && o.reachable));
});

test('stall detected when one target is flat while the other advances', async () => {
  const checker = makeChecker({
    'https://a.example': { heights: [100, 100, 100] },
    'https://b.example': { heights: [200, 201, 202] },
  });
  await checker.runCycle();
  await checker.runCycle();
  const [a, b] = await checker.runCycle();
  assert.equal(a.status, 'stalled');
  assert.equal(b.status, 'healthy');
});

test('flat heights on ALL targets is not a stall', async () => {
  const checker = makeChecker({
    'https://a.example': { heights: [100, 100, 100] },
    'https://b.example': { heights: [200, 200, 200] },
  });
  await checker.runCycle();
  await checker.runCycle();
  const [a, b] = await checker.runCycle();
  assert.equal(a.status, 'healthy');
  assert.equal(b.status, 'healthy');
});

test('request timeout is a clean failure, not a hang', async () => {
  const fetchFn = (_url, options) => new Promise((_resolve, reject) => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    options.signal.addEventListener('abort', () => reject(error));
  });
  const checker = new Checker({
    targets: TARGETS.slice(0, 1),
    thresholds: T,
    targetDelayMs: 0,
    requestTimeoutMs: 10,
    backoffMs: 60_000,
    fetchFn,
    sleepFn: async () => {},
    nowFn: () => Date.now(),
  });
  const [a] = await checker.runCycle();
  assert.equal(a.reachable, false);
  assert.equal(a.error, 'request timed out');
});

test('snapshot reports unknown before the first cycle', () => {
  const checker = makeChecker({});
  const snap = checker.snapshot();
  assert.equal(snap[0].status, 'unknown');
  assert.equal(snap[0].blockHeight, null);
});
