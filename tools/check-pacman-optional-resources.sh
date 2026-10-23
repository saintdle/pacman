#!/usr/bin/env bash
set -euo pipefail

chart_dir="${1:-charts/pacman}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

helm template defaults "$chart_dir" >"$tmp_dir/defaults.yaml"
for kind in ServiceMonitor CiliumNetworkPolicy TracingPolicyNamespaced; do
  if yq -e "select(.kind == \"$kind\")" "$tmp_dir/defaults.yaml" >/dev/null 2>&1; then
    echo "optional resource $kind appeared in the default render" >&2
    exit 1
  fi
done

cat >"$tmp_dir/values.yaml" <<'YAML'
roles:
  enabled: true
simulator:
  enabled: true
  securityProbes:
    enabled: true
    seed: 8
    durationSeconds: 60
    operations:
      - {operation: fileProbe, ratePerSecond: 1, maxCount: 2}
      - {operation: execProbe, ratePerSecond: 1, maxCount: 2}
demo:
  enabled: true
  existingTokenSecret: pacman-demo-token
  fileProbeEnabled: true
  execProbeEnabled: true
serviceMonitor:
  enabled: true
  interval: 15s
  labels:
    monitoring-stack: pacman-demo
ciliumNetworkPolicy:
  enabled: true
  denyScoreWrites: false
  monitoringNamespace: observability
tetragon:
  enabled: true
  fileProbeMode: observe
  execProbeMode: observe
YAML
helm template observe "$chart_dir" -n pacman-demo -f "$tmp_dir/values.yaml" >"$tmp_dir/observe.yaml"

yq -e 'select(.kind == "ServiceMonitor") | .metadata.labels["monitoring-stack"] == "pacman-demo" and .spec.namespaceSelector.matchNames[0] == "pacman-demo" and .spec.endpoints[0].port == "http" and .spec.endpoints[0].path == "/metrics" and .spec.endpoints[0].interval == "15s"' "$tmp_dir/observe.yaml" >/dev/null
yq -e 'select(.kind == "CiliumNetworkPolicy") | .metadata.namespace == "pacman-demo" and .spec.endpointSelector.matchLabels["app.kubernetes.io/name"] == "pacman-score" and .spec.endpointSelector.matchLabels["app.kubernetes.io/instance"] == "observe" and .spec.endpointSelector.matchLabels["app.kubernetes.io/component"] == "score"' "$tmp_dir/observe.yaml" >/dev/null
yq -e 'select(.kind == "CiliumNetworkPolicy") | .spec.ingress[0].fromEndpoints[0].matchLabels["app.kubernetes.io/name"] == "pacman-frontend" and .spec.ingress[0].fromEndpoints[0].matchLabels["app.kubernetes.io/instance"] == "observe" and .spec.ingress[0].fromEndpoints[0].matchLabels["app.kubernetes.io/component"] == "frontend"' "$tmp_dir/observe.yaml" >/dev/null
yq -e 'select(.kind == "CiliumNetworkPolicy") | .spec.ingress[0].toPorts[0].rules.http[0].method == "GET" and .spec.ingress[0].toPorts[0].rules.http[0].path == "^/internal/score/read(\\?.*)?$" and .spec.ingress[0].toPorts[0].rules.http[1].method == "POST" and .spec.ingress[0].toPorts[0].rules.http[1].path == "^/internal/score/write$"' "$tmp_dir/observe.yaml" >/dev/null
yq -e 'select(.kind == "CiliumNetworkPolicy") | .spec.ingress[1].fromEntities[0] == "host" and .spec.ingress[1].toPorts[0].rules.http[0].path == "^/healthz$" and .spec.ingress[1].toPorts[0].rules.http[1].path == "^/readyz$"' "$tmp_dir/observe.yaml" >/dev/null
yq -e 'select(.kind == "CiliumNetworkPolicy") | .spec.ingress[2].fromEndpoints[0].matchLabels["k8s:io.kubernetes.pod.namespace"] == "observability" and .spec.ingress[2].toPorts[0].rules.http[0].path == "^/metrics$"' "$tmp_dir/observe.yaml" >/dev/null

yq -e 'select(.kind == "TracingPolicyNamespaced" and .metadata.name == "observe-pacman-file-probe") | .metadata.namespace == "pacman-demo" and .spec.podSelector.matchLabels["app.kubernetes.io/name"] == "pacman-frontend" and .spec.podSelector.matchLabels["app.kubernetes.io/instance"] == "observe" and .spec.podSelector.matchLabels["app.kubernetes.io/component"] == "frontend" and .spec.kprobes[0].call == "sys_openat" and .spec.kprobes[0].syscall == true and .spec.kprobes[0].args[1].index == 1 and .spec.kprobes[0].args[1].type == "string" and .spec.kprobes[0].selectors[0].matchArgs[0].operator == "Equal" and .spec.kprobes[0].selectors[0].matchArgs[0].values[0] == "/app/demo-fixtures/synthetic-secret.txt" and .spec.kprobes[0].selectors[0].matchActions[0].action == "Post"' "$tmp_dir/observe.yaml" >/dev/null
yq -e 'select(.kind == "TracingPolicyNamespaced" and .metadata.name == "observe-pacman-exec-probe") | .spec.podSelector.matchLabels["app.kubernetes.io/name"] == "pacman-frontend" and .spec.podSelector.matchLabels["app.kubernetes.io/instance"] == "observe" and .spec.podSelector.matchLabels["app.kubernetes.io/component"] == "frontend" and .spec.kprobes[0].call == "sys_execve" and .spec.kprobes[0].syscall == true and .spec.kprobes[0].args[0].index == 0 and .spec.kprobes[0].args[0].type == "string" and .spec.kprobes[0].selectors[0].matchArgs[0].operator == "Equal" and .spec.kprobes[0].selectors[0].matchArgs[0].values[0] == "/app/tools/demo-exec-probe.js" and .spec.kprobes[0].selectors[0].matchActions[0].action == "Post"' "$tmp_dir/observe.yaml" >/dev/null

helm template enforce "$chart_dir" -n pacman-demo -f "$tmp_dir/values.yaml" \
  --set ciliumNetworkPolicy.denyScoreWrites=true \
  --set tetragon.fileProbeMode=enforce \
  --set tetragon.execProbeMode=enforce >"$tmp_dir/enforce.yaml"
if yq -e 'select(.kind == "CiliumNetworkPolicy") | .spec.ingress[0].toPorts[0].rules.http[] | select(.method == "POST" and .path == "/internal/score/write")' "$tmp_dir/enforce.yaml" >/dev/null 2>&1; then
  echo "denyScoreWrites render still allows score POST" >&2
  exit 1
fi
yq -e 'select(.kind == "CiliumNetworkPolicy") | .spec.ingress[0].toPorts[0].rules.http[0].method == "GET" and .spec.ingress[0].toPorts[0].rules.http[0].path == "^/internal/score/read(\\?.*)?$"' "$tmp_dir/enforce.yaml" >/dev/null
yq -e 'select(.kind == "TracingPolicyNamespaced" and .metadata.name == "enforce-pacman-file-probe") | .spec.kprobes[0].selectors[0].matchActions[0].action == "Override" and .spec.kprobes[0].selectors[0].matchActions[0].argError == -13' "$tmp_dir/enforce.yaml" >/dev/null
yq -e 'select(.kind == "TracingPolicyNamespaced" and .metadata.name == "enforce-pacman-exec-probe") | .spec.kprobes[0].selectors[0].matchActions[0].action == "Sigkill"' "$tmp_dir/enforce.yaml" >/dev/null
if ! helm template invalid "$chart_dir" -n pacman-demo -f "$tmp_dir/values.yaml" --set tetragon.enabled=false --set tetragon.fileProbeMode=enforce >"$tmp_dir/invalid.yaml" 2>&1; then
  :
else
  echo "enforce mode without enabled Tetragon was accepted" >&2
  exit 1
fi

helm template file-only "$chart_dir" -n pacman-demo -f "$tmp_dir/values.yaml" \
  --set demo.execProbeEnabled=false \
  --set-json 'simulator.securityProbes.operations=[{"operation":"fileProbe","ratePerSecond":1,"maxCount":1}]' >"$tmp_dir/file-only.yaml"
yq -e 'select(.kind == "TracingPolicyNamespaced" and .metadata.name == "file-only-pacman-file-probe")' "$tmp_dir/file-only.yaml" >/dev/null
if yq -e 'select(.kind == "TracingPolicyNamespaced" and .metadata.name == "file-only-pacman-exec-probe")' "$tmp_dir/file-only.yaml" >/dev/null 2>&1; then
  echo "disabled exec probe still rendered a Tetragon policy" >&2
  exit 1
fi
helm template exec-only "$chart_dir" -n pacman-demo -f "$tmp_dir/values.yaml" \
  --set demo.fileProbeEnabled=false \
  --set-json 'simulator.securityProbes.operations=[{"operation":"execProbe","ratePerSecond":1,"maxCount":1}]' >"$tmp_dir/exec-only.yaml"
yq -e 'select(.kind == "TracingPolicyNamespaced" and .metadata.name == "exec-only-pacman-exec-probe")' "$tmp_dir/exec-only.yaml" >/dev/null
if yq -e 'select(.kind == "TracingPolicyNamespaced" and .metadata.name == "exec-only-pacman-file-probe")' "$tmp_dir/exec-only.yaml" >/dev/null 2>&1; then
  echo "disabled file probe still rendered a Tetragon policy" >&2
  exit 1
fi
if grep -Eq 'matchBinaries:|/nodejs/bin/node|/usr/bin/node' "$tmp_dir/enforce.yaml"; then
  echo "Tetragon policy used a binary match instead of the fixed helper path" >&2
  exit 1
fi

# Check support against the official pinned namespaced CRD without applying it.
crd_url="https://raw.githubusercontent.com/cilium/tetragon/v1.7.1/pkg/k8s/apis/cilium.io/client/crds/v1alpha1/cilium.io_tracingpoliciesnamespaced.yaml"
curl -fsSL --retry 1 "$crd_url" -o "$tmp_dir/tetragon-crd.yaml"
yq -e '.spec.scope == "Namespaced" and .spec.names.kind == "TracingPolicyNamespaced" and .spec.names.plural == "tracingpoliciesnamespaced"' "$tmp_dir/tetragon-crd.yaml" >/dev/null
crd_spec='.spec.versions[] | select(.name == "v1alpha1") | .schema.openAPIV3Schema.properties.spec.properties'
yq -e "$crd_spec.podSelector.properties.matchLabels.type == \"object\"" "$tmp_dir/tetragon-crd.yaml" >/dev/null
yq -e "$crd_spec.kprobes.items.properties.syscall.type == \"boolean\"" "$tmp_dir/tetragon-crd.yaml" >/dev/null
yq -r "$crd_spec.kprobes.items.properties.args.items.properties.type.enum[]" "$tmp_dir/tetragon-crd.yaml" | grep -x string >/dev/null
yq -r "$crd_spec.kprobes.items.properties.selectors.items.properties.matchArgs.items.properties.operator.enum[]" "$tmp_dir/tetragon-crd.yaml" | grep -x Equal >/dev/null
yq -r "$crd_spec.kprobes.items.properties.selectors.items.properties.matchActions.items.properties.action.enum[]" "$tmp_dir/tetragon-crd.yaml" >"$tmp_dir/actions.txt"
grep -x Post "$tmp_dir/actions.txt" >/dev/null
grep -x Override "$tmp_dir/actions.txt" >/dev/null
grep -x Sigkill "$tmp_dir/actions.txt" >/dev/null
yq -e "$crd_spec.kprobes.items.properties.selectors.items.properties.matchActions.items.properties.argError.type == \"integer\"" "$tmp_dir/tetragon-crd.yaml" >/dev/null

echo "Optional ServiceMonitor, Cilium L7, Tetragon render, and v1.7.1 CRD checks passed"
