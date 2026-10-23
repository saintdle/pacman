import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
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
  const marker = /chart-artifact-source\.mjs publish|api\.github\.com\/repos\/saintdle\/helm-charts\/dispatches|pages\.github\.com|helm\s+(?:package|push)|upload-pages-artifact|actions\/deploy-pages|gh\s+release\s+create/i;
  const publisherFiles = [];

  for (const file of files) {
    const contents = await readFile(path.join(workflowDir, file), 'utf8');
    if (marker.test(contents)) publisherFiles.push(file);
  }

  assert.deepEqual(publisherFiles.sort(), ['chart-artifact-source.yml', 'release.yml']);
  const releaseWorkflow = await readFile(path.join(workflowDir, 'release.yml'), 'utf8');
  const sourceWorkflow = await readFile(path.join(workflowDir, 'chart-artifact-source.yml'), 'utf8');
  assert.match(releaseWorkflow, /Dispatch Helm chart promotion/);
  assert.match(releaseWorkflow, /saintdle\/helm-charts/);
  assert.match(sourceWorkflow, /workflow_run:/);
  assert.match(sourceWorkflow, /node tools\/chart-artifact-source\.mjs validate-candidate/);
  assert.doesNotMatch(sourceWorkflow, /vars\./);
  assert.match(sourceWorkflow, /RELEASE_AUTOMATION_TOKEN/);
});
