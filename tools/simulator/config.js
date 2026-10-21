const MAX_SEED = 0xffff_ffff;
const MAX_DURATION_SECONDS = 3600;
const MAX_RULES = 32;
const LOGICAL_OPERATIONS = Object.freeze([
  'scoreRead',
  'scoreWrite',
  'userRead',
  'userWrite',
  'pageView',
]);

function roleCanHandleOperation(role, operation) {
  if (role === 'web') return true;
  if (role === 'score') return operation === 'scoreRead' || operation === 'scoreWrite';
  return operation === 'userRead' || operation === 'userWrite';
}

function fail(name, message) {
  throw new Error(`${name}: ${message}`);
}

function record(value, name, allowedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(name, 'must be a JSON object');
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(name, `contains unsupported field "${key}"`);
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) fail(name, `is missing required field "${key}"`);
  }
  return value;
}

function jsonEnv(env, name, fallback) {
  if (!Object.hasOwn(env, name)) return fallback;
  try {
    return JSON.parse(env[name]);
  } catch {
    fail(name, 'must contain valid JSON');
  }
}

function boolean(value, name) {
  if (typeof value !== 'boolean') fail(name, 'must be a boolean');
  return value;
}

function integer(value, name, { min, max }) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(name, `must be an integer from ${min} through ${max}`);
  }
  return value;
}

function rate(value, name, max = 1) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    fail(name, `must be a finite number from 0 through ${max}`);
  }
  return value;
}

function enumValue(value, name, allowed) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(name, `must be one of ${allowed.join(', ')}`);
  }
  return value;
}

function uniqueStrings(value, name, allowed) {
  if (!Array.isArray(value) || value.length === 0) fail(name, 'must be a non-empty array');
  const selected = value.map((item, index) => enumValue(item, `${name}[${index}]`, allowed));
  if (new Set(selected).size !== selected.length) fail(name, 'must not contain duplicates');
  return selected;
}

function validateFaults(value) {
  const name = 'SIM_FAULTS_JSON';
  record(value, name, ['enabled', 'seed', 'durationSeconds', 'rules']);
  const enabled = boolean(value.enabled, `${name}.enabled`);
  const seed = integer(value.seed, `${name}.seed`, { min: 0, max: MAX_SEED });
  const durationSeconds = integer(value.durationSeconds, `${name}.durationSeconds`, {
    min: enabled ? 1 : 0,
    max: MAX_DURATION_SECONDS,
  });
  if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES) {
    fail(`${name}.rules`, `must be an array with at most ${MAX_RULES} entries`);
  }

  const usedOperations = new Set();
  const rules = value.rules.map((rule, index) => {
    const ruleName = `${name}.rules[${index}]`;
    record(rule, ruleName, [
      'operations',
      'targetRole',
      'errorRate',
      'errorStatus',
      'delayRate',
      'delayMs',
    ]);
    const operations = uniqueStrings(rule.operations, `${ruleName}.operations`, LOGICAL_OPERATIONS);
    const targetRole = enumValue(rule.targetRole, `${ruleName}.targetRole`, [
      'web',
      'score',
      'user',
    ]);
    for (const operation of operations) {
      if (!roleCanHandleOperation(targetRole, operation)) {
        fail(`${ruleName}.targetRole`, `cannot consume operation "${operation}"`);
      }
      if (usedOperations.has(operation))
        fail(`${name}.rules`, `operation "${operation}" appears in multiple rules`);
      usedOperations.add(operation);
    }

    const errorRate = rate(rule.errorRate, `${ruleName}.errorRate`);
    const errorStatus = integer(rule.errorStatus, `${ruleName}.errorStatus`, {
      min: 500,
      max: 599,
    });
    const delayRate = rate(rule.delayRate, `${ruleName}.delayRate`);
    if (errorRate + delayRate > 1) fail(ruleName, 'errorRate plus delayRate must not exceed 1');
    if (errorRate === 0 && delayRate === 0) fail(ruleName, 'must enable an error or delay fault');

    record(rule.delayMs, `${ruleName}.delayMs`, ['min', 'max']);
    const min = integer(rule.delayMs.min, `${ruleName}.delayMs.min`, { min: 0, max: 10_000 });
    const max = integer(rule.delayMs.max, `${ruleName}.delayMs.max`, { min: 0, max: 10_000 });
    if (min > max) fail(`${ruleName}.delayMs`, 'min must not exceed max');
    if (delayRate > 0 && max === 0)
      fail(`${ruleName}.delayMs`, 'max must be positive when delayRate is enabled');

    return { operations, targetRole, errorRate, errorStatus, delayRate, delayMs: { min, max } };
  });
  if (enabled && rules.length === 0)
    fail(`${name}.rules`, 'must contain at least one rule when enabled');
  return { enabled, seed, durationSeconds, rules };
}

function validateProbes(value) {
  const name = 'SIM_SECURITY_PROBES_JSON';
  record(value, name, ['enabled', 'seed', 'durationSeconds', 'operations']);
  const enabled = boolean(value.enabled, `${name}.enabled`);
  const seed = integer(value.seed, `${name}.seed`, { min: 0, max: MAX_SEED });
  const durationSeconds = integer(value.durationSeconds, `${name}.durationSeconds`, {
    min: enabled ? 1 : 0,
    max: MAX_DURATION_SECONDS,
  });
  if (!Array.isArray(value.operations) || value.operations.length > 2) {
    fail(`${name}.operations`, 'must be an array containing at most fileProbe and execProbe');
  }
  const usedOperations = new Set();
  let totalRate = 0;
  let totalCount = 0;
  const operations = value.operations.map((item, index) => {
    const operationName = `${name}.operations[${index}]`;
    record(item, operationName, ['operation', 'ratePerSecond', 'maxCount']);
    const operation = enumValue(item.operation, `${operationName}.operation`, [
      'fileProbe',
      'execProbe',
    ]);
    if (usedOperations.has(operation))
      fail(`${name}.operations`, `operation "${operation}" appears more than once`);
    usedOperations.add(operation);
    const ratePerSecond = rate(item.ratePerSecond, `${operationName}.ratePerSecond`, 10);
    const maxCount = integer(item.maxCount, `${operationName}.maxCount`, { min: 1, max: 1000 });
    if (enabled && ratePerSecond === 0)
      fail(`${operationName}.ratePerSecond`, 'must be positive when probes are enabled');
    totalRate += ratePerSecond;
    totalCount += maxCount;
    return { operation, ratePerSecond, maxCount };
  });
  if (totalRate > 10) fail(`${name}.operations`, 'combined ratePerSecond must not exceed 10');
  if (totalCount > 1000) fail(`${name}.operations`, 'combined maxCount must not exceed 1000');
  if (enabled && operations.length === 0)
    fail(`${name}.operations`, 'must contain an operation when enabled');
  return { enabled, seed, durationSeconds, operations };
}

function parseEnvBoolean(env, name, fallback) {
  if (!Object.hasOwn(env, name)) return fallback;
  const raw = String(env[name]).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  fail(name, 'must be true or false');
}

function envNumber(env, name, fallback, { min, max, integerOnly = true }) {
  if (!Object.hasOwn(env, name)) return fallback;
  const raw = String(env[name]).trim();
  if (!raw || !/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) fail(name, 'must be a number');
  const value = Number(raw);
  if (
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integerOnly && !Number.isSafeInteger(value))
  ) {
    fail(
      name,
      `must be ${integerOnly ? 'an integer' : 'a finite number'} from ${min} through ${max}`,
    );
  }
  return value;
}

function parseFaults(env) {
  const fallback = { enabled: false, seed: 42, durationSeconds: 0, rules: [] };
  return validateFaults(jsonEnv(env, 'SIM_FAULTS_JSON', fallback));
}

function parseProbes(env) {
  const fallback = { enabled: false, seed: 42, durationSeconds: 0, operations: [] };
  return validateProbes(jsonEnv(env, 'SIM_SECURITY_PROBES_JSON', fallback));
}

export function loadSimulatorSettings(env = process.env) {
  const faults = parseFaults(env);
  const probes = parseProbes(env);
  const demoSecurityMode = parseEnvBoolean(env, 'DEMO_SECURITY_MODE', false);
  const demoToken = env.DEMO_TOKEN;
  if ((faults.enabled || probes.enabled) && !demoSecurityMode) {
    fail('DEMO_SECURITY_MODE', 'must be true when simulator faults or probes are enabled');
  }
  if (
    (faults.enabled || probes.enabled) &&
    (typeof demoToken !== 'string' || demoToken.trim() === '')
  ) {
    fail('DEMO_TOKEN', 'must be non-empty when simulator faults or probes are enabled');
  }
  const demoTokenHeader = env.DEMO_TOKEN_HEADER || 'x-demo-token';
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(demoTokenHeader)) {
    fail('DEMO_TOKEN_HEADER', 'must be a valid HTTP header name');
  }

  const users = envNumber(env, 'USERS', 25, { min: 1, max: 100 });
  const durationSeconds = envNumber(env, 'DURATION_SECONDS', 0, {
    min: 0,
    max: MAX_DURATION_SECONDS,
  });
  const minThinkMs = envNumber(env, 'MIN_THINK_MS', 750, { min: 0, max: 60_000 });
  const maxThinkMs = envNumber(env, 'MAX_THINK_MS', 3500, { min: 1, max: 60_000 });
  const minSessionSeconds = envNumber(env, 'MIN_SESSION_SECONDS', 45, {
    min: 1,
    max: MAX_DURATION_SECONDS,
  });
  const maxSessionSeconds = envNumber(env, 'MAX_SESSION_SECONDS', 180, {
    min: 1,
    max: MAX_DURATION_SECONDS,
  });
  const minSessionGapMs = envNumber(env, 'MIN_SESSION_GAP_MS', 250, { min: 0, max: 60_000 });
  const maxSessionGapMs = envNumber(env, 'MAX_SESSION_GAP_MS', 3000, { min: 0, max: 60_000 });
  if (maxThinkMs < minThinkMs)
    fail('MAX_THINK_MS', 'must be greater than or equal to MIN_THINK_MS');
  if (maxSessionSeconds < minSessionSeconds)
    fail('MAX_SESSION_SECONDS', 'must be greater than or equal to MIN_SESSION_SECONDS');
  if (maxSessionGapMs < minSessionGapMs)
    fail('MAX_SESSION_GAP_MS', 'must be greater than or equal to MIN_SESSION_GAP_MS');

  const baseUrl = env.PACMAN_BASE_URL || env.BASE_URL || 'http://127.0.0.1:8080';
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    fail('PACMAN_BASE_URL', 'must be an absolute HTTP or HTTPS URL');
  }
  if (
    !['http:', 'https:'].includes(parsedBaseUrl.protocol) ||
    parsedBaseUrl.username ||
    parsedBaseUrl.password
  ) {
    fail('PACMAN_BASE_URL', 'must be an HTTP or HTTPS URL without credentials');
  }

  const staticPaths = Object.hasOwn(env, 'STATIC_PATHS')
    ? String(env.STATIC_PATHS)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;
  if (staticPaths?.some((path) => !path.startsWith('/') || path.startsWith('//'))) {
    fail('STATIC_PATHS', 'entries must be absolute paths on the configured server');
  }

  return {
    baseUrl,
    users,
    durationSeconds,
    minThinkMs,
    maxThinkMs,
    minSessionMs: minSessionSeconds * 1000,
    maxSessionMs: maxSessionSeconds * 1000,
    minSessionGapMs,
    maxSessionGapMs,
    scoreSubmitRate: envNumber(env, 'SCORE_SUBMIT_RATE', 0.08, {
      min: 0,
      max: 1,
      integerOnly: false,
    }),
    finalScoreSubmitRate: envNumber(env, 'FINAL_SCORE_SUBMIT_RATE', 0.7, {
      min: 0,
      max: 1,
      integerOnly: false,
    }),
    highScoreReadRate: envNumber(env, 'HIGH_SCORE_READ_RATE', 0.35, {
      min: 0,
      max: 1,
      integerOnly: false,
    }),
    timeoutMs: envNumber(env, 'REQUEST_TIMEOUT_MS', 4000, { min: 100, max: 60_000 }),
    metricsIntervalMs:
      envNumber(env, 'METRICS_INTERVAL_SECONDS', 30, { min: 5, max: MAX_DURATION_SECONDS }) * 1000,
    staticPaths,
    faults,
    probes,
    demoSecurityMode,
    demoToken,
    demoTokenHeader,
    randomSeed: faults.enabled ? faults.seed : probes.enabled ? probes.seed : 42,
  };
}
