import http from 'node:http';
import { config } from './config/index.js';
import { logger } from './logger.js';
import { createAdapter } from './db/index.js';
import { createApp } from './app.js';
import { startGrpcScoreServer } from './grpc/score-service.js';

async function main() {
  const db = createAdapter(config);

  try {
    await db.connect();
  } catch (err) {
    logger.error({ err }, 'database connect failed; continuing in degraded state');
  }

  let grpcHandle;
  if (config.APP_ROLE === 'grpc') {
    grpcHandle = await startGrpcScoreServer({ db, host: config.HOST, port: config.GRPC_PORT, logger });
  }

  const app = createApp({ db });
  const server = http.createServer(app);

  server.listen(config.PORT, config.HOST, () => {
    logger.info({ host: config.HOST, port: config.PORT, db: config.DB_TYPE }, 'pacman listening');
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');

    const forceExit = setTimeout(() => {
      logger.warn('graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 10_000).unref();

    server.close(async (err) => {
      if (err) logger.error({ err }, 'server close error');
      try {
        if (grpcHandle) grpcHandle.server.forceShutdown();
        await db.disconnect();
      } catch (e) {
        logger.error({ err: e }, 'db disconnect failed');
      }
      clearTimeout(forceExit);
      process.exit(0);
    });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
