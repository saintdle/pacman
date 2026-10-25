import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baselineSha = '4cc1b880ca6ca7359869057a1f4e822d9fd00ed4';
const baselineRepo = process.env.PACMAN_MIGRATION_BASELINE_REPO;
const sourceRepo = process.env.PACMAN_PINNED_SOURCE_REPO;
const candidateChart = process.env.PACMAN_CANDIDATE_CHART;
const enabled = Boolean(baselineRepo && sourceRepo && candidateChart);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function runOk(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr}`);
  return result.stdout;
}

function runRejected(command, args, expectedMessage, options = {}) {
  const result = run(command, args, options);
  assert.notEqual(result.status, 0, `${command} ${args.join(' ')} unexpectedly passed`);
  assert.match(result.stderr, expectedMessage);
}

function replaceExactlyOnce(contents, pattern, replacement, label) {
  const matches = contents.match(pattern);
  assert.equal(matches?.length, 1, `${label} must appear once in the fixture`);
  return contents.replace(pattern, replacement);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('current chart edits pass candidate contracts while migration parity stays pinned', {
  skip: enabled ? false : 'requires the two pinned chart checkouts provided by chart-ci',
}, () => {
  const workflow = readFileSync(path.join(repoRoot, '.github/workflows/chart-ci.yml'), 'utf8');
  const equivalence = readFileSync(path.join(repoRoot, 'tools/check-pacman-chart-equivalence.sh'), 'utf8');
  assert.match(workflow, new RegExp(`ref: \\$\\{\\{ env\\.MIGRATION_BASELINE_SHA \\}\\}[\\s\\S]*?path: migration-baseline[\\s\\S]*?fetch-depth: 0`));
  assert.match(workflow, new RegExp(`MIGRATION_BASELINE_SHA: ${baselineSha}`));
  assert.match(equivalence, new RegExp(`baseline_sha="${baselineSha}"`));
  assert.match(workflow, /run: node --test test\/pacman-chart-migration-baseline\.test\.js/);
  assert.match(workflow, /tools\/check-pacman-probes\.sh "\$CHART_DIR"/);
  assert.match(workflow, /tools\/check-pacman-postgres-migration\.sh "\$CHART_DIR"/);
  assert.match(workflow, /tools\/check-pacman-fault-demo\.sh "\$CHART_DIR"/);
  assert.match(workflow, /tools\/check-pacman-optional-resources\.sh "\$CHART_DIR"/);
  assert.match(workflow, /tools\/check-pacman-lifecycle\.sh "\$CHART_DIR" \. "\$DATABASE"/);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pacman-chart-baseline-test-'));
  const changedCandidate = path.join(tempDir, 'changed-candidate');
  const badBaseline = path.join(tempDir, 'tampered-baseline');
  const chartParity = path.join(repoRoot, 'tools/check-pacman-chart-equivalence.sh');
  const currentHead = runOk('git', ['rev-parse', 'HEAD']).trim();
  let changedCandidateAdded = false;
  let badBaselineAdded = false;

  try {
    runOk('git', ['worktree', 'add', '--detach', changedCandidate, currentHead]);
    changedCandidateAdded = true;
    const changedChart = path.resolve(changedCandidate, candidateChart);

    const readmePath = path.join(changedChart, 'README.md');
    writeFileSync(readmePath, `${readFileSync(readmePath, 'utf8')}\n<!-- editable chart documentation fixture -->\n`);

    const chartYamlPath = path.join(changedChart, 'Chart.yaml');
    const chartYaml = readFileSync(chartYamlPath, 'utf8');
    const chartVersion = chartYaml.match(/^version: (\d+\.\d+\.\d+)$/m)?.[1];
    const appVersion = chartYaml.match(/^appVersion: "(\d+\.\d+\.\d+)"$/m)?.[1];
    assert.ok(chartVersion, 'candidate chart has a semantic version');
    assert.ok(appVersion, 'candidate chart has an app version');
    const bumpPatch = (version) => version.replace(/(\d+)$/, (patch) => String(Number(patch) + 1));
    let promotedChartYaml = replaceExactlyOnce(chartYaml, new RegExp(`^version: ${escapeRegex(chartVersion)}$`, 'gm'), `version: ${bumpPatch(chartVersion)}`, 'chart version');
    promotedChartYaml = replaceExactlyOnce(promotedChartYaml, new RegExp(`^appVersion: "${escapeRegex(appVersion)}"$`, 'gm'), `appVersion: "${bumpPatch(appVersion)}"`, 'app version');
    writeFileSync(chartYamlPath, promotedChartYaml);

    const valuesYamlPath = path.join(changedChart, 'values.yaml');
    const valuesYaml = readFileSync(valuesYamlPath, 'utf8');
    const currentDigest = valuesYaml.match(/^  digest: "sha256:([a-f0-9]{64})"$/m)?.[1];
    assert.ok(currentDigest, 'candidate chart has a pinned image digest');
    const updatedDigest = currentDigest === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64);
    writeFileSync(valuesYamlPath, replaceExactlyOnce(valuesYaml, /^  digest: "sha256:[a-f0-9]{64}"$/gm, `  digest: "sha256:${updatedDigest}"`, 'image digest'));

    runOk('helm', ['lint', changedChart]);
    for (const contract of ['probes', 'postgres-migration', 'fault-demo', 'optional-resources']) {
      runOk('bash', [`tools/check-pacman-${contract}.sh`, changedChart]);
    }

    runOk('bash', [chartParity, baselineRepo, sourceRepo]);
    runRejected('bash', [chartParity, repoRoot, sourceRepo], /migration baseline checkout must be/);

    runOk('git', ['-C', baselineRepo, 'worktree', 'add', '--detach', badBaseline, baselineSha]);
    badBaselineAdded = true;
    const baselineReadmePath = path.join(badBaseline, 'charts/pacman/README.md');
    writeFileSync(baselineReadmePath, `${readFileSync(baselineReadmePath, 'utf8')}\n<!-- tampered migration baseline fixture -->\n`);
    runRejected('bash', [chartParity, badBaseline, sourceRepo], /migration baseline differs from pinned chart source/);
  } finally {
    if (badBaselineAdded) runOk('git', ['-C', baselineRepo, 'worktree', 'remove', '--force', badBaseline]);
    if (changedCandidateAdded) runOk('git', ['worktree', 'remove', '--force', changedCandidate]);
    rmSync(tempDir, { recursive: true, force: true });
  }
});
