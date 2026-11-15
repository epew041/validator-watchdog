// Pure status classification. No I/O, no time — every rule is a function of
// the target state, the peer evidence, and the documented thresholds.
//
// Statuses, in evaluation order:
//   down     — the latest check failed AND consecutive failures reached the
//              downFailures threshold.
//   degraded — exactly one recent failure (a single miss), OR a successful
//              check slower than slowMs. Slow means strictly greater than
//              the threshold; exactly at it is still healthy.
//   stalled  — the last stallChecks successful checks all reported the same
//              height WHILE at least one other target advanced in the same
//              window. Without peer advancement we cannot tell a stalled
//              endpoint from a chain that simply produced no blocks, so we
//              do not call it stalled.
//   healthy  — everything else.
export function classifyTarget(state, peersAdvanced, thresholds) {
  const { slowMs, downFailures, stallChecks } = thresholds;

  if (!state.lastReachable) {
    if (state.consecutiveFailures >= downFailures) return 'down';
    return 'degraded';
  }

  const heights = state.heightHistory ?? [];
  if (
    peersAdvanced &&
    heights.length >= stallChecks &&
    heights.slice(-stallChecks).every((h) => h === heights[heights.length - 1])
  ) {
    return 'stalled';
  }

  if (state.lastLatencyMs !== null && state.lastLatencyMs > slowMs) {
    return 'degraded';
  }

  return 'healthy';
}

// Did any OTHER target advance during the window this target's height
// history covers? Peer advancement is what separates "endpoint stuck" from
// "chain quiet". A peer counts as advanced when its newest height exceeds
// its oldest height in the same-length window.
export function computePeersAdvanced(targetName, histories, window) {
  for (const [name, heights] of Object.entries(histories)) {
    if (name === targetName) continue;
    const slice = heights.slice(-window);
    if (slice.length >= 2 && slice[slice.length - 1] > slice[0]) return true;
  }
  return false;
}
