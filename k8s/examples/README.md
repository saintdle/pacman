# Kubernetes Examples

This directory contains raw Kubernetes manifests and Kustomize examples for
learning and testing Pac-Man integrations. The generic multi-role example and
the PostgreSQL example are smoke-tested in a disposable Kind cluster by the
Pac-Man repository CI.

The Cilium, Prometheus, and Tetragon examples are optional controller-specific
resources. CI validates their Kubernetes shape, but does not apply them to the
plain Kind cluster because their CRDs and controllers are not installed there.

## Helm chart

The supported packaged deployment is the
[Pac-Man Helm chart](https://github.com/saintdle/helm-charts/tree/main/charts/pacman),
published at `https://saintdle.github.io/helm-charts`. Use the chart for normal
installations, database configuration, persistence, ingress, OpenShift
support, and production-style defaults.

The files [`helm-values.yaml`](helm-values.yaml) and
[`values-openshift.yaml`](values-openshift.yaml) are Helm values fragments,
which you pass to Helm with `--values`. The OpenShift fragment targets the
published chart. The demo fragment uses the typed `demo` values in chart
`0.7.17`; the published chart's pinned app image is `0.7.16` and already
contains the opt-in fault and synthetic security-probe runtime. The fragment
does not replace either default. Set `image.repository` and `image.tag` only
when testing a separately built app image.

The demo values reference an existing `pacman-demo-token` Secret with a `token`
key in the release namespace. Before you install the published chart, create
the namespace and Secret:

```bash
kubectl create namespace pacman-demo --dry-run=client -o yaml | kubectl apply -f -
read -r -s -p 'Demo token: ' DEMO_TOKEN
printf '\n'
printf '%s' "$DEMO_TOKEN" | kubectl create secret generic pacman-demo-token \
  --namespace pacman-demo --from-file=token=/dev/stdin
unset DEMO_TOKEN
```

Set `demo.existingTokenSecret` to the Secret name. The chart resolves
`DEMO_TOKEN` from its `token` key through a rendered `secretKeyRef`. Keep the
token value in the Secret.

Install the released chart and values fragment with the stable public
repository. The chart and app versions are independent, so pin each when you
need to reproduce this published pair:

```bash
helm repo add saintdle https://saintdle.github.io/helm-charts --force-update
helm repo update saintdle
helm upgrade --install pacman saintdle/pacman --version 0.7.17 \
  --namespace pacman-demo --create-namespace \
  --values k8s/examples/helm-values.yaml
```

For the published chart's complete, versioned values schema, use:

```sh
helm repo add saintdle https://saintdle.github.io/helm-charts
helm repo update saintdle
helm show values saintdle/pacman --version 0.7.17
```

The raw manifests remain useful when demonstrating individual Kubernetes,
Cilium, Prometheus, or Tetragon concepts without installing the full chart.

## Example ownership and intentional differences

`charts/pacman` is the editable packaged deployment. Chart-source promotion
generates the Pac-Man image pins in [`multi-role-deployment.yaml`](multi-role-deployment.yaml)
and [`postgres-example.yaml`](postgres-example.yaml) from that chart's app image
repository and digest; those files remain raw teaching examples, not alternate
chart sources.

| Example | Purpose and intentional difference | Conformance |
| --- | --- | --- |
| `multi-role-deployment.yaml` | Raw migration and role-splitting lesson. It keeps the web, score, and user Services, ConfigMap, probes, and Mongo service names visible instead of using the chart's all-in-one default. | Promotion regenerates all three app image refs; the Kubernetes examples workflow applies this manifest. |
| `postgres-example.yaml` | PostgreSQL teaching scenario with its own migration Job, Secret, PVC, and Postgres Service. It intentionally differs from the chart's Mongo-backed default. | Promotion regenerates the two Pac-Man app image refs; Postgres images and lifecycle resources remain scenario-owned. |
| `helm-values.yaml`, `values-openshift.yaml`, patches, and optional controller resources | Input fragments or focused Cilium, Prometheus, and Tetragon teaching examples, not alternate generic deployments. | Existing chart contracts and Kubernetes example checks validate their applicable schemas and behavior. |

The multi-role web Deployment enables `READINESS_CHECK_UPSTREAMS`, so its
`/readyz` probe checks configured backends as well as the local database. This
can remove the web pod from service while a backend is unavailable. The check
is off by default elsewhere; `/readyz/details` always reports web-role upstream
probes, and `/healthz` remains a liveness check without a database probe.
