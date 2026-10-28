#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
from pathlib import Path
import re
import sys

workflow_dir = Path(".github/workflows")
chart_workflow = workflow_dir / "chart-ci.yml"
release_workflow = workflow_dir / "release.yml"
promotion_workflow = workflow_dir / "chart-source-promotion.yml"
chart_text = chart_workflow.read_text()
release_text = release_workflow.read_text()
promotion_text = promotion_workflow.read_text()

if not re.search(r"(?m)^on:\n  pull_request:\s*\n  push:\n    branches: \[main\]\n    paths:\n      - 'charts/pacman/\*\*'", chart_text):
    sys.exit("chart CI must validate every pull request and main chart-source changes")
if not re.search(r"(?m)^permissions:\n  contents: read\s*$", chart_text):
    sys.exit("chart CI permissions must be read-only contents")
if re.search(r"(?m)^\s+(?:contents|packages|pull-requests|id-token):\s*write\s*$", chart_text):
    sys.exit("chart CI must not request write permissions")
if re.search(r"(?i)helm\s+(?:package|push)|gh\s+release\s+create|gh-pages|upload-pages-artifact", chart_text):
    sys.exit("chart CI must not publish chart artifacts")

publisher_markers = re.compile(
    r"chart-artifact-source\.mjs publish|"
    r"api\.github\.com/repos/saintdle/pacman/dispatches|"
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
if publisher_workflows != ["chart-artifact-source.yml", "release.yml"]:
    sys.exit(f"expected the existing release and guarded chart artifact workflows; found {publisher_workflows}")

notification_match = re.search(
    r"(?ms)^      - name: Notify app-owned chart source promoter\n(?P<step>.*?)(?=^      - (?:name|uses): |\Z)",
    release_text,
)
if notification_match is None:
    sys.exit("app-owned chart source notification step is missing from release.yml")
notification = notification_match.group("step")
notification_contract = (
    (r"(?m)^        if: steps\.policy\.outputs\.dispatch == 'true' && steps\.image\.outcome == 'success'$", "release notification must require the release policy and successful image build"),
    (r"(?m)^          GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}$", "release notification must use the same-app GITHUB_TOKEN"),
    (r'test -n "\$GITHUB_TOKEN"', "release notification must require its GITHUB_TOKEN"),
    (r"payload=\$\(jq -n '\{event_type: \"pacman-release\"\}'\)", "release notification must send only the pacman-release hint"),
    (r"https://api\.github\.com/repos/saintdle/pacman/dispatches", "release notification must target the Pac-Man repository"),
    (r'-H "Authorization: Bearer \$GITHUB_TOKEN"', "release notification must authenticate with GITHUB_TOKEN"),
)
for pattern, message in notification_contract:
    if not re.search(pattern, notification):
        sys.exit(message)
if "RELEASE_AUTOMATION_TOKEN" in notification or "helm-charts" in notification:
    sys.exit("release notification must not use a cross-repository publisher token or destination")

if not re.search(r"(?m)^on:\n  repository_dispatch:\n    types: \[pacman-release\]$", promotion_text):
    sys.exit("app-owned chart source promoter must listen for the pacman-release notification")

print("Chart CI is read-only; release notifications and chart artifact publication use guarded workflows.")
PY
