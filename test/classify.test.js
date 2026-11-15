import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTarget, computePeersAdvanced } from '../src/classify.js';

const T = { slowMs: 2000, downFailures: 2, stallChecks: 3 };

function state(overrides = {}) {
  return {
    consecutiveFailures: 0,
    heightHistory: [100, 101, 102],
    lastLatencyMs: 120,
    lastReachable: true,
    ...overrides,
  };
}

test('healthy when reachable, fast, and advancing', () => {
  assert.equal(classifyTarget(state(), false, T), 'healthy');
});

test('degraded when slow (strictly over the threshold)', () => {
  assert.equal(classifyTarget(state({ lastLatencyMs: 2001 }), false, T), 'degraded');
});

test('exactly at the slow threshold is still healthy (boundary)', () => {
  assert.equal(classifyTarget(state({ lastLatencyMs: 2000 }), false, T), 'healthy');
});

test('one failure is degraded, two failures is down', () => {
  assert.equal(
    classifyTarget(state({ lastReachable: false, consecutiveFailures: 1 }), false, T),
    'degraded',
  );
  assert.equal(
    classifyTarget(state({ lastReachable: false, consecutiveFailures: 2 }), false, T),
    'down',
  );
  assert.equal(
    classifyTarget(state({ lastReachable: false, consecutiveFailures: 5 }), false, T),
    'down',
  );
});

test('stalled when height is flat across the window and peers advanced', () => {
  const s = state({ heightHistory: [100, 100, 100] });
  assert.equal(classifyTarget(s, true, T), 'stalled');
});

test('flat height without peer advancement is NOT stalled', () => {
  const s = state({ heightHistory: [100, 100, 100] });
  assert.equal(classifyTarget(s, false, T), 'healthy');
});

test('fewer than stallChecks points cannot be stalled', () => {
  const s = state({ heightHistory: [100, 100] });
  assert.equal(classifyTarget(s, true, T), 'healthy');
});

test('stall needs the LAST window flat, not the whole history', () => {
  const s = state({ heightHistory: [98, 100, 100, 100] });
  assert.equal(classifyTarget(s, true, T), 'stalled');
  const advancing = state({ heightHistory: [100, 100, 101] });
  assert.equal(classifyTarget(advancing, true, T), 'healthy');
});

test('failure beats stall: an unreachable target is never stalled', () => {
  const s = state({ lastReachable: false, consecutiveFailures: 2, heightHistory: [100, 100, 100] });
  assert.equal(classifyTarget(s, true, T), 'down');
});

test('computePeersAdvanced ignores the target itself', () => {
  const histories = { a: [100, 101, 102], b: [50, 50, 50] };
  assert.equal(computePeersAdvanced('a', histories, 3), false); // Only b, flat.
  assert.equal(computePeersAdvanced('b', histories, 3), true); // a advanced.
});

test('computePeersAdvanced needs at least two points', () => {
  assert.equal(computePeersAdvanced('a', { b: [50] }, 3), false);
  assert.equal(computePeersAdvanced('a', {}, 3), false);
});
