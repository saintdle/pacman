import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  appReleaseRecordReference,
  assertChartReferencesApp,
  assertCompatibilityLockMatches,
  assertImmutableRecordBytes,
  chartReleaseRecordReference,
  createAppReleaseRecordFromManifest,
  createChartReleaseBundle,
  createCompatibilityLock,
  parseAppReleaseRecord,
  parseChartReleaseRecord,
  parseCompatibilityLock,
  readLegacyReleaseMetadata,
  serializeAppReleaseRecord,
  serializeChartReleaseRecord,
  serializeCompatibilityLock,
  sha256Hex,
  verifyChartReleaseBundle,
} from '../tools/release-records.js';

const readFixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/release-records/${name}`, import.meta.url), 'utf8'));
const app = readFixture('app-release-record.json');
const chart = readFixture('chart-release-record.json');
const lock = readFixture('consumer-compatibility-lock.json');
const digest = (letter) => `sha256:${letter.repeat(64)}`;
const recordsScript = fileURLToPath(new URL('../tools/release-records.js', import.meta.url));

test('app, chart, and compatibility lock fixtures round-trip deterministically', () => {
  for (const [record, serialize, parse] of [
    [app, serializeAppReleaseRecord, parseAppReleaseRecord],
    [chart, serializeChartReleaseRecord, parseChartReleaseRecord],
    [lock, serializeCompatibilityLock, parseCompatibilityLock],
  ]) {
    const bytes = serialize(record);
    assert.deepEqual(parse(bytes), record);
    assert.equal(serialize(parse(bytes)), bytes);
    assert.equal(sha256Hex(bytes), sha256Hex(serialize(record)));
  }

  assert.equal(appReleaseRecordReference(app), 'https://github.com/saintdle/pacman/releases/download/pacman-v1.3.0/app-release-record.json');
  assert.equal(chartReleaseRecordReference(chart), 'https://github.com/saintdle/helm-charts/releases/download/helm-chart-v0.4.2/chart-release-record.json');
  assertChartReferencesApp(chart, app);
  assertCompatibilityLockMatches(lock, { appRecord: app, chartRecord: chart });
  assert.deepEqual(createCompatibilityLock({ appRecord: app, chartRecord: chart }), lock);
  assert.equal(app.kind, 'app-release');
  assert.equal(chart.kind, 'chart-release');
  assert.equal(lock.kind, 'consumer-compatibility-lock');
});

test('generated chart bundle pins the Pacman source SHA, independent chart version, immutable package, app record, and lock', () => {
  const packageBytes = Buffer.from('synthetic fixture: helm package bytes');
  const chartVersion = '0.7.18';
  const packageReference = `https://github.com/saintdle/helm-charts/releases/download/pacman-${chartVersion}/pacman-${chartVersion}.tgz`;
  const bundle = createChartReleaseBundle({
    appRecordBytes: serializeAppReleaseRecord(app),
    chartVersion,
    sourceRepository: 'https://github.com/saintdle/pacman',
    sourceCommit: 'c'.repeat(40),
    packageReference,
    packageBytes,
  });

  assert.equal(bundle.chartRecord.chart_version, chartVersion);
  assert.equal(bundle.chartRecord.source.commit, 'c'.repeat(40));
  assert.equal(bundle.chartRecord.package.immutable_url, packageReference);
  assert.equal(bundle.chartRecord.package.sha256, sha256Hex(packageBytes));
  assert.equal(bundle.chartRecord.app_release.sha256, sha256Hex(serializeAppReleaseRecord(app)));
  assertCompatibilityLockMatches(bundle.compatibilityLock, { appRecord: app, chartRecord: bundle.chartRecord });
  assert.doesNotThrow(() => verifyChartReleaseBundle({
    appRecordBytes: serializeAppReleaseRecord(app),
    chartRecordBytes: bundle.chartRecordBytes,
    compatibilityLockBytes: bundle.compatibilityLockBytes,
    packageBytes,
  }));
  assert.throws(() => verifyChartReleaseBundle({
    appRecordBytes: serializeAppReleaseRecord(app),
    chartRecordBytes: bundle.chartRecordBytes,
    compatibilityLockBytes: bundle.compatibilityLockBytes,
    packageBytes: Buffer.from('different package bytes'),
  }), /package checksum does not match/);
});

test('app records require full identities, valid digests, and observed platform descriptors', () => {
  const valid = {
    schema_version: 1,
    kind: 'app-release',
    app_version: '1.3.0',
    tag: 'pacman-v1.3.0',
    source: { repository: 'https://github.com/saintdle/pacman', commit: 'a'.repeat(40) },
    image: { repository: 'docker.io/saintdle/pacman', manifest_list_digest: digest('b') },
    platforms: [
      { platform: 'linux/amd64', digest: digest('c') },
      { platform: 'linux/arm64', digest: digest('d') },
    ],
    provenance_reference: 'https://github.com/saintdle/pacman/actions/runs/123',
    signature_reference: `docker://docker.io/saintdle/pacman@${digest('b')}`,
  };

  for (const invalid of [
    { ...valid, app_version: '01.3.0', tag: 'pacman-v01.3.0' },
    { ...valid, app_version: '1.3.0\n', tag: 'pacman-v1.3.0\n' },
    { ...valid, tag: 'pacman-v10.3.0' },
    { ...valid, source: { ...valid.source, commit: 'a'.repeat(39) } },
    { ...valid, image: { ...valid.image, manifest_list_digest: 'sha256:bad' } },
    { ...valid, platforms: [{ platform: 'linux/amd64', digest: digest('c') }] },
    { ...valid, platforms: [...valid.platforms, valid.platforms[0]] },
    { ...valid, provenance_reference: 'https://user:secret@github.com/saintdle/pacman/actions/runs/123' },
    { ...valid, access_token: 'must never be accepted' },
  ]) {
    assert.throws(() => serializeAppReleaseRecord(invalid));
  }
});

test('manifest descriptors come from the verified manifest list and unsupported claims are omitted', () => {
  const manifest = {
    schemaVersion: 2,
    manifests: [
      { digest: digest('c'), platform: { os: 'linux', architecture: 'amd64' } },
      { digest: digest('d'), platform: { os: 'linux', architecture: 'arm64' } },
      { digest: digest('e'), platform: { os: 'unknown', architecture: 'unknown' } },
    ],
  };
  const record = createAppReleaseRecordFromManifest({
    appVersion: '1.3.0',
    tag: 'pacman-v1.3.0',
    sourceRepository: 'https://github.com/saintdle/pacman',
    sourceCommit: 'a'.repeat(40),
    imageRepository: 'docker.io/saintdle/pacman',
    imageDigest: digest('b'),
    provenanceReference: 'https://github.com/saintdle/pacman/actions/runs/123',
    signatureReference: `docker://docker.io/saintdle/pacman@${digest('b')}`,
    manifest,
  });

  assert.deepEqual(record.platforms, [
    { platform: 'linux/amd64', digest: digest('c') },
    { platform: 'linux/arm64', digest: digest('d') },
  ]);
  assert.throws(() => createAppReleaseRecordFromManifest({
    appVersion: '1.3.0',
    tag: 'pacman-v1.3.0',
    sourceRepository: 'https://github.com/saintdle/pacman',
    sourceCommit: 'a'.repeat(40),
    imageRepository: 'docker.io/saintdle/pacman',
    imageDigest: digest('b'),
    provenanceReference: 'https://github.com/saintdle/pacman/actions/runs/123',
    signatureReference: `docker://docker.io/saintdle/pacman@${digest('b')}`,
    manifest: { schemaVersion: 2, manifests: [manifest.manifests[0]] },
  }), /platform/);
});

test('chart and lock reject inconsistent app references, versions, sources, and checksums', () => {
  const invalidChart = structuredClone(chart);
  invalidChart.app_release.sha256 = '0'.repeat(64);
  assert.doesNotThrow(() => serializeChartReleaseRecord(invalidChart));
  assert.throws(() => assertChartReferencesApp(invalidChart, app));
  const changedSource = structuredClone(app);
  changedSource.source.commit = '9'.repeat(40);
  assert.throws(() => assertChartReferencesApp(chart, changedSource));

  const invalidLock = structuredClone(lock);
  invalidLock.app.image_manifest_list_digest = digest('f');
  assert.throws(() => assertCompatibilityLockMatches(invalidLock, { appRecord: app, chartRecord: chart }));
  const missingLockIdentity = structuredClone(lock);
  delete missingLockIdentity.chart.package_sha256;
  assert.throws(() => serializeCompatibilityLock(missingLockIdentity));

  const invalidPackage = structuredClone(chart);
  invalidPackage.package.sha256 = 'bad';
  assert.throws(() => serializeChartReleaseRecord(invalidPackage));
  const mutablePackageReference = structuredClone(chart);
  mutablePackageReference.package.immutable_url = mutablePackageReference.package.immutable_url.replace('helm-chart-v0.4.2', 'latest');
  assert.throws(() => serializeChartReleaseRecord(mutablePackageReference));
  const mismatchedChartTag = structuredClone(chart);
  mismatchedChartTag.package.immutable_url = mismatchedChartTag.package.immutable_url.replace('helm-chart-v0.4.2', 'helm-chart-v10.4.20');
  assert.throws(() => serializeChartReleaseRecord(mismatchedChartTag));
  const malformedChartVersion = structuredClone(chart);
  malformedChartVersion.chart_version = '01.3.0';
  malformedChartVersion.package.filename = 'pacman-01.3.0.tgz';
  malformedChartVersion.package.immutable_url = malformedChartVersion.package.immutable_url.replace('0.4.2', '01.3.0');
  assert.throws(() => serializeChartReleaseRecord(malformedChartVersion));
  const publicChartTag = structuredClone(chart);
  publicChartTag.chart_version = '0.7.17';
  publicChartTag.package.filename = 'pacman-0.7.17.tgz';
  publicChartTag.package.immutable_url = 'https://github.com/saintdle/helm-charts/releases/download/pacman-0.7.17/pacman-0.7.17.tgz';
  assert.doesNotThrow(() => serializeChartReleaseRecord(publicChartTag));
  const publicChartLock = createCompatibilityLock({ appRecord: app, chartRecord: publicChartTag });
  assert.doesNotThrow(() => serializeCompatibilityLock(publicChartLock));
  const mutableAppReference = structuredClone(chart);
  mutableAppReference.app_release.reference = 'https://github.com/saintdle/pacman/app-release-record.json';
  assert.throws(() => serializeChartReleaseRecord(mutableAppReference));

  const migratedChart = structuredClone(chart);
  migratedChart.source.repository = 'https://github.com/saintdle/pacman';
  assert.doesNotThrow(() => serializeChartReleaseRecord(migratedChart));
  assert.equal(chartReleaseRecordReference(migratedChart), 'https://github.com/saintdle/helm-charts/releases/download/helm-chart-v0.4.2/chart-release-record.json');
  const migratedLock = createCompatibilityLock({ appRecord: app, chartRecord: migratedChart });
  assert.equal(migratedLock.chart.source_repository, 'https://github.com/saintdle/pacman');
  assert.match(migratedLock.chart.reference, /^https:\/\/github\.com\/saintdle\/helm-charts\//);
  assert.match(migratedLock.chart.package_reference, /^https:\/\/github\.com\/saintdle\/helm-charts\//);
  assert.doesNotThrow(() => assertCompatibilityLockMatches(migratedLock, { appRecord: app, chartRecord: migratedChart }));
  const wrongSourcePin = structuredClone(migratedLock);
  wrongSourcePin.chart.source_repository = 'https://github.com/saintdle/helm-charts';
  assert.throws(() => assertCompatibilityLockMatches(wrongSourcePin, { appRecord: app, chartRecord: migratedChart }));
  const wrongDistribution = structuredClone(migratedLock);
  wrongDistribution.chart.reference = wrongDistribution.chart.reference.replace('/helm-charts/', '/pacman/');
  assert.throws(() => serializeCompatibilityLock(wrongDistribution));
  const wrongPackageDistribution = structuredClone(migratedLock);
  wrongPackageDistribution.chart.package_reference = wrongPackageDistribution.chart.package_reference.replace('/helm-charts/', '/pacman/');
  assert.throws(() => serializeCompatibilityLock(wrongPackageDistribution));
  const lockLeadingZero = structuredClone(lock);
  lockLeadingZero.chart.version = '01.3.0';
  assert.throws(() => serializeCompatibilityLock(lockLeadingZero));
  const lockMismatchedAppTag = structuredClone(lock);
  lockMismatchedAppTag.app.reference = lockMismatchedAppTag.app.reference.replace('pacman-v1.3.0', 'pacman-v10.3.0');
  assert.throws(() => serializeCompatibilityLock(lockMismatchedAppTag));
  const lockMismatchedChartTag = structuredClone(lock);
  lockMismatchedChartTag.chart.package_reference = lockMismatchedChartTag.chart.package_reference.replace('helm-chart-v0.4.2', 'helm-chart-v10.4.20');
  assert.throws(() => serializeCompatibilityLock(lockMismatchedChartTag));
});

test('same-version app bytes cannot be replaced with a contradictory identity', () => {
  const original = serializeAppReleaseRecord(app);
  const contradictory = structuredClone(app);
  contradictory.image.manifest_list_digest = digest('f');
  contradictory.signature_reference = `docker://${contradictory.image.repository}@${digest('f')}`;

  assert.throws(() => assertImmutableRecordBytes(original, serializeAppReleaseRecord(contradictory)), /immutable/i);
  assert.equal(assertImmutableRecordBytes(original, original), true);

  const chartBytes = serializeChartReleaseRecord(chart);
  const changedChart = structuredClone(chart);
  changedChart.package.sha256 = '1'.repeat(64);
  assert.throws(() => assertImmutableRecordBytes(chartBytes, serializeChartReleaseRecord(changedChart)), /immutable/i);
});

test('legacy release metadata is read only after its source and image identities are verified', () => {
  const metadata = JSON.stringify({ version: app.app_version, tag: app.tag, commit: app.source.commit });
  const verified = readLegacyReleaseMetadata(metadata, {
    version: app.app_version,
    tag: app.tag,
    commit: app.source.commit,
    imageDigest: app.image.manifest_list_digest,
  });

  assert.deepEqual(verified, {
    format: 'legacy-release-metadata-v0',
    app_version: app.app_version,
    tag: app.tag,
    source_commit: app.source.commit,
    image_digest: app.image.manifest_list_digest,
    missing_evidence: ['platform_descriptors', 'provenance', 'signature'],
  });
  assert.throws(() => readLegacyReleaseMetadata(metadata, { ...verified, commit: '0'.repeat(40) }));
  assert.throws(() => readLegacyReleaseMetadata(JSON.stringify({ version: app.app_version, tag: app.tag }), {}));
});

test('workflow record CLI writes a pinned v1 record and keeps legacy replay evidence explicit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pacman-release-records-'));
  const manifestPath = join(directory, 'manifest-list.json');
  const recordPath = join(directory, 'app-release-record.json');
  const metadataPath = join(directory, 'release-metadata.json');
  const manifest = {
    schemaVersion: 2,
    manifests: [
      { digest: digest('c'), platform: { os: 'linux', architecture: 'amd64' } },
      { digest: digest('d'), platform: { os: 'linux', architecture: 'arm64' } },
    ],
  };
  const env = {
    ...process.env,
    RELEASE_VERSION: app.app_version,
    RELEASE_TAG: app.tag,
    SOURCE_REPOSITORY: app.source.repository,
    SOURCE_COMMIT: app.source.commit,
    IMAGE_NAME: app.image.repository,
    IMAGE_DIGEST: app.image.manifest_list_digest,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'saintdle/pacman',
    GITHUB_RUN_ID: '123456789',
  };

  try {
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const write = spawnSync(process.execPath, [recordsScript, 'write-app', manifestPath, recordPath], { encoding: 'utf8', env });
    assert.equal(write.status, 0, write.stderr);
    const outputs = Object.fromEntries(write.stdout.trim().split('\n').map((line) => line.split('=')));
    const recordBytes = readFileSync(recordPath, 'utf8');
    const record = parseAppReleaseRecord(recordBytes);
    assert.equal(outputs.reference, appReleaseRecordReference(record));
    assert.equal(outputs.sha256, sha256Hex(recordBytes));
    assert.equal(outputs.format, 'app-release-v1');

    writeFileSync(metadataPath, JSON.stringify({
      version: record.app_version,
      tag: record.tag,
      commit: record.source.commit,
      image_digest: record.image.manifest_list_digest,
      app_record_ref: outputs.reference,
      app_record_sha256: outputs.sha256,
    }));
    const verify = spawnSync(process.execPath, [recordsScript, 'verify-app', recordPath, metadataPath], { encoding: 'utf8', env });
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /format=app-release-v1/);
    assert.match(verify.stdout, /missing_evidence=\n/);

    const contradictoryMetadataPath = join(directory, 'contradictory-release-metadata.json');
    writeFileSync(contradictoryMetadataPath, JSON.stringify({
      version: record.app_version,
      tag: record.tag,
      commit: record.source.commit,
      image_digest: record.image.manifest_list_digest,
      app_record_ref: outputs.reference,
      app_record_sha256: '0'.repeat(64),
    }));
    const contradictoryReplay = spawnSync(process.execPath, [recordsScript, 'verify-app', recordPath, contradictoryMetadataPath], { encoding: 'utf8', env });
    assert.notEqual(contradictoryReplay.status, 0);
    assert.match(contradictoryReplay.stderr, /does not pin/);

    const legacyDirectory = join(directory, 'legacy');
    const legacyMetadataPath = join(legacyDirectory, 'release-metadata.json');
    mkdirSync(legacyDirectory);
    writeFileSync(legacyMetadataPath, JSON.stringify({ version: app.app_version, tag: app.tag, commit: app.source.commit }));
    const legacy = spawnSync(process.execPath, [recordsScript, 'verify-legacy', legacyMetadataPath], { encoding: 'utf8', env });
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.match(legacy.stdout, /format=legacy-release-metadata-v0/);
    assert.match(legacy.stdout, /missing_evidence=platform_descriptors,provenance,signature/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
