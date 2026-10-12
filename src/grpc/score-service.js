import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { parseScoreSubmission } from '../routes/score-validation.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const protoPath = path.resolve(here, '../../proto/pacman.proto');

const packageDefinition = protoLoader.loadSync(protoPath, {
  keepCase: false,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

export const pacmanProto = grpc.loadPackageDefinition(packageDefinition).pacman;

function statusError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function createScoreService(db, { logger, maxLevel = config.MAX_LEVEL } = {}) {
  return {
    async submitScore(call, callback) {
      const req = call.request;
      const submission = parseScoreSubmission(req.score, req.level, maxLevel);
      if (submission.error) {
        callback(statusError(grpc.status.INVALID_ARGUMENT, submission.error));
        return;
      }

      try {
        await db.insertScore({
          name: req.name ?? '',
          cloud: req.cloud ?? '',
          zone: req.zone ?? '',
          host: req.host ?? '',
          score: submission.score,
          level: submission.level,
          referer: 'grpc',
          user_agent: 'grpc',
          hostname: 'grpc',
          ip_addr: null,
        });
        callback(null, {
          rs: 'success',
          name: req.name ?? '',
          zone: req.zone ?? '',
          score: submission.score,
          level: submission.level,
        });
      } catch (err) {
        logger?.error?.({ err }, 'gRPC score submission failed');
        callback(statusError(grpc.status.INTERNAL, 'score submission failed'));
      }
    },

    async listScores(call, callback) {
      try {
        const limit = call.request.limit > 0 ? call.request.limit : 10;
        const scores = await db.listTopScores(limit);
        callback(null, { scores });
      } catch (err) {
        logger?.error?.({ err }, 'gRPC score listing failed');
        callback(statusError(grpc.status.INTERNAL, 'score listing failed'));
      }
    },
  };
}

export async function startGrpcScoreServer({ db, host = '0.0.0.0', port = 9090, logger }) {
  const server = new grpc.Server();
  server.addService(pacmanProto.ScoreService.service, createScoreService(db, { logger }));
  const bindAddress = `${host}:${port}`;
  const boundPort = await new Promise((resolve, reject) => {
    server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (err, allocatedPort) => {
      if (err) return reject(err);
      logger?.info?.({ host, port }, 'pacman grpc score service listening');
      resolve(allocatedPort);
    });
  });

  return { server, port: boundPort };
}
