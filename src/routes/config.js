import { Router } from 'express';
import { config } from '../config/index.js';
import { getClientConfig } from './client-config.js';

// Surfaces a small slice of server configuration to the client so the game
// can adapt to operator-controlled values (e.g. the maximum reachable level).
// Keep the response shape narrow: only fields safe to expose publicly.
export function configRouter() {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(getClientConfig());
  });

  router.get('/schema', (_req, res) => {
    res.json({
      config: getClientConfig(),
      fields: {
        maxLevel: {
          env: 'MAX_LEVEL',
          type: 'positive integer | "unlimited"',
          default: 10,
          clientOverride: 'ALLOW_CLIENT_CONFIG_OVERRIDE',
          description: 'Authoritative server cap for playable levels and high-score validation.',
        },
        allowClientOverride: {
          env: 'ALLOW_CLIENT_CONFIG_OVERRIDE',
          type: 'boolean',
          default: true,
          description: 'Allows browsers to store a local max-level gameplay override.',
        },
        ebeeMode: {
          env: 'EBEE_MODE',
          type: 'boolean',
          default: false,
          clientOverride: 'ALLOW_CLIENT_EBEE_MODE_OVERRIDE',
          description: 'Server default for the eBee visual theme.',
        },
        allowEbeeModeOverride: {
          env: 'ALLOW_CLIENT_EBEE_MODE_OVERRIDE',
          type: 'boolean',
          default: true,
          description: 'Allows browsers to store a local eBee-mode theme override.',
        },
        liveStatsMaxAgeSeconds: {
          env: 'LIVE_STATS_MAX_AGE_SECONDS',
          type: 'positive integer',
          default: 300,
          description: 'Seconds without a live-stats update before a session is hidden.',
        },
        liveStatsPageSize: {
          env: 'LIVE_STATS_PAGE_SIZE',
          type: 'positive integer <= 100',
          default: 10,
          description: 'Default number of live sessions shown per page.',
        },
        simulatedUsersEnabled: {
          env: 'SIMULATED_USERS_ENABLED',
          type: 'boolean',
          default: false,
          description: 'Sets the default visibility of sim# users on score tables.',
        },
      },
    });
  });

  // POST /config — server-side gate the client calls before persisting a
  // local override. The server does not store anything; this is purely a
  // permission + validation check so admins can lock the game's settings
  // by flipping the relevant ALLOW_CLIENT_* override to false. The client
  // respects a 403 by refusing to save the override and showing the message.
  router.post('/', (req, res) => {
    const body = req.body || {};
    const result = { rs: 'success' };

    if (Object.hasOwn(body, 'maxLevel')) {
      if (!config.ALLOW_CLIENT_CONFIG_OVERRIDE) {
        return res.status(403).json({ error: 'client gameplay config overrides are disabled on this server' });
      }

      const raw = body.maxLevel;
      if (raw === 'unlimited') {
        result.maxLevel = 'unlimited';
      } else {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) {
          return res.status(400).json({ error: 'maxLevel must be a positive integer or "unlimited"' });
        }
        result.maxLevel = n;
      }
    }

    if (Object.hasOwn(body, 'ebeeMode')) {
      if (!config.ALLOW_CLIENT_EBEE_MODE_OVERRIDE) {
        return res.status(403).json({ error: 'client eBee mode overrides are disabled on this server' });
      }

      if (!['true', 'false', true, false].includes(body.ebeeMode)) {
        return res.status(400).json({ error: 'ebeeMode must be true or false' });
      }
      result.ebeeMode = body.ebeeMode === true || body.ebeeMode === 'true';
    }

    return res.json(result);
  });

  return router;
}

export default configRouter;
