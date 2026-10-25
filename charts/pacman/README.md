# pacman

Pac-Man on Kubernetes, hardened to the Pod Security Standards `restricted`
profile, with a choice of MongoDB or PostgreSQL backend.

App image: [`docker.io/saintdle/pacman`](https://hub.docker.com/r/saintdle/pacman)
(pinned by digest by default).
Source: [`saintdle/pacman`](https://github.com/saintdle/pacman),
deployment surface: [`saintdle/pacman-for-k8s`](https://github.com/saintdle/pacman-for-k8s).

## TL;DR

```bash
helm repo add veducate https://saintdle.github.io/helm-charts/
helm repo update
helm install pacman veducate/pacman \
  --namespace pacman-demo --create-namespace
```

## Switch backend to PostgreSQL

```bash
helm install pacman veducate/pacman \
  --namespace pacman-demo --create-namespace \
  --set database=postgres
```

When you select PostgreSQL, Helm runs the migration Job as a `post-install` and
`post-upgrade` hook. Before the initial hook starts, Helm creates the
PostgreSQL Service with the release. The Job waits until PostgreSQL accepts
connections.

After Helm applies the release resources, it runs the `post-upgrade` hook. Helm
deletes successful hook Jobs. Before the next run, Helm deletes any previous
Job. Kubernetes cleans up failed Jobs after their 10-minute TTL.

## Common overrides

| Key                                | Description                                       | Default                  |
|------------------------------------|---------------------------------------------------|--------------------------|
| `database`                         | `mongo` or `postgres`                             | `mongo`                  |
| `image.repository`                 | Pac-Man image repo                                | `docker.io/saintdle/pacman` |
| `image.tag`                        | Tag override (set to skip the digest)             | `""`                     |
| `image.digest`                     | Image digest (used when `tag` is empty)           | pinned released digest  |
| `replicaCount`                     | Pac-Man pods                                      | `1`                      |
| `service.type`                     | `LoadBalancer`, `NodePort`, `ClusterIP`           | `LoadBalancer`           |
| `service.port`                     | Service port                                      | `80`                     |
| `ingress.enabled`                  | Enable an Ingress                                 | `false`                  |
| `autoscaling.enabled`              | Enable HPA                                        | `false`                  |
| `rbac.create`                      | ClusterRole+CRB for in-app pod/node probe         | `true`                   |
| `serviceAccount.create`            | Dedicated SA for pacman                           | `true`                   |
| `probes.liveness`                  | Lightweight application liveness probe            | `/healthz`, 5s timeout   |
| `probes.readiness`                 | Dependency-aware application readiness probe      | `/readyz`, 5s timeout    |
| `mongo.auth.*`                     | Mongo credentials (root + app user)               | demo values              |
| `mongo.persistence.size`           | Mongo PVC size                                    | `1Gi`                    |
| `mongo.existingSecret`             | Use a pre-created Secret instead                  | `""`                     |
| `mongo.livenessProbe` / `mongo.readinessProbe` | Mongo health probes; `mongosh` needs a generous `timeoutSeconds` | `10s` timeout |
| `postgres.auth.*`                  | Postgres credentials                              | demo values              |
| `postgres.migration.enabled`       | Runs migrations                                | `true`                   |

The complete list is in [`values.yaml`](values.yaml).

Application liveness uses `/healthz`, which only checks that the Node.js
process can serve HTTP and does not query the database or other services.
Readiness uses `/readyz`, which checks the configured database before admitting
traffic. Both probes are configurable under `probes`; set either probe's
`enabled` field to `false` to omit it when a deployment needs to provide its
own health policy. The default liveness timeout is five seconds with a failure
threshold of six, so short periods of event-loop contention do not cause kubelet
restarts.

## Multi-role (scaled-out) deployment

By default the chart deploys a single all-in-one frontend. Set `roles.enabled=true`
to split it into cooperating **web**, **score**, and **user** roles, each its own
Deployment and Service, so east-west API traffic flows between separate services
(useful for Cilium/Hubble L7 flow demos). The same image runs every role; the
`APP_ROLE` env var selects the behaviour, and the web role is wired to the
backends automatically via `SCORE_SERVICE_URL`/`USER_SERVICE_URL`.

```bash
helm install pacman infra-charts/pacman --set roles.enabled=true
```

An optional load generator (`node tools/simulate-users.js`) drives gameplay
traffic through the frontend Service:

```bash
helm install pacman infra-charts/pacman \
  --set roles.enabled=true \
  --set simulator.enabled=true
```

| Key                        | Description                                    | Default |
|----------------------------|------------------------------------------------|---------|
| `roles.enabled`            | Deploy web/score/user as separate tiers        | `false` |
| `roles.score.replicas`     | Score backend replicas                         | `1`     |
| `roles.user.replicas`      | User backend replicas                          | `1`     |
| `roles.<role>.resources`   | Per-role resources (falls back to `resources`) | `{}`    |
| `simulator.enabled`        | Run the load generator Deployment              | `false` |
| `simulator.replicas`       | Load generator replicas                        | `1`     |
| `simulator.users`          | Concurrent simulated users per replica         | `20`    |
| `simulator.baseUrl`        | Target URL (defaults to the frontend Service)  | `""`    |

Every role reuses the same database backend (`database`), pod securityContext,
and OpenShift handling as the frontend, so no extra wiring is required.

## Fault and security-probe demos

Chart `0.7.17` defaults to app image `0.7.16`, which already includes the
opt-in fault and synthetic security-probe runtime. These controls remain off by
default, so the published pair can use the demos without an image override.

Build and load a custom app image only when testing unpublished app/runtime
changes. From the root of the matching Pac-Man app source checkout, build that
candidate.
The revision label records the source commit used for the build:

```bash
docker build -f docker/Dockerfile \
  --tag docker.io/library/pacman:fault-demo-local \
  --build-arg APP_VERSION=fault-demo-local \
  --build-arg COMMIT_SHA="$(git rev-parse HEAD)" \
  --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  .
```

Load that image into the kind cluster. In the root of your helm-charts source
checkout, create `local-fault-demo.yaml` with the image overrides below and the
demo settings shown later in this section. Create the nonempty token Secret
described below before running the Helm upgrade:

```bash
kind load docker-image docker.io/library/pacman:fault-demo-local --name my-cluster
helm upgrade --install pacman ./charts/pacman \
  --namespace pacman-demo --create-namespace \
  --values local-fault-demo.yaml
```

```yaml
image:
  repository: docker.io/library/pacman
  tag: fault-demo-local
  digest: ""
  pullPolicy: Never
```

This local candidate workflow does not publish an image or change the chart's
version or default image digest.

Fault injection and synthetic security probes are opt-in. The defaults for
`demo.enabled`, `simulator.faults.enabled`, `simulator.securityProbes.enabled`,
`demo.fileProbeEnabled`, and `demo.execProbeEnabled` are all `false`. To enable
them, create a Secret with a nonempty `token` key and set
`demo.existingTokenSecret` to its name. The chart does not render the token
value into manifests:

```bash
kubectl -n pacman-demo create secret generic pacman-demo-token \
  --from-literal=token="$DEMO_TOKEN"
```

Use `demo.tokenHeader` to change the default `x-demo-token` request header.
Incident endpoints require demo mode and the matching token. Each synthetic
probe must also be enabled with its corresponding `demo.fileProbeEnabled` or
`demo.execProbeEnabled` value.

The simulator accepts typed schedules under `simulator.faults` and
`simulator.securityProbes`; both are disabled with empty rule/operation lists by
default. For example, this schedule injects a 503 on 10% of score reads at the
score backend and adds a bounded delay on 20% of them. It enables a file probe
schedule as well; the matching app probe switch must also be enabled:

```yaml
demo:
  enabled: true
  existingTokenSecret: pacman-demo-token
  fileProbeEnabled: true
simulator:
  enabled: true
  faults:
    enabled: true
    seed: 42
    durationSeconds: 300
    rules:
      - operations: [scoreRead]
        targetRole: score
        errorRate: 0.1
        errorStatus: 503
        delayRate: 0.2
        delayMs:
          min: 500
          max: 1500
  securityProbes:
    enabled: true
    seed: 42
    durationSeconds: 300
    operations:
      - operation: fileProbe
        ratePerSecond: 0.2
        maxCount: 10
```

Fault operations are `scoreRead`, `scoreWrite`, `userRead`, `userWrite`, and
`pageView`; `targetRole` is `web`, `score`, or `user`. These are independent
dimensions: `web` can target any logical operation, while score and user
backends consume only their own operation families. A selected logical request
consumes its fault once. The simulator uses a deterministic per-worker random
stream from `seed`; durations, delay (0 to 10,000 ms), status (500 to 599),
rates, probe counts, and user concurrency are schema-validated and bounded. Probe
operations are `fileProbe` and `execProbe`, each with a `ratePerSecond` of at
most 10 and `maxCount` at most 1000. The simulator sends the token from the
Secret separately from the schedule JSON.

The chart rolls workloads when the demo settings, schedule JSON, or Secret
identity changes. Its checksum tracks the Secret namespace, name, and `token`
key identity, not the external Secret's token contents. After changing the
token value under the same Secret name, restart all web, score, user, and
simulator workloads together, or rotate to a new Secret name and upgrade the
chart.

Optional integrations remain separately controlled: `serviceMonitor.enabled`
creates a ServiceMonitor; `ciliumNetworkPolicy.enabled` creates the chart's
typed Cilium policy (with score-write denial controlled by
`ciliumNetworkPolicy.denyScoreWrites`); and `tetragon.enabled` creates the
file/exec tracing policies, with `tetragon.fileProbeMode` and
`tetragon.execProbeMode` set to `observe` or `enforce`. The Tetragon policies
match only the fixed synthetic file and helper under the selected Pac-Man pods.
Enforcement depends on kernel support for BPF kprobe override and a compatible
syscall path; a pathname check has a time-of-check/time-of-use limitation.
Preflight those requirements and verify actual actions and unrelated-workload
negative controls before relying on enforcement. Chart rendering or policy
presence alone does not demonstrate runtime enforcement.

The matching new app candidate uses explicit Node entrypoints and a nonroot
distroless runtime. It has no shell inside the image and does not launch
through npm or use wget/curl for health checks. The runtime supports arbitrary
nonroot UIDs; Docker tests and static OpenShift compatibility checks do not
establish that a cluster deployment has been tested on OpenShift.

## Upgrading to 0.7.13

This release makes the Pac-Man application probes configurable and increases
the default liveness timeout to five seconds with six consecutive failures
allowed. Existing installs will use the new defaults on upgrade; override
`probes.liveness` or `probes.readiness` when a deployment needs different
thresholds, or set `probes.<name>.enabled=false` to disable that probe.

## Workload labels

Every workload is given a distinct identity so observability tools such as
Hubble render them as separate services instead of collapsing every pod under
the chart name. Alongside the standard `app.kubernetes.io/*` labels, each object
carries a short `app` and `role` pair:

| Workload           | `app`             | `role`     |
|--------------------|-------------------|------------|
| Pac-Man            | `pacman-frontend` | `frontend` |
| Score role         | `pacman-score`    | `score`    |
| User role          | `pacman-user`     | `user`     |
| Load simulator     | `pacman-simulator`| `load-generator` |
| MongoDB            | `mongodb`         | `database` |
| PostgreSQL         | `postgres`        | `database` |
| Postgres migration | `pacman-migrate`  | `migrate`  |

`app.kubernetes.io/name` matches the `app` value, `app.kubernetes.io/component`
matches the `role` value, and every object shares
`app.kubernetes.io/part-of: pacman` so the whole release can still be selected
together.

## Pod Security Standards `restricted`

Every workload in this chart sets:

- `runAsNonRoot: true`, `runAsUser`, `runAsGroup`, `fsGroup`
- `seccompProfile.type: RuntimeDefault`
- `allowPrivilegeEscalation: false`
- `capabilities.drop: [ALL]`
- `readOnlyRootFilesystem: true` on the Pac-Man container

Apply the namespace labels yourself when you want enforcement to be hard:

```bash
kubectl label ns pacman-demo \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted \
  --overwrite
```

## OpenShift

OpenShift's `restricted-v2` SCC assigns each pod a random UID from the
namespace's pre-allocated range and rejects pods that request a fixed
`runAsUser`, `runAsGroup`, or `fsGroup` outside that range. The fixed IDs this
chart normally sets (Pac-Man and the databases) would otherwise fail admission.

The chart auto-detects OpenShift (it probes for the
`security.openshift.io/v1` API group) and, when detected, drops
`runAsUser`/`runAsGroup`/`fsGroup` from every pod so the SCC can inject its own.
`runAsNonRoot`, `seccompProfile`, dropped capabilities, and
`readOnlyRootFilesystem` are all preserved, so the workloads still satisfy the
`restricted-v2` SCC. No configuration is required:

```bash
helm install pacman infra-charts/pacman
```

Override the detection with `openShift.enabled`:

- `auto` (default) &mdash; probe the API server.
- `true` &mdash; force OpenShift behaviour (useful for `helm template`).
- `false` &mdash; never drop the fixed IDs.

If you would rather keep the chart's fixed UIDs, grant the workloads the
`nonroot-v2` SCC instead by creating a RoleBinding:

```bash
helm install pacman infra-charts/pacman \
  --set openShift.sccRoleBinding.create=true
```

This binds the Pac-Man ServiceAccount (and the namespace `default`
ServiceAccount used by MongoDB/PostgreSQL) to the
`system:openshift:scc:nonroot-v2` ClusterRole and leaves the fixed IDs in place.
Creating SCC RoleBindings requires cluster-admin.

## Existing secrets

Set `mongo.existingSecret` or `postgres.existingSecret` to use a pre-created
Secret. Expected keys:

- Mongo: `database-admin-name`, `database-admin-password`, `database-name`,
  `database-user`, `database-password`
- Postgres: `username`, `password`, `database`

## Upgrading to 0.7.0

0.7.0 gives each workload a distinct `app.kubernetes.io/name` (previously every
pod shared `pacman`). A Deployment's label selector is immutable, so an
in-place `helm upgrade` from an earlier version is rejected by the API server.
Uninstall and reinstall instead:

```bash
helm uninstall pacman --namespace pacman-demo
helm install pacman veducate/pacman --namespace pacman-demo
```

The Mongo and Postgres PVCs are retained across an uninstall, so high scores
survive the reinstall.

## Uninstall

```bash
helm uninstall pacman --namespace pacman-demo
# Mongo / Postgres PVCs are intentionally left behind so high scores survive
# a reinstall. Delete them explicitly to wipe the data:
kubectl -n pacman-demo delete pvc -l app.kubernetes.io/instance=pacman
```
