import { setTimeout as delay } from 'node:timers/promises';
import { demoAuthorized } from '../demo/guard.js';
import { incCounter } from '../metrics.js';
import { config } from '../config/index.js';

const MAX_DELAY_MS = 10_000;
const MIN_FAULT_STATUS = 500;
const MAX_FAULT_STATUS = 599;

const VALID_ROLES = new Set(['web', 'score', 'user']);
const VALID_OPERATIONS = new Set(['scoreRead', 'scoreWrite', 'userRead', 'userWrite', 'pageView']);

export const FAULT_HEADER_NAMES = [
  'x-demo-fault-role',
  'x-demo-fault-operation',
  'x-demo-fault-delay-ms',
  'x-demo-fault-status',
];

// Probe/config/bootstrap/metrics/demo traffic is exempt from automatic fault
// selection so the lab controls themselves stay reachable during a fault.
const EXEMPT_PREFIXES = ['/healthz', '/readyz', '/config', '/metrics', '/demo'];

function isExempt(path) {
  return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// Logical operation for each request, independent of whether it is served by
// the public API or forwarded to /internal/* on a backend role. Anything not
// covered (and not exempt) is a generic page view on the web role.
const OPERATIONS_BY_ROUTE = [
  { method: 'GET', path: '/highscores/list', operation: 'scoreRead' },
  { method: 'POST', path: '/highscores', operation: 'scoreWrite' },
  { method: 'GET', path: '/internal/score/read', operation: 'scoreRead' },
  { method: 'POST', path: '/internal/score/write', operation: 'scoreWrite' },
  { method: 'GET', path: '/user/id', operation: 'userRead' },
  { method: 'GET', path: '/user/stats', operation: 'userRead' },
  { method: 'POST', path: '/user/stats', operation: 'userWrite' },
  { method: 'GET', path: '/internal/user/session', operation: 'userRead' },
  { method: 'GET', path: '/internal/user/stats', operation: 'userRead' },
  { method: 'POST', path: '/internal/user/stats', operation: 'userWrite' },
];

export function operationForRequest(req) {
  if (isExempt(req.path)) return null;
  const match = OPERATIONS_BY_ROUTE.find((route) => route.method === req.method && route.path === req.path);
  return match ? match.operation : 'pageView';
}

function parseFaultHeaders(req) {
  const role = req.headers['x-demo-fault-role'];
  const operation = req.headers['x-demo-fault-operation'];
  if (!VALID_ROLES.has(role) || !VALID_OPERATIONS.has(operation)) return null;

  const delayRaw = Number.parseInt(req.headers['x-demo-fault-delay-ms'], 10);
  const delayMs = Number.isInteger(delayRaw) && delayRaw >= 0 ? Math.min(delayRaw, MAX_DELAY_MS) : 0;

  const statusRaw = Number.parseInt(req.headers['x-demo-fault-status'], 10);
  const status = Number.isInteger(statusRaw) && statusRaw >= MIN_FAULT_STATUS && statusRaw <= MAX_FAULT_STATUS
    ? statusRaw
    : null;

  return { role, operation, delayMs, status };
}

// Consuming a fault removes the headers from the request in place so a
// subsequent forwarding hop (see services/http-client.js) never re-sends a
// fault that has already been applied once.
function consumeFaultHeaders(req) {
  for (const name of FAULT_HEADER_NAMES) delete req.headers[name];
}

export function demoFaultMiddleware() {
  return async (req, res, next) => {
    if (!demoAuthorized(req)) return next();

    const operation = operationForRequest(req);
    if (!operation) return next();

    const fault = parseFaultHeaders(req);
    if (!fault) return next();

    const isIntendedTarget = fault.role === config.APP_ROLE && fault.operation === operation;
    if (!isIntendedTarget) return next();

    consumeFaultHeaders(req);

    if (fault.delayMs > 0) {
      await delay(fault.delayMs);
    }

    if (fault.status) {
      // `role` is added globally by renderMetrics(); fault.role is always
      // config.APP_ROLE here (see isIntendedTarget above), so omit it to
      // avoid emitting a duplicate role label in the exposition output.
      incCounter('pacman_demo_faults_total', { operation: fault.operation, status: String(fault.status) });
      req.log?.warn({ role: fault.role, operation: fault.operation, status: fault.status }, 'demo fault injected');
      return res.status(fault.status).json({ error: 'demo fault injected', status: fault.status });
    }

    return next();
  };
}

export default demoFaultMiddleware;
