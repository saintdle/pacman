import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export function createScoreService(db) {
  return {
    async submitScore(call, callback) {
      try {
        const req = call.request;
        await db.insertScore({
          name: req.name,
          cloud: req.cloud,
          zone: req.zone,
          host: req.host,
          score: req.score,
          level: req.level,
          referer: 'grpc',
          user_agent: 'grpc',
          hostname: 'grpc',
          ip_addr: null,
        });
        callback(null, {
          rs: 'success',
          name: req.name,
          zone: req.zone,
          score: req.score,
          level: req.level,
        });
      } catch (err) {
        callback(err);
      }
    },

    async listScores(call, callback) {
      try {
        const limit = call.request.limit > 0 ? call.request.limit : 10;
        const scores = await db.listTopScores(limit);
        callback(null, { scores });
      } catch (err) {
        callback(err);
      }
    },
  };
}

export async function startGrpcScoreServer({ db, host = '0.0.0.0', port = 9090, logger }) {
  const server = new grpc.Server();
  server.addService(pacmanProto.ScoreService.service, createScoreService(db));
  const bindAddress = `${host}:${port}`;
  const boundPort = await new Promise((resolve, reject) => {
    server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (err, allocatedPort) => {
      if (err) return reject(err);
      logger?.info({ host, port }, 'pacman grpc score service listening');
      resolve(allocatedPort);
    });
  });

  return { server, port: boundPort };
}
