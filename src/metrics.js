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

export function routeLabel(req) {
  const path = (req.originalUrl || req.path || '/').split('?')[0];
  if (path === '/metrics') return '/metrics';
  if (path === '/healthz' || path.startsWith('/readyz')) return 'health';

  if (req.baseUrl && req.route?.path) {
    return `${req.baseUrl}${req.route.path === '/' ? '' : req.route.path}`;
  }

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
    res.on('finish', () => {
      incCounter('pacman_http_requests_total', {
        method: req.method,
        route: routeLabel(req),
        status: String(res.statusCode),
      });
    });
    next();
  };
}
