import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appReleaseRecordReference, serializeAppReleaseRecord, sha256Hex } from '../tools/release-records.js';
import { publishPacmanChartArtifact, selectImmutableSourcePackage, validatePacmanChartCandidate } from '../tools/chart-artifact-source.mjs';

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

test('every existing Helm setup action remains pinned to the reviewed v5 commit', () => {
  const workflows = [
    readFileSync(new URL('../.github/workflows/chart-ci.yml', import.meta.url), 'utf8'),
    readFileSync(new URL('../.github/workflows/chart-artifact-source.yml', import.meta.url), 'utf8'),
  ].join('\n');
  const helmSetupReferences = [...workflows.matchAll(/^ {8}uses: azure\/setup-helm@[^\n]+$/gm)].map(([reference]) => reference.trim());
  assert.deepEqual(helmSetupReferences, Array(3).fill('uses: azure/setup-helm@9bc31f4ebc9c6b171d7bfbaa5d006ae7abdb4310 # v5'));
});

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

test('publishPacmanChartArtifact sends a bounded v1 envelope and replays workflow_run/workflow_dispatch from the original source without rebuilding or uploading', async () => {
  const originalSourceCommit = 'a405d8d66d63c8d121ed993f55583a6ff634c86d';
  const chartVersion = '0.7.20';
  const appVersion = '0.7.17';
  const imageDigest = 'sha256:2a55f4d74bc05dea3ae05912fbdcbe9348f9aafb752902054a7f066cfa112f68';
  const packageBytes = Buffer.from('existing immutable chart package bytes');
  const packageChecksum = createHash('sha256').update(packageBytes).digest('hex');
  const appRecord = JSON.parse(readFileSync(new URL('./fixtures/release-records/app-release-record.json', import.meta.url), 'utf8'));
  appRecord.app_version = appVersion;
  appRecord.tag = `pacman-v${appVersion}`;
  appRecord.source.commit = originalSourceCommit;
  appRecord.image.manifest_list_digest = imageDigest;
  appRecord.signature_reference = `docker://${appRecord.image.repository}@${imageDigest}`;
  const appRecordBytes = Buffer.from(serializeAppReleaseRecord(appRecord));
  const appRecordReference = appReleaseRecordReference(appRecord);
  const appRecordChecksum = sha256Hex(appRecordBytes);
  const identity = {
    schema_version: 1,
    kind: 'pacman-chart-source-package',
    chart_version: chartVersion,
    source_commit: originalSourceCommit,
    package_sha256: packageChecksum,
    app_record_reference: appRecordReference,
    app_record_sha256: appRecordChecksum,
    image_digest: imageDigest,
  };
  const identityBytes = Buffer.from(`${JSON.stringify(identity)}\n`);
  const identityChecksum = sha256Hex(identityBytes);
  const identityFilename = `pacman-${chartVersion}.tgz.identity.json`;
  const metadataBytes = Buffer.from(JSON.stringify({
    version: appVersion,
    tag: appRecord.tag,
    app_record_ref: appRecordReference,
    app_record_sha256: appRecordChecksum,
    image_digest: imageDigest,
    commit: originalSourceCommit,
  }));
  const assetBytes = new Map([
    ['app-release-record.json', appRecordBytes],
    ['release-metadata.json', metadataBytes],
    [`pacman-${chartVersion}.tgz`, packageBytes],
    [identityFilename, identityBytes],
  ]);
  const assets = [...assetBytes].map(([name], index) => ({
    id: index + 1,
    name,
    url: `https://api.github.com/repos/saintdle/pacman/releases/assets/${index + 1}`,
    ...(name === `pacman-${chartVersion}.tgz` ? { label: `chart-source-identity-sha256-${identityChecksum}` } : {}),
  }));
  const release = {
    tag_name: `pacman-v${appVersion}`,
    draft: false,
    prerelease: false,
    upload_url: 'https://uploads.github.com/repos/saintdle/pacman/releases/1/assets{?name,label}',
    assets,
  };
  const originalWorkflowRunEvent = {
    ...event,
    workflow_run: { ...event.workflow_run, head_sha: originalSourceCommit },
  };
  const dispatches = [];
  const transportViolations = [];
  const uploads = [];
  const workflowQueries = [];
  const releaseReads = [];
  const runCalls = [];
  let rejectDispatch = false;
  const sourceRoot = mkdtempSync(join(tmpdir(), 'pacman-chart-source-publish-'));
  const chartDirectory = join(sourceRoot, 'charts/pacman');
  mkdirSync(chartDirectory, { recursive: true });
  writeFileSync(join(chartDirectory, 'Chart.yaml'), `apiVersion: v2\nname: pacman\nversion: ${chartVersion}\nappVersion: "${appVersion}"\n`);
  writeFileSync(join(chartDirectory, 'values.yaml'), `image:\n  repository: docker.io/saintdle/pacman\n  digest: "${imageDigest}"\n`);

  const fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/actions/variables')) return { ok: true, status: 200 };
    if (parsed.pathname.endsWith('/actions/variables/PACMAN_CHART_PUBLISHER_AUTHORITY')) {
      return { ok: true, status: 200, json: async () => ({ value: 'pacman' }) };
    }
    if (parsed.pathname.endsWith('/actions/workflows/chart-ci.yml/runs')) {
      workflowQueries.push(parsed.searchParams.get('head_sha'));
      return {
        ok: true,
        status: 200,
        json: async () => ({ workflow_runs: [{
          id: 147,
          head_sha: originalSourceCommit,
          head_branch: 'main',
          event: 'push',
          status: 'completed',
          conclusion: 'success',
          path: '.github/workflows/chart-ci.yml',
        }] }),
      };
    }
    if (parsed.pathname.endsWith(`/releases/tags/pacman-v${appVersion}`)) {
      releaseReads.push(parsed.pathname);
      return { ok: true, status: 200, json: async () => release };
    }
    const assetId = parsed.pathname.match(/\/releases\/assets\/(\d+)$/)?.[1];
    if (assetId) {
      const filename = assets.find((asset) => String(asset.id) === assetId)?.name;
      const bytes = assetBytes.get(filename);
      return { ok: true, status: 200, arrayBuffer: async () => bytes };
    }
    if (parsed.pathname === '/repos/saintdle/pacman/releases/1/assets') {
      uploads.push({ method: options.method, path: parsed.pathname });
      return { ok: true, status: 201, json: async () => ({}) };
    }
    if (parsed.pathname === '/repos/saintdle/helm-charts/dispatches') {
      const body = JSON.parse(options.body);
      const properties = Object.keys(body.client_payload ?? {}).length;
      const bytes = Buffer.byteLength(options.body, 'utf8');
      if (rejectDispatch) {
        return { ok: false, status: 422, json: async () => ({ message: 'response-secret?private=query' }) };
      }
      if (properties > 10 || bytes >= 65536) {
        transportViolations.push({ properties, bytes });
        return { ok: false, status: 422, json: async () => ({ message: 'mock response body must not escape' }) };
      }
      dispatches.push({ body, bytes });
      return { ok: true, status: 204 };
    }
    throw new Error(`unexpected mocked request ${options.method ?? 'GET'} ${parsed.pathname}`);
  };
  const run = (command, args, _options) => {
    runCalls.push([command, ...args]);
    if (command === 'git' && args[0] === 'rev-parse') return `${originalSourceCommit}\n`;
    if (command === 'helm' && args[0] === 'show' && args[1] === 'chart') return `version: ${chartVersion}\nappVersion: "${appVersion}"\n`;
    if (command === 'helm' && args[0] === 'show' && args[1] === 'values') return `image:\n  digest: "${imageDigest}"\n`;
    if (command === 'helm' && args[0] === 'package') throw new Error('existing immutable package must not be rebuilt');
    throw new Error(`unexpected injected command ${command} ${args.join(' ')}`);
  };

  try {
    for (const sourceEvent of [originalWorkflowRunEvent, { inputs: { source_commit: originalSourceCommit } }]) {
      const result = await publishPacmanChartArtifact({ event: sourceEvent, sourceRoot, token: 'fixture', fetch, run });
      assert.equal(result.status, 'dispatched');
      assert.equal(result.sourceCommit, originalSourceCommit);
    }
    rejectDispatch = true;
    await assert.rejects(
      publishPacmanChartArtifact({ event: originalWorkflowRunEvent, sourceRoot, token: 'fixture', fetch, run }),
      (error) => {
        assert.equal(error.message, 'POST /repos/saintdle/helm-charts/dispatches failed: HTTP 422');
        assert.doesNotMatch(error.message, /fixture|response-secret|private=query/);
        return true;
      },
    );
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }

  const expectedArtifact = {
    chart_name: 'pacman',
    chart_version: chartVersion,
    app_version: appVersion,
    image_digest: imageDigest,
    source_repository: 'saintdle/pacman',
    source_commit: originalSourceCommit,
    source_package_reference: `https://github.com/saintdle/pacman/releases/download/pacman-v${appVersion}/pacman-${chartVersion}.tgz`,
    package_sha256: packageChecksum,
    app_record_reference: appRecordReference,
    app_record_sha256: appRecordChecksum,
    source_identity_reference: `https://github.com/saintdle/pacman/releases/download/pacman-v${appVersion}/${identityFilename}`,
    source_identity_sha256: identityChecksum,
  };
  assert.deepEqual(dispatches.map(({ body }) => body), [
    { event_type: 'pacman-chart-artifact', client_payload: { schema_version: 1, artifact: expectedArtifact } },
    { event_type: 'pacman-chart-artifact', client_payload: { schema_version: 1, artifact: expectedArtifact } },
  ]);
  assert.ok(dispatches.every(({ bytes }) => bytes < 65536));
  assert.deepEqual(transportViolations, [], 'the documented GitHub transport boundary accepts the new envelope');
  assert.deepEqual(workflowQueries, [originalSourceCommit, originalSourceCommit, originalSourceCommit], 'automatic and explicit replay validate the exact original source SHA');
  assert.equal(releaseReads.length, 6, 'each run verifies the original release before and after dispatch');
  assert.deepEqual(uploads, [], 'existing immutable package and identity assets are reused without overwrite');
  assert.equal(runCalls.filter(([, ...args]) => args[0] === 'package').length, 0, 'existing package is reused without rebuilding');
  assert.deepEqual(assetBytes.get(`pacman-${chartVersion}.tgz`), packageBytes);
  assert.deepEqual(assetBytes.get(identityFilename), identityBytes);
});
