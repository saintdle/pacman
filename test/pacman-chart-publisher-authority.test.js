import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('chart validation reports on every pull request with read-only permissions', async () => {
  const workflow = await readFile(path.join(repoRoot, '.github/workflows/chart-ci.yml'), 'utf8');

  assert.match(workflow, /^on:\n {2}pull_request:\s*$/m);
  assert.doesNotMatch(workflow, /^ {2}(?:push|workflow_dispatch|schedule):/m);
  assert.match(workflow, /^permissions:\n {2}contents: read\s*$/m);
  assert.doesNotMatch(workflow, /^\s+(?:contents|packages|pull-requests|id-token):\s*write\s*$/m);
  assert.match(workflow, /name: chart-contracts/);
  assert.match(workflow, /name: chart-lifecycle \(\$\{\{ matrix\.database \}\}\)/);
  assert.match(workflow, /tools\/check-pacman-lifecycle\.sh "\$CHART_DIR" \. "\$DATABASE"/);
  assert.doesNotMatch(workflow, /PACMAN_SOURCE_SHA|e05647623417f620ec0b156c9e7551ec5ad040dd/);
});

test('only the existing release workflow references chart publication', async () => {
  const workflowDir = path.join(repoRoot, '.github/workflows');
  const files = (await readdir(workflowDir)).filter((file) => file.endsWith('.yml'));
  const marker = /api\.github\.com\/repos\/saintdle\/helm-charts\/dispatches|pages\.github\.com|helm\s+(?:package|push)|upload-pages-artifact|actions\/deploy-pages|gh\s+release\s+create/i;
  const publisherFiles = [];

  for (const file of files) {
    const contents = await readFile(path.join(workflowDir, file), 'utf8');
    if (marker.test(contents)) publisherFiles.push(file);
  }

  assert.deepEqual(publisherFiles.sort(), ['release.yml']);
  const releaseWorkflow = await readFile(path.join(workflowDir, 'release.yml'), 'utf8');
  assert.match(releaseWorkflow, /Dispatch Helm chart promotion/);
  assert.match(releaseWorkflow, /saintdle\/helm-charts/);
});
