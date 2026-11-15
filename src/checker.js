// Sequential JSON-RPC health checker.
//
// Discipline (non-negotiable, learned the hard way on BSC public endpoints):
// one call at a time, a delay between targets, never batched, never
// concurrent. On HTTP 429 the target is backed off for backoffMs and skipped
// until then — we stop and report, we never hammer.
//
// Each target check is two sequential calls: eth_chainId, then
// eth_blockNumber. Latency is the wall time of both calls combined.
import { classifyTarget, computePeersAdvanced } from './classify.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseHexInt(hex, what) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`invalid ${what} response: ${JSON.stringify(hex)}`);
  }
  return Number.parseInt(hex, 16);
}

export class Checker {
  constructor({
    targets,
    thresholds,
    targetDelayMs,
    requestTimeoutMs,
    backoffMs,
    fetchFn = globalThis.fetch,
    sleepFn = sleep,
    nowFn = () => Date.now(),
  }) {
    this.targets = targets;
    this.thresholds = thresholds;
    this.targetDelayMs = targetDelayMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.backoffMs = backoffMs;
    this.fetchFn = fetchFn;
    this.sleepFn = sleepFn;
    this.nowFn = nowFn;
    this.states = new Map(
      targets.map((t) => [
        t.name,
        {
          consecutiveFailures: 0,
          heightHistory: [],
          lastLatencyMs: null,
          lastReachable: null,
          lastChainId: null,
          lastBlockHeight: null,
          lastCheckAt: null,
          lastError: null,
          backoffUntil: 0,
        },
      ]),
    );
  }

  async rpcCall(url, method) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
        signal: controller.signal,
      });
      if (res.status === 429) {
        const error = new Error('rate limited (HTTP 429)');
        error.rateLimited = true;
        throw error;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const payload = await res.json();
      if (payload?.error) {
        throw new Error(`JSON-RPC error ${payload.error.code ?? ''}: ${payload.error.message ?? 'unknown'}`.trim());
      }
      if (typeof payload?.result !== 'string') {
        throw new Error('missing string result in JSON-RPC response');
      }
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async checkTarget(target) {
    const state = this.states.get(target.name);
    const now = this.nowFn();
    if (now < state.backoffUntil) {
      return null; // Backed off: no observation this cycle, by design.
    }
    const started = this.nowFn();
    try {
      const chainIdHex = await this.rpcCall(target.url, 'eth_chainId');
      const heightHex = await this.rpcCall(target.url, 'eth_blockNumber');
      const latencyMs = this.nowFn() - started;
      return {
        target: target.name,
        url: target.url,
        reachable: true,
        latencyMs,
        chainId: chainIdHex,
        blockHeight: parseHexInt(heightHex, 'eth_blockNumber'),
        error: null,
      };
    } catch (error) {
      if (error?.rateLimited) {
        state.backoffUntil = this.nowFn() + this.backoffMs;
      }
      return {
        target: target.name,
        url: target.url,
        reachable: false,
        latencyMs: this.nowFn() - started,
        chainId: null,
        blockHeight: null,
        error: error?.name === 'AbortError' ? 'request timed out' : String(error?.message ?? error),
      };
    }
  }

  // One full cycle: check every target sequentially (spaced), then classify
  // each with peer evidence, then return observations in target order.
  // Targets in backoff produce no observation.
  async runCycle() {
    const raw = [];
    for (const [index, target] of this.targets.entries()) {
      if (index > 0 && this.targetDelayMs > 0) await this.sleepFn(this.targetDelayMs);
      const observation = await this.checkTarget(target);
      if (observation) raw.push(observation);
    }

    // Update per-target state from this cycle's raw results.
    for (const obs of raw) {
      const state = this.states.get(obs.target);
      state.lastCheckAt = new Date().toISOString();
      state.lastLatencyMs = obs.latencyMs;
      state.lastReachable = obs.reachable;
      state.lastError = obs.error;
      if (obs.reachable) {
        state.consecutiveFailures = 0;
        state.lastChainId = obs.chainId;
        state.lastBlockHeight = obs.blockHeight;
        state.heightHistory.push(obs.blockHeight);
        if (state.heightHistory.length > this.thresholds.stallChecks) {
          state.heightHistory.shift();
        }
      } else {
        state.consecutiveFailures += 1;
      }
    }

    const histories = Object.fromEntries(
      [...this.states.entries()].map(([name, s]) => [name, s.heightHistory]),
    );
    return raw.map((obs) => {
      const state = this.states.get(obs.target);
      const peersAdvanced = computePeersAdvanced(obs.target, histories, this.thresholds.stallChecks);
      return { ...obs, status: classifyTarget(state, peersAdvanced, this.thresholds) };
    });
  }

  // Snapshot for GET /api/status. Backoff state is reported so a gap in the
  // report log is explainable instead of mysterious.
  snapshot() {
    return this.targets.map((t) => {
      const s = this.states.get(t.name);
      return {
        name: t.name,
        url: t.url,
        status: s.lastReachable === null ? 'unknown' : classifyTarget(
          s,
          computePeersAdvanced(t.name, Object.fromEntries(
            [...this.states.entries()].map(([n, st]) => [n, st.heightHistory]),
          ), this.thresholds.stallChecks),
          this.thresholds,
        ),
        latencyMs: s.lastLatencyMs,
        chainId: s.lastChainId,
        blockHeight: s.lastBlockHeight,
        lastCheckAt: s.lastCheckAt,
        consecutiveFailures: s.consecutiveFailures,
        lastError: s.lastError,
        backoffUntil: s.backoffUntil > this.nowFn() ? new Date(s.backoffUntil).toISOString() : null,
      };
    });
  }
}
