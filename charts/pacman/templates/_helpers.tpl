{{/*
Common helpers
*/}}

{{- define "pacman.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pacman.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "pacman.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels shared by every rendered object, independent of which
workload/component they belong to. Call with the root context.
*/}}
{{- define "pacman.commonLabels" -}}
helm.sh/chart: {{ include "pacman.chart" . }}
app.kubernetes.io/part-of: pacman
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end -}}

{{/*
Full label set for a single workload/component.

Each workload is given a distinct identity so observability tools such as
Hubble render them as separate services instead of collapsing every pod
under the chart name. Call with a dict:

  (dict "root" $ "name" "mongodb" "role" "database")

  - name: value for app.kubernetes.io/name and the app label.
  - role: value for app.kubernetes.io/component and the role label.
*/}}
{{- define "pacman.labels" -}}
{{ include "pacman.commonLabels" .root }}
{{ include "pacman.selectorLabels" . }}
app: {{ .name }}
role: {{ .role }}
{{- end -}}

{{/*
Immutable selector labels for a single workload/component. Limited to the
stable identity keys (name, instance, component).
*/}}
{{- define "pacman.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .role }}
{{- end -}}

{{/*
Per-workload label helpers. These centralise the app name and role for each
component so the identity is defined in exactly one place. Call with the
root context, e.g. {{ include "pacman.frontend.labels" $ }}.
*/}}
{{- define "pacman.frontend.labels" -}}
{{ include "pacman.labels" (dict "root" . "name" "pacman-frontend" "role" "frontend") }}
{{- end -}}
{{- define "pacman.frontend.selectorLabels" -}}
{{ include "pacman.selectorLabels" (dict "root" . "name" "pacman-frontend" "role" "frontend") }}
{{- end -}}

{{- define "pacman.mongo.labels" -}}
{{ include "pacman.labels" (dict "root" . "name" "mongodb" "role" "database") }}
{{- end -}}
{{- define "pacman.mongo.selectorLabels" -}}
{{ include "pacman.selectorLabels" (dict "root" . "name" "mongodb" "role" "database") }}
{{- end -}}

{{- define "pacman.postgres.labels" -}}
{{ include "pacman.labels" (dict "root" . "name" "postgres" "role" "database") }}
{{- end -}}
{{- define "pacman.postgres.selectorLabels" -}}
{{ include "pacman.selectorLabels" (dict "root" . "name" "postgres" "role" "database") }}
{{- end -}}

{{- define "pacman.migrate.labels" -}}
{{ include "pacman.labels" (dict "root" . "name" "pacman-migrate" "role" "migrate") }}
{{- end -}}

{{- define "pacman.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "pacman.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* Pacman container image reference. Uses digest unless tag is set. */}}
{{- define "pacman.image" -}}
{{- if .Values.image.tag -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- else if .Values.image.digest -}}
{{ .Values.image.repository }}@{{ .Values.image.digest }}
{{- else -}}
{{ .Values.image.repository }}:latest
{{- end -}}
{{- end -}}

{{- define "pacman.mongo.fullname" -}}
{{- printf "%s-mongo" (include "pacman.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pacman.postgres.fullname" -}}
{{- printf "%s-postgres" (include "pacman.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pacman.postgres.migration.fullname" -}}
{{- printf "%s-migrate" (include "pacman.postgres.fullname" . | trunc 55 | trimSuffix "-") -}}
{{- end -}}

{{- define "pacman.mongo.secretName" -}}
{{- if .Values.mongo.existingSecret -}}
{{ .Values.mongo.existingSecret }}
{{- else -}}
{{ include "pacman.mongo.fullname" . }}
{{- end -}}
{{- end -}}

{{- define "pacman.postgres.secretName" -}}
{{- if .Values.postgres.existingSecret -}}
{{ .Values.postgres.existingSecret }}
{{- else -}}
{{ include "pacman.postgres.fullname" . }}
{{- end -}}
{{- end -}}

{{- define "pacman.demo.secretName" -}}
{{- .Values.demo.existingTokenSecret -}}
{{- end -}}

{{- define "pacman.demo.tokenEnv" -}}
{{- if .Values.demo.enabled }}
- name: DEMO_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ include "pacman.demo.secretName" . }}
      key: token
{{- end }}
{{- end -}}

{{/* Hash only public config and Secret identity, never the token value. */}}
{{- define "pacman.demo.checksum" -}}
{{- toJson (dict
  "faults" .Values.simulator.faults
  "securityProbes" .Values.simulator.securityProbes
  "demoEnabled" .Values.demo.enabled
  "fileProbeEnabled" .Values.demo.fileProbeEnabled
  "execProbeEnabled" .Values.demo.execProbeEnabled
  "secretNamespace" .Release.Namespace
  "secretName" (include "pacman.demo.secretName" .)
  "secretKey" "token") | sha256sum -}}
{{- end -}}

{{- define "pacman.demo.annotations" -}}
{{- $annotations := deepCopy (.Values.podAnnotations | default dict) -}}
{{- $_ := set $annotations "checksum/pacman-demo" (include "pacman.demo.checksum" .) -}}
{{- toYaml $annotations -}}
{{- end -}}

{{/*
Whether the target cluster is OpenShift. Returns a non-empty string ("true")
when so. .Values.openShift.enabled may be true, false, or "auto" (in which case
the security.openshift.io/v1 API group is probed). Call with the root context.
*/}}
{{- define "pacman.isOpenShift" -}}
{{- $mode := toString (.Values.openShift).enabled -}}
{{- if eq $mode "true" -}}
true
{{- else if eq $mode "false" -}}
{{- else if .Capabilities.APIVersions.Has "security.openshift.io/v1" -}}
true
{{- end -}}
{{- end -}}

{{/*
Whether to drop the fixed runAsUser/runAsGroup/fsGroup so OpenShift's SCC can
inject them. True on OpenShift unless the user opts to keep them via a
nonroot-v2 RoleBinding. Call with the root context.
*/}}
{{- define "pacman.dropFixedIDs" -}}
{{- if and (include "pacman.isOpenShift" .) (not (.Values.openShift).sccRoleBinding.create) -}}
true
{{- end -}}
{{- end -}}

{{/*
Render a pod-level securityContext, stripping runAsUser/runAsGroup/fsGroup when
running on OpenShift (see pacman.dropFixedIDs). Call with:
  (dict "root" $ "ctx" <securityContext map>)
*/}}
{{- define "pacman.podSecurityContext" -}}
{{- $ctx := deepCopy .ctx -}}
{{- if include "pacman.dropFixedIDs" .root -}}
{{- $_ := unset $ctx "runAsUser" -}}
{{- $_ := unset $ctx "runAsGroup" -}}
{{- $_ := unset $ctx "fsGroup" -}}
{{- end -}}
{{- toYaml $ctx -}}
{{- end -}}

{{/*
Database environment for the app container, shared by the frontend and the
score/user backend roles. Selects mongo or postgres from .Values.database.
Call with the root context.
*/}}
{{- define "pacman.dbEnv" -}}
{{- if eq .Values.database "mongo" -}}
- name: DB_TYPE
  value: mongo
- name: MONGO_SERVICE_HOST
  value: {{ include "pacman.mongo.fullname" . }}
- name: MY_MONGO_PORT
  value: "{{ .Values.mongo.service.port }}"
- name: MONGO_USE_SSL
  value: "false"
- name: MONGO_VALIDATE_SSL
  value: "false"
- name: MONGO_AUTH_USER
  valueFrom: { secretKeyRef: { name: {{ include "pacman.mongo.secretName" . }}, key: database-user } }
- name: MONGO_AUTH_PWD
  valueFrom: { secretKeyRef: { name: {{ include "pacman.mongo.secretName" . }}, key: database-password } }
- name: MONGO_DATABASE
  valueFrom: { secretKeyRef: { name: {{ include "pacman.mongo.secretName" . }}, key: database-name } }
{{- else if eq .Values.database "postgres" -}}
- name: DB_TYPE
  value: postgres
- name: POSTGRES_HOST
  value: {{ include "pacman.postgres.fullname" . }}
- name: POSTGRES_PORT
  value: "{{ .Values.postgres.service.port }}"
- name: POSTGRES_DB
  valueFrom: { secretKeyRef: { name: {{ include "pacman.postgres.secretName" . }}, key: database } }
- name: POSTGRES_USER
  valueFrom: { secretKeyRef: { name: {{ include "pacman.postgres.secretName" . }}, key: username } }
- name: POSTGRES_PASSWORD
  valueFrom: { secretKeyRef: { name: {{ include "pacman.postgres.secretName" . }}, key: password } }
{{- end -}}
{{- end -}}

{{- define "pacman.applicationProbes" -}}
{{- $probes := .Values.probes | default dict -}}
{{- range $name := list "liveness" "readiness" }}
{{- $probe := index $probes $name | default dict -}}
{{- if and $probe (or (not (hasKey $probe "enabled")) $probe.enabled) }}
{{- $renderedProbe := omit $probe "enabled" }}
{{ $name }}Probe: {{- toYaml $renderedProbe | nindent 2 }}
{{ end }}
{{ end }}
{{- end -}}

{{- define "pacman.validate" -}}
{{- $db := .Values.database -}}
{{- if not (or (eq $db "mongo") (eq $db "postgres")) -}}
{{- fail (printf ".Values.database must be 'mongo' or 'postgres', got %q" $db) -}}
{{- end -}}
{{- $demo := .Values.demo -}}
{{- $sim := .Values.simulator -}}
{{- if and $demo.enabled (empty $demo.existingTokenSecret) -}}
{{- fail ".Values.demo.existingTokenSecret is required when demo.enabled=true; Secret key 'token' must exist" -}}
{{- end -}}
{{- if or $sim.faults.enabled $sim.securityProbes.enabled -}}
{{- if not $demo.enabled -}}
{{- fail "simulator fault/security probe JSON requires demo.enabled=true and DEMO_SECURITY_MODE=true" -}}
{{- end -}}
{{- if not $sim.enabled -}}
{{- fail "simulator fault/security probe JSON requires simulator.enabled=true" -}}
{{- end -}}
{{- if empty $demo.existingTokenSecret -}}
{{- fail "simulator fault/security probe JSON requires demo.existingTokenSecret referencing a Secret with key 'token'" -}}
{{- end -}}
{{- end -}}
{{- $seenFaultOps := dict -}}
{{- if and $sim.faults.enabled (empty $sim.faults.rules) -}}
{{- fail "simulator.faults.enabled requires at least one rule" -}}
{{- end -}}
{{- if and (not $sim.faults.enabled) (gt (len $sim.faults.rules) 0) -}}
{{- fail "simulator.faults.rules must be empty when faults.enabled=false" -}}
{{- end -}}
{{- range $index, $rule := $sim.faults.rules -}}
{{- if gt $rule.delayMs.min $rule.delayMs.max -}}
{{- fail (printf "simulator.faults.rules[%d].delayMs.min must be <= max" $index) -}}
{{- end -}}
{{- $rateTotal := addf $rule.errorRate $rule.delayRate -}}
{{- if gt $rateTotal 1.0 -}}
{{- fail (printf "simulator.faults.rules[%d] errorRate plus delayRate must not exceed 1" $index) -}}
{{- end -}}
{{- if empty $rateTotal -}}
{{- fail (printf "simulator.faults.rules[%d] must enable an error or delay fault" $index) -}}
{{- end -}}
{{- if and $rule.delayRate (not $rule.delayMs.max) -}}
{{- fail (printf "simulator.faults.rules[%d].delayMs.max must be positive when delayRate is enabled" $index) -}}
{{- end -}}
{{- range $operation := $rule.operations -}}
{{- $expectedRole := "" -}}
{{- if hasPrefix "score" $operation -}}{{- $expectedRole = "score" -}}{{- else if hasPrefix "user" $operation -}}{{- $expectedRole = "user" -}}{{- else if eq $operation "pageView" -}}{{- $expectedRole = "web" -}}{{- end -}}
{{- if and (ne $rule.targetRole "web") (ne $rule.targetRole $expectedRole) -}}
{{- fail (printf "simulator.faults.rules[%d].targetRole %q does not support operation %q" $index $rule.targetRole $operation) -}}
{{- end -}}
{{- if and (not $.Values.roles.enabled) (ne $rule.targetRole "web") -}}
{{- fail (printf "simulator.faults.rules[%d] targetRole %q requires roles.enabled=true" $index $rule.targetRole) -}}
{{- end -}}
{{- if hasKey $seenFaultOps $operation -}}
{{- fail (printf "simulator.faults operation %q appears in more than one rule" $operation) -}}
{{- end -}}
{{- $_ := set $seenFaultOps $operation true -}}
{{- end -}}
{{- end -}}
{{- $probeOps := list -}}
{{- $probeRateTotal := 0.0 -}}
{{- $probeCountTotal := 0 -}}
{{- range $entry := $sim.securityProbes.operations -}}
{{- if has $entry.operation $probeOps -}}
{{- fail (printf "simulator.securityProbes operation %q appears more than once" $entry.operation) -}}
{{- end -}}
{{- $probeOps = append $probeOps $entry.operation -}}
{{- $probeRateTotal = addf $probeRateTotal $entry.ratePerSecond -}}
{{- $probeCountTotal = add $probeCountTotal $entry.maxCount -}}
{{- if and $sim.securityProbes.enabled (empty $entry.ratePerSecond) -}}
{{- fail (printf "simulator.securityProbes operation %q needs a positive ratePerSecond when enabled" $entry.operation) -}}
{{- end -}}
{{- end -}}
{{- if and $sim.securityProbes.enabled (empty $probeOps) -}}
{{- fail "simulator.securityProbes.enabled requires at least one operation" -}}
{{- end -}}
{{- if and (not $sim.securityProbes.enabled) (gt (len $probeOps) 0) -}}
{{- fail "simulator.securityProbes.operations must be empty when securityProbes.enabled=false" -}}
{{- end -}}
{{- if gt $probeRateTotal 10.0 -}}
{{- fail "simulator.securityProbes combined ratePerSecond must not exceed 10" -}}
{{- end -}}
{{- if gt $probeCountTotal 1000 -}}
{{- fail "simulator.securityProbes combined maxCount must not exceed 1000" -}}
{{- end -}}
{{- if ne $demo.fileProbeEnabled (has "fileProbe" $probeOps) -}}
{{- fail "demo.fileProbeEnabled must match whether simulator.securityProbes.operations includes fileProbe" -}}
{{- end -}}
{{- if ne $demo.execProbeEnabled (has "execProbe" $probeOps) -}}
{{- fail "demo.execProbeEnabled must match whether simulator.securityProbes.operations includes execProbe" -}}
{{- end -}}
{{- if and .Values.ciliumNetworkPolicy.enabled (not .Values.roles.enabled) -}}
{{- fail "ciliumNetworkPolicy.enabled requires roles.enabled=true" -}}
{{- end -}}
{{- if and .Values.ciliumNetworkPolicy.denyScoreWrites (not .Values.ciliumNetworkPolicy.enabled) -}}
{{- fail "ciliumNetworkPolicy.denyScoreWrites requires ciliumNetworkPolicy.enabled=true" -}}
{{- end -}}
{{- if and .Values.tetragon.enabled (not (or $demo.fileProbeEnabled $demo.execProbeEnabled)) -}}
{{- fail "tetragon.enabled requires demo.fileProbeEnabled or demo.execProbeEnabled" -}}
{{- end -}}
{{- if and (not .Values.tetragon.enabled) (eq .Values.tetragon.fileProbeMode "enforce") -}}
{{- fail "tetragon.fileProbeMode=enforce requires tetragon.enabled=true" -}}
{{- end -}}
{{- if and (not .Values.tetragon.enabled) (eq .Values.tetragon.execProbeMode "enforce") -}}
{{- fail "tetragon.execProbeMode=enforce requires tetragon.enabled=true" -}}
{{- end -}}
{{- if and (eq .Values.tetragon.fileProbeMode "enforce") (not $demo.fileProbeEnabled) -}}
{{- fail "tetragon.fileProbeMode=enforce requires demo.fileProbeEnabled=true" -}}
{{- end -}}
{{- if and (eq .Values.tetragon.execProbeMode "enforce") (not $demo.execProbeEnabled) -}}
{{- fail "tetragon.execProbeMode=enforce requires demo.execProbeEnabled=true" -}}
{{- end -}}
{{- $reservedEnv := list "DEMO_SECURITY_MODE" "DEMO_TOKEN" "DEMO_TOKEN_HEADER" "DEMO_FILE_PROBE_ENABLED" "DEMO_EXEC_PROBE_ENABLED" "SIM_FAULTS_JSON" "SIM_SECURITY_PROBES_JSON" -}}
{{- range $entry := .Values.extraEnv -}}
{{- if has $entry.name $reservedEnv -}}
{{- fail (printf "extraEnv must not override chart-managed variable %s" $entry.name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
