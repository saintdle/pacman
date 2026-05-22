import { config } from '../config/index.js';

export function demoAuthorized(req) {
  const header = config.DEMO_TOKEN_HEADER.toLowerCase();
  return config.DEMO_SECURITY_MODE && req.headers[header] === config.DEMO_TOKEN;
}

export function requireDemoAccess(req, res) {
  if (demoAuthorized(req)) return true;
  res.status(403).json({ error: 'demo security mode or token is not enabled' });
  return false;
}