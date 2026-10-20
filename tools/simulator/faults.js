export const FAULT_HEADER_NAMES = Object.freeze({
  role: 'x-demo-fault-role',
  operation: 'x-demo-fault-operation',
  delayMs: 'x-demo-fault-delay-ms',
  status: 'x-demo-fault-status',
});

const STATIC_PAGE_PATHS = new Set([
  '/',
  '/style.css',
  '/pacman-canvas.css',
  '/pacman-canvas.js',
  '/js/jquery-3.4.1.min.js',
  '/js/jquery.hammer.min.js',
]);

function pathname(path) {
  return String(path).split(/[?#]/, 1)[0];
}

export function describeLogicalRequest(method, path, { bootstrap = false } = {}) {
  if (bootstrap) return null;
  const verb = String(method).toUpperCase();
  const requestPath = pathname(path);
  if (verb === 'GET' && STATIC_PAGE_PATHS.has(requestPath)) return { operation: 'pageView' };
  if (verb === 'GET' && requestPath === '/highscores/list') return { operation: 'scoreRead' };
  if (verb === 'POST' && requestPath === '/highscores') return { operation: 'scoreWrite' };
  if (verb === 'GET' && requestPath === '/user/stats') return { operation: 'userRead' };
  if (verb === 'POST' && requestPath === '/user/stats') return { operation: 'userWrite' };
  return null;
}

export function createFaultSelector(config, startedAt = Date.now()) {
  return {
    select(logicalRequest, random, now = Date.now()) {
      if (!config.enabled || !logicalRequest || now - startedAt >= config.durationSeconds * 1000)
        return null;
      const rule = config.rules.find((candidate) =>
        candidate.operations.includes(logicalRequest.operation),
      );
      if (!rule) return null;

      const sample = random.next();
      if (sample < rule.errorRate) {
        return {
          targetRole: rule.targetRole,
          operation: logicalRequest.operation,
          status: rule.errorStatus,
        };
      }
      if (sample < rule.errorRate + rule.delayRate) {
        return {
          targetRole: rule.targetRole,
          operation: logicalRequest.operation,
          delayMs: random.int(rule.delayMs.min, rule.delayMs.max),
        };
      }
      return null;
    },
  };
}

export function faultHeadersFor(fault) {
  if (!fault) return {};
  const headers = {
    [FAULT_HEADER_NAMES.role]: fault.targetRole,
    [FAULT_HEADER_NAMES.operation]: fault.operation,
  };
  if (fault.status !== undefined) headers[FAULT_HEADER_NAMES.status] = String(fault.status);
  if (fault.delayMs !== undefined) headers[FAULT_HEADER_NAMES.delayMs] = String(fault.delayMs);
  return headers;
}
