#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <chart-dir> <candidate-source-dir> <mongo|postgres>" >&2
  exit 2
fi

chart_dir="$1"
candidate_dir="$2"
database="$3"

case "$database" in
  mongo|postgres) ;;
  *) echo "unsupported database backend: $database" >&2; exit 2 ;;
esac

candidate_sha_actual="$(git -C "$candidate_dir" rev-parse HEAD)"
candidate_sha="$candidate_sha_actual"
if [[ -n "${GITHUB_SHA:-}" && "$candidate_sha" != "$GITHUB_SHA" ]]; then
  echo "candidate source $candidate_sha does not match workflow source $GITHUB_SHA" >&2
  exit 1
fi

docker_arch="$(docker info --format '{{.Architecture}}')"
case "$docker_arch" in
  amd64|x86_64) image_arch=amd64 ;;
  arm64|aarch64) image_arch=arm64 ;;
  *) echo "unsupported Docker server architecture: $docker_arch" >&2; exit 1 ;;
esac

tmp_dir="$(mktemp -d)"
cluster_name="pcl-${database}-$$"
image="docker.io/library/pacman:ci-${candidate_sha}-$$"
image_id=""
loaded_image_digest=""
cluster_created=false
watch_pid=""
current_namespace=""
release_fullname=""

dump_diagnostics() {
  [[ -n "$current_namespace" ]] || return 0
  echo "--- bounded lifecycle diagnostics: namespace $current_namespace ---" >&2
  kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$current_namespace" \
    get pods,deployments,services,jobs,persistentvolumeclaims -o wide >&2 2>/dev/null || true
  kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$current_namespace" \
    get events --sort-by=.lastTimestamp >&2 2>/dev/null | tail -n 40 >&2 || true
}

stop_watch() {
  if [[ -n "$watch_pid" ]]; then
    kill "$watch_pid" 2>/dev/null || true
    wait "$watch_pid" 2>/dev/null || true
    watch_pid=""
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_watch
  if (( status != 0 )); then
    dump_diagnostics
  fi
  if [[ "$cluster_created" == true ]]; then
    kind delete cluster --name "$cluster_name" || status=1
    if kind get clusters | grep -Fxq "$cluster_name"; then
      echo "owned Kind cluster was not removed: $cluster_name" >&2
      status=1
    else
      echo "owned Kind cluster cleanup passed: $cluster_name"
    fi
  fi
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

assert_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required command not found: $1" >&2
    exit 1
  }
}
for tool in docker kind kubectl helm node python3; do assert_command "$tool"; done

docker build \
  --platform "linux/$image_arch" \
  --file "$candidate_dir/docker/Dockerfile" \
  --build-arg "COMMIT_SHA=$candidate_sha" \
  --tag "$image" \
  "$candidate_dir"
image_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")"
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
[[ "$image_revision" == "$candidate_sha" ]] || {
  echo "built image revision $image_revision does not match source $candidate_sha" >&2
  exit 1
}
node "$candidate_dir/tools/smoke-container-images.js" \
  --expected-revision "$candidate_sha" "linux/$image_arch=$image"

kind create cluster \
  --name "$cluster_name" \
  --image kindest/node:v1.31.4 \
  --wait 120s \
  --kubeconfig "$tmp_dir/kubeconfig"
cluster_created=true
kubectl --kubeconfig "$tmp_dir/kubeconfig" wait --for=condition=Ready nodes --all --timeout=120s
kind load docker-image "$image" --name "$cluster_name"
loaded_image_digest="$(docker exec "$cluster_name-control-plane" crictl inspecti "$image" | python3 -c '
import json, sys
status = json.load(sys.stdin)["status"]
expected_tag, expected_id = sys.argv[1:]
if status.get("id") != expected_id:
    sys.exit("Kind CRI image ID does not match the built Docker image ID")
if expected_tag not in status.get("repoTags", []):
    sys.exit("Kind did not load the candidate image tag")
digests = status.get("repoDigests", [])
if not digests:
    sys.exit("Kind CRI did not report a candidate image digest")
print(digests[0])
' "$image" "$image_id")"

kubectl --kubeconfig "$tmp_dir/kubeconfig" apply -f \
  https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.31/deploy/local-path-storage.yaml >/dev/null
kubectl --kubeconfig "$tmp_dir/kubeconfig" patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}' >/dev/null
kubectl --kubeconfig "$tmp_dir/kubeconfig" -n local-path-storage \
  rollout status deployment/local-path-provisioner --timeout=120s

migration_job_name() {
  local fullname="$1"
  printf '%s-postgres-migrate' "$fullname"
}

start_migration_watch() {
  local namespace="$1"
  local events_file="$2"
  kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" \
    get pods --watch --output-watch-events -o json >"$events_file" 2>"$tmp_dir/watch.err" &
  watch_pid=$!
  sleep 2
  kill -0 "$watch_pid" 2>/dev/null || {
    echo "Kubernetes pod watch did not remain connected" >&2
    cat "$tmp_dir/watch.err" >&2 || true
    exit 1
  }
}

assert_migration_pod() {
  local namespace="$1"
  local job_name="$2"
  local events_file="$3"
  local previous_pod="${4:-}"
  local snapshot="$tmp_dir/migration-pod.json"
  local pod_name

  stop_watch
  python3 - "$events_file" "$job_name" "$snapshot" <<'PY'
import json
import sys
from pathlib import Path

events_path, job_name, snapshot_path = sys.argv[1:]
text = Path(events_path).read_text()
decoder = json.JSONDecoder()
position = 0
successful = []
while position < len(text):
    while position < len(text) and text[position].isspace():
        position += 1
    if position >= len(text):
        break
    try:
        event, next_position = decoder.raw_decode(text, position)
    except json.JSONDecodeError:
        break
    position = next_position
    pod = event.get("object", event)
    name = pod.get("metadata", {}).get("name", "")
    if not name.startswith(job_name + "-"):
        continue
    if pod.get("status", {}).get("phase") != "Succeeded":
        continue
    if not any(item.get("name") == "migrate" for item in pod.get("spec", {}).get("containers", [])):
        continue
    successful.append(pod)

if not successful:
    sys.exit(f"no succeeded migration pod event was observed for {job_name}")
Path(snapshot_path).write_text(json.dumps(successful[-1]))
PY

  pod_name="$(MIGRATION_JOB_NAME="$job_name" node --input-type=module - \
    "$candidate_dir/tools/check-kubernetes-image-identity.js" \
    "$snapshot" "$image" "$loaded_image_digest" "$candidate_sha" <<'NODE'
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const [helperPath, snapshotPath, image, imageId, revision] = process.argv.slice(2);
const { assertPodImageIdentity } = await import(pathToFileURL(helperPath));
const pod = JSON.parse(await readFile(snapshotPath, 'utf8'));
assert.equal(pod.status?.phase, 'Succeeded', 'migration pod must complete successfully');
assertPodImageIdentity(pod, { containerName: 'migrate', image, imageId });
assert.ok(revision.length === 40, 'candidate source revision must be a full commit SHA');
assert.match(pod.metadata?.name ?? '', new RegExp(`^${process.env.MIGRATION_JOB_NAME}-`));
console.log(pod.metadata.name);
NODE
  )"
  if [[ -n "$previous_pod" && "$pod_name" == "$previous_pod" ]]; then
    echo "PostgreSQL upgrade reused the prior migration pod $pod_name" >&2
    exit 1
  fi
  if kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" get job "$job_name" >/dev/null 2>&1; then
    echo "successful migration hook Job was not cleaned up: $job_name" >&2
    exit 1
  fi
  printf '%s\n' "$pod_name"
}

secret_fingerprint() {
  local namespace="$1"
  local name="$2"
  kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" get secret "$name" -o json \
    | python3 -c 'import hashlib, json, sys; print(hashlib.sha256(json.dumps(json.load(sys.stdin)["data"], sort_keys=True).encode()).hexdigest())'
}

wait_workloads() {
  local namespace="$1"
  local release="$2"
  local role_mode="$3"
  local fullname="${release}-pacman"
  local database_deployment="${fullname}-${database}"
  kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" \
    rollout status "deployment/$database_deployment" --timeout=240s
  local pvc_name="${database_deployment}"
  kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" \
    wait --for=jsonpath='{.status.phase}'=Bound "pvc/$pvc_name" --timeout=180s
  local component
  if [[ "$role_mode" == split ]]; then
    for component in "$fullname" "${fullname}-score" "${fullname}-user"; do
      kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" \
        rollout status "deployment/$component" --timeout=240s
    done
  else
    kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" \
      rollout status "deployment/$fullname" --timeout=240s
  fi
}

assert_role_images() {
  local namespace="$1"
  local release="$2"
  local role_mode="$3"
  local selector

  selector="app.kubernetes.io/instance=$release,app.kubernetes.io/component=frontend"
  node "$candidate_dir/tools/check-kubernetes-image-identity.js" role \
    --kubeconfig "$tmp_dir/kubeconfig" --namespace "$namespace" \
    --selector "$selector" --role web --image "$image" \
    --image-id "$loaded_image_digest" --revision "$candidate_sha"
  if [[ "$role_mode" == split ]]; then
    local role
    for role in score user; do
      selector="app.kubernetes.io/instance=$release,app.kubernetes.io/component=$role"
      node "$candidate_dir/tools/check-kubernetes-image-identity.js" role \
        --kubeconfig "$tmp_dir/kubeconfig" --namespace "$namespace" \
        --selector "$selector" --role "$role" --image "$image" \
        --image-id "$loaded_image_digest" --revision "$candidate_sha"
    done
  fi
}

assert_migrations() {
  local namespace="$1"
  # The quoted script executes in the PostgreSQL pod, where these variables exist.
  # shellcheck disable=SC2016
  kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" \
    exec "deployment/${release_fullname}-postgres" -- /bin/sh -ec '
      PGPASSWORD="$POSTGRES_PASSWORD" psql -XAt -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
        -c "SELECT version FROM schema_migrations ORDER BY version"
    ' >"$tmp_dir/migrations.txt"
  [[ "$(cat "$tmp_dir/migrations.txt")" == $'0001_init.sql\n0002_live_stats_name.sql' ]] || {
    echo "PostgreSQL migrations did not complete in order" >&2
    exit 1
  }
}

assert_database_sentinel() {
  local namespace="$1"
  local verify="$2"
  if [[ "$database" == mongo ]]; then
    local js
    if [[ "$verify" == true ]]; then
      js='if (db.lifecycle_sentinel.countDocuments({_id: "ci-persisted"}) !== 1) quit(1); if (db.lifecycle_sentinel.findOne({_id: "ci-persisted"}).value !== "retained") quit(1);'
    else
      # This JavaScript is passed literally through the remote shell to mongosh.
      # shellcheck disable=SC2016
      js='db.lifecycle_sentinel.updateOne({_id: "ci-persisted"}, {$set: {value: "retained"}}, {upsert: true});'
    fi
    # The single-quoted command expands its arguments inside the pod.
    # shellcheck disable=SC2016
    kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" \
      exec "deployment/${release_fullname}-mongo" -- /bin/sh -ec \
      'mongosh --quiet --username "$APP_DB_USER" --password "$APP_DB_PWD" --authenticationDatabase "$APP_DB_NAME" "$APP_DB_NAME" --eval "$1"' \
      sh "$js" >/dev/null
  else
    local sql
    if [[ "$verify" == true ]]; then
      sql="SELECT CASE WHEN COUNT(*) = 1 AND MAX(score) = 9001 THEN 'ok' ELSE 'bad' END FROM highscores WHERE id = '00000000-0000-4000-8000-000000000001'"
    else
      sql="INSERT INTO highscores (id, name, score) VALUES ('00000000-0000-4000-8000-000000000001', 'chart-lifecycle', 9001) ON CONFLICT (id) DO UPDATE SET score = EXCLUDED.score"
    fi
    local output
    # The single-quoted command expands its arguments inside the pod.
    # shellcheck disable=SC2016
    output="$(kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" \
      exec "deployment/${release_fullname}-postgres" -- /bin/sh -ec \
      'PGPASSWORD="$POSTGRES_PASSWORD" psql -XAt -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' \
      sh "$sql")"
    if [[ "$verify" == true && "$output" != ok ]]; then
      echo "PostgreSQL persisted row or credentials did not survive upgrade" >&2
      exit 1
    fi
  fi
}

write_values() {
  local mode="$1"
  local roles_enabled="$2"
  local phase="$3"
  cat >"$tmp_dir/values-${mode}-${phase}.yaml" <<YAML
database: ${database}
image:
  repository: docker.io/library/pacman
  digest: ""
  tag: "${image##*:}"
  pullPolicy: IfNotPresent
service:
  type: ClusterIP
roles:
  enabled: ${roles_enabled}
  score:
    replicas: 1
  user:
    replicas: 1
podAnnotations:
  lifecycle-check: ${phase}
mongo:
  auth:
    rootUsername: ci-root
    rootPassword: ci-root-pass
    databaseName: pacman
    databaseUser: ci-pacman
    databasePassword: ci-pacman-pass
  persistence:
    enabled: true
    storageClass: local-path
postgres:
  auth:
    username: ci-pacman
    password: ci-pacman-pass
    database: pacman
  persistence:
    enabled: true
    storageClass: local-path
  migration:
    enabled: true
YAML
}

run_mode() {
  local role_mode="$1"
  local roles_enabled=false
  [[ "$role_mode" == split ]] && roles_enabled=true

  local release="pcl-${database}-${role_mode}"
  current_namespace="$release"
  release_fullname="${release}-pacman"
  local namespace="$current_namespace"
  local job_name
  job_name="$(migration_job_name "$release_fullname")"
  local initial_migration_pod=""
  local watch_file="$tmp_dir/${role_mode}-install-events.json"

  kubectl --kubeconfig "$tmp_dir/kubeconfig" create namespace "$namespace" >/dev/null
  write_values "$role_mode" "$roles_enabled" install
  if [[ "$database" == postgres ]]; then
    start_migration_watch "$namespace" "$watch_file"
  fi
  helm upgrade --install "$release" "$chart_dir" \
    --kubeconfig "$tmp_dir/kubeconfig" --namespace "$namespace" \
    --values "$tmp_dir/values-${role_mode}-install.yaml" \
    --wait --timeout 6m
  wait_workloads "$namespace" "$release" "$role_mode"
  assert_role_images "$namespace" "$release" "$role_mode"
  local secret_name="${release_fullname}-${database}"
  local secret_before
  secret_before="$(secret_fingerprint "$namespace" "$secret_name")"

  if [[ "$database" == postgres ]]; then
    initial_migration_pod="$(MIGRATION_JOB_NAME="$job_name" assert_migration_pod \
      "$namespace" "$job_name" "$watch_file")"
    assert_migrations "$namespace"
  fi
  assert_database_sentinel "$namespace" false

  write_values "$role_mode" "$roles_enabled" upgrade
  watch_file="$tmp_dir/${role_mode}-upgrade-events.json"
  if [[ "$database" == postgres ]]; then
    start_migration_watch "$namespace" "$watch_file"
  fi
  helm upgrade "$release" "$chart_dir" \
    --kubeconfig "$tmp_dir/kubeconfig" --namespace "$namespace" \
    --values "$tmp_dir/values-${role_mode}-upgrade.yaml" \
    --wait --timeout 6m
  wait_workloads "$namespace" "$release" "$role_mode"
  assert_role_images "$namespace" "$release" "$role_mode"
  [[ "$(secret_fingerprint "$namespace" "$secret_name")" == "$secret_before" ]] || {
    echo "$database credentials changed during the chart upgrade" >&2
    exit 1
  }
  assert_database_sentinel "$namespace" true
  if [[ "$database" == postgres ]]; then
    local upgrade_migration_pod
    upgrade_migration_pod="$(MIGRATION_JOB_NAME="$job_name" assert_migration_pod \
      "$namespace" "$job_name" "$watch_file" "$initial_migration_pod")"
    [[ "$upgrade_migration_pod" != "$initial_migration_pod" ]] || {
      echo "PostgreSQL post-upgrade hook did not create a new migration pod" >&2
      exit 1
    }
    assert_migrations "$namespace"
  fi

  helm uninstall "$release" --kubeconfig "$tmp_dir/kubeconfig" \
    --namespace "$namespace" --wait --timeout 2m
  local resource
  for resource in deployments services pods persistentvolumeclaims secrets configmaps jobs serviceaccounts; do
    if kubectl --kubeconfig "$tmp_dir/kubeconfig" -n "$namespace" \
      get "$resource" -l "app.kubernetes.io/instance=$release" -o name | grep -q .; then
      echo "owned $resource remain after helm uninstall for $release" >&2
      exit 1
    fi
  done
  if kubectl --kubeconfig "$tmp_dir/kubeconfig" \
    get clusterroles,clusterrolebindings -l "app.kubernetes.io/instance=$release" -o name | grep -q .; then
    echo "owned cluster-scoped RBAC resources remain after helm uninstall for $release" >&2
    exit 1
  fi
  kubectl --kubeconfig "$tmp_dir/kubeconfig" delete namespace "$namespace" \
    --wait=true --timeout=2m
  echo "$database/$role_mode install, upgrade, identity, credentials, data, and cleanup passed"
  current_namespace=""
}

run_mode default
run_mode split

echo "Pac-Man $database chart lifecycle checks passed for default and split roles using source $candidate_sha"
