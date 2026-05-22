# pacman

A Node.js / HTML5 canvas implementation of Pac-Man, originally by
[platzh1rsch](https://github.com/platzhersh/pacman-canvas) and modified by
[Ivan Font](https://github.com/font). This fork modernizes the server to Node
22 + Express 5, adds a pluggable database layer (in-memory, MongoDB, or
PostgreSQL), and ships unit tests, integration tests, and a Docker Compose
stack for local development.

> **Migrating from the previous version?** See [`MIGRATION.md`](MIGRATION.md)
> for the full list of changes (breaking and otherwise).

## Quickstart

Requires Node.js **22+**.

```bash
nvm use            # picks up .nvmrc
npm install
npm run dev        # in-memory DB, no extra services needed
```

Open <http://localhost:8080> to play. High scores live for the lifetime of the
process when `DB_TYPE=memory` (the default).

## Running with a real database

Use the Docker Compose stack and pick a profile:

```bash
# MongoDB
DB_TYPE=mongo docker compose --profile mongo up --build

# PostgreSQL (a one-shot migration job runs first to create the schema)
DB_TYPE=postgres docker compose --profile postgres up --build
```

The app is exposed on <http://localhost:8080>.

To run the app process locally against a database container, point env vars at
it and start the app outside Docker:

```bash
export DB_TYPE=postgres POSTGRES_HOST=localhost
npm run db:migrate
npm start
```

See [`.env.example`](.env.example) for the full set of variables.

## HTTP API

| Method | Path                 | Description                                                   |
|--------|----------------------|---------------------------------------------------------------|
| GET    | `/healthz`           | Liveness (no DB)                                              |
| GET    | `/readyz`            | Readiness (DB healthcheck)                                    |
| GET    | `/readyz/details`    | Readiness plus DB, upstream deps, and config details          |
| GET    | `/version`           | Role, version, variant, commit, database, dependency map      |
| GET    | `/metrics`           | Prometheus text metrics (requests, DB ops, upstream latency)  |
| GET    | `/config`            | Client-visible config (`maxLevel`, eBee mode, override flags) |
| GET    | `/config/schema`     | Client-visible config fields and env mappings                 |
| POST   | `/config`            | Validate/authorise a client config override                   |
| GET    | `/highscores/list`   | Top 10 high scores                                            |
| POST   | `/highscores`        | Submit a high score (validated, see below)                    |
| GET    | `/user/id`           | Create a new user id (UUID v4)                                |
| POST   | `/user/stats`        | Update live stats for a user id                               |
| GET    | `/user/stats`        | List all live stats                                           |
| GET    | `/location/metadata` | Detect cloud / zone / host                                    |

#### Internal (policy-friendly) endpoints

These mirror the public API with distinct path prefixes for Cilium L7
network policy targeting:

| Method | Path                    | Description                        |
|--------|-------------------------|------------------------------------|
| GET    | `/internal/score/read`  | List top scores (same as above)    |
| POST   | `/internal/score/write` | Submit a score (same as above)     |
| GET    | `/internal/user/session`| Create a new user id               |
| GET    | `/internal/user/stats`  | List all user stats                |
| POST   | `/internal/user/stats`  | Update stats for a user id         |
| GET    | `/internal/config/read` | Read server config                 |

Cloud detection probes (in order): Kubernetes node API, AWS, Azure, GCP,
OpenStack. In Kubernetes, the `zone` field prefers topology-aware routing
details from Service annotations or EndpointSlice hints when available, then
falls back to the node zone label. All probes have short timeouts; failure
falls through to `{cloud: "unknown", zone: "unknown"}`.

### `POST /highscores` validation

The server rejects implausible submissions before they reach the database.
The form fields are `name`, `cloud`, `zone`, `host`, `score`, `level`
(`application/x-www-form-urlencoded`). Validation rules:

| Rule                                              | Response                                          |
|---------------------------------------------------|---------------------------------------------------|
| `score` missing or not a number                   | `400 {"error":"score must be a number"}`          |
| `level` outside `[1, MAX_LEVEL]`                  | `400 {"error":"invalid level"}`                   |
| `score / level > 2840` (max attainable per level) | `400 {"error":"score is implausible for level"}`  |
| Otherwise                                         | `200 {"rs":"success", ...}`                       |

The cap `2840 = 104 * 10 + 4 * 50 + 4 * 4 * 100` is the maximum points one
level can yield (104 pills + 4 power pills + four ghosts eaten four times
during beast mode). It is enforced **both** client-side (in
`public/pacman-canvas.js` `Game.validateScoreWithLevel()`) and server-side
so a tampered browser cannot poison the leaderboard.

Examples:

```bash
# rejected: score impossible for level 1
curl -i -X POST localhost:8080/highscores \
  -d 'name=CHEATER&score=999999&level=1'
# HTTP/1.1 400 Bad Request
# {"error":"score is implausible for level"}

# rejected: level out of range
curl -i -X POST localhost:8080/highscores \
  -d 'name=CHEATER&score=100&level=99'
# HTTP/1.1 400 Bad Request
# {"error":"invalid level"}

# accepted: at the per-level ceiling
curl -i -X POST localhost:8080/highscores \
  -d 'name=OK&score=2840&level=1'
# HTTP/1.1 200 OK
# {"name":"OK","zone":"...","score":2840,"level":1,"rs":"success"}
```

This is intentionally a small, predictable signature so it can be used as
an example of layered input validation in Kubernetes demos. Pair it with,
for example, a Cilium L7 `CiliumNetworkPolicy` that allows `POST
/highscores` only from the game pods, a Tetragon `TracingPolicy` watching
for unexpected exec/file activity in the app container, or an OPA/Kyverno
admission policy on the Deployment. The 400 path is hot enough to be
visible in Hubble flows and pod logs without generating a real attack.

### Configurable max level

The maximum level is configurable via the `MAX_LEVEL` environment variable
(positive integer, or the string `unlimited`, default `10`). It is enforced
on `POST /highscores` and surfaced to the client via `GET /config`:

```bash
MAX_LEVEL=20 npm run dev          # cap at level 20
MAX_LEVEL=unlimited npm run dev   # no cap (legacy upstream behaviour)
```

In Kubernetes set it as an env var or via a ConfigMap key on the Deployment.

The in-game **Settings** menu lets players override the cap locally
(stored in `localStorage`). The override only changes how far the client
will let you progress; the server still validates submissions against
its own `MAX_LEVEL`, so picking `unlimited` on the client against a
server capped at `10` will succeed up to level 10 and then start
returning `400 invalid level`. That deliberate mismatch is a useful
demo of trusting the server, not the client, for authoritative limits.

### Locking client-side overrides

By default the Settings page is editable. Set
`ALLOW_CLIENT_CONFIG_OVERRIDE=false` to lock it:

```bash
ALLOW_CLIENT_CONFIG_OVERRIDE=false MAX_LEVEL=10 npm run dev
```

When locked:

- `GET /config` returns `{"maxLevel":10,"allowClientOverride":false}`.
- `POST /config` returns `403 {"error":"client gameplay config overrides are disabled on this server"}`.
- The Settings page shows a notice (*"This server does not allow client config changes."*) and the maximum-level controls are disabled.
- Any stale override previously saved in `localStorage` is ignored at runtime, so the client always matches the server cap.

This is useful for hosted demos and Instruqt-style labs where you want
all players to see the same level cap, and it also makes a clean
illustration of a server-authoritative config flag pattern.

### eBee mode

eBee mode is a visual theme that keeps the maze, collisions, scoring, and
server validation unchanged. When enabled:

- Pac-Man is drawn as an 8-bit eBee inspired by the Isovalent eBeeDex.
- eBee's wings flap in place of Pac-Man's mouth animation.
- Ghosts are drawn as chunky 8-bit flowers.
- Flowers turn blue during power-pill mode, preserving the original
  frightened-state signal.
- Regular pills stay as small white circles; power pills are drawn as
  Cilium logos.
- Life icons are drawn as Kubernetes logos.

The server default is controlled with `EBEE_MODE`:

```bash
EBEE_MODE=true npm run dev
```

By default players can override that theme locally from the Settings page,
with the preference stored in `localStorage` as `pacman.ebeeMode`. To hard
set eBee mode at the server level, disable the client override:

```bash
EBEE_MODE=true ALLOW_CLIENT_EBEE_MODE_OVERRIDE=false npm run dev
```

When locked, `GET /config` advertises
`{"ebeeMode":true,"allowEbeeModeOverride":false}`, `POST /config` returns
`403` for attempted eBee-mode changes, and the Settings checkbox is shown
read-only.

### Kubernetes config examples

Example ConfigMap and patch files live under [`k8s/examples`](k8s/examples):

- [`configmap.yaml`](k8s/examples/configmap.yaml) sets `MAX_LEVEL`,
  `ALLOW_CLIENT_CONFIG_OVERRIDE`, `EBEE_MODE`,
  `ALLOW_CLIENT_EBEE_MODE_OVERRIDE`, `APP_VERSION`, `APP_VARIANT`,
  `APP_COLOR`, and `DEMO_SECURITY_MODE`.
- [`deployment-env-patch.yaml`](k8s/examples/deployment-env-patch.yaml)
  wires those values into a Deployment via `envFrom`.
- [`multi-role-deployment.yaml`](k8s/examples/multi-role-deployment.yaml)
  deploys `pacman-web`, `pacman-score`, and `pacman-user` as separate
  Deployments and Services, with the web role forwarding east-west
  traffic to the score and user backends.
- [`cilium-l7-policy.yaml`](k8s/examples/cilium-l7-policy.yaml) applies
  Cilium L7 `CiliumNetworkPolicy` rules that restrict which HTTP methods
  and paths each role can reach, including browser static assets and
  `/internal/*` policy-friendly service paths.
- [`prometheus-servicemonitor.yaml`](k8s/examples/prometheus-servicemonitor.yaml)
  creates a Prometheus `ServiceMonitor` to scrape the `/metrics`
  endpoint on all Pac-Man roles.
- [`tetragon-tracingpolicy.yaml`](k8s/examples/tetragon-tracingpolicy.yaml)
  adds Tetragon `TracingPolicy` resources for file-access and
  process-exec tracing, triggered by the demo incident probe endpoints.
- [`kustomization.yaml`](k8s/examples/kustomization.yaml) applies the base
  ConfigMap and multi-role Deployment without requiring optional CRDs.
- [`overlays/cilium`](k8s/examples/overlays/cilium),
  [`overlays/prometheus`](k8s/examples/overlays/prometheus), and
  [`overlays/tetragon`](k8s/examples/overlays/tetragon) apply optional
  CRD-backed resources only when those controllers are installed.
- [`helm-values.yaml`](k8s/examples/helm-values.yaml) shows a Helm-style
  values mapping for charts with an `extraEnv` pattern.
- [`ebee-mode-rollout-patch.yaml`](k8s/examples/ebee-mode-rollout-patch.yaml)
  flips eBee mode on and bumps a pod-template annotation to force a rollout.

### Cilium demo runtime hooks

The app can run as separate Kubernetes roles from one image for Cilium demos:

```bash
APP_ROLE=web|score|user|config|topology|incident|grpc
```

When `SCORE_SERVICE_URL` or `USER_SERVICE_URL` is set on the `web` role, the
browser-facing routes stay the same, but the web pod forwards score and user
traffic to those internal Services through `/internal/*` paths. This creates
real east-west traffic for Hubble and CiliumNetworkPolicy demos while
preserving local in-process behavior when the URLs are unset.

`GET /version` returns visible canary metadata from `APP_VERSION`,
`APP_VARIANT`, `APP_COLOR`, `COMMIT_SHA`, and `BUILD_DATE`. The same metadata is
also included in `GET /config` so the Settings panel can show which backend
variant handled the request.

Lab-only fault and incident hooks are double gated. They require both:

```bash
DEMO_SECURITY_MODE=true
DEMO_TOKEN_HEADER=x-demo-token
DEMO_TOKEN=pacman-demo
```

With the correct token header, demos can inject controlled HTTP delay/status
responses using `x-demo-fault-delay-ms` and `x-demo-fault-status`, record a
structured incident with `POST /demo/incidents`, or trigger safe Tetragon probes
with `POST /demo/incidents/file-probe` and `POST /demo/incidents/exec-probe`.
With demo mode disabled, those incident actions return `403` and normal gameplay
is unaffected.

### Synthetic user simulator

The app image includes a dependency-free simulator that creates realistic
frontend-style sessions. It fetches the browser shell, reads `/config` and
`/location`, creates user IDs, posts user stats during simulated gameplay,
refreshes highscores, and occasionally submits plausible scores.

Run it against a local or port-forwarded app:

```bash
PACMAN_BASE_URL=http://127.0.0.1:8080 USERS=25 DURATION_SECONDS=300 npm run simulate:users
```

Useful knobs:

```bash
USERS=100
DURATION_SECONDS=0
MIN_THINK_MS=750
MAX_THINK_MS=3500
MIN_SESSION_SECONDS=45
MAX_SESSION_SECONDS=180
SCORE_SUBMIT_RATE=0.08
HIGH_SCORE_READ_RATE=0.35
REQUEST_TIMEOUT_MS=4000
```

`DURATION_SECONDS=0` runs continuously, which is useful when the simulator is
deployed in Kubernetes while you scale, roll, fault, or policy-restrict the app.

## Tests

```bash
npm test                                  # unit + route tests (memory adapter)
RUN_ADAPTER_TESTS=1 npm run test:adapters # mongo + postgres via testcontainers
npm run lint
```

The `canMoveTo` wall-rules helper in `src/client/movement.js` is unit-tested
in `test/movement.test.js` and pins the wall/teleport bug fixes documented in
[`MIGRATION.md`](MIGRATION.md#frontend).

## Project layout

```text
src/
  app.js              Express 5 app factory
  server.js           Boots adapter + http server, graceful shutdown
  config/index.js     dotenv + zod validation
  logger.js           pino logger
  metrics.js          Lightweight Prometheus metrics (no deps)
  db/
    adapter.js        DatabaseAdapter interface
    index.js          Factory: DB_TYPE -> adapter
    memory.js         In-memory adapter (default; powers tests and dev)
    mongo.js          MongoDB adapter (driver v6)
    postgres.js       PostgreSQL adapter (pg)
    migrate.js        Forward-only migration runner (postgres)
    migrations/postgres/0001_init.sql
  routes/
    health.js         /healthz, /readyz (with upstream dep probes)
    highscores.js     /highscores
    user.js           /user/id, /user/stats
    location.js       /location/metadata
    metrics.js        /metrics (Prometheus text format)
    internal.js       /internal/* policy-friendly endpoints
  client/
    movement.js       Pure wall/wrap helpers (used by tests)
public/               Static game assets (served as-is)
views/                Pug error template
test/                 Tests
k8s/examples/         Kubernetes, Cilium, Tetragon, and Prometheus manifests
docker/Dockerfile     Multi-stage, node:22-alpine, non-root, HEALTHCHECK
docker-compose.yml    memory / mongo / postgres profiles
```

## Deployment to Kubernetes

There are two deployment surfaces:

- **In-repo learning examples** at [`k8s/examples/`](k8s/examples/). A small,
  self-contained set of manifests (multi-role `Deployment`s, a `ConfigMap`,
  Cilium L7 example, a PostgreSQL example with a migration `Job`, optional
  Prometheus and Tetragon overlays) suitable for reading, hacking on locally,
  and trying out Cilium/Hubble/Tetragon flows.
- **Extended deployment build-out** at
  [`saintdle/pacman-for-k8s`](https://github.com/saintdle/pacman-for-k8s).
  A richer surface that layers in persistent storage, Pod Security Standards,
  install/uninstall scripts, and a catalogue of Cilium demos (east-west,
  cluster mesh, canary, fault injection, Tetragon enforcement, gRPCRoute,
  topology-aware routing, runtime security). Use this when you want a
  production-leaning reference rather than a minimal example.

Both surfaces target the same `docker.io/saintdle/pacman` image built from
this repository.

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).
