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

  async listTopScores(limit = 10) {
    return [...this.highscores]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ name, cloud, zone, host, score }) => ({ name, cloud, zone, host, score }));
  }

  async insertScore(record) {
    this.highscores.push({ ...record, date: record.date ?? new Date().toISOString() });
  }

  async createUser() {
    const id = randomUUID();
    this.users.set(id, { id, updateCounter: 0, date: new Date().toISOString() });
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

  async listUserStats() {
    return [...this.users.values()]
      .filter((u) => typeof u.score === 'number')
      .map((u) => ({
        cloud: u.cloud,
        zone: u.zone,
        host: u.host,
        score: u.score,
        level: u.level,
        lives: u.lives,
        et: u.elapsedTime,
        txncount: u.updateCounter,
      }));
  }
}

export default MemoryAdapter;
