#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
from pathlib import Path
import re
import sys

workflow_dir = Path(".github/workflows")
chart_workflow = workflow_dir / "chart-ci.yml"
release_workflow = workflow_dir / "release.yml"
chart_text = chart_workflow.read_text()
release_text = release_workflow.read_text()

if not re.search(r"(?m)^on:\n  pull_request:\s*$", chart_text):
    sys.exit("chart CI must run on every pull request without a path filter")
if re.search(r"(?m)^  (?:push|workflow_dispatch|schedule):", chart_text):
    sys.exit("chart CI may only validate pull requests")
if not re.search(r"(?m)^permissions:\n  contents: read\s*$", chart_text):
    sys.exit("chart CI permissions must be read-only contents")
if re.search(r"(?m)^\s+(?:contents|packages|pull-requests|id-token):\s*write\s*$", chart_text):
    sys.exit("chart CI must not request write permissions")
if re.search(r"(?i)helm\s+(?:package|push)|gh\s+release\s+create|gh-pages|upload-pages-artifact", chart_text):
    sys.exit("chart CI must not publish chart artifacts")

publisher_markers = re.compile(
    r"api\.github\.com/repos/saintdle/helm-charts/dispatches|"
    r"pages\.github\.com|helm\s+(?:package|push)|upload-pages-artifact|"
    r"actions/deploy-pages|gh\s+release\s+create",
    re.IGNORECASE,
)
publisher_workflows = sorted(
    path.name
    for path in workflow_dir.glob("*.yml")
    if publisher_markers.search(path.read_text())
)
if publisher_workflows != ["release.yml"]:
    sys.exit(f"expected release.yml to remain the sole chart publisher; found {publisher_workflows}")
if "Dispatch Helm chart promotion" not in release_text or "saintdle/helm-charts" not in release_text:
    sys.exit("existing helm-charts publisher handoff is missing from release.yml")

print("Chart CI is read-only and release.yml remains the sole chart publisher.")
PY
