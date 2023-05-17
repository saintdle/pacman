'use strict';

const MongoClient = require('mongodb').MongoClient;
const config = require('./config');

class Database {
  constructor() {
    this._db = null;
  }

  async connect(app) {
    try {
      const db = await MongoClient.connect(
        config.database.url,
        config.database.options
      );
      this._db = db;
      app.locals.db = db;
      return db;
    } catch (err) {
      console.error(err);
      console.error(config.database.url);
      console.error(config.database.options);
      throw err;
    }
  }

  async getDb(app) {
    if (!this._db) {
      try {
        await this.connect(app);
        console.log('Connected to database server successfully');
        return this._db;
      } catch (err) {
        console.error('Failed to connect to database server');
        throw err;
      }
    } else {
      return this._db;
    }
  }
}

module.exports = new Database(); // Singleton
