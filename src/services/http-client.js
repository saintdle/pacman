import { incCounter, observeHistogram } from '../metrics.js';
import { config } from '../config/index.js';
import { demoAuthorized } from '../demo/guard.js';
import { FAULT_HEADER_NAMES } from '../middleware/demo-fault.js';

const DEFAULT_TIMEOUT_MS = 2000;

export async function requestJson(baseUrl, path, { method = 'GET', body, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL(path, baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  const target = url.hostname || 'unknown';

  try {
    const res = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      // Fetch only strips Authorization/Cookie on a cross-origin redirect, not
      // our custom demo token header, so a redirecting backend could otherwise
      // leak it to an arbitrary Location. Refuse to follow any redirect instead.
      redirect: 'error',
    });
    const text = await res.text();
    const payload = text ? JSON.parse(text) : null;

    const elapsed = performance.now() - start;
    incCounter('pacman_upstream_requests_total', { target, method, status: String(res.status) });
    observeHistogram('pacman_upstream_latency_ms', elapsed, { target, method });

    return { ok: res.ok, status: res.status, payload };
  } catch (err) {
    incCounter('pacman_upstream_requests_total', { target, method, status: 'error' });
    observeHistogram('pacman_upstream_latency_ms', performance.now() - start, { target, method });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Forwards the demo token and any unconsumed, allowlisted fault headers to an
// internal backend only when the inbound request is itself demo-authorized.
// A fault already consumed by this role was deleted from req.headers by
// demoFaultMiddleware, so it is never re-sent downstream.
function demoForwardHeaders(req) {
  if (!demoAuthorized(req)) return {};

  const tokenHeader = config.DEMO_TOKEN_HEADER.toLowerCase();
  const headers = { [tokenHeader]: req.headers[tokenHeader] };
  for (const name of FAULT_HEADER_NAMES) {
    if (req.headers[name] !== undefined) headers[name] = req.headers[name];
  }
  return headers;
}

export function passThroughHeaders(req) {
  return {
    'x-forwarded-host': req.hostname,
    'x-forwarded-for': req.ip,
    'user-agent': req.headers['user-agent'] ?? 'pacman-internal-client',
    ...(req.headers.referer ? { referer: req.headers.referer } : {}),
    ...demoForwardHeaders(req),
  };
}