#!/usr/bin/env bash
set -euo pipefail

chart_dir="${1:-charts/pacman}"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

assert_yq() {
  local query="$1"
  local file="$2"
  local description="$3"

  if ! yq -e "$query" "$file" >/dev/null; then
    echo "PostgreSQL migration assertion failed: $description" >&2
    exit 1
  fi
}

helm template pacman "$chart_dir" --namespace pacman-demo \
  --set database=postgres \
  --set image.tag=review-a >"$tmp_dir/install.yaml"
helm template pacman "$chart_dir" --namespace pacman-demo --is-upgrade \
  --set database=postgres \
  --set image.tag=review-a >"$tmp_dir/upgrade-a.yaml"
helm template pacman "$chart_dir" --namespace pacman-demo --is-upgrade \
  --set database=postgres \
  --set image.tag=review-b >"$tmp_dir/upgrade-b.yaml"

assert_yq 'select(.kind == "Service" and .metadata.name == "pacman-postgres") | .metadata.annotations."helm.sh/hook" == null' \
  "$tmp_dir/install.yaml" 'initial install keeps the PostgreSQL Service as a regular resource'
assert_yq 'select(.kind == "Job" and .metadata.name == "pacman-postgres-migrate") | .metadata.annotations."helm.sh/hook" == "post-install,post-upgrade"' \
  "$tmp_dir/install.yaml" 'initial install and upgrades use the intended hook lifecycle'
assert_yq 'select(.kind == "Job" and .metadata.name == "pacman-postgres-migrate") | .metadata.annotations."helm.sh/hook-delete-policy" == "before-hook-creation,hook-succeeded"' \
  "$tmp_dir/install.yaml" 'migration hook has bounded recreation and success cleanup'
assert_yq 'select(.kind == "Job" and .metadata.name == "pacman-postgres-migrate") | .spec.ttlSecondsAfterFinished == 600' \
  "$tmp_dir/install.yaml" 'failed or otherwise retained completed jobs have a cleanup TTL'
assert_yq 'select(.kind == "Job" and .metadata.name == "pacman-postgres-migrate") | .metadata.labels."app.kubernetes.io/name" == "pacman-migrate" and .metadata.labels."app.kubernetes.io/component" == "migrate" and .metadata.labels."app.kubernetes.io/part-of" == "pacman" and .metadata.labels.app == "pacman-migrate" and .metadata.labels.role == "migrate"' \
  "$tmp_dir/install.yaml" 'migration Job carries its component labels'
assert_yq 'select(.kind == "Job" and .metadata.name == "pacman-postgres-migrate") | .spec.template.metadata.labels."app.kubernetes.io/name" == "pacman-migrate" and .spec.template.metadata.labels."app.kubernetes.io/component" == "migrate" and .spec.template.metadata.labels.app == "pacman-migrate" and .spec.template.metadata.labels.role == "migrate"' \
  "$tmp_dir/install.yaml" 'migration pod carries its component labels'
assert_yq 'select(.kind == "Job" and .metadata.name == "pacman-postgres-migrate") | .spec.template.spec.initContainers[0].env[] | select(.name == "POSTGRES_HOST") | .value == "pacman-postgres"' \
  "$tmp_dir/install.yaml" 'initial migration Job waits on the rendered PostgreSQL Service'

assert_yq 'select(.kind == "Service" and .metadata.name == "pacman-postgres") | .metadata.annotations."helm.sh/hook" == null' \
  "$tmp_dir/upgrade-a.yaml" 'PostgreSQL Service remains a regular resource on upgrade'
assert_yq 'select(.kind == "Job" and .metadata.name == "pacman-postgres-migrate") | .metadata.annotations."helm.sh/hook" == "post-install,post-upgrade"' \
  "$tmp_dir/upgrade-a.yaml" 'upgrade render registers the post-upgrade migration hook'
assert_yq 'select(.kind == "Job" and .metadata.name == "pacman-postgres-migrate") | .metadata.annotations."helm.sh/hook-delete-policy" == "before-hook-creation,hook-succeeded"' \
  "$tmp_dir/upgrade-b.yaml" 'each upgrade recreates the same-name hook before running it'
job_name_a="$(yq -r 'select(.kind == "Job") | .metadata.name' "$tmp_dir/upgrade-a.yaml")"
job_name_b="$(yq -r 'select(.kind == "Job") | .metadata.name' "$tmp_dir/upgrade-b.yaml")"
job_image_a="$(yq -r 'select(.kind == "Job") | .spec.template.spec.containers[] | select(.name == "migrate") | .image' "$tmp_dir/upgrade-a.yaml")"
job_image_b="$(yq -r 'select(.kind == "Job") | .spec.template.spec.containers[] | select(.name == "migrate") | .image' "$tmp_dir/upgrade-b.yaml")"
[[ "$job_name_a" == "$job_name_b" && "$job_image_a" != "$job_image_b" ]] || {
  echo "upgrade image variants must exercise same-name hook recreation" >&2
  exit 1
}

helm template pacman "$chart_dir" --namespace pacman-demo --is-upgrade \
  --set database=postgres \
  --set fullnameOverride=custom-pg >"$tmp_dir/changed-identity.yaml"
assert_yq 'select(.kind == "Service" and .metadata.name == "custom-pg-postgres")' \
  "$tmp_dir/changed-identity.yaml" 'upgrade creates the selected PostgreSQL Service before its hook runs'
assert_yq 'select(.kind == "Job" and .metadata.name == "custom-pg-postgres-migrate") | .metadata.annotations."helm.sh/hook" == "post-install,post-upgrade" and .spec.template.spec.containers[] | select(.name == "migrate") | .env[] | select(.name == "POSTGRES_HOST") | .value == "custom-pg-postgres"' \
  "$tmp_dir/changed-identity.yaml" 'migration hook targets the PostgreSQL Service rendered by the same upgrade'

long_release="$(printf 'r%.0s' {1..53})"
helm template "$long_release" "$chart_dir" --namespace pacman-demo \
  --set database=postgres >"$tmp_dir/long-name.yaml"
long_job_name="$(yq -r 'select(.kind == "Job") | .metadata.name' "$tmp_dir/long-name.yaml")"
[[ ${#long_job_name} -le 63 && "$long_job_name" == *-migrate ]] || {
  echo "migration Job name must fit Kubernetes limits and retain its suffix; got $long_job_name" >&2
  exit 1
}
assert_yq "select(.kind == \"Job\") | .metadata.labels.\"app.kubernetes.io/instance\" == \"$long_release\"" \
  "$tmp_dir/long-name.yaml" 'long release name remains intact as a valid migration label'

helm template disabled-migration "$chart_dir" --namespace pacman-demo \
  --set database=postgres --set postgres.migration.enabled=false >"$tmp_dir/disabled.yaml"
if yq -e 'select(.kind == "Job")' "$tmp_dir/disabled.yaml" >/dev/null 2>&1; then
  echo "disabled PostgreSQL migration still rendered a Job" >&2
  exit 1
fi

echo "Pac-Man PostgreSQL migration lifecycle checks passed"
