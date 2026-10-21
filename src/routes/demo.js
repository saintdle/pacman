import { Router } from 'express';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config/index.js';
import { requireDemoAccess } from '../demo/guard.js';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

// Fixed, non-caller-controlled paths. In the distroless runtime image these
// resolve under /app; falling back to the repo-relative path lets the same
// code run unmodified in host-local tests/dev.
const APP_FIXTURE_PATH = '/app/demo-fixtures/synthetic-secret.txt';
const FIXTURE_PATH = existsSync(APP_FIXTURE_PATH) ? APP_FIXTURE_PATH : path.join(repoRoot, 'demo-fixtures/synthetic-secret.txt');

const APP_HELPER_PATH = '/app/tools/demo-exec-probe.js';
const HELPER_PATH = existsSync(APP_HELPER_PATH) ? APP_HELPER_PATH : path.join(repoRoot, 'tools/demo-exec-probe.js');

// The distroless image's Node binary is the exec target pinned by the fixed
// helper's shebang; Tetragon scopes enforcement to sys_execve arg0 matching
// HELPER_PATH exactly, so no caller-selected command/args are ever passed.
const DISTROLESS_NODE_BIN = '/nodejs/bin/node';

export function demoRouter() {
  const router = Router();

  router.use(rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'too many demo requests' },
  }));

  router.get('/status', (req, res) => {
    res.json({
      demoSecurityMode: config.DEMO_SECURITY_MODE,
      tokenHeader: config.DEMO_TOKEN_HEADER,
      authorized: req.headers[config.DEMO_TOKEN_HEADER.toLowerCase()] === config.DEMO_TOKEN,
      role: config.APP_ROLE,
      version: config.APP_VERSION,
      variant: config.APP_VARIANT,
      fileProbeEnabled: config.DEMO_FILE_PROBE_ENABLED,
      execProbeEnabled: config.DEMO_EXEC_PROBE_ENABLED,
    });
  });

  router.post('/incidents', async (req, res) => {
    if (!requireDemoAccess(req, res)) return;

    const incident = {
      type: req.body?.type ?? 'manual-demo-incident',
      action: req.body?.action ?? 'record',
      role: config.APP_ROLE,
      version: config.APP_VERSION,
      variant: config.APP_VARIANT,
      remoteAddress: req.ip,
      userAgent: req.headers['user-agent'] ?? 'unknown',
      at: new Date().toISOString(),
    };
    req.log?.warn({ incident }, 'demo incident recorded');
    res.json({ rs: 'success', incident });
  });

  router.post('/incidents/file-probe', async (req, res, next) => {
    if (!requireDemoAccess(req, res)) return;
    if (!config.DEMO_FILE_PROBE_ENABLED) return res.status(404).json({ error: 'demo file probe is disabled' });

    try {
      const content = (await readFile(FIXTURE_PATH, 'utf8')).trim();
      req.log?.warn({ probe: 'file', path: FIXTURE_PATH }, 'demo incident file probe');
      res.json({ rs: 'success', probe: 'file', path: FIXTURE_PATH, content });
    } catch (err) {
      next(err);
    }
  });

  router.post('/incidents/exec-probe', async (req, res, next) => {
    if (!requireDemoAccess(req, res)) return;
    if (!config.DEMO_EXEC_PROBE_ENABLED) return res.status(404).json({ error: 'demo exec probe is disabled' });

    try {
      const { stdout } = existsSync(DISTROLESS_NODE_BIN)
        ? await execFileAsync(HELPER_PATH, [], { timeout: 1000 })
        : await execFileAsync(process.execPath, [HELPER_PATH], { timeout: 1000 });
      req.log?.warn({ probe: 'exec', binary: HELPER_PATH }, 'demo incident exec probe');
      res.json({ rs: 'success', probe: 'exec', output: stdout.trim() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default demoRouter;
