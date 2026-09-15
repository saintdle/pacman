import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { DatabaseAdapter } from './adapter.js';
import { logger } from '../logger.js';

const { Pool } = pg;

export function createPostgresPoolOptions(cfg) {
  return {
    host: cfg.POSTGRES_HOST,
    port: cfg.POSTGRES_PORT,
    database: cfg.POSTGRES_DB,
    user: cfg.POSTGRES_USER,
    password: cfg.POSTGRES_PASSWORD,
    max: cfg.POSTGRES_POOL_MAX ?? 10,
    connectionTimeoutMillis: cfg.POSTGRES_CONNECTION_TIMEOUT_MS ?? 5000,
    idleTimeoutMillis: cfg.POSTGRES_IDLE_TIMEOUT_MS ?? 30000,
    statement_timeout: cfg.POSTGRES_STATEMENT_TIMEOUT_MS ?? 10000,
    query_timeout: cfg.POSTGRES_QUERY_TIMEOUT_MS ?? 15000,
    ssl: cfg.POSTGRES_SSL
      ? {
        rejectUnauthorized: cfg.POSTGRES_SSL_REJECT_UNAUTHORIZED ?? true,
        ...(cfg.POSTGRES_SSL_CA ? { ca: cfg.POSTGRES_SSL_CA } : {}),
      }
      : false,
  };
}

export class PostgresAdapter extends DatabaseAdapter {
  constructor(cfg, { pool } = {}) {
    super();
    this.cfg = cfg;
    this.pool = pool ?? new Pool(createPostgresPoolOptions(cfg));
  }

  async connect() {
    // Validate connectivity early.
    const client = await this.pool.connect();
    client.release();
    logger.info({ db: this.cfg.POSTGRES_DB }, 'postgres connected');
  }

  async disconnect() {
    await this.pool.end();
  }

  async healthcheck() {
    try {
      const { rows } = await this.pool.query('SELECT 1 AS ok');
      return rows[0]?.ok === 1;
    } catch (err) {
      logger.warn({ err }, 'postgres healthcheck failed');
      return false;
    }
  }

  async listTopScores(limit = 10, { includeSimulated = true } = {}) {
    const simulatorFilter = includeSimulated ? '' : "WHERE name IS NULL OR name !~* '^sim[0-9]+$'";
    const { rows } = await this.pool.query(
      `SELECT name, cloud, zone, host, score
         FROM highscores
        ${simulatorFilter}
        ORDER BY score DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  }

  async insertScore(record) {
    await this.pool.query(
      `INSERT INTO highscores
         (id, name, cloud, zone, host, score, level, created_at, referer, user_agent, hostname, ip_addr)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10, $11)`,
      [
        randomUUID(),
        record.name ?? null,
        record.cloud ?? null,
        record.zone ?? null,
        record.host ?? null,
        record.score,
        record.level,
        record.referer ?? null,
        record.user_agent ?? null,
        record.hostname ?? null,
        record.ip_addr ?? null,
      ],
    );
  }

  async createUser(name) {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO user_stats (id, name, update_counter, created_at) VALUES ($1, $2, 0, now())`,
      [id, name ?? null],
    );
    return { id };
  }

  async updateUserStats(id, patch) {
    await this.pool.query(
      `INSERT INTO user_stats
         (id, name, cloud, zone, host, score, level, lives, elapsed_time,
          created_at, referer, user_agent, hostname, ip_addr, update_counter)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, $11, $12, $13, 1)
       ON CONFLICT (id) DO UPDATE SET
         name = COALESCE(EXCLUDED.name, user_stats.name),
         cloud = EXCLUDED.cloud,
         zone = EXCLUDED.zone,
         host = EXCLUDED.host,
         score = EXCLUDED.score,
         level = EXCLUDED.level,
         lives = EXCLUDED.lives,
         elapsed_time = EXCLUDED.elapsed_time,
         created_at = now(),
         referer = EXCLUDED.referer,
         user_agent = EXCLUDED.user_agent,
         hostname = EXCLUDED.hostname,
         ip_addr = EXCLUDED.ip_addr,
         update_counter = user_stats.update_counter + 1`,
      [
        id,
        patch.name ?? null,
        patch.cloud ?? null,
        patch.zone ?? null,
        patch.host ?? null,
        patch.score ?? null,
        patch.level ?? null,
        patch.lives ?? null,
        patch.elapsedTime ?? null,
        patch.referer ?? null,
        patch.user_agent ?? null,
        patch.hostname ?? null,
        patch.ip_addr ?? null,
      ],
    );
  }

  async listUserStats({ maxAgeSeconds = 300, includeSimulated = true } = {}) {
    const simulatorFilter = includeSimulated ? '' : "AND (name IS NULL OR name !~* '^sim[0-9]+$')";
    const { rows } = await this.pool.query(
      `SELECT id, name, cloud, zone, host, score, level, lives,
              elapsed_time AS et, update_counter AS txncount,
              created_at AS date
         FROM user_stats
        WHERE score IS NOT NULL
          AND created_at >= now() - ($1 * interval '1 second')
          ${simulatorFilter}
        ORDER BY created_at ASC`,
      [maxAgeSeconds],
    );
    return rows;
  }
}

export default PostgresAdapter;
