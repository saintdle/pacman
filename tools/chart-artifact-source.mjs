import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appReleaseRecordReference, parseAppReleaseRecord, serializeAppReleaseRecord, sha256Hex } from './release-records.js';
import { readDistributionChartPublisherAuthority } from './chart-publisher-authority.mjs';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const apiBase = 'https://api.github.com';
const dispatchPath = '/repos/saintdle/helm-charts/dispatches';
const maxDispatchProperties = 10;
const maxDispatchBytes = 65536;

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceIdentityFilename(chartVersion) {
  return `pacman-${chartVersion}.tgz.identity.json`;
}

function sourcePackageIdentity({ chartSource, sourceCommit, packageChecksum, appRecord }) {
  return {
    schema_version: 1,
    kind: 'pacman-chart-source-package',
    chart_version: chartSource.chartVersion,
    source_commit: sourceCommit,
    package_sha256: packageChecksum,
    app_record_reference: appRecord.reference,
    app_record_sha256: appRecord.checksum,
    image_digest: chartSource.imageDigest,
  };
}

function serializeSourcePackageIdentity(identity) {
  return Buffer.from(`${JSON.stringify(identity)}\n`);
}

function verifySourcePackageIdentity(bytes, expected) {
  let identity;
  try { identity = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { fail('chart package identity sidecar is not JSON'); }
  if (serializeSourcePackageIdentity(identity).toString('utf8') !== Buffer.from(bytes).toString('utf8')
    || JSON.stringify(identity) !== JSON.stringify(expected)) fail('chart package identity sidecar does not match the exact verified source and package');
  return identity;
}

function parseChartSource(chartYaml, valuesYaml) {
  const chartVersion = chartYaml.match(/^version:\s*['"]?([^\s'"]+)['"]?\s*$/m)?.[1];
  const appVersion = chartYaml.match(/^appVersion:\s*['"]?([^\s'"]+)['"]?\s*$/m)?.[1];
  const imageDigest = valuesYaml.match(/^\s+digest:\s*['"]?(sha256:[a-f0-9]{64})['"]?\s*$/m)?.[1];
  if (!versionPattern.test(chartVersion ?? '') || !versionPattern.test(appVersion ?? '') || !digestPattern.test(imageDigest ?? '')) {
    fail('chart source must declare canonical chart/app versions and a pinned image digest');
  }
  return { chartVersion, appVersion, imageDigest };
}

async function request(url, { token, fetch: fetchRequest = fetch, body, method = 'GET', accept = 'application/vnd.github+json', contentType = 'application/json', allow404 = false } = {}) {
  if (!token) fail('RELEASE_AUTOMATION_TOKEN is required for chart artifact handoff');
  let response;
  try {
    response = await fetchRequest(url.startsWith('http') ? url : `${apiBase}${url}`, {
      method,
      body,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': contentType } : {}),
      },
    });
  } catch {
    fail(`${method} ${safeRequestPath(url)} failed: network error`);
  }
  if (allow404 && response.status === 404) return null;
  if (!response.ok) fail(`${method} ${safeRequestPath(url)} failed: HTTP ${response.status}`);
  if (response.status === 204) return null;
  if (accept === 'application/octet-stream') return Buffer.from(await response.arrayBuffer());
  return response.json();
}

function safeRequestPath(url) {
  try {
    return new URL(url.startsWith('http') ? url : `${apiBase}${url}`).pathname;
  } catch {
    return '/<invalid-url>';
  }
}

function serializeRepositoryDispatch(payload) {
  const propertyCount = Object.keys(payload.client_payload).length;
  if (propertyCount > maxDispatchProperties) {
    fail(`POST ${dispatchPath} rejected before request: client_payload has ${propertyCount} properties; limit is ${maxDispatchProperties}`);
  }
  const body = JSON.stringify(payload);
  const byteCount = Buffer.byteLength(body, 'utf8');
  if (byteCount >= maxDispatchBytes) {
    fail(`POST ${dispatchPath} rejected before request: request body is ${byteCount} UTF-8 bytes; limit is less than ${maxDispatchBytes}`);
  }
  return body;
}

async function verifyCandidateRun({ sourceCommit, event, token, fetch: fetchRequest = fetch }) {
  if (!commitPattern.test(sourceCommit ?? '')) fail('chart source must be a full lowercase commit SHA');
  const workflowRun = event.workflow_run;
  if (workflowRun && (workflowRun.head_sha !== sourceCommit || workflowRun.head_branch !== 'main'
    || workflowRun.event !== 'push' || workflowRun.conclusion !== 'success')) {
    fail('chart-ci workflow_run must be a successful push for the exact main source SHA');
  }
  const result = await request(`${apiBase}/repos/saintdle/pacman/actions/workflows/chart-ci.yml/runs?head_sha=${sourceCommit}&branch=main&per_page=100`, { token, fetch: fetchRequest });
  const candidate = result.workflow_runs?.find((run) => (!workflowRun || run.id === workflowRun.id)
    && run.head_sha === sourceCommit && run.head_branch === 'main' && run.event === 'push'
    && run.status === 'completed' && run.conclusion === 'success'
    && [
      '.github/workflows/chart-ci.yml',
      '.github/workflows/chart-ci.yml@main',
      '.github/workflows/chart-ci.yml@refs/heads/main',
    ].includes(run.path));
  if (!candidate) fail(`no successful chart-ci.yml run exists for exact pacman SHA ${sourceCommit} on main`);
  return { sourceCommit, runId: String(candidate.id), ref: 'refs/heads/main', conclusion: 'success' };
}

function verifyReleaseMetadata(recordBytes, metadataBytes, { appVersion, imageDigest }) {
  const record = parseAppReleaseRecord(recordBytes);
  if (serializeAppReleaseRecord(record) !== recordBytes.toString('utf8')) fail('app-release-record.json is not canonical');
  const metadata = JSON.parse(metadataBytes.toString('utf8'));
  const checksum = sha256Hex(recordBytes);
  if (record.app_version !== appVersion || record.tag !== `pacman-v${appVersion}`
    || record.source.repository !== 'https://github.com/saintdle/pacman'
    || record.image.manifest_list_digest !== imageDigest
    || metadata.version !== appVersion || metadata.tag !== record.tag
    || metadata.app_record_ref !== appReleaseRecordReference(record)
    || metadata.app_record_sha256 !== checksum || metadata.image_digest !== imageDigest
    || metadata.commit !== record.source.commit) {
    fail('immutable app release record and metadata do not match the chart source version and image');
  }
  return { record, checksum, reference: appReleaseRecordReference(record) };
}

// Helm archives include timestamps. Once an immutable app-release asset exists, it
// is the only byte identity that may be replayed; rebuilding it is not a check.
export async function selectImmutableSourcePackage({ existingPackage, buildPackage, inspectPackage }) {
  const packageBytes = existingPackage ? Buffer.from(existingPackage) : Buffer.from(await buildPackage());
  await inspectPackage(packageBytes);
  return packageBytes;
}

async function releaseAsset(release, filename, token, fetchRequest) {
  const assets = release.assets.filter((asset) => asset.name === filename);
  if (assets.length > 1) fail(`release ${release.tag_name} contains duplicate ${filename} assets`);
  if (!assets.length) return null;
  return request(assets[0].url, { token, fetch: fetchRequest, accept: 'application/octet-stream' });
}

function releaseAssetMetadata(release, filename) {
  const assets = release.assets.filter((asset) => asset.name === filename);
  if (assets.length > 1) fail(`release ${release.tag_name} contains duplicate ${filename} assets`);
  return assets[0] ?? null;
}

function sourceIdentityLabel(identityBytes) {
  return `chart-source-identity-sha256-${sha256(identityBytes)}`;
}

async function inspectHelmPackage(packagePath, expected, run = execFileSync) {
  const chart = run('helm', ['show', 'chart', packagePath], { encoding: 'utf8' });
  const values = run('helm', ['show', 'values', packagePath], { encoding: 'utf8' });
  const packageIdentity = parseChartSource(chart, values);
  if (packageIdentity.chartVersion !== expected.chartVersion || packageIdentity.appVersion !== expected.appVersion
    || packageIdentity.imageDigest !== expected.imageDigest) fail('Helm package metadata does not match the verified Pacman source and app release');
  return packageIdentity;
}

export async function publishPacmanChartArtifact({ event, sourceRoot, token, fetch: fetchRequest = fetch, run = execFileSync }) {
  const authority = await readDistributionChartPublisherAuthority({ token, fetch: fetchRequest });
  if (authority !== 'pacman') return { status: 'skipped', reason: `distribution authority is ${authority}` };
  const workflowRun = event.workflow_run;
  const sourceCommit = workflowRun?.head_sha ?? event.inputs?.source_commit ?? process.env.GITHUB_SHA;
  const candidate = await verifyCandidateRun({ sourceCommit, event, token, fetch: fetchRequest });
  const checkedOutCommit = run('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  if (checkedOutCommit !== sourceCommit) fail('checked-out Pacman source does not match the validated chart-ci SHA');

  const chartSource = parseChartSource(
    readFileSync(join(sourceRoot, 'charts/pacman/Chart.yaml'), 'utf8'),
    readFileSync(join(sourceRoot, 'charts/pacman/values.yaml'), 'utf8'),
  );
  const tag = `pacman-v${chartSource.appVersion}`;
  const release = await request(`/repos/saintdle/pacman/releases/tags/${encodeURIComponent(tag)}`, { token, fetch: fetchRequest });
  if (release.tag_name !== tag || release.draft || release.prerelease) fail(`app release ${tag} is not published`);
  const [appRecordBytes, metadataBytes] = await Promise.all([
    releaseAsset(release, 'app-release-record.json', token, fetchRequest),
    releaseAsset(release, 'release-metadata.json', token, fetchRequest),
  ]);
  if (!appRecordBytes || !metadataBytes) fail(`app release ${tag} has no schema-v1 app record and release metadata`);
  const appRecord = verifyReleaseMetadata(appRecordBytes, metadataBytes, chartSource);

  const tempDirectory = mkdtempSync(join(process.env.RUNNER_TEMP ?? '/tmp', 'pacman-chart-source-'));
  try {
    const packageFilename = `pacman-${chartSource.chartVersion}.tgz`;
    const packagePath = join(tempDirectory, packageFilename);
    const identityFilename = sourceIdentityFilename(chartSource.chartVersion);
    const packageAsset = releaseAssetMetadata(release, packageFilename);
    const [uploadedPackage, uploadedIdentity] = await Promise.all([
      releaseAsset(release, packageFilename, token, fetchRequest),
      releaseAsset(release, identityFilename, token, fetchRequest),
    ]);
    const packageBytes = await selectImmutableSourcePackage({
      existingPackage: uploadedPackage,
      buildPackage: () => {
        run('helm', ['package', join(sourceRoot, 'charts/pacman'), '--destination', tempDirectory], { encoding: 'utf8' });
        return readFileSync(packagePath);
      },
      inspectPackage: (bytes) => {
        writeFileSync(packagePath, bytes);
        return inspectHelmPackage(packagePath, chartSource, run);
      },
    });
    const packageChecksum = sha256(packageBytes);
    const sourceIdentity = sourcePackageIdentity({ chartSource, sourceCommit, packageChecksum, appRecord });
    const identityBytes = serializeSourcePackageIdentity(sourceIdentity);
    const identityLabel = sourceIdentityLabel(identityBytes);
    if (uploadedIdentity) verifySourcePackageIdentity(uploadedIdentity, sourceIdentity);
    if (uploadedPackage && !uploadedIdentity && packageAsset?.label !== identityLabel) {
      fail(`release asset ${packageFilename} has no authoritative chart source identity binding; recovery requires its immutable identity label`);
    }
    if (!uploadedPackage) {
      const uploadUrl = release.upload_url.split('{')[0];
      await request(`${uploadUrl}?name=${encodeURIComponent(packageFilename)}&label=${encodeURIComponent(identityLabel)}`, {
        token,
        fetch: fetchRequest,
        method: 'POST',
        accept: 'application/vnd.github+json',
        contentType: 'application/gzip',
        body: packageBytes,
      });
    }
    if (!uploadedIdentity) {
      const uploadUrl = release.upload_url.split('{')[0];
      await request(`${uploadUrl}?name=${encodeURIComponent(identityFilename)}`, {
        token, fetch: fetchRequest, method: 'POST', accept: 'application/vnd.github+json', contentType: 'application/json', body: identityBytes,
      });
    }
    const refreshedRelease = await request(`/repos/saintdle/pacman/releases/tags/${encodeURIComponent(tag)}`, { token, fetch: fetchRequest });
    const verifiedPackage = await releaseAsset(refreshedRelease, packageFilename, token, fetchRequest);
    if (!verifiedPackage || !verifiedPackage.equals(packageBytes)) fail(`immutable app release asset ${packageFilename} does not match the generated Helm package`);
    const verifiedIdentity = await releaseAsset(refreshedRelease, identityFilename, token, fetchRequest);
    if (!verifiedIdentity || !verifiedIdentity.equals(identityBytes)) fail(`immutable chart source identity sidecar ${identityFilename} was not stored with the exact verified bytes`);
    const sourcePackageReference = `https://github.com/saintdle/pacman/releases/download/${tag}/${packageFilename}`;
    const payload = {
      event_type: 'pacman-chart-artifact',
      client_payload: {
        schema_version: 1,
        artifact: {
          chart_name: 'pacman',
          chart_version: chartSource.chartVersion,
          app_version: chartSource.appVersion,
          image_digest: chartSource.imageDigest,
          source_repository: 'saintdle/pacman',
          source_commit: sourceCommit,
          source_package_reference: sourcePackageReference,
          package_sha256: packageChecksum,
          app_record_reference: appRecord.reference,
          app_record_sha256: appRecord.checksum,
          source_identity_reference: `https://github.com/saintdle/pacman/releases/download/${tag}/${identityFilename}`,
          source_identity_sha256: sha256(identityBytes),
        },
      },
    };
    await request(dispatchPath, {
      token,
      fetch: fetchRequest,
      method: 'POST',
      body: serializeRepositoryDispatch(payload),
    });
    return { status: 'dispatched', sourceCommit, chartVersion: chartSource.chartVersion, appVersion: chartSource.appVersion, packageChecksum, candidateRunId: candidate.runId };
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

export async function validatePacmanChartCandidate({ event, token, fetch: fetchRequest = fetch }) {
  const authority = await readDistributionChartPublisherAuthority({ token, fetch: fetchRequest });
  if (authority !== 'pacman') return { active: false, authority };
  const sourceCommit = event.workflow_run?.head_sha ?? event.inputs?.source_commit ?? process.env.GITHUB_SHA;
  const candidate = await verifyCandidateRun({ sourceCommit, event, token, fetch: fetchRequest });
  return { active: true, authority, sourceCommit, runId: candidate.runId };
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const sourceRoot = process.env.PACMAN_CHART_SOURCE_ROOT ?? process.env.GITHUB_WORKSPACE;
  if (process.argv[2] === 'validate-candidate') {
    const result = await validatePacmanChartCandidate({ event, token: process.env.RELEASE_AUTOMATION_TOKEN });
    const output = process.env.GITHUB_OUTPUT;
    if (output) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(output, `active=${result.active}\n`);
      if (result.sourceCommit) appendFileSync(output, `source_commit=${result.sourceCommit}\n`);
      if (result.runId) appendFileSync(output, `candidate_run_id=${result.runId}\n`);
    }
    console.log(result.active ? `validated candidate ${result.sourceCommit}` : `skipped; helm-charts authority is ${result.authority}`);
    return;
  }
  const result = await publishPacmanChartArtifact({ event, sourceRoot, token: process.env.RELEASE_AUTOMATION_TOKEN });
  console.log(`${result.status}: ${result.reason ?? `${result.chartVersion} from ${result.sourceCommit}`}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
