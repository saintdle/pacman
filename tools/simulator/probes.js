export const SECURITY_PROBE_REQUESTS = Object.freeze({
  fileProbe: Object.freeze({ method: 'POST', path: '/demo/incidents/file-probe' }),
  execProbe: Object.freeze({ method: 'POST', path: '/demo/incidents/exec-probe' }),
});

export function createProbeScheduler(config, startedAt = Date.now()) {
  const entries = config.operations.map((entry) => ({
    ...entry,
    attempted: 0,
    nextAt: startedAt,
  }));
  const expiresAt = startedAt + config.durationSeconds * 1000;
  const totalRate = entries.reduce((sum, entry) => sum + entry.ratePerSecond, 0);
  let globalNextAt = startedAt;

  return {
    claimDue(now = Date.now(), random) {
      if (!config.enabled || now >= expiresAt || now < globalNextAt) return [];
      const due = entries.filter(
        (entry) =>
          entry.ratePerSecond > 0 && entry.attempted < entry.maxCount && now >= entry.nextAt,
      );
      if (due.length === 0) return [];

      const dueIndex = due.length > 1 && random ? random.int(0, due.length - 1) : 0;
      const entry = due[dueIndex];
      entry.attempted += 1;
      entry.nextAt = Math.max(
        entry.nextAt + 1000 / entry.ratePerSecond,
        now + 1000 / entry.ratePerSecond,
      );
      globalNextAt = now + 1000 / totalRate;
      return [{ operation: entry.operation, ...SECURITY_PROBE_REQUESTS[entry.operation] }];
    },
    nextDelay(now = Date.now()) {
      if (!config.enabled || now >= expiresAt) return null;
      const nextAt = entries
        .filter((entry) => entry.ratePerSecond > 0 && entry.attempted < entry.maxCount)
        .reduce(
          (earliest, entry) => Math.min(earliest, Math.max(entry.nextAt, globalNextAt)),
          Number.POSITIVE_INFINITY,
        );
      return Number.isFinite(nextAt) ? Math.max(0, nextAt - now) : null;
    },
    snapshot() {
      return entries.map(({ operation, attempted, maxCount, ratePerSecond }) => ({
        operation,
        attempted,
        maxCount,
        ratePerSecond,
      }));
    },
  };
}
