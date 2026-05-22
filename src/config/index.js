import 'dotenv/config';
import { z } from 'zod';

const boolish = z
  .union([z.string(), z.boolean()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  GRPC_PORT: z.coerce.number().int().positive().default(9090),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DB_TYPE: z.enum(['memory', 'mongo', 'postgres']).default('memory'),

  // Demo/runtime metadata. APP_ROLE lets one image run separate Kubernetes
  // workloads for east-west, Gateway API, and Tetragon demos.
  APP_ROLE: z.enum(['web', 'score', 'user', 'config', 'topology', 'incident', 'grpc']).default('web'),
  APP_VERSION: z.string().default('dev'),
  APP_VARIANT: z.string().default('stable'),
  APP_COLOR: z.string().default('#ffcc00'),
  COMMIT_SHA: z.string().default('unknown'),
  BUILD_DATE: z.string().default('unknown'),
  SCORE_SERVICE_URL: z.string().url().optional(),
  USER_SERVICE_URL: z.string().url().optional(),
  CONFIG_SERVICE_URL: z.string().url().optional(),
  TOPOLOGY_SERVICE_URL: z.string().url().optional(),

  // Lab-only demo controls. Fault/incident actions require both
  // DEMO_SECURITY_MODE=true and the configured token header.
  DEMO_SECURITY_MODE: boolish.default(false),
  DEMO_TOKEN_HEADER: z.string().default('x-demo-token'),
  DEMO_TOKEN: z.string().default('pacman-demo'),

  // Mongo
  MONGO_SERVICE_HOST: z.string().default('localhost'),
  MONGO_NAMESPACE_SERVICE_HOST: z.string().optional(),
  MY_MONGO_PORT: z.coerce.number().int().positive().default(27017),
  MONGO_DATABASE: z.string().default('pacman'),
  MONGO_AUTH_USER: z.string().optional(),
  MONGO_AUTH_PWD: z.string().optional(),
  MONGO_REPLICA_SET: z.string().optional(),
  MONGO_USE_SSL: boolish.default(false),
  MONGO_VALIDATE_SSL: boolish.default(true),

  // Postgres
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().default('pacman'),
  POSTGRES_USER: z.string().default('pacman'),
  POSTGRES_PASSWORD: z.string().default('pacman'),
  POSTGRES_SSL: boolish.default(false),

  // Gameplay
  // MAX_LEVEL caps how far Pac-Man can progress. Accepts a positive integer
  // or the string "unlimited" to disable the cap entirely. The same value is
  // surfaced to the client via GET /config and enforced on POST /highscores.
  MAX_LEVEL: z
    .union([z.string(), z.number()])
    .default(10)
    .transform((v, ctx) => {
      if (typeof v === 'string' && v.trim().toLowerCase() === 'unlimited') {
        return 'unlimited';
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MAX_LEVEL must be a positive integer or "unlimited"' });
        return z.NEVER;
      }
      return n;
    }),

  // When true (default) the in-game Settings page can override MAX_LEVEL
  // locally via localStorage and POST /config returns 200. When false the
  // server advertises a locked config: the client UI disables the form and
  // POST /config returns 403. The server's MAX_LEVEL is still authoritative
  // for highscore validation either way.
  ALLOW_CLIENT_CONFIG_OVERRIDE: boolish.default(true),

  // eBee mode is a visual theme: Pac-Man becomes eBee, ghosts become
  // flowers, pills become Cilium logos, and lives become Kubernetes icons.
  // EBEE_MODE is the server default. When ALLOW_CLIENT_EBEE_MODE_OVERRIDE
  // is false, that server value is enforced and the Settings checkbox is
  // read-only. When true, the browser may store a local override.
  EBEE_MODE: boolish.default(false),
  ALLOW_CLIENT_EBEE_MODE_OVERRIDE: boolish.default(true),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const config = parsed.data;
export default config;
