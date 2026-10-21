import { describeLogicalRequest, FAULT_HEADER_NAMES, faultHeadersFor } from './faults.js';

export function createMetrics() {
  const counts = () => ({ attempted: 0, succeeded: 0, failed: 0, timeouts: 0 });
  return {
    requests: counts(),
    probes: {
      fileProbe: counts(),
      execProbe: counts(),
    },
    sessionsStarted: 0,
    sessionsCompleted: 0,
    scoreSubmissions: { attempted: 0, succeeded: 0, failed: 0, invalid: 0 },
    scoresSubmitted: 0,
  };
}

function deleteHeader(headers, name) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
  }
}

function clearFaultHeaders(headers) {
  for (const name of Object.values(FAULT_HEADER_NAMES)) deleteHeader(headers, name);
}

function increment(bucket, result) {
  if (result === 'attempted') bucket.attempted += 1;
  else if (result === 'succeeded') bucket.succeeded += 1;
  else {
    bucket.failed += 1;
    if (result === 'timeout') bucket.timeouts += 1;
  }
}

export function createRequestExecutor({
  metrics,
  fetchImpl = globalThis.fetch,
  faultSelector,
  faultRandom,
  demoToken,
  demoTokenHeader = 'x-demo-token',
  now = Date.now,
  onFailure = (details) =>
    console.error(JSON.stringify({ level: 'warn', msg: 'simulator request failed', ...details })),
}) {
  return async function request(
    baseUrl,
    path,
    {
      method = 'GET',
      body,
      headers = {},
      timeoutMs = 4000,
      optional = false,
      bootstrap = false,
      demoAuth = false,
      probeOperation,
    } = {},
  ) {
    const verb = String(method).toUpperCase();
    const logicalRequest = describeLogicalRequest(verb, path, { bootstrap });
    const fault =
      logicalRequest && faultSelector
        ? faultSelector.select(logicalRequest, faultRandom, now())
        : null;
    const requestHeaders = { ...headers };
    clearFaultHeaders(requestHeaders);
    deleteHeader(requestHeaders, demoTokenHeader);
    if (fault) {
      requestHeaders[demoTokenHeader] = demoToken;
      Object.assign(requestHeaders, faultHeadersFor(fault));
    } else if (demoAuth) {
      requestHeaders[demoTokenHeader] = demoToken;
    }

    const probeMetrics = probeOperation ? metrics.probes[probeOperation] : null;
    increment(metrics.requests, 'attempted');
    if (probeMetrics) increment(probeMetrics, 'attempted');

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await fetchImpl(new URL(path, baseUrl).toString(), {
        method: verb,
        body,
        headers: requestHeaders,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`${verb} ${path} returned ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.toLowerCase().includes('application/json')
        ? await response.json()
        : await response.text();
      increment(metrics.requests, 'succeeded');
      if (probeMetrics) increment(probeMetrics, 'succeeded');
      return { ok: true, payload, status: response.status };
    } catch (error) {
      const outcome = timedOut || controller.signal.aborted ? 'timeout' : 'failed';
      increment(metrics.requests, outcome);
      if (probeMetrics) increment(probeMetrics, outcome);
      if (!optional) onFailure({ path, method: verb, error: error.message });
      return { ok: false, error, timeout: outcome === 'timeout' };
    } finally {
      clearTimeout(timeout);
    }
  };
}
