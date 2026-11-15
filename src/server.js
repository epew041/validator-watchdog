// HTTP server. Node stdlib only, zero dependencies.
//
// Routes:
//   GET /                 HTML dashboard
//   GET /api/status       JSON summary (targets, statuses, identity)
//   GET /api/reports      JSON list, newest first, ?limit= (capped)
//   GET /api/reports/:seq One entry by sequence number
//   GET /public-key       PEM public key for offline signature verification
//   GET /health           {"ok":true}
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function statusBadge(status) {
  const colors = {
    healthy: '#1a7f37',
    degraded: '#9a6700',
    stalled: '#8250df',
    down: '#cf222e',
    unknown: '#57606a',
  };
  const color = colors[status] ?? colors.unknown;
  return `<span style="color:#fff;background:${color};padding:2px 8px;border-radius:999px;font-size:12px">${escapeHtml(status)}</span>`;
}

function dashboardHtml({ targets, reportCount, stableIdentity, keyFingerprint }) {
  const rows = targets
    .map(
      (t) => `<tr>
        <td>${escapeHtml(t.name)}</td>
        <td>${statusBadge(t.status)}</td>
        <td>${t.latencyMs === null ? '—' : `${t.latencyMs} ms`}</td>
        <td>${t.blockHeight === null ? '—' : t.blockHeight}</td>
        <td>${escapeHtml(t.chainId ?? '—')}</td>
        <td>${escapeHtml(t.lastCheckAt ?? 'never')}</td>
      </tr>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Validator Watchdog</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1f2328}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #d0d7de;padding:8px;text-align:left}
code{background:#f6f8fa;padding:2px 5px;border-radius:4px}</style></head>
<body>
<h1>Validator Watchdog</h1>
<p>Live health of ${targets.length} public JSON-RPC endpoint(s). Every observation is
published as a signed, hash-chained report entry — verify them offline with
<code>node scripts/verify.js</code> against the <a href="/public-key">public key</a>.</p>
<p>Reports so far: <strong>${reportCount}</strong> · Identity: <strong>${stableIdentity ? 'stable (configured key)' : 'ephemeral (generated at boot)'}</strong> · Key fingerprint: <code>${escapeHtml(keyFingerprint)}</code></p>
<table><thead><tr><th>Target</th><th>Status</th><th>Latency</th><th>Height</th><th>Chain ID</th><th>Last check</th></tr></thead>
<tbody>${rows}</tbody></table>
<p><a href="/api/reports">/api/reports</a> · <a href="/api/status">/api/status</a> · <a href="/public-key">/public-key</a> · <a href="/health">/health</a></p>
<p><small>Reports are Ed25519-signed observations, not zkVerify proofs. See the README for what is and is not claimed.</small></p>
</body></html>`;
}

export function createHttpServer({ reportLog, checker, publicKeyPem, stableIdentity, config, startedAt }) {
  const fingerprint = createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16);

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  const server = createServer((req, res) => {
    try {
      if (req.method !== 'GET') {
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (path === '/') {
        const body = dashboardHtml({
          targets: checker.snapshot(),
          reportCount: reportLog.entries.length,
          stableIdentity,
          keyFingerprint: fingerprint,
        });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        return res.end(body);
      }
      if (path === '/health') {
        return sendJson(res, 200, { ok: true });
      }
      if (path === '/public-key') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(publicKeyPem) });
        return res.end(publicKeyPem);
      }
      if (path === '/api/status') {
        return sendJson(res, 200, {
          service: 'validator-watchdog',
          startedAt,
          stableIdentity,
          keyFingerprint: fingerprint,
          intervalMs: config.intervalMs,
          reportCount: reportLog.entries.length,
          targets: checker.snapshot(),
        });
      }
      if (path === '/api/reports') {
        const requested = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
        const limit = Number.isFinite(requested)
          ? Math.min(Math.max(1, requested), config.maxReportLimit)
          : config.reportLimit;
        return sendJson(res, 200, { entries: reportLog.listNewestFirst(limit) });
      }
      const single = path.match(/^\/api\/reports\/(\d+)$/);
      if (single) {
        const entry = reportLog.get(Number(single[1]));
        if (!entry) return sendJson(res, 404, { error: 'no report with that seq' });
        return sendJson(res, 200, { entry });
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(res, 500, { error: String(error?.message ?? error) });
    }
  });

  return server;
}
