import assert from 'node:assert/strict';
import test from 'node:test';
import { selectImmutableSourcePackage, validatePacmanChartCandidate } from '../tools/chart-artifact-source.mjs';

const sourceCommit = 'a'.repeat(40);
const event = {
  workflow_run: {
    id: 147,
    head_sha: sourceCommit,
    head_branch: 'main',
    event: 'push',
    conclusion: 'success',
  },
};

function candidateApi({
  value = 'pacman',
  candidateSha = sourceCommit,
  candidateId = 147,
  candidatePath = '.github/workflows/chart-ci.yml',
  candidateBranch = 'main',
  candidateEvent = 'push',
  candidateStatus = 'completed',
  candidateConclusion = 'success',
  candidate = true,
} = {}) {
  return async (url) => {
    if (url.endsWith('/actions/variables?per_page=1')) return { ok: true, status: 200 };
    if (url.includes('/actions/variables/PACMAN_CHART_PUBLISHER_AUTHORITY')) {
      return { ok: true, status: 200, json: async () => ({ value }) };
    }
    if (url.includes('/actions/workflows/chart-ci.yml/runs')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ workflow_runs: candidate ? [{
          id: candidateId,
          head_sha: candidateSha,
          head_branch: candidateBranch,
          event: candidateEvent,
          status: candidateStatus,
          conclusion: candidateConclusion,
          path: candidatePath,
        }] : [] }),
      };
    }
    throw new Error(`unexpected API request ${url}`);
  };
}

test('chart artifact candidate accepts exact GitHub main workflow identities and verifies the successful main push run', async () => {
  for (const candidatePath of [
    '.github/workflows/chart-ci.yml',
    '.github/workflows/chart-ci.yml@main',
    '.github/workflows/chart-ci.yml@refs/heads/main',
  ]) {
    const valid = await validatePacmanChartCandidate({ event, token: 'fixture', fetch: candidateApi({ candidatePath }) });
    assert.deepEqual(valid, { active: true, authority: 'pacman', sourceCommit, runId: '147' });
  }

  await assert.rejects(validatePacmanChartCandidate({
    event, token: 'fixture', fetch: candidateApi({ candidateSha: 'b'.repeat(40) }),
  }), /no successful chart-ci\.yml run exists/);
  await assert.rejects(validatePacmanChartCandidate({
    event, token: 'fixture', fetch: candidateApi({ candidate: false }),
  }), /no successful chart-ci\.yml run exists/);
  for (const candidatePath of [
    '.github/workflows/other.yml',
    '.github/workflows/chart-ci.yml@feature',
    '.github/workflows/chart-ci.yml@refs/heads/feature',
    '.github/workflows/chart-ci.yml@refs/tags/main',
    '.github/workflows/chart-ci.yml@main/extra',
    '.github/workflows/chart-ci.yml@@main',
  ]) {
    await assert.rejects(validatePacmanChartCandidate({
      event, token: 'fixture', fetch: candidateApi({ candidatePath }),
    }), /no successful chart-ci\.yml run exists/);
  }
  for (const changed of [
    { candidateId: 148 },
    { candidateBranch: 'feature' },
    { candidateEvent: 'pull_request' },
    { candidateStatus: 'in_progress' },
    { candidateConclusion: 'failure' },
  ]) {
    await assert.rejects(validatePacmanChartCandidate({
      event, token: 'fixture', fetch: candidateApi(changed),
    }), /no successful chart-ci\.yml run exists/);
  }
  for (const workflowRun of [
    { ...event.workflow_run, head_branch: 'feature' },
    { ...event.workflow_run, event: 'pull_request' },
    { ...event.workflow_run, conclusion: 'failure' },
  ]) {
    await assert.rejects(validatePacmanChartCandidate({
      event: { workflow_run: workflowRun }, token: 'fixture', fetch: candidateApi(),
    }), /workflow_run must be a successful push/);
  }
});

test('legacy authority skips candidate publication work', async () => {
  const result = await validatePacmanChartCandidate({ event, token: 'fixture', fetch: candidateApi({ value: 'helm-charts' }) });
  assert.deepEqual(result, { active: false, authority: 'helm-charts' });
});

test('replay verifies the stored immutable package instead of rebuilding a timestamped Helm archive', async () => {
  const existing = Buffer.from('stored package bytes');
  let builds = 0;
  const inspected = [];
  const selected = await selectImmutableSourcePackage({
    existingPackage: existing,
    buildPackage: () => { builds += 1; return Buffer.from('new archive bytes'); },
    inspectPackage: (bytes) => { inspected.push(Buffer.from(bytes)); },
  });

  assert.deepEqual(selected, existing);
  assert.equal(builds, 0);
  assert.deepEqual(inspected, [existing]);
});

test('a first publication still creates and validates the package when no immutable asset exists', async () => {
  let builds = 0;
  const selected = await selectImmutableSourcePackage({
    existingPackage: null,
    buildPackage: () => { builds += 1; return Buffer.from('new archive bytes'); },
    inspectPackage: () => {},
  });
  assert.deepEqual(selected, Buffer.from('new archive bytes'));
  assert.equal(builds, 1);
});
