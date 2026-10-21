import pino from 'pino';
import { config } from './config/index.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  // The demo token is a lab secret; never let it reach logs even though
  // pino-http otherwise serializes every request header.
  redact: {
    paths: [`req.headers["${config.DEMO_TOKEN_HEADER.toLowerCase()}"]`],
    censor: '[redacted]',
  },
  ...(config.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino/file',
          options: { destination: 1 },
        },
      }
    : {}),
});

export default logger;
