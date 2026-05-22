import { Router } from 'express';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { config } from '../config/index.js';
import { requireDemoAccess } from '../demo/guard.js';

const execFileAsync = promisify(execFile);

export function demoRouter() {
  const router = Router();

  router.get('/status', (req, res) => {
    res.json({
      demoSecurityMode: config.DEMO_SECURITY_MODE,
      tokenHeader: config.DEMO_TOKEN_HEADER,
      authorized: req.headers[config.DEMO_TOKEN_HEADER.toLowerCase()] === config.DEMO_TOKEN,
      role: config.APP_ROLE,
      version: config.APP_VERSION,
      variant: config.APP_VARIANT,
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

    try {
      const hostname = (await readFile('/etc/hostname', 'utf8')).trim();
      req.log?.warn({ probe: 'file', path: '/etc/hostname', hostname }, 'demo incident file probe');
      res.json({ rs: 'success', probe: 'file', path: '/etc/hostname', hostname });
    } catch (err) {
      next(err);
    }
  });

  router.post('/incidents/exec-probe', async (req, res, next) => {
    if (!requireDemoAccess(req, res)) return;

    try {
      const { stdout } = await execFileAsync(process.execPath, ['-e', 'process.stdout.write("demo-exec-probe")'], {
        timeout: 1000,
      });
      req.log?.warn({ probe: 'exec', binary: process.execPath }, 'demo incident exec probe');
      res.json({ rs: 'success', probe: 'exec', output: stdout });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export default demoRouter;