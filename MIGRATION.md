# Migration notes

This migration moves the server to Node.js 22 and Express 5 and adds PostgreSQL
support through a pluggable database adapter. Most public HTTP routes keep the
same methods and response shapes; the breaking changes are listed below.

## Runtime / dependencies

- Minimum Node.js: **22 LTS** (CI runs on Node 22).
- `express` 4 → **5**; `body-parser` removed (now built into Express).
- `jade` (renamed to Pug years ago) → **`pug`**. The error template moved to
  `views/error.pug`. The game itself is still served from `public/index.html`.
- `mongodb` driver 2.x → **6.x** (modern Promise API, no callbacks).
- Added `pg` (node-postgres), `pino` / `pino-http`, `zod`, `dotenv`.
- Removed `nodemon`; use `node --watch` via `npm run dev`.

## New environment variables

| Variable           | Default       | Notes                                      |
|--------------------|---------------|--------------------------------------------|
| `DB_TYPE`          | `memory`      | `memory` \| `mongo` \| `postgres`          |
| `LOG_LEVEL`        | `info`        | pino levels (`debug`, `info`, etc.)        |
| `POSTGRES_HOST`    | `localhost`   | Postgres adapter only                      |
| `POSTGRES_PORT`    | `5432`        |                                            |
| `POSTGRES_DB`      | `pacman`      |                                            |
| `POSTGRES_USER`    | `pacman`      |                                            |
| `POSTGRES_PASSWORD`| `pacman`      |                                            |
| `POSTGRES_SSL`     | `false`       | `true` enables TLS with certificate validation |
| `POSTGRES_SSL_CA`  | unset         | Optional PEM CA bundle for PostgreSQL TLS |
| `POSTGRES_SSL_REJECT_UNAUTHORIZED` | `true` | Allow disabling PostgreSQL certificate verification only for demos |
| `POSTGRES_POOL_MAX` | `10`          | Maximum PostgreSQL connections |
| `POSTGRES_CONNECTION_TIMEOUT_MS` | `5000` | Connection timeout |
| `POSTGRES_IDLE_TIMEOUT_MS` | `30000` | Idle connection timeout |
| `POSTGRES_STATEMENT_TIMEOUT_MS` | `10000` | Server-side statement timeout |
| `POSTGRES_QUERY_TIMEOUT_MS` | `15000` | Client-side query timeout |

Existing `MONGO_*` variables are preserved. See `.env.example` for the full list.

## HTTP API: what changed

The route table, methods, and core response shapes are unchanged:

- `GET /highscores/list`: list of `{name, cloud, zone, host, score}`
- `POST /highscores`: `{name, zone, score, level, rs}`
- `GET /user/id`: bare string id (JSON-encoded)
- `POST /user/stats`: `{rs: 'success'|'error'}`
- `GET /user/stats`: list of `{cloud, zone, host, score, level, lives, et, txncount}`
- `GET /location/metadata`: `{cloud, zone, host}`

New endpoints for K8s probes:

- `GET /healthz` → `200 {status: 'ok'}` (liveness, no DB)
- `GET /readyz` → `200` when the DB adapter `healthcheck()` passes; on the web
  role it can also check configured upstreams when
  `READINESS_CHECK_UPSTREAMS=true` (default `false`)
- `GET /readyz/details` → readiness with database and configured upstream details;
  web-role upstream probes always run here

Upstream readiness probes run in parallel with a 750 ms timeout and a one-hop
marker to avoid probe cycles. The multi-role Kubernetes web example enables
them; enabling the setting can make the web pod unready when a backend is
unavailable. `/healthz` remains a liveness check without a database probe.
`TRUST_PROXY` defaults to `false`; configure a non-negative hop count or a
comma-separated proxy IP, CIDR, or named range (`loopback`, `linklocal`,
`uniquelocal`) to match the actual ingress. Forwarded headers from direct
external clients are not trusted by default.

Behavioural changes worth noting:

- **`GET /user/id`** returns the ID format used by the configured adapter:
  Mongo returns an `ObjectId` string; memory and PostgreSQL return UUID v4
  strings. The JSON shape remains a bare string. `POST /user/stats` accepts
  both legacy ObjectId hex and UUID strings with the Mongo adapter.
- **Request validation**: HTTP score routes reject missing, nonnumeric,
  fractional, negative, or unsafe scores, and reject missing, nonnumeric,
  fractional, unsafe, or out-of-range levels. Invalid score and level values
  return `400` with `score must be a non-negative safe integer` or
  `invalid level`. gRPC `SubmitScore` applies the same checks to decoded values
  and returns `INVALID_ARGUMENT`; internal failures return a sanitized
  `INTERNAL` error. In the gRPC wire format, an absent score decodes to zero
  and is accepted with a valid level, while an absent level decodes to zero
  and is rejected. Fractions and unsafe integers cannot be transmitted as such
  as `int32` values. `POST /user/stats` also returns `400` if `userId` is
  missing. Older versions could silently insert partial documents.
- **Error responses** use the Pug error template (was Jade).

## Database storage

### Mongo
Collection names and documents are unchanged (`highscore`, `userstats`). Existing
production data is read/written as before. New writes set `date` as an ISO 8601
string (was the output of `Date()`).

### Postgres
Two new tables created by `npm run db:migrate` (or the `postgres-migrate`
service in `docker-compose.yml`):

```sql
highscores(id uuid pk, name, cloud, zone, host, score, level,
           created_at, referer, user_agent, hostname, ip_addr)
user_stats(id uuid pk, cloud, zone, host, score, level, lives,
           elapsed_time, created_at, referer, user_agent, hostname,
           ip_addr, update_counter)
```

Migrations are tracked in `schema_migrations`.

## Frontend

The game remains in `public/pacman-canvas.js` and uses jQuery and Hammer. Changes
include:

- **Wall/teleport bug fixes** in `public/pacman-canvas.js`:
  1. Operator-precedence bug in the wall-collision unstick code:
     `posX % 2*radius` → `posX % (2*radius)`. Same for Y.
  2. `if (y <= -1) x = ...` assigned to the wrong variable. Now correctly
     assigns to `y`.
  3. Typo `game.heigth` → `game.height`. The downward-wrap branch never
     fired before; combined with bug 2 this is the most likely root cause
     of Pac-Man teleporting across the middle of the board.
  Pure rules extracted to `src/client/movement.js` with unit tests in
  `test/movement.test.js` so this stays fixed.
- **Upstream fixes ported from `platzhersh/pacman-canvas`** (this fork
  branched pre-1.0.0; upstream is at 1.0.6):
  - **PR #57** (Oct 2023, post-1.0.6): use `this.speed` instead of the
    hardcoded number `5` in the pill-collision and wall-unstick blocks so
    the game still works if Pac-Man's speed is ever changed.
  - **v1.0.2 + v1.0.5**: add an end-game transition (`Game.endGame()`,
    `Game.showHighscoreForm()`) and a client-side `Game.validateScoreWithLevel()`
    plausibility check. The client uses `FINAL_LEVEL = 10` until it loads the
    server setting. The check caps scores at
    `104*10 + 4*50 + 4*4*100 = 2840` points per level. Both the
    `pacman.dieFinal` lose-path and the `nextLevel` win-path use this transition.
  - HTTP score routes and gRPC `SubmitScore` apply the same `2840` plausibility
    cap and validate score and level values. `MAX_LEVEL` defaults to `10`, can
    be set to another positive integer, or to `unlimited`. The cap is a
    plausibility check and does not prove that a score is authentic.

- Deprecated AppCache (`cache.manifest`) reference removed from
  `public/index.html`; the file itself is deleted.

The browser loads the shared movement helper from `public/js/movement.js`
synchronously; the Node wrapper re-exports that helper. Movement wraps at the
maze edges, lands on grid-aligned positions, and uses breadth-first maze
distances for ghost routing while retaining target modes, house behavior,
scoring, and themes. Regenerate all six normal and eBee instruction screenshots
from the current maze and sprite rules with
`node tools/generate-instruction-screenshots.js`.

## File layout

Old → new:

| Old                     | New                                       |
|-------------------------|-------------------------------------------|
| `app.js`                | `src/app.js` (app factory, ESM)           |
| `bin/server.js`         | `src/server.js` (graceful shutdown)       |
| `lib/database.js`       | `src/db/{adapter,memory,mongo,postgres,index}.js` |
| `lib/config.js`         | `src/config/index.js` (zod-validated env) |
| `routes/*.js`           | `src/routes/*.js`                         |
| `views/*.jade`          | `views/*.pug`                             |
| `docker/dev/*`          | removed (use `docker compose`)            |

## Local development

```bash
nvm use                       # Node 22
npm install
cp .env.example .env          # optional
npm run dev                   # in-memory DB, no extra services

# or with a real database
DB_TYPE=postgres docker compose --profile postgres up --build
DB_TYPE=mongo docker compose --profile mongo up --build
```

Run tests:

```bash
npm test                                  # unit + route tests (memory adapter)
RUN_ADAPTER_TESTS=1 npm run test:adapters # spins up mongo + postgres via testcontainers
```

## Deferred work

- Modularize the frontend with esbuild and remove jQuery.
- TypeScript migration.
