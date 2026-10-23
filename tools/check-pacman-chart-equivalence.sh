#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <pinned-source-repository> <candidate-chart-dir>" >&2
  exit 2
fi

source_repo="$1"
candidate_chart="$2"
source_sha="c24c5267340a58259cf3d7c8f337ace4c19d1d7a"
source_chart="$source_repo/charts/pacman"
actual_source_sha="$(git -C "$source_repo" rev-parse HEAD)"
[[ "$actual_source_sha" == "$source_sha" ]] || {
  echo "source chart checkout must be $source_sha; got $actual_source_sha" >&2
  exit 1
}

python3 - "$source_chart" "$candidate_chart" <<'PY'
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

source, candidate = map(snapshot, sys.argv[1:])
if source != candidate:
    missing = sorted(source.keys() - candidate.keys())
    extra = sorted(candidate.keys() - source.keys())
    changed = sorted(path for path in source.keys() & candidate.keys() if source[path] != candidate[path])
    print(f"chart source differs: missing={missing}, extra={extra}, changed={changed}", file=sys.stderr)
    raise SystemExit(1)
print(f"Chart files and modes match pinned source {sys.argv[1]} at {sys.argv[2]}.")
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
    helm template pacman "$source_chart" --namespace pacman-demo \
      --values "$tmp_dir/credentials.yaml" "$@" "${upgrade_flag[@]}" >"$tmp_dir/source.yaml"
    helm template pacman "$candidate_chart" --namespace pacman-demo \
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

echo "Pac-Man pinned chart source and render equivalence checks passed. Optional policy renders are static checks only."
