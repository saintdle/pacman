import { MongoClient, ObjectId } from 'mongodb';
import { DatabaseAdapter } from './adapter.js';
import { logger } from '../logger.js';

function buildUrl(cfg) {
  const host = cfg.MONGO_NAMESPACE_SERVICE_HOST || cfg.MONGO_SERVICE_HOST;
  const hosts = host
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => `${h}:${cfg.MY_MONGO_PORT}`)
    .join(',');
  const auth =
    cfg.MONGO_AUTH_USER && cfg.MONGO_AUTH_PWD
      ? `${encodeURIComponent(cfg.MONGO_AUTH_USER)}:${encodeURIComponent(cfg.MONGO_AUTH_PWD)}@`
      : '';
  return `mongodb://${auth}${hosts}/${cfg.MONGO_DATABASE}`;
}

function buildOptions(cfg) {
  const options = { readPreference: 'secondaryPreferred' };
  if (cfg.MONGO_REPLICA_SET) options.replicaSet = cfg.MONGO_REPLICA_SET;
  if (cfg.MONGO_USE_SSL) {
    options.tls = true;
    options.tlsAllowInvalidCertificates = !cfg.MONGO_VALIDATE_SSL;
  }
  return options;
}

export class MongoAdapter extends DatabaseAdapter {
  constructor(cfg, { url, options } = {}) {
    super();
    this.cfg = cfg;
    this.url = url ?? buildUrl(cfg);
    this.options = options ?? buildOptions(cfg);
    this.client = null;
    this.db = null;
  }

  async connect() {
    this.client = new MongoClient(this.url, this.options);
    await this.client.connect();
    this.db = this.client.db(this.cfg.MONGO_DATABASE);
    logger.info({ db: this.cfg.MONGO_DATABASE }, 'mongo connected');
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.db = null;
    }
  }

  async healthcheck() {
    if (!this.db) return false;
    try {
      await this.db.command({ ping: 1 });
      return true;
    } catch (err) {
      logger.warn({ err }, 'mongo healthcheck failed');
      return false;
    }
  }

  async listTopScores(limit = 10) {
    const docs = await this.db
      .collection('highscore')
      .find({}, { projection: { _id: 0, name: 1, cloud: 1, zone: 1, host: 1, score: 1 } })
      .sort({ score: -1 })
      .limit(limit)
      .toArray();
    return docs;
  }

  async insertScore(record) {
    const doc = { ...record, date: record.date ?? new Date().toISOString() };
    await this.db.collection('highscore').insertOne(doc, {
      writeConcern: { w: 'majority', j: true, wtimeout: 10000 },
    });
  }

  async createUser() {
    const result = await this.db
      .collection('userstats')
      .insertOne({ date: new Date().toISOString() }, { writeConcern: { w: 'majority', j: true, wtimeout: 10000 } });
    return { id: result.insertedId.toString() };
  }

  async updateUserStats(id, patch) {
    let _id;
    try {
      _id = new ObjectId(id);
    } catch {
      // Allow non-ObjectId ids (e.g. UUID strings from a Postgres-backed deployment migrating in).
      _id = id;
    }
    await this.db.collection('userstats').updateOne(
      { _id },
      {
        $set: { ...patch, date: new Date().toISOString() },
        $inc: { updateCounter: 1 },
      },
      { upsert: true, writeConcern: { w: 'majority', j: true, wtimeout: 10000 } },
    );
  }

  async listUserStats() {
    const docs = await this.db
      .collection('userstats')
      .find({ score: { $exists: true } })
      .sort({ _id: 1 })
      .toArray();
    return docs.map((d) => ({
      cloud: d.cloud,
      zone: d.zone,
      host: d.host,
      score: d.score,
      level: d.level,
      lives: d.lives,
      et: d.elapsedTime,
      txncount: d.updateCounter,
    }));
  }
}

export default MongoAdapter;
