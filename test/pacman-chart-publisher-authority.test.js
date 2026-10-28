import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('chart validation runs on pull requests and main chart commits with read-only permissions', async () => {
  const workflow = await readFile(path.join(repoRoot, '.github/workflows/chart-ci.yml'), 'utf8');

  assert.match(workflow, /^on:\n {2}pull_request:\s*\n {2}push:\n {4}branches: \[main\]/m);
  assert.match(workflow, /paths:\n {6}- 'charts\/pacman\/\*\*'/);
  assert.match(workflow, /^permissions:\n {2}contents: read\s*$/m);
  assert.doesNotMatch(workflow, /^\s+(?:contents|packages|pull-requests|id-token):\s*write\s*$/m);
  assert.match(workflow, /name: chart-contracts/);
  assert.match(workflow, /name: chart-lifecycle \(\$\{\{ matrix\.database \}\}\)/);
  assert.match(workflow, /tools\/check-pacman-lifecycle\.sh "\$CHART_DIR" \. "\$DATABASE"/);
  assert.doesNotMatch(workflow, /PACMAN_SOURCE_SHA|e05647623417f620ec0b156c9e7551ec5ad040dd/);
});

test('chart CI is only a candidate validator; publisher jobs have one authority guard', async () => {
  const workflowDir = path.join(repoRoot, '.github/workflows');
  const files = (await readdir(workflowDir)).filter((file) => file.endsWith('.yml'));
  const marker = /chart-artifact-source\.mjs publish|api\.github\.com\/repos\/saintdle\/pacman\/dispatches|pages\.github\.com|helm\s+(?:package|push)|upload-pages-artifact|actions\/deploy-pages|gh\s+release\s+create/i;
  const publisherFiles = [];

  for (const file of files) {
    const contents = await readFile(path.join(workflowDir, file), 'utf8');
    if (marker.test(contents)) publisherFiles.push(file);
  }

  assert.deepEqual(publisherFiles.sort(), ['chart-artifact-source.yml', 'release.yml']);
  const releaseWorkflow = await readFile(path.join(workflowDir, 'release.yml'), 'utf8');
  const sourceWorkflow = await readFile(path.join(workflowDir, 'chart-artifact-source.yml'), 'utf8');
  const promotionWorkflow = await readFile(path.join(workflowDir, 'chart-source-promotion.yml'), 'utf8');
  assert.match(releaseWorkflow, /Notify app-owned chart source promoter/);
  assert.match(releaseWorkflow, /if: steps\.policy\.outputs\.dispatch == 'true' && steps\.image\.outcome == 'success'/);
  assert.match(releaseWorkflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(releaseWorkflow, /https:\/\/api\.github\.com\/repos\/saintdle\/pacman\/dispatches/);
  assert.doesNotMatch(releaseWorkflow, /RELEASE_AUTOMATION_TOKEN|saintdle\/helm-charts/);
  assert.match(promotionWorkflow, /repository_dispatch:\n\s+types: \[pacman-release\]/);
  assert.match(promotionWorkflow, /EVENT_RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \|\| '' \}\}/);
  assert.match(promotionWorkflow, /gh release list --repo saintdle\/pacman --limit 1 --exclude-drafts --exclude-pre-releases/);
  assert.match(promotionWorkflow, /node tools\/release-records\.js verify-app/);
  assert.doesNotMatch(promotionWorkflow, /github\.event\.client_payload/);
  assert.match(sourceWorkflow, /workflow_run:/);
  assert.match(sourceWorkflow, /node tools\/chart-artifact-source\.mjs validate-candidate/);
  assert.doesNotMatch(sourceWorkflow, /vars\./);
  assert.match(sourceWorkflow, /RELEASE_AUTOMATION_TOKEN/);
});

test('publisher authority checker accepts the guarded app notification and rejects broken authority contracts', () => {
  const workflowNames = ['chart-ci.yml', 'release.yml', 'chart-artifact-source.yml', 'chart-source-promotion.yml'];
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), 'pacman-publisher-authority-'));
  const fixtureWorkflowDir = path.join(fixtureRoot, '.github', 'workflows');
  const fixtureChecker = path.join(fixtureRoot, 'tools', 'check-pacman-publisher-authority.sh');
  const originalWorkflows = Object.fromEntries(workflowNames.map((name) => [
    name,
    readFileSync(path.join(repoRoot, '.github', 'workflows', name), 'utf8'),
  ]));

  mkdirSync(fixtureWorkflowDir, { recursive: true });
  mkdirSync(path.dirname(fixtureChecker), { recursive: true });
  for (const [name, contents] of Object.entries(originalWorkflows)) {
    writeFileSync(path.join(fixtureWorkflowDir, name), contents);
  }
  writeFileSync(fixtureChecker, readFileSync(path.join(repoRoot, 'tools', 'check-pacman-publisher-authority.sh'), 'utf8'));

  const runChecker = () => spawnSync('bash', [fixtureChecker], { cwd: fixtureRoot, encoding: 'utf8' });
  const expectRejected = (name, workflowName, mutate, message) => {
    const mutated = mutate(originalWorkflows[workflowName]);
    assert.notEqual(mutated, originalWorkflows[workflowName], `${name} fixture must change the workflow`);
    writeFileSync(path.join(fixtureWorkflowDir, workflowName), mutated);
    const result = runChecker();
    assert.notEqual(result.status, 0, `${name} must be rejected`);
    assert.match(result.stderr, message, `${name} must fail for its authority contract`);
    writeFileSync(path.join(fixtureWorkflowDir, workflowName), originalWorkflows[workflowName]);
  };

  try {
    const positive = runChecker();
    assert.equal(positive.status, 0, positive.stderr);
    assert.match(positive.stdout, /Chart CI is read-only/);

    expectRejected(
      'wrong notification destination',
      'release.yml',
      (workflow) => workflow.replace('api.github.com/repos/saintdle/pacman/dispatches', 'api.github.com/repos/saintdle/other/dispatches'),
      /target the Pac-Man repository/,
    );
    expectRejected(
      'missing release success guard',
      'release.yml',
      (workflow) => workflow.replace("if: steps.policy.outputs.dispatch == 'true' && steps.image.outcome == 'success'", 'if: always()'),
      /release notification must require the release policy and successful image build/,
    );
    expectRejected(
      'wrong notification token',
      'release.yml',
      (workflow) => workflow.replace('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}', 'GITHUB_TOKEN: ${{ secrets.WRONG_TOKEN }}'),
      /release notification must use the same-app GITHUB_TOKEN/,
    );
    expectRejected(
      'reintroduced cross-repository notification token',
      'release.yml',
      (workflow) => workflow.replace(
        '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n',
        '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          RELEASE_AUTOMATION_TOKEN: ${{ secrets.RELEASE_AUTOMATION_TOKEN }}\n',
      ),
      /release notification must not use a cross-repository publisher token or destination/,
    );
    expectRejected(
      'mismatched promoter event',
      'chart-source-promotion.yml',
      (workflow) => workflow.replace('types: [pacman-release]', 'types: [other-release]'),
      /must listen for the pacman-release notification/,
    );
    expectRejected(
      'writable chart CI permissions',
      'chart-ci.yml',
      (workflow) => workflow.replace('contents: read', 'contents: write'),
      /chart CI permissions must be read-only contents/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
