import { randomUUID } from 'node:crypto';
import { DatabaseAdapter } from './adapter.js';

export class MemoryAdapter extends DatabaseAdapter {
  constructor() {
    super();
    this.highscores = [];
    this.users = new Map();
  }

  async connect() {}
  async disconnect() {}
  async healthcheck() {
    return true;
  }

  async listTopScores(limit = 10, { includeSimulated = true } = {}) {
    return [...this.highscores]
      .filter((score) => includeSimulated || !/^sim\d+$/i.test(score.name ?? ''))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ name, cloud, zone, host, score }) => ({ name, cloud, zone, host, score }));
  }

  async insertScore(record) {
    this.highscores.push({ ...record, date: record.date ?? new Date().toISOString() });
  }

  async createUser(name) {
    const id = randomUUID();
    this.users.set(id, { id, name: name ?? null, updateCounter: 0, date: new Date().toISOString() });
    return { id };
  }

  async updateUserStats(id, patch) {
    const existing = this.users.get(id);
    if (!existing) {
      // Match upsert semantics of mongo/postgres adapters.
      this.users.set(id, { id, ...patch, updateCounter: 1, date: new Date().toISOString() });
      return;
    }
    this.users.set(id, {
      ...existing,
      ...patch,
      updateCounter: (existing.updateCounter ?? 0) + 1,
      date: new Date().toISOString(),
    });
  }

  async listUserStats({ maxAgeSeconds = 300, includeSimulated = true } = {}) {
    const cutoff = Date.now() - maxAgeSeconds * 1000;
    return [...this.users.values()]
      .filter((u) => typeof u.score === 'number')
      .filter((u) => Date.parse(u.date) >= cutoff)
      .filter((u) => includeSimulated || !/^sim\d+$/i.test(u.name ?? ''))
      .map((u) => ({
        id: u.id,
        name: u.name,
        cloud: u.cloud,
        zone: u.zone,
        host: u.host,
        score: u.score,
        level: u.level,
        lives: u.lives,
        et: u.elapsedTime,
        txncount: u.updateCounter,
        date: u.date,
      }));
  }
}

export default MemoryAdapter;
