import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[a-f0-9]{40}$/;
const imageDigestPattern = /^sha256:[a-f0-9]{64}$/;
const packageChecksumPattern = /^[a-f0-9]{64}$/;
const requiredPlatforms = ['linux/amd64', 'linux/arm64'];
const evidenceLanes = [
  'app-manifest-list',
  'app-platform-descriptors',
  'app-provenance',
  'app-signature',
  'chart-package-sha256',
];

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value, name) {
  if (!isObject(value)) fail(`${name} must be an object`);
}

function requireKeys(value, keys, name) {
  requireObject(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${name} must contain exactly these fields: ${expected.join(', ')}`);
  }
}

function requireVersion(value, name) {
  const match = typeof value === 'string' ? versionPattern.exec(value) : null;
  if (!match || match[0] !== value) {
    fail(`${name} must use canonical stable MAJOR.MINOR.PATCH format without leading zeroes`);
  }
}

function chartReleaseTag(tag, version, name) {
  const supported = [`helm-chart-v${version}`, `pacman-${version}`];
  if (!supported.includes(tag)) fail(`${name} must identify the exact chart_version in a supported release tag`);
  return tag;
}

function appReleaseTag(tag, version, name) {
  if (tag !== `pacman-v${version}`) fail(`${name} must identify the exact app_version`);
  return tag;
}

function releaseAsset(value, name) {
  const url = parseUrl(value, name, { githubOnly: true });
  const segments = url.pathname.split('/');
  if (segments.length !== 7 || !segments[1] || !segments[2] || segments[3] !== 'releases' || segments[4] !== 'download') {
    fail(`${name} must identify a GitHub release asset`);
  }
  const repository = requireRepository(`${url.origin}/${segments[1]}/${segments[2]}`, `${name} repository`);
  return { url, repository, tag: segments[5], filename: segments[6] };
}

function requireCommit(value, name) {
  if (typeof value !== 'string' || !commitPattern.test(value)) fail(`${name} must be a full 40-character lowercase commit SHA`);
}

function requireImageDigest(value, name) {
  if (typeof value !== 'string' || !imageDigestPattern.test(value)) fail(`${name} must be a sha256 digest`);
}

function requirePackageChecksum(value, name) {
  if (typeof value !== 'string' || !packageChecksumPattern.test(value)) fail(`${name} must be a 64-character lowercase SHA-256 checksum`);
}

function parseUrl(value, name, { githubOnly = false } = {}) {
  if (typeof value !== 'string' || value.trim() !== value) fail(`${name} must be a URL`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} must be a URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    fail(`${name} must be a credential-free HTTPS URL without query or fragment`);
  }
  if (githubOnly && url.hostname !== 'github.com') fail(`${name} must use github.com`);
  return url;
}

function requireRepository(value, name) {
  const url = parseUrl(value, name, { githubOnly: true });
  if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname)) {
    fail(`${name} must identify a GitHub owner and repository`);
  }
  return url;
}

function requireImageRepository(value, name) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?(?:\/[a-z0-9._-]+)+$/.test(value)) {
    fail(`${name} must be a registry and image repository`);
  }
}

function requireSignatureReference(value, image) {
  const expected = `docker://${image.repository}@${image.manifest_list_digest}`;
  if (value !== expected) fail('signature_reference must identify the image manifest-list digest');
}

function validateAppRecord(record) {
  requireKeys(record, [
    'schema_version', 'kind', 'app_version', 'tag', 'source', 'image',
    'platforms', 'provenance_reference', 'signature_reference',
  ], 'app release record');
  if (record.schema_version !== 1 || record.kind !== 'app-release') fail('app release record must use schema_version 1 and kind app-release');
  requireVersion(record.app_version, 'app_version');
  if (record.tag !== `pacman-v${record.app_version}`) fail('tag must match app_version');

  requireKeys(record.source, ['repository', 'commit'], 'app source');
  requireRepository(record.source.repository, 'app source repository');
  requireCommit(record.source.commit, 'app source commit');

  requireKeys(record.image, ['repository', 'manifest_list_digest'], 'app image');
  requireImageRepository(record.image.repository, 'image repository');
  requireImageDigest(record.image.manifest_list_digest, 'manifest_list_digest');

  if (!Array.isArray(record.platforms) || record.platforms.length < requiredPlatforms.length) {
    fail('platforms must include linux/amd64 and linux/arm64 descriptors');
  }
  const platforms = new Set();
  for (const descriptor of record.platforms) {
    requireKeys(descriptor, ['platform', 'digest'], 'platform descriptor');
    if (typeof descriptor.platform !== 'string' || !/^[a-z0-9]+\/[a-z0-9]+(?:\/v[0-9]+)?$/.test(descriptor.platform)) {
      fail('platform descriptor platform must use os/architecture format');
    }
    if (platforms.has(descriptor.platform)) fail(`duplicate platform descriptor: ${descriptor.platform}`);
    platforms.add(descriptor.platform);
    requireImageDigest(descriptor.digest, `platform ${descriptor.platform} digest`);
  }
  for (const platform of requiredPlatforms) {
    if (!platforms.has(platform)) fail(`platform descriptors must include ${platform}`);
  }

  const provenance = parseUrl(record.provenance_reference, 'provenance_reference', { githubOnly: true });
  const runPrefix = `${new URL(record.source.repository).pathname}/actions/runs/`;
  const runId = provenance.pathname.startsWith(runPrefix) ? provenance.pathname.slice(runPrefix.length) : '';
  if (!/^\d+$/.test(runId)) {
    fail('provenance_reference must identify a GitHub Actions run for the source repository');
  }
  requireSignatureReference(record.signature_reference, record.image);
  return record;
}

function validateChartRecord(record) {
  requireKeys(record, ['schema_version', 'kind', 'chart_version', 'source', 'package', 'app_release'], 'chart release record');
  if (record.schema_version !== 1 || record.kind !== 'chart-release') fail('chart release record must use schema_version 1 and kind chart-release');
  requireVersion(record.chart_version, 'chart_version');

  const source = record.source;
  requireKeys(source, ['repository', 'commit'], 'chart source');
  requireRepository(source.repository, 'chart source repository');
  requireCommit(source.commit, 'chart source commit');

  const chartPackage = record.package;
  requireKeys(chartPackage, ['filename', 'sha256', 'immutable_url'], 'chart package');
  if (typeof chartPackage.filename !== 'string' || !/^[A-Za-z0-9._-]+\.tgz$/.test(chartPackage.filename)) {
    fail('package filename must be a .tgz filename');
  }
  requirePackageChecksum(chartPackage.sha256, 'package sha256');
  const packageAsset = releaseAsset(chartPackage.immutable_url, 'package immutable_url');
  chartReleaseTag(packageAsset.tag, record.chart_version, 'package immutable_url release tag');
  if (packageAsset.filename !== chartPackage.filename || chartPackage.filename !== `pacman-${record.chart_version}.tgz`) {
    fail('package immutable_url must end with the chart-versioned package filename');
  }

  requireKeys(record.app_release, ['reference', 'sha256'], 'chart app_release');
  const appReference = parseUrl(record.app_release.reference, 'app_release reference', { githubOnly: true });
  const appReferencePath = appReference.pathname.split('/');
  if (appReferencePath[3] !== 'releases' || appReferencePath[4] !== 'download'
    || appReferencePath.at(-1) !== 'app-release-record.json') {
    fail('app_release reference must identify a versioned app-release-record.json asset');
  }
  const referencedAppVersion = (appReferencePath[5] ?? '').replace(/^pacman-v/, '');
  requireVersion(referencedAppVersion, 'app_release reference version');
  appReleaseTag(appReferencePath[5], referencedAppVersion, 'app_release reference tag');
  requirePackageChecksum(record.app_release.sha256, 'app_release sha256');
  return record;
}

function validateLock(lock) {
  requireKeys(lock, ['schema_version', 'kind', 'app', 'chart', 'supported_evidence_lanes'], 'consumer compatibility lock');
  if (lock.schema_version !== 1 || lock.kind !== 'consumer-compatibility-lock') fail('compatibility lock must use schema_version 1 and kind consumer-compatibility-lock');

  requireKeys(lock.app, [
    'version', 'reference', 'sha256', 'source_repository', 'source_commit',
    'image_repository', 'image_manifest_list_digest',
  ], 'lock app identity');
  requireVersion(lock.app.version, 'lock app version');
  const appReference = parseUrl(lock.app.reference, 'lock app reference', { githubOnly: true });
  requirePackageChecksum(lock.app.sha256, 'lock app sha256');
  const appSource = requireRepository(lock.app.source_repository, 'lock app source repository');
  const appAsset = releaseAsset(lock.app.reference, 'lock app reference');
  appReleaseTag(appAsset.tag, lock.app.version, 'lock app reference tag');
  const expectedAppPath = `${appSource.pathname}/releases/download/pacman-v${lock.app.version}/app-release-record.json`;
  if (appReference.origin !== appSource.origin || appReference.pathname !== expectedAppPath) {
    fail('lock app reference must identify the versioned app record from app source repository');
  }
  requireCommit(lock.app.source_commit, 'lock app source commit');
  requireImageRepository(lock.app.image_repository, 'lock image repository');
  requireImageDigest(lock.app.image_manifest_list_digest, 'lock image manifest-list digest');

  requireKeys(lock.chart, [
    'version', 'reference', 'sha256', 'package_reference', 'package_sha256',
    'source_repository', 'source_commit',
  ], 'lock chart identity');
  requireVersion(lock.chart.version, 'lock chart version');
  const chartRecordAsset = releaseAsset(lock.chart.reference, 'lock chart reference');
  chartReleaseTag(chartRecordAsset.tag, lock.chart.version, 'lock chart reference release tag');
  if (chartRecordAsset.filename !== 'chart-release-record.json') fail('lock chart reference must identify chart-release-record.json');
  requirePackageChecksum(lock.chart.sha256, 'lock chart sha256');
  const packageAsset = releaseAsset(lock.chart.package_reference, 'lock chart package reference');
  chartReleaseTag(packageAsset.tag, lock.chart.version, 'lock chart package release tag');
  if (packageAsset.filename !== `pacman-${lock.chart.version}.tgz`) fail('lock chart package reference must identify the chart-versioned package');
  requirePackageChecksum(lock.chart.package_sha256, 'lock chart package sha256');
  requireRepository(lock.chart.source_repository, 'lock chart source repository');
  const expectedChartRecordPath = packageAsset.url.pathname.replace(/[^/]+$/, 'chart-release-record.json');
  if (chartRecordAsset.repository.origin !== packageAsset.repository.origin
    || chartRecordAsset.repository.pathname !== packageAsset.repository.pathname
    || chartRecordAsset.tag !== packageAsset.tag
    || chartRecordAsset.url.pathname !== expectedChartRecordPath) {
    fail('lock chart record and package references must identify sibling assets in one distribution release');
  }
  requireCommit(lock.chart.source_commit, 'lock chart source commit');

  if (!Array.isArray(lock.supported_evidence_lanes) || lock.supported_evidence_lanes.length === 0) {
    fail('supported_evidence_lanes must be a non-empty array');
  }
  const lanes = new Set();
  for (const lane of lock.supported_evidence_lanes) {
    if (!evidenceLanes.includes(lane)) fail(`unsupported evidence lane: ${lane}`);
    if (lanes.has(lane)) fail(`duplicate evidence lane: ${lane}`);
    lanes.add(lane);
  }
  return lock;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function canonicalBytes(record, validate, { sortArray } = {}) {
  validate(record);
  const normalized = structuredClone(record);
  if (sortArray) normalized[sortArray.field].sort((left, right) => sortArray.key
    ? left[sortArray.key].localeCompare(right[sortArray.key])
    : left.localeCompare(right));
  return `${JSON.stringify(sortObject(normalized), null, 2)}\n`;
}

function parseJson(value, name) {
  if (typeof value !== 'string' && !Buffer.isBuffer(value)) fail(`${name} must be JSON text`);
  try {
    return JSON.parse(value.toString());
  } catch {
    fail(`${name} must be valid JSON`);
  }
}

function recordReference(repository, tag, filename) {
  const source = requireRepository(repository, 'source repository');
  return `${source.origin}${source.pathname}/releases/download/${encodeURIComponent(tag)}/${filename}`;
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function serializeAppReleaseRecord(record) {
  return canonicalBytes(record, validateAppRecord, { sortArray: { field: 'platforms', key: 'platform' } });
}

export function parseAppReleaseRecord(value) {
  const record = parseJson(value, 'app release record');
  return validateAppRecord(record);
}

export function appReleaseRecordReference(record) {
  validateAppRecord(record);
  return recordReference(record.source.repository, record.tag, 'app-release-record.json');
}

export function assertAppRecordIdentity(record, expected) {
  validateAppRecord(record);
  const identity = {
    app_version: expected.version,
    tag: expected.tag,
    source_repository: expected.sourceRepository,
    source_commit: expected.commit,
    image_repository: expected.imageRepository,
    image_manifest_list_digest: expected.imageDigest,
  };
  const actual = {
    app_version: record.app_version,
    tag: record.tag,
    source_repository: record.source.repository,
    source_commit: record.source.commit,
    image_repository: record.image.repository,
    image_manifest_list_digest: record.image.manifest_list_digest,
  };
  for (const [field, value] of Object.entries(identity)) {
    if (value === undefined || value === '') fail(`expected ${field} is required`);
    if (actual[field] !== value) fail(`existing app record ${field} does not match the verified release`);
  }
  return true;
}

export function createAppReleaseRecordFromManifest(input) {
  requireObject(input, 'app release input');
  const manifest = input.manifest;
  if (!isObject(manifest) || manifest.schemaVersion !== 2 || !Array.isArray(manifest.manifests)) {
    fail('verified image must contain a schemaVersion 2 manifest list');
  }
  const descriptors = [];
  for (const item of manifest.manifests) {
    if (!isObject(item) || !isObject(item.platform)) continue;
    const platform = `${item.platform.os}/${item.platform.architecture}`;
    if (platform === 'unknown/unknown') continue;
    descriptors.push({ platform, digest: item.digest });
  }
  const record = {
    schema_version: 1,
    kind: 'app-release',
    app_version: input.appVersion,
    tag: input.tag,
    source: { repository: input.sourceRepository, commit: input.sourceCommit },
    image: { repository: input.imageRepository, manifest_list_digest: input.imageDigest },
    platforms: descriptors,
    provenance_reference: input.provenanceReference,
    signature_reference: input.signatureReference,
  };
  validateAppRecord(record);
  return record;
}

export function serializeChartReleaseRecord(record) {
  return canonicalBytes(record, validateChartRecord);
}

export function parseChartReleaseRecord(value) {
  const record = parseJson(value, 'chart release record');
  return validateChartRecord(record);
}

export function chartReleaseRecordReference(record) {
  validateChartRecord(record);
  const packageUrl = new URL(record.package.immutable_url);
  const segments = packageUrl.pathname.split('/');
  segments[segments.length - 1] = 'chart-release-record.json';
  packageUrl.pathname = segments.join('/');
  return packageUrl.toString();
}

export function assertChartReferencesApp(chartRecord, appRecord, expected = {}) {
  validateChartRecord(chartRecord);
  validateAppRecord(appRecord);
  const reference = appReleaseRecordReference(appRecord);
  const checksum = sha256Hex(serializeAppReleaseRecord(appRecord));
  const expectedReference = expected.reference ?? reference;
  const expectedChecksum = expected.sha256 ?? checksum;
  if (chartRecord.app_release.reference !== expectedReference || chartRecord.app_release.sha256 !== expectedChecksum) {
    fail('chart record must reference the immutable app record and its checksum');
  }
  return true;
}

export function serializeCompatibilityLock(lock) {
  return canonicalBytes(lock, validateLock, { sortArray: { field: 'supported_evidence_lanes' } });
}

export function parseCompatibilityLock(value) {
  const lock = parseJson(value, 'consumer compatibility lock');
  return validateLock(lock);
}

export function createCompatibilityLock({ appRecord, chartRecord, supportedEvidenceLanes = evidenceLanes }) {
  validateAppRecord(appRecord);
  validateChartRecord(chartRecord);
  const appReference = appReleaseRecordReference(appRecord);
  const appSha256 = sha256Hex(serializeAppReleaseRecord(appRecord));
  assertChartReferencesApp(chartRecord, appRecord, { reference: appReference, sha256: appSha256 });
  const lock = {
    schema_version: 1,
    kind: 'consumer-compatibility-lock',
    app: {
      version: appRecord.app_version,
      reference: appReference,
      sha256: appSha256,
      source_repository: appRecord.source.repository,
      source_commit: appRecord.source.commit,
      image_repository: appRecord.image.repository,
      image_manifest_list_digest: appRecord.image.manifest_list_digest,
    },
    chart: {
      version: chartRecord.chart_version,
      reference: chartReleaseRecordReference(chartRecord),
      sha256: sha256Hex(serializeChartReleaseRecord(chartRecord)),
      package_reference: chartRecord.package.immutable_url,
      package_sha256: chartRecord.package.sha256,
      source_repository: chartRecord.source.repository,
      source_commit: chartRecord.source.commit,
    },
    supported_evidence_lanes: supportedEvidenceLanes,
  };
  validateLock(lock);
  return lock;
}

export function assertCompatibilityLockMatches(lock, { appRecord, chartRecord }) {
  validateLock(lock);
  validateAppRecord(appRecord);
  validateChartRecord(chartRecord);
  assertChartReferencesApp(chartRecord, appRecord);
  const expected = createCompatibilityLock({ appRecord, chartRecord, supportedEvidenceLanes: lock.supported_evidence_lanes });
  if (serializeCompatibilityLock(lock) !== serializeCompatibilityLock(expected)) {
    fail('compatibility lock does not match immutable app and chart identities');
  }
  return true;
}

export function assertImmutableRecordBytes(existingBytes, proposedBytes) {
  const existing = parseJson(existingBytes, 'existing release record');
  const proposed = parseJson(proposedBytes, 'proposed release record');
  const versionField = existing.kind === 'app-release' ? 'app_version'
    : existing.kind === 'chart-release' ? 'chart_version' : null;
  if (!versionField || existing.kind !== proposed.kind) fail('release record kind cannot be changed');
  const validate = existing.kind === 'app-release' ? validateAppRecord : validateChartRecord;
  validate(existing);
  validate(proposed);
  if (existing[versionField] !== proposed[versionField]) fail(`${versionField} cannot be reassigned`);
  if (!Buffer.from(existingBytes).equals(Buffer.from(proposedBytes))) fail(`release record for ${existing[versionField]} is immutable`);
  return true;
}

export function readLegacyReleaseMetadata(value, expected) {
  const metadata = parseJson(value, 'legacy release metadata');
  requireKeys(metadata, ['version', 'tag', 'commit'], 'legacy release metadata');
  requireVersion(metadata.version, 'legacy metadata version');
  if (metadata.tag !== `pacman-v${metadata.version}`) fail('legacy metadata tag must match version');
  requireCommit(metadata.commit, 'legacy metadata commit');
  requireObject(expected, 'legacy expected identity');
  requireVersion(expected.version, 'expected version');
  if (expected.tag !== `pacman-v${expected.version}`) fail('expected tag must match version');
  requireCommit(expected.commit, 'expected commit');
  requireImageDigest(expected.imageDigest, 'verified image digest');
  if (metadata.version !== expected.version || metadata.tag !== expected.tag || metadata.commit !== expected.commit) {
    fail('legacy release metadata does not match the verified source release');
  }
  return {
    format: 'legacy-release-metadata-v0',
    app_version: metadata.version,
    tag: metadata.tag,
    source_commit: metadata.commit,
    image_digest: expected.imageDigest,
    missing_evidence: ['platform_descriptors', 'provenance', 'signature'],
  };
}

function expectedFromEnvironment(imageDigest = process.env.IMAGE_DIGEST) {
  return {
    version: process.env.RELEASE_VERSION,
    tag: process.env.RELEASE_TAG,
    sourceRepository: process.env.SOURCE_REPOSITORY,
    commit: process.env.SOURCE_COMMIT,
    imageRepository: process.env.IMAGE_NAME,
    imageDigest,
  };
}

function appReferenceFromEnvironment(tag, filename) {
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!server || !repository) fail('GitHub repository context is required');
  const serverUrl = parseUrl(server, 'GITHUB_SERVER_URL');
  const sourceRepository = `${serverUrl.origin}/${repository}`;
  requireRepository(sourceRepository, 'GITHUB_REPOSITORY');
  return recordReference(sourceRepository, tag, filename);
}

function writeAppRecord(manifestPath, outputPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const imageDigest = process.env.IMAGE_DIGEST;
  const runId = process.env.GITHUB_RUN_ID;
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^\d+$/.test(runId ?? '')) fail('GITHUB_RUN_ID is required');
  const record = createAppReleaseRecordFromManifest({
    appVersion: process.env.RELEASE_VERSION,
    tag: process.env.RELEASE_TAG,
    sourceRepository: process.env.SOURCE_REPOSITORY,
    sourceCommit: process.env.SOURCE_COMMIT,
    imageRepository: process.env.IMAGE_NAME,
    imageDigest,
    provenanceReference: `${server}/${repository}/actions/runs/${runId}`,
    signatureReference: `docker://${process.env.IMAGE_NAME}@${imageDigest}`,
    manifest,
  });
  const bytes = serializeAppReleaseRecord(record);
  writeFileSync(outputPath, bytes, { flag: 'wx' });
  return {
    reference: appReleaseRecordReference(record),
    sha256: sha256Hex(bytes),
    format: 'app-release-v1',
    missing_evidence: '',
  };
}

function readCurrentReleaseMetadata(value, record, recordBytes) {
  const metadata = parseJson(value, 'release metadata');
  requireKeys(metadata, ['version', 'tag', 'commit', 'image_digest', 'app_record_ref', 'app_record_sha256'], 'release metadata');
  requireVersion(metadata.version, 'release metadata version');
  requireCommit(metadata.commit, 'release metadata commit');
  requireImageDigest(metadata.image_digest, 'release metadata image_digest');
  const reference = parseUrl(metadata.app_record_ref, 'release metadata app_record_ref', { githubOnly: true });
  if (reference.href !== appReleaseRecordReference(record)) fail('release metadata app_record_ref does not match the app record');
  requirePackageChecksum(metadata.app_record_sha256, 'release metadata app_record_sha256');
  if (metadata.version !== record.app_version || metadata.tag !== record.tag || metadata.commit !== record.source.commit
    || metadata.image_digest !== record.image.manifest_list_digest || metadata.app_record_sha256 !== sha256Hex(recordBytes)) {
    fail('release metadata does not pin the immutable app record bytes and identity');
  }
  return metadata;
}

function verifyAppFile(recordPath, metadataPath) {
  const bytes = readFileSync(recordPath);
  const record = parseAppReleaseRecord(bytes);
  if (serializeAppReleaseRecord(record) !== bytes.toString('utf8')) fail('existing app record is not in deterministic canonical form');
  const expected = expectedFromEnvironment();
  assertAppRecordIdentity(record, expected);
  if (!metadataPath) fail('release metadata with the app-record checksum is required');
  const metadataBytes = readFileSync(metadataPath);
  const metadata = readCurrentReleaseMetadata(metadataBytes, record, bytes);
  if (metadata.image_digest !== expected.imageDigest || metadata.commit !== expected.commit) {
    fail('release metadata does not match the verified replay image and source');
  }
  return {
    reference: appReleaseRecordReference(record),
    sha256: sha256Hex(bytes),
    format: 'app-release-v1',
    missing_evidence: '',
  };
}

function verifyLegacyFile(metadataPath) {
  const bytes = readFileSync(metadataPath);
  const expected = expectedFromEnvironment();
  readLegacyReleaseMetadata(bytes, {
    version: expected.version,
    tag: expected.tag,
    commit: expected.commit,
    imageDigest: expected.imageDigest,
  });
  return {
    reference: appReferenceFromEnvironment(expected.tag, 'release-metadata.json'),
    sha256: sha256Hex(bytes),
    format: 'legacy-release-metadata-v0',
    missing_evidence: 'platform_descriptors,provenance,signature',
  };
}

function printOutputs(outputs) {
  for (const [name, value] of Object.entries(outputs)) console.log(`${name}=${value}`);
}

function main() {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'write-app') {
    printOutputs(writeAppRecord(first, second));
    return;
  }
  if (command === 'verify-app') {
    printOutputs(verifyAppFile(first, second));
    return;
  }
  if (command === 'verify-legacy') {
    printOutputs(verifyLegacyFile(first));
    return;
  }
  fail('usage: release-records.js write-app <manifest.json> <output.json> | verify-app <record.json> | verify-legacy <metadata.json>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
