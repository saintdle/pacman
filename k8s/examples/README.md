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
[`values-openshift.yaml`](values-openshift.yaml) are values fragments for that
external chart. They are not Kubernetes manifests and must not be passed to
`kubectl apply`. For the complete, versioned values schema, use:

```sh
helm repo add saintdle https://saintdle.github.io/helm-charts
helm repo update
helm show values saintdle/pacman
```

The raw manifests remain useful when demonstrating individual Kubernetes,
Cilium, Prometheus, or Tetragon concepts without installing the full chart.