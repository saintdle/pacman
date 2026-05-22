import { incCounter, observeHistogram } from '../metrics.js';

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

export function passThroughHeaders(req) {
  return {
    'x-forwarded-host': req.hostname,
    'x-forwarded-for': req.ip,
    'user-agent': req.headers['user-agent'] ?? 'pacman-internal-client',
    ...(req.headers.referer ? { referer: req.headers.referer } : {}),
  };
}