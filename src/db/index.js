import { MemoryAdapter } from './memory.js';
import { MongoAdapter } from './mongo.js';
import { PostgresAdapter } from './postgres.js';

/**
 * Factory: returns a DatabaseAdapter for the requested DB_TYPE.
 *
 * @param {object} cfg - validated config from src/config
 * @returns {import('./adapter.js').DatabaseAdapter}
 */
export function createAdapter(cfg) {
  switch (cfg.DB_TYPE) {
    case 'mongo':
      return new MongoAdapter(cfg);
    case 'postgres':
      return new PostgresAdapter(cfg);
    case 'memory':
    default:
      return new MemoryAdapter();
  }
}

export default createAdapter;
