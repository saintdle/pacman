#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <migration-baseline-repository> <pinned-source-repository>" >&2
  exit 2
fi

baseline_repo="$1"
source_repo="$2"
baseline_sha="4cc1b880ca6ca7359869057a1f4e822d9fd00ed4"
source_sha="c24c5267340a58259cf3d7c8f337ace4c19d1d7a"
baseline_chart="$baseline_repo/charts/pacman"
source_chart="$source_repo/charts/pacman"
actual_baseline_sha="$(git -C "$baseline_repo" rev-parse HEAD)"
[[ "$actual_baseline_sha" == "$baseline_sha" ]] || {
  echo "migration baseline checkout must be $baseline_sha; got $actual_baseline_sha" >&2
  exit 1
}
actual_source_sha="$(git -C "$source_repo" rev-parse HEAD)"
[[ "$actual_source_sha" == "$source_sha" ]] || {
  echo "source chart checkout must be $source_sha; got $actual_source_sha" >&2
  exit 1
}

python3 - "$baseline_chart" "$source_chart" <<'PY'
import hashlib
import stat
import sys
from pathlib import Path

def snapshot(root):
    root = Path(root)
    return {
        path.relative_to(root).as_posix(): (
            stat.S_IMODE(path.stat().st_mode),
            hashlib.sha256(path.read_bytes()).hexdigest(),
        )
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }

baseline, source = map(snapshot, sys.argv[1:])
if baseline != source:
    missing = sorted(source.keys() - baseline.keys())
    extra = sorted(baseline.keys() - source.keys())
    changed = sorted(path for path in baseline.keys() & source.keys() if baseline[path] != source[path])
    print(f"migration baseline differs from pinned chart source: missing={missing}, extra={extra}, changed={changed}", file=sys.stderr)
    raise SystemExit(1)
print(f"Original migration baseline files and modes match pinned chart source {sys.argv[1]}.")
PY

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cat >"$tmp_dir/credentials.yaml" <<'YAML'
mongo:
  auth:
    rootPassword: pacman-fixture-mongo-root
    databasePassword: pacman-fixture-mongo-user
postgres:
  auth:
    password: pacman-fixture-postgres
YAML

cat >"$tmp_dir/optional.yaml" <<'YAML'
roles:
  enabled: true
simulator:
  enabled: true
  securityProbes:
    enabled: true
    seed: 8
    durationSeconds: 60
    operations:
      - operation: fileProbe
        ratePerSecond: 1
        maxCount: 2
      - operation: execProbe
        ratePerSecond: 1
        maxCount: 2
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

render_compare() {
  local case_name="$1"
  shift
  local -a upgrade_flag=()
  for mode in install upgrade; do
    upgrade_flag=()
    if [[ "$mode" == upgrade ]]; then
      upgrade_flag=(--is-upgrade)
    fi
    helm template pacman "$baseline_chart" --namespace pacman-demo \
      --values "$tmp_dir/credentials.yaml" "$@" "${upgrade_flag[@]}" >"$tmp_dir/source.yaml"
    helm template pacman "$source_chart" --namespace pacman-demo \
      --values "$tmp_dir/credentials.yaml" "$@" "${upgrade_flag[@]}" >"$tmp_dir/candidate.yaml"
    if ! cmp -s "$tmp_dir/source.yaml" "$tmp_dir/candidate.yaml"; then
      echo "render mismatch for $case_name/$mode" >&2
      diff -u "$tmp_dir/source.yaml" "$tmp_dir/candidate.yaml" | head -n 80 >&2 || true
      exit 1
    fi
    echo "render equivalence passed: $case_name/$mode"
  done
}

for database in mongo postgres; do
  render_compare "$database-default" --set "database=$database"
  render_compare "$database-split" --set "database=$database" --set roles.enabled=true
  if [[ "$database" == mongo ]]; then
    render_compare "$database-existing-secret" --set "database=$database" --set mongo.existingSecret=pacman-mongo-credentials
  else
    render_compare "$database-existing-secret" --set "database=$database" --set postgres.existingSecret=pacman-postgres-credentials
  fi
  render_compare "$database-optional-integrations" --set "database=$database" --values "$tmp_dir/optional.yaml"
done

render_compare openshift-auto --set database=mongo --set roles.enabled=true --api-versions security.openshift.io/v1
render_compare openshift-forced-on --set database=mongo --set openShift.enabled=true
render_compare openshift-forced-off --set database=postgres --set openShift.enabled=false --api-versions security.openshift.io/v1

echo "Pac-Man migration-baseline parity and 22 pinned-source render checks passed. Optional policy renders are static checks only."
