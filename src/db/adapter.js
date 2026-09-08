/**
 * Database adapter contract.
 *
 * All adapters return plain JS objects with the same shape so HTTP routes
 * never see driver-specific types (no Mongo ObjectId, no pg row objects, etc.).
 *
 * HighscoreRecord:
 *   { name, cloud, zone, host, score, level, date, referer, user_agent, hostname, ip_addr }
 *
 * UserStatsRecord:
 *   { id, name, cloud, zone, host, score, level, lives, elapsedTime, date,
 *     referer, user_agent, hostname, ip_addr, updateCounter }
 *
 * Methods:
 *   connect()                          -> Promise<void>
 *   disconnect()                       -> Promise<void>
 *   healthcheck()                      -> Promise<boolean>
 *   listTopScores(limit)               -> Promise<HighscoreRecord[]>  (desc by score)
 *   insertScore(record)                -> Promise<void>
 *   createUser()                       -> Promise<{ id: string }>
 *   updateUserStats(id, patch)         -> Promise<void>
 *   listUserStats(options)             -> Promise<UserStatsRecord[]>  (active rows with score)
 */
export class DatabaseAdapter {
  async connect() {
    throw new Error('connect() not implemented');
  }
  async disconnect() {
    throw new Error('disconnect() not implemented');
  }
  async healthcheck() {
    throw new Error('healthcheck() not implemented');
  }
  async listTopScores(_limit, _options) {
    throw new Error('listTopScores() not implemented');
  }
  async insertScore(_record) {
    throw new Error('insertScore() not implemented');
  }
  async createUser(_name) {
    throw new Error('createUser() not implemented');
  }
  async updateUserStats(_id, _patch) {
    throw new Error('updateUserStats() not implemented');
  }
  async listUserStats(_options) {
    throw new Error('listUserStats() not implemented');
  }
}
