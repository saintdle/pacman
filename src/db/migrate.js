#!/usr/bin/env node
/**
 * Minimal forward-only migration runner for the Postgres adapter.
 * Reads .sql files from src/db/migrations/postgres in lexicographic order,
 * tracks applied versions in a schema_migrations table, applies new ones
 * inside a transaction each.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { createPostgresPoolOptions } from './postgres.js';

const { Pool } = pg;

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations', 'postgres');
const migrationLockKey = 'pacman:schema_migrations';

async function main() {
  if (config.DB_TYPE !== 'postgres') {
    logger.warn({ DB_TYPE: config.DB_TYPE }, 'db:migrate currently only supports DB_TYPE=postgres; nothing to do');
    return;
  }

  const pool = new Pool(createPostgresPoolOptions(config));
  let client;
  let lockAcquired = false;

  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [migrationLockKey]);
    lockAcquired = true;

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows: applied } = await client.query('SELECT version FROM schema_migrations');
    const appliedSet = new Set(applied.map((r) => r.version));

    for (const file of files) {
      if (appliedSet.has(file)) {
        logger.info({ file }, 'migration already applied, skipping');
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        logger.info({ file }, 'migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error({ file, err }, 'migration failed; rolled back');
        throw err;
      }
    }
  } finally {
    if (client && lockAcquired) {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [migrationLockKey]);
    }
    client?.release();
    await pool.end();
  }
}

main().catch((err) => {
  logger.error({ err }, 'migration runner crashed');
  process.exit(1);
});
