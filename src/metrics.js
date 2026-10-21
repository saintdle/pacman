// Lightweight Prometheus metrics — no external dependencies.
// Counters are bounded by route/status/role labels; no user data.

import { config } from './config/index.js';

const counters = {};
const histogramBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
const histograms = {};

function labelString(labels) {
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
}

export function incCounter(name, labels = {}) {
  const key = `${name}{${labelString(labels)}}`;
  counters[key] = (counters[key] || 0) + 1;
}

export function observeHistogram(name, value, labels = {}) {
  const base = `${name}{${labelString(labels)}}`;
  if (!histograms[base]) {
    histograms[base] = {
      sum: 0,
      count: 0,
      buckets: histogramBuckets.map((le) => ({ le, count: 0 })),
    };
  }
  const h = histograms[base];
  h.sum += value;
  h.count += 1;
  for (const bucket of h.buckets) {
    if (value <= bucket.le) bucket.count += 1;
  }
}

export function renderMetrics() {
  const lines = [];
  const role = config.APP_ROLE;

  lines.push('# HELP pacman_http_requests_total Total HTTP requests');
  lines.push('# TYPE pacman_http_requests_total counter');
  lines.push('# HELP pacman_db_operations_total Total database operations');
  lines.push('# TYPE pacman_db_operations_total counter');
  lines.push('# HELP pacman_upstream_requests_total Total upstream service requests');
  lines.push('# TYPE pacman_upstream_requests_total counter');
  lines.push('# HELP pacman_demo_faults_total Total demo fault injections');
  lines.push('# TYPE pacman_demo_faults_total counter');
  lines.push('# HELP pacman_score_submissions_total Total high-score submissions');
  lines.push('# TYPE pacman_score_submissions_total counter');
  lines.push('# HELP pacman_user_stat_updates_total Total user stat updates');
  lines.push('# TYPE pacman_user_stat_updates_total counter');

  for (const [key, val] of Object.entries(counters)) {
    const name = key.slice(0, key.indexOf('{'));
    const innerLabels = key.slice(key.indexOf('{') + 1, key.lastIndexOf('}'));
    const withRole = innerLabels ? `role="${role}",${innerLabels}` : `role="${role}"`;
    lines.push(`${name}{${withRole}} ${val}`);
  }

  lines.push('# HELP pacman_http_request_duration_ms HTTP server request duration in milliseconds');
  lines.push('# TYPE pacman_http_request_duration_ms histogram');
  lines.push('# HELP pacman_upstream_latency_ms Upstream request latency in milliseconds');
  lines.push('# TYPE pacman_upstream_latency_ms histogram');
  for (const [base, h] of Object.entries(histograms)) {
    const name = base.slice(0, base.indexOf('{'));
    const innerLabels = base.slice(base.indexOf('{') + 1, base.lastIndexOf('}'));
    const withRole = innerLabels ? `role="${role}",${innerLabels}` : `role="${role}"`;
    for (const bucket of h.buckets) {
      lines.push(`${name}_bucket{${withRole},le="${bucket.le}"} ${bucket.count}`);
    }
    lines.push(`${name}_bucket{${withRole},le="+Inf"} ${h.count}`);
    lines.push(`${name}_sum{${withRole}} ${h.sum}`);
    lines.push(`${name}_count{${withRole}} ${h.count}`);
  }

  lines.push('');
  return lines.join('\n');
}

// Fixed identities for known API routes let metrics recover the route when
// early middleware responds before routing or Express unwinds an error and
// clears req.baseUrl. Keep this an explicit method/path allowlist so unknown
// URLs never become metric labels.
const KNOWN_ROUTES = new Map([
  ['GET /version', '/version'],
  ['GET /metrics', '/metrics'],
  ['GET /demo/status', '/demo/status'],
  ['POST /demo/incidents', '/demo/incidents'],
  ['POST /demo/incidents/file-probe', '/demo/incidents/file-probe'],
  ['POST /demo/incidents/exec-probe', '/demo/incidents/exec-probe'],
  ['GET /config', '/config'],
  ['GET /config/schema', '/config/schema'],
  ['POST /config', '/config'],
  ['GET /internal/score/read', '/internal/score/read'],
  ['POST /internal/score/write', '/internal/score/write'],
  ['GET /internal/user/session', '/internal/user/session'],
  ['GET /internal/user/stats', '/internal/user/stats'],
  ['POST /internal/user/stats', '/internal/user/stats'],
  ['GET /internal/config/read', '/internal/config/read'],
  ['GET /highscores/list', '/highscores/list'],
  ['POST /highscores', '/highscores'],
  ['GET /user/id', '/user/id'],
  ['GET /user/stats', '/user/stats'],
  ['POST /user/stats', '/user/stats'],
  ['GET /location/metadata', '/location/metadata'],
]);

function knownRouteLabel(method, path) {
  // Mirror Express's case-insensitive, non-strict routes and GET-to-HEAD behavior,
  // while keeping this fixed allowlist as the only source of metric identities.
  const routeMethod = method === 'HEAD' ? 'GET' : method;
  const routePath = path.toLowerCase().replace(/\/$/, '');
  return KNOWN_ROUTES.get(`${routeMethod} ${routePath}`);
}

export function routeLabel(req) {
  const path = (req.originalUrl || req.path || '/').split('?')[0];
  if (path === '/metrics') return '/metrics';
  if (path === '/healthz' || path.startsWith('/readyz')) return 'health';

  if (req.baseUrl && req.route?.path) {
    const matchedPath = `${req.baseUrl}${req.route.path === '/' ? '' : req.route.path}`;
    return knownRouteLabel(req.method, matchedPath) || matchedPath;
  }

  const known = knownRouteLabel(req.method, path);
  if (known && (!req.baseUrl || !req.route)) return known;

  if (
    path === '/'
    || path === '/favicon.ico'
    || path.startsWith('/data/')
    || path.startsWith('/fonts/')
    || path.startsWith('/img/')
    || path.startsWith('/js/')
    || path.startsWith('/mp3/')
    || path.startsWith('/wav/')
    || path.endsWith('.css')
    || path.endsWith('.js')
    || path.endsWith('.html')
    || path.endsWith('.manifest')
  ) {
    return 'static';
  }

  return 'unknown';
}

// Express middleware — counts every request by method, route group, and status.
export function metricsMiddleware() {
  return (req, res, next) => {
    const start = performance.now();
    res.on('finish', () => {
      const route = routeLabel(req);
      incCounter('pacman_http_requests_total', {
        method: req.method,
        route,
        status: String(res.statusCode),
      });
      observeHistogram('pacman_http_request_duration_ms', performance.now() - start, {
        method: req.method,
        route,
      });
    });
    next();
  };
}
