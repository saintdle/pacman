# pacman

A Node.js / HTML5 canvas implementation of Pac-Man, originally by
[platzh1rsch](https://github.com/platzhersh/pacman-canvas) and modified by
[Ivan Font](https://github.com/font). This fork runs on Node.js 22 and Express
5. It supports in-memory, MongoDB, and PostgreSQL databases, with unit and
integration tests and a Docker Compose stack for local development.

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

## Releases

Merging a pull request into `main` runs the release workflow. Unless the pull
request changes the `version` field in `package.json`, the workflow increments
the highest published Pac-Man release by one patch version. For example, a
published `0.7.5` becomes `0.7.6` automatically.

To request a minor or major release, change both `package.json` and
`package-lock.json` in the pull request, for example from `0.7.5` to `0.8.0`.
The reviewed `package.json` version is the release override. The workflow
rejects an out-of-order version, an unsynchronised lockfile, or a reused release
tag.

Each release publishes one `linux/amd64` and `linux/arm64` manifest list under
the version tag and moves `latest` to that same manifest list. The image is
stamped with the release version, source commit, and build timestamp. Releases
also publish SBOM and provenance attestations and run an advisory Trivy scan
for high and critical vulnerabilities with available fixes. When findings are
present, the workflow opens a GitHub issue with affected packages, versions,
severities, and advisory links.

Pull requests build the image locally and run the same Trivy scan before
merge. The scan reports HIGH and CRITICAL findings with available fixes. Its
step continues when it finds vulnerabilities, so findings alone do not fail
the job. Same-repository pull requests also upload SARIF results for
review in GitHub code scanning. This check does not push the image to Docker
Hub.

GitHub Actions workflows pin actions to commit SHAs. Dependabot checks npm
packages and GitHub Actions weekly. Separate checks run CodeQL source analysis
and `npm audit --audit-level=high` against the complete lockfile; the dependency
audit fails on known high or critical vulnerabilities.

## Running with a real database

Use the Docker Compose stack and pick a profile:

```bash
# MongoDB
DB_TYPE=mongo docker compose --profile mongo up --build

# PostgreSQL (a one-shot migration job runs first to create the schema)
DB_TYPE=postgres docker compose --profile postgres up --build
```

The app is exposed on <http://localhost:8080>.

To run the app outside Docker against a database container, set connection
variables and start it locally:

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
| GET    | `/readyz`            | Readiness (DB healthcheck; optional upstream checks)          |
| GET    | `/readyz/details`    | Readiness plus DB, upstream deps, and config details          |
| GET    | `/version`           | Role, version, variant, commit, database, dependency map      |
| GET    | `/metrics`           | Prometheus text metrics (requests, DB ops, upstream latency)  |
| GET    | `/config`            | Client-visible config (`maxLevel`, eBee mode, override flags) |
| GET    | `/config/schema`     | Client-visible config fields and env mappings                 |
| POST   | `/config`            | Validate/authorise a client config override                   |
| GET    | `/highscores/list`   | High scores; accepts `page`, `pageSize`, and `includeSimulated` |
| POST   | `/highscores`        | Submit a high score (validated, see below)                    |
| GET    | `/user/id`           | Create ID (UUID on memory/Postgres; Mongo ObjectId); accepts `name` |
| POST   | `/user/stats`        | Update live stats for a user id                               |
| GET    | `/user/stats`        | Active live stats; accepts `page`, `pageSize`, and `includeSimulated` |
| GET    | `/location/metadata` | Detect cloud / zone / host                                    |

### Internal (policy-friendly) endpoints

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

### Proxy and readiness settings

`TRUST_PROXY` defaults to `false`, so forwarded client-address headers are not
trusted. Set it only to match the real ingress: use a non-negative hop count or
a comma-separated list of proxy IPs, CIDRs, or named ranges (`loopback`,
`linklocal`, `uniquelocal`). Named ranges are normalized case-insensitively.
Direct external requests that supply forwarding headers are not trusted by the
default setting.

`READINESS_CHECK_UPSTREAMS` defaults to `false`. When enabled on the web role,
`/readyz` checks configured upstream services' `/readyz` endpoints in parallel,
with a 750 ms timeout per request and a one-hop probe marker to prevent cycles.
The multi-role Kubernetes example enables this option. Upstream-aware readiness
can remove a web pod from service while a backend is unavailable; leave it off
when readiness should reflect only the local database. `/readyz/details` always
includes web-role upstream probes. `/healthz` remains a liveness check and does
not check the database.

### `POST /highscores` validation

The HTTP route accepts JSON and form-encoded bodies. Submit `name`, `cloud`,
`zone`, `host`, `score`, and `level`. The validation rules below apply to
`POST /highscores` and the internal HTTP score-write route:

| Rule                                                     | Response                                                 |
|----------------------------------------------------------|----------------------------------------------------------|
| Missing, nonnumeric, fractional, negative, or unsafe `score` | `400 {"error":"score must be a non-negative safe integer"}` |
| Missing, nonnumeric, fractional, unsafe, or out-of-range `level` | `400 {"error":"invalid level"}` |
| `score / level > 2840`                                    | `400 {"error":"score is implausible for level"}`       |
| Otherwise                                                 | `200 {"rs":"success", ...}`                            |

`MAX_LEVEL` defaults to `10`; set it to a positive integer for another cap or
to `unlimited` for no upper bound. The per-level score cap is
`2840 = 104 * 10 + 4 * 50 + 4 * 4 * 100`: 104 pills, four power pills, and four
ghosts eaten four times during beast mode.

The browser checks this cap before showing the high-score form. Both HTTP score
routes and gRPC `SubmitScore` validate decoded scores and levels, including the
integer, non-negative, safe-score, and configured level-range requirements.
gRPC returns `INVALID_ARGUMENT` for invalid submissions and sanitizes internal
errors. Its wire format uses `int32`: an absent score decodes to zero and is
accepted with a valid level, while an absent level decodes to zero and is
rejected. Fractions and unsafe integers cannot be sent as such in that wire
format. Treat the cap as a plausibility check; it does not prove that a score
is authentic.

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

Use the level-1 request to show HTTP validation in Kubernetes. In the Cilium
example, Hubble can show its `400` response. Related controls include:

- A Cilium L7 `CiliumNetworkPolicy` that restricts `POST /highscores` to game pods.
- A Tetragon `TracingPolicy` that watches process or file activity.
- An OPA/Kyverno admission policy for the Deployment.

### Configurable max level

The maximum level comes from the `MAX_LEVEL` environment variable. It defaults
to `10`; set it to a positive integer for another cap or to `unlimited` for no
upper bound. The server enforces this setting on `POST /highscores` and shares
it with the client through `GET /config`:

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

- `GET /config` includes `{"maxLevel":10,"allowClientOverride":false}`.
- `POST /config` returns `403 {"error":"client gameplay config overrides are disabled on this server"}`.
- The Settings page shows a notice (*"This server does not allow client config changes."*) and the maximum-level controls are disabled.
- The Settings page ignores any saved local override while locked, so the client uses the server cap.

Use this setting in hosted demos or labs that require every player to share the
server's level cap.

### eBee mode

eBee mode changes the visuals and the client-side ghost contact range. It keeps
the maze layout, scoring, and server validation unchanged. Ghost contact uses
a 15-pixel range instead of Pac-Man mode's 10-pixel range. The theme also:

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

When locked, `GET /config` includes
`{"ebeeMode":true,"allowEbeeModeOverride":false}`, `POST /config` returns
`403` for attempted eBee-mode changes, and the Settings checkbox is shown
read-only.

The browser loads `public/js/movement.js` synchronously. To regenerate the six
instruction screenshots (normal and eBee themes), run
`node tools/generate-instruction-screenshots.js`; the command uses the current
maze and sprite rules.

### Kubernetes config examples

Example ConfigMap and patch files live under [`k8s/examples`](k8s/examples):

- [`configmap.yaml`](k8s/examples/configmap.yaml) sets `MAX_LEVEL`,
  `ALLOW_CLIENT_CONFIG_OVERRIDE`, `EBEE_MODE`,
  `ALLOW_CLIENT_EBEE_MODE_OVERRIDE`, `APP_VARIANT`, `APP_COLOR`, and
  `DEMO_SECURITY_MODE`. `APP_VERSION` is intentionally omitted so the value
  stamped into the image by the release workflow remains authoritative.
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
- [`helm-values.yaml`](k8s/examples/helm-values.yaml) contains demo values for
  a matching candidate chart and app image. The published defaults remain
  unchanged. See [`k8s/examples/README.md`](k8s/examples/README.md) for Secret
  setup and candidate install guidance. Pass this fragment to Helm with
  `--values`.
- [`values-openshift.yaml`](k8s/examples/values-openshift.yaml) documents the
  OpenShift override values for that chart (`openShift.enabled` and
  `openShift.sccRoleBinding.create`). The complete chart values schema lives in
  the [`helm-charts` repository](https://github.com/saintdle/helm-charts).
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

Lab-only fault and incident hooks are disabled by default. They require both
`DEMO_SECURITY_MODE=true` and a nonempty `DEMO_TOKEN`; the token has no default.
The configured header defaults to `x-demo-token`:

```bash
DEMO_SECURITY_MODE=true
DEMO_TOKEN_HEADER=x-demo-token
DEMO_TOKEN=<value-from-a-secret>
```

In Kubernetes, provide the token through a Secret. The file and exec probes
also have separate `DEMO_FILE_PROBE_ENABLED` and `DEMO_EXEC_PROBE_ENABLED`
switches, both false by default, even when demo mode is enabled.

Send the token header with a request to authorize lab actions. Fault requests
also specify `x-demo-fault-role` (`web`, `score`, or `user`) and
`x-demo-fault-operation` (`scoreRead`, `scoreWrite`, `userRead`, `userWrite`, or
`pageView`). Optional `x-demo-fault-delay-ms` is bounded from 0 to 10,000 ms.
`x-demo-fault-status` accepts values from 500 to 599. A fault applies only when
both its role and logical operation match the receiving app. The web role can
be selected for any listed operation. The score backend handles score
operations, and the user backend handles user operations. On a proxied request,
web forwards only the authenticated token and allowlisted fault headers. The
selected logical request consumes the fault once. Health, readiness, config,
metrics, and demo endpoints are exempt from fault selection. Forwarded
client-address headers are not trusted by default (`TRUST_PROXY=false`). The
app does not follow backend redirects, so it cannot send the token to a redirect
destination.

The authorized incident endpoints are `POST /demo/incidents`,
`POST /demo/incidents/file-probe`, and `POST /demo/incidents/exec-probe`. The
security probes use only the fixed synthetic file
`/app/demo-fixtures/synthetic-secret.txt` and the fixed helper
`/app/tools/demo-exec-probe.js`; callers cannot provide arbitrary paths,
commands, or URLs. Demo controls return `403` without authorization, and
gameplay is unaffected when controls are disabled.

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
    health.js         /healthz, /readyz, /readyz/details (upstream probes)
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
docker/Dockerfile     Multi-stage, Node 22 on Debian 13, distroless non-root, HEALTHCHECK
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

### OpenShift

The container image is built to run under an arbitrary, non-root UID, so it is
compatible with OpenShift's `restricted-v2` SCC. The
[Helm chart](https://github.com/saintdle/helm-charts/tree/main/charts/pacman)
auto-detects OpenShift and drops the fixed `runAsUser`/`runAsGroup`/`fsGroup`
from every pod so the SCC can inject a namespace-allocated UID; no configuration
is required. See [`k8s/examples/values-openshift.yaml`](k8s/examples/values-openshift.yaml)
for the available overrides. When applying the raw manifests instead, remove the
fixed IDs from any pod `securityContext` (keep `runAsNonRoot`) as noted in
[`postgres-example.yaml`](k8s/examples/postgres-example.yaml).

## License

GPL-3.0-or-later. See [`LICENSE`](LICENSE).
