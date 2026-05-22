// Policy-friendly internal endpoints.
//
// These mirror the public game API but use distinct path prefixes so Cilium
// L7 network policies can grant fine-grained access:
//   /internal/score/read   — list scores  (GET)
//   /internal/score/write  — submit score (POST)
//   /internal/user/session — create user  (GET)
//   /internal/user/stats   — user stats   (GET + POST)
//   /internal/config/read  — read config  (GET)
//
// The public game API stays untouched.

import { Router } from 'express';
import { config } from '../config/index.js';
import { incCounter } from '../metrics.js';

const PILL_POINTS = 10;
const POWERPILL_POINTS = 50;
const GHOST_POINTS = 100;
const MAX_POINTS_PER_LEVEL =
  104 * PILL_POINTS + 4 * POWERPILL_POINTS + 4 * 4 * GHOST_POINTS;

export function internalRouter() {
  const router = Router();

  // ---------- scores ----------

  router.get('/score/read', async (req, res, next) => {
    try {
      incCounter('pacman_db_operations_total', { op: 'listTopScores', source: 'internal' });
      const scores = await req.app.locals.db.listTopScores(10);
      res.json(scores);
    } catch (err) {
      next(err);
    }
  });

  router.post('/score/write', async (req, res, next) => {
    try {
      const userScore = Number.parseInt(req.body.score, 10);
      const userLevel = Number.parseInt(req.body.level, 10);

      if (!Number.isFinite(userScore)) {
        return res.status(400).json({ error: 'score must be a number' });
      }

      if (Number.isFinite(userLevel)) {
        if (userLevel < 1) {
          return res.status(400).json({ error: 'invalid level' });
        }
        if (config.MAX_LEVEL !== 'unlimited' && userLevel > config.MAX_LEVEL) {
          return res.status(400).json({ error: 'invalid level' });
        }
        if (userScore / userLevel > MAX_POINTS_PER_LEVEL) {
          return res.status(400).json({ error: 'score is implausible for level' });
        }
      }

      incCounter('pacman_db_operations_total', { op: 'insertScore', source: 'internal' });
      incCounter('pacman_score_submissions_total', { source: 'internal' });

      await req.app.locals.db.insertScore({
        name: req.body.name,
        cloud: req.body.cloud,
        zone: req.body.zone,
        host: req.body.host,
        score: userScore,
        level: Number.isFinite(userLevel) ? userLevel : null,
        referer: req.headers.referer,
        user_agent: req.headers['user-agent'],
        hostname: req.hostname,
        ip_addr: req.ip,
      });

      res.json({
        name: req.body.name,
        zone: req.body.zone,
        score: userScore,
        level: userLevel,
        rs: 'success',
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------- users ----------

  router.get('/user/session', async (req, res, next) => {
    try {
      incCounter('pacman_db_operations_total', { op: 'createUser', source: 'internal' });
      const { id } = await req.app.locals.db.createUser();
      res.json({ id });
    } catch (err) {
      next(err);
    }
  });

  router.get('/user/stats', async (req, res, next) => {
    try {
      incCounter('pacman_db_operations_total', { op: 'listUserStats', source: 'internal' });
      const stats = await req.app.locals.db.listUserStats();
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  router.post('/user/stats', async (req, res, next) => {
    try {
      const userId = req.body.userId;
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({ error: 'userId required' });
      }

      incCounter('pacman_db_operations_total', { op: 'updateUserStats', source: 'internal' });
      incCounter('pacman_user_stat_updates_total', { source: 'internal' });

      await req.app.locals.db.updateUserStats(userId, {
        cloud: req.body.cloud,
        zone: req.body.zone,
        host: req.body.host,
        score: Number.isFinite(Number(req.body.score)) ? Number(req.body.score) : null,
        level: Number.isFinite(Number(req.body.level)) ? Number(req.body.level) : null,
        lives: Number.isFinite(Number(req.body.lives)) ? Number(req.body.lives) : null,
        elapsedTime: Number.isFinite(Number(req.body.elapsedTime)) ? Number(req.body.elapsedTime) : null,
        referer: req.headers.referer,
        user_agent: req.headers['user-agent'],
        hostname: req.hostname,
        ip_addr: req.ip,
      });

      res.json({ rs: 'success' });
    } catch (err) {
      next(err);
    }
  });

  // ---------- config ----------

  router.get('/config/read', (_req, res) => {
    res.json({
      maxLevel: config.MAX_LEVEL,
      allowClientOverride: config.ALLOW_CLIENT_CONFIG_OVERRIDE,
      ebeeMode: config.EBEE_MODE,
      allowEbeeModeOverride: config.ALLOW_CLIENT_EBEE_MODE_OVERRIDE,
      appRole: config.APP_ROLE,
      appVersion: config.APP_VERSION,
      appVariant: config.APP_VARIANT,
      appColor: config.APP_COLOR,
    });
  });

  return router;
}

export default internalRouter;
