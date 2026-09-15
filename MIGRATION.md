# Migration notes (modernization pass)

This release modernizes the Node.js / Express / MongoDB stack and adds first-class
PostgreSQL support behind a pluggable adapter. Most of the public HTTP surface
is unchanged so existing K8s manifests and clients keep working; the small
breaking changes are listed below.

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

- `GET /highscores/list` — list of `{name, cloud, zone, host, score}`
- `POST /highscores` — `{name, zone, score, level, rs}`
- `GET /user/id` — bare string id (JSON-encoded)
- `POST /user/stats` — `{rs: 'success'|'error'}`
- `GET /user/stats` — list of `{cloud, zone, host, score, level, lives, et, txncount}`
- `GET /location/metadata` — `{cloud, zone, host}`

New endpoints for K8s probes:

- `GET /healthz` → `200 {status: 'ok'}` (liveness, no DB)
- `GET /readyz` → `200` when the DB adapter `healthcheck()` passes, `503` otherwise

Behavioural changes worth noting:

- **`GET /user/id`** now returns a UUID v4 string instead of a Mongo `ObjectId`
  string. Same JSON shape (a bare string), but if clients parse it as a Mongo
  ObjectId they will need to stop doing that. `POST /user/stats` accepts both
  legacy ObjectId hex and the new UUID for the `userId` field when running
  against the Mongo adapter.
- **Request validation**: `POST /highscores` returns `400` if `score` is not a
  number; `POST /user/stats` returns `400` if `userId` is missing. Previously
  both silently inserted partial documents.
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

The game (`public/pacman-canvas.js`, jQuery + Hammer) is **not** rewritten in
this pass — risk/reward did not justify it. Specific changes:

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
  - **v1.0.2 + v1.0.5**: cap the game at `FINAL_LEVEL = 10` with a real
    end-game transition (`Game.endGame()`, `Game.showHighscoreForm()`) and
    a client-side `Game.validateScoreWithLevel()` anti-cheat check
    (max points per level = `104*10 + 4*50 + 4*4*100 = 2840`). The
    `pacman.dieFinal` lose-path and the `nextLevel` win-path both route
    through these now.
  - Server-side enforcement of the same rule in
    `src/routes/highscores.js`: `POST /highscores` returns `400` if
    `level` is outside `[1, 10]` or `score / level > 2840`.
  - Skipped: upstream dependabot bumps (different stack), PHP/SQLite
    SQL-injection fix (N/A), webpack/build-tooling commits (deferred).
- Deprecated AppCache (`cache.manifest`) reference removed from
  `public/index.html`; the file itself is deleted.

Deferred to a follow-up: splitting `pacman-canvas.js` into ES modules, an
esbuild bundle pipeline, and removing the jQuery dependency.

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
docker compose --profile postgres up --build
docker compose --profile mongo up --build
```

Run tests:

```bash
npm test                                  # unit + route tests (memory adapter)
RUN_ADAPTER_TESTS=1 npm run test:adapters # spins up mongo + postgres via testcontainers
```

## Deferred (next pass)

- Extend `pacman-for-k8s` further (Helm chart, Postgres `StatefulSet`, a
  `Job` for `db:migrate`). The lightweight `k8s/examples/` in this repo and
  the existing `pacman-for-k8s` Cilium demos already cover the common cases.
- Modular frontend (esbuild bundle) and jQuery removal.
- TypeScript migration.
