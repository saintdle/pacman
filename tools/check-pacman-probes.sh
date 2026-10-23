#!/usr/bin/env bash

set -euo pipefail

chart_dir="${1:-charts/pacman}"
default_render="$(mktemp)"
custom_render="$(mktemp)"
disabled_render="$(mktemp)"
trap 'rm -f "$default_render" "$custom_render" "$disabled_render"' EXIT

assert_equals() {
  local expected="$1"
  local actual="$2"
  local description="$3"

  if [[ "$actual" != "$expected" ]]; then
    printf 'Probe assertion failed: %s (expected %s, got %s)\n' \
      "$description" "$expected" "$actual" >&2
    exit 1
  fi
}

container_value() {
  local render_file="$1"
  local workload="$2"
  local field="$3"

  yq -r "select(.kind == \"Deployment\" and .metadata.name == \"$workload\") | .spec.template.spec.containers[0].$field" \
    "$render_file"
}

deployment_value() {
  local render_file="$1"
  local workload="$2"
  local field="$3"

  yq -r "select(.kind == \"Deployment\" and .metadata.name == \"$workload\") | .spec.$field" \
    "$render_file"
}

probe_enabled() {
  local render_file="$1"
  local workload="$2"
  local probe="$3"

  yq -r "select(.kind == \"Deployment\" and .metadata.name == \"$workload\") | .spec.template.spec.containers[0] | has(\"$probe\")" \
    "$render_file"
}

helm template pacman "$chart_dir" --namespace pacman-demo \
  --set roles.enabled=true \
  --set simulator.enabled=true \
  --set roles.score.replicas=2 > "$default_render"

for workload in pacman pacman-score pacman-user; do
  assert_equals /healthz "$(container_value "$default_render" "$workload" 'livenessProbe.httpGet.path')" \
    "$workload liveness path"
  assert_equals 5 "$(container_value "$default_render" "$workload" 'livenessProbe.timeoutSeconds')" \
    "$workload liveness timeout"
  assert_equals 6 "$(container_value "$default_render" "$workload" 'livenessProbe.failureThreshold')" \
    "$workload liveness failure threshold"
  assert_equals /readyz "$(container_value "$default_render" "$workload" 'readinessProbe.httpGet.path')" \
    "$workload readiness path"
  assert_equals 5 "$(container_value "$default_render" "$workload" 'readinessProbe.timeoutSeconds')" \
    "$workload readiness timeout"
done

assert_equals 2 "$(deployment_value "$default_render" pacman-score replicas)" \
  'score replica override'

helm template pacman "$chart_dir" --namespace pacman-demo \
  --set probes.liveness.timeoutSeconds=9 \
  --set probes.liveness.failureThreshold=8 \
  --set probes.readiness.periodSeconds=7 > "$custom_render"
assert_equals 9 "$(container_value "$custom_render" pacman 'livenessProbe.timeoutSeconds')" \
  'custom liveness timeout'
assert_equals 8 "$(container_value "$custom_render" pacman 'livenessProbe.failureThreshold')" \
  'custom liveness failure threshold'
assert_equals 7 "$(container_value "$custom_render" pacman 'readinessProbe.periodSeconds')" \
  'custom readiness period'

helm template pacman "$chart_dir" --namespace pacman-demo \
  --set probes.liveness.enabled=null \
  --set probes.liveness.timeoutSeconds=9 > "$custom_render"
assert_equals 9 "$(container_value "$custom_render" pacman 'livenessProbe.timeoutSeconds')" \
  'custom liveness without enabled flag'

helm template pacman "$chart_dir" --namespace pacman-demo \
  --set probes.liveness.enabled=false \
  --set probes.readiness.enabled=false > "$disabled_render"
assert_equals false "$(probe_enabled "$disabled_render" pacman livenessProbe)" \
  'disabled liveness probe'
assert_equals false "$(probe_enabled "$disabled_render" pacman readinessProbe)" \
  'disabled readiness probe'

printf 'Pac-Man application probe checks passed.\n'