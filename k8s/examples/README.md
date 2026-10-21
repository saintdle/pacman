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
published chart. The demo fragment uses typed `demo` values from the matching
candidate chart and app image. Published chart and pinned image defaults remain
unchanged. Set `image.repository` and `image.tag` to the app image from that
candidate build.

The demo values reference an existing `pacman-demo-token` Secret with a `token`
key in the release namespace. Before you install the candidate chart, create
the namespace and Secret:

```bash
kubectl create namespace pacman-demo --dry-run=client -o yaml | kubectl apply -f -
read -r -s -p 'Demo token: ' DEMO_TOKEN
printf '\n'
printf '%s' "$DEMO_TOKEN" | kubectl create secret generic pacman-demo-token \
  --namespace pacman-demo --from-file=token=/dev/stdin
unset DEMO_TOKEN
```

Set `demo.existingTokenSecret` to the Secret name. The candidate chart resolves
`DEMO_TOKEN` from its `token` key through a rendered `secretKeyRef`. Keep the
token value in the Secret.

For the published chart's complete, versioned values schema, use:

```sh
helm repo add saintdle https://saintdle.github.io/helm-charts
helm repo update
helm show values saintdle/pacman
```

The raw manifests remain useful when demonstrating individual Kubernetes,
Cilium, Prometheus, or Tetragon concepts without installing the full chart.

The multi-role web Deployment enables `READINESS_CHECK_UPSTREAMS`, so its
`/readyz` probe checks configured backends as well as the local database. This
can remove the web pod from service while a backend is unavailable. The check
is off by default elsewhere; `/readyz/details` always reports web-role upstream
probes, and `/healthz` remains a liveness check without a database probe.
