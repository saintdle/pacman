#!/usr/bin/env bash
set -euo pipefail

chart_dir="${1:-charts/pacman}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

helm template defaults "$chart_dir" >"$tmp_dir/defaults.yaml"
if grep -q 'name: DEMO_TOKEN$' "$tmp_dir/defaults.yaml"; then
  echo "default render unexpectedly injects a demo token" >&2
  exit 1
fi
grep -q 'value: "x-demo-token"' "$tmp_dir/defaults.yaml" || {
  echo "default demo token header was not rendered" >&2
  exit 1
}

# Cilium's HTTP path matcher receives the request path with its query string.
# Keep the score-read exception scoped to that endpoint while allowing the
# pagination and simulator-filter query options forwarded by the frontend.
helm template cnp "$chart_dir" --set roles.enabled=true --set ciliumNetworkPolicy.enabled=true >"$tmp_dir/cnp.yaml"
score_read_regex="$(sed -n 's/^[[:space:]]*path: //p' "$tmp_dir/cnp.yaml" | grep -F '/internal/score/read' | head -n 1)"
expected_score_read_regex='^/internal/score/read(\?.*)?$'
[[ "$score_read_regex" == "$expected_score_read_regex" ]] || {
  echo "score-read Cilium rule did not render the exact query-aware path regex: $score_read_regex" >&2
  exit 1
}
for request_path in \
  '/internal/score/read' \
  '/internal/score/read?page=2&pageSize=10&includeSimulated=false' \
  '/internal/score/read?includeSimulated=false'; do
  [[ "$request_path" =~ $score_read_regex ]] || {
    echo "score-read Cilium rule rejected a valid request path: $request_path" >&2
    exit 1
  }
done
for request_path in \
  '/internal/score/readiness' \
  '/internal/score/read/more' \
  '/internal/score/write'; do
  if [[ "$request_path" =~ $score_read_regex ]]; then
    echo "score-read Cilium rule matched an unrelated path: $request_path" >&2
    exit 1
  fi
done

if helm template invalid "$chart_dir" --set demo.unknownField=true >"$tmp_dir/invalid.yaml" 2>&1; then
  echo "schema accepted an unknown demo field" >&2
  exit 1
fi
if helm template invalid-token-header "$chart_dir" --set-string 'demo.tokenHeader=bad header' >"$tmp_dir/invalid.yaml" 2>&1; then
  echo "schema accepted an invalid HTTP header name" >&2
  exit 1
fi
grep -q 'demo.tokenHeader' "$tmp_dir/invalid.yaml" || {
  echo "invalid HTTP header name was rejected for an unexpected reason" >&2
  exit 1
}
if helm template invalid "$chart_dir" --set simulator.users=101 >"$tmp_dir/invalid.yaml" 2>&1; then
  echo "schema accepted simulator.users above the contract limit" >&2
  exit 1
fi
if helm template invalid "$chart_dir" --set demo.enabled=true >"$tmp_dir/invalid.yaml" 2>&1; then
  echo "demo.enabled without an existing token Secret was accepted" >&2
  exit 1
fi

cat >"$tmp_dir/valid.yaml" <<'YAML'
roles:
  enabled: true
simulator:
  enabled: true
  faults:
    enabled: true
    seed: 7
    durationSeconds: 60
    rules:
      - operations: [scoreWrite]
        targetRole: score
        errorRate: 0.2
        errorStatus: 503
        delayRate: 0.3
        delayMs: {min: 10, max: 500}
  securityProbes:
    enabled: true
    seed: 8
    durationSeconds: 60
    operations:
      - {operation: fileProbe, ratePerSecond: 1, maxCount: 2}
      - {operation: execProbe, ratePerSecond: 0.5, maxCount: 2}
demo:
  enabled: true
  existingTokenSecret: pacman-demo-token
  tokenHeader: X-Demo_Token.2
  fileProbeEnabled: true
  execProbeEnabled: true
YAML
helm template valid "$chart_dir" -f "$tmp_dir/valid.yaml" >"$tmp_dir/valid-render.yaml"
custom_header_count="$(grep -c 'value: "X-Demo_Token.2"' "$tmp_dir/valid-render.yaml" || true)"
[[ "$custom_header_count" -eq 4 ]] || {
  echo "custom HTTP header was not rendered across all four workloads; got $custom_header_count" >&2
  exit 1
}
grep -q 'command: \["node", "/app/tools/simulate-users.js"\]' "$tmp_dir/valid-render.yaml"
grep -q 'name: SIM_FAULTS_JSON' "$tmp_dir/valid-render.yaml"
grep -q 'name: SIM_SECURITY_PROBES_JSON' "$tmp_dir/valid-render.yaml"
grep -q 'key: token' "$tmp_dir/valid-render.yaml"
grep -q 'name: DEMO_SECURITY_MODE' "$tmp_dir/valid-render.yaml"
grep -q 'name: DEMO_FILE_PROBE_ENABLED' "$tmp_dir/valid-render.yaml"
grep -q 'name: DEMO_EXEC_PROBE_ENABLED' "$tmp_dir/valid-render.yaml"
grep -q 'scoreWrite' "$tmp_dir/valid-render.yaml"
grep -q 'fileProbe' "$tmp_dir/valid-render.yaml"
token_refs="$(grep -c 'name: DEMO_TOKEN$' "$tmp_dir/valid-render.yaml")"
[[ "$token_refs" -eq 4 ]] || { echo "expected token refs in frontend, score, user, and simulator; got $token_refs" >&2; exit 1; }

helm template null-annotations "$chart_dir" --set podAnnotations=null --set roles.enabled=true --set simulator.enabled=true >"$tmp_dir/null-annotations.yaml"
null_checksum_count="$(grep -c 'checksum/pacman-demo:' "$tmp_dir/null-annotations.yaml" || true)"
[[ "$null_checksum_count" -eq 4 ]] || { echo "null podAnnotations omitted a rollout checksum from one or more workloads" >&2; exit 1; }
for component in frontend score user load-generator; do
  grep -q "app.kubernetes.io/component: $component$" "$tmp_dir/null-annotations.yaml" || {
    echo "null podAnnotations render omitted the $component workload" >&2
    exit 1
  }
done

helm template custom-annotations "$chart_dir" --set-string podAnnotations.rollout-tag=retain --set roles.enabled=true --set simulator.enabled=true >"$tmp_dir/custom-annotations.yaml"
custom_annotation_count="$(grep -c 'rollout-tag: retain$' "$tmp_dir/custom-annotations.yaml" || true)"
[[ "$custom_annotation_count" -eq 4 ]] || { echo "custom podAnnotations were not retained across all four workloads" >&2; exit 1; }

checksum_for() {
  sed -n 's/^[[:space:]]*checksum\/pacman-demo: //p' "$1" | head -n 1
}
base_checksum="$(checksum_for "$tmp_dir/valid-render.yaml")"
helm template secret-change "$chart_dir" -f "$tmp_dir/valid.yaml" --set demo.existingTokenSecret=another-token-secret >"$tmp_dir/secret-change.yaml"
secret_checksum="$(checksum_for "$tmp_dir/secret-change.yaml")"
helm template config-change "$chart_dir" -f "$tmp_dir/valid.yaml" --set simulator.faults.seed=9 >"$tmp_dir/config-change.yaml"
config_checksum="$(checksum_for "$tmp_dir/config-change.yaml")"
[[ "$base_checksum" != "$secret_checksum" && "$base_checksum" != "$config_checksum" ]] || {
  echo "demo rollout checksum did not change with Secret identity and JSON config" >&2
  exit 1
}

if helm template invalid "$chart_dir" -f "$tmp_dir/valid.yaml" --set simulator.faults.rules[0].targetRole=user >"$tmp_dir/invalid.yaml" 2>&1; then
  echo "chart accepted an operation/role mismatch" >&2
  exit 1
fi
if helm template invalid "$chart_dir" -f "$tmp_dir/valid.yaml" --set roles.enabled=false >"$tmp_dir/invalid.yaml" 2>&1; then
  echo "chart accepted a backend fault target without backend role Deployments" >&2
  exit 1
fi
if helm template invalid "$chart_dir" -f "$tmp_dir/valid.yaml" --set simulator.faults.rules[0].delayMs.min=900 --set simulator.faults.rules[0].delayMs.max=10 >"$tmp_dir/invalid.yaml" 2>&1; then
  echo "chart accepted delayMs.min greater than max" >&2
  exit 1
fi

helm template openshift "$chart_dir" --set roles.enabled=true --set simulator.enabled=true --api-versions security.openshift.io/v1 >"$tmp_dir/openshift.yaml"
if grep -Eq '^[[:space:]]*(runAsUser|runAsGroup|fsGroup):' "$tmp_dir/openshift.yaml"; then
  echo "OpenShift render retained fixed pod IDs" >&2
  exit 1
fi

if grep -q 'wget' "$chart_dir/templates/NOTES.txt" || ! grep -q -- '-- node -e' "$chart_dir/templates/NOTES.txt"; then
  echo "installation notes must use the Node health check supported by the distroless image" >&2
  exit 1
fi

echo "Pac-Man fault-demo values, render, checksum, and OpenShift checks passed"
