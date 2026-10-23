import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;
const bumps = new Set(['patch', 'minor', 'major']);

function parseVersion(value, source) {
  const match = versionPattern.exec(value ?? '');
  if (!match) throw new Error(`${source} must use MAJOR.MINOR.PATCH format: ${value}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function formatVersion(version) {
  return version.join('.');
}

function bumpVersion(version, bump) {
  if (bump === 'major') return [version[0] + 1, 0, 0];
  if (bump === 'minor') return [version[0], version[1] + 1, 0];
  return [version[0], version[1], version[2] + 1];
}

function git(...argumentsList) {
  return execFileSync('git', argumentsList, { encoding: 'utf8' }).trim();
}

function gitRaw(...argumentsList) {
  return execFileSync('git', argumentsList, { encoding: 'utf8' });
}

function isAncestor(ancestor, descendant) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { encoding: 'utf8' });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`Unable to compare release source ancestry: ${result.stderr || result.error?.message || 'git failed'}`);
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function readPreviousPackageVersion(baseSha) {
  if (!baseSha || /^0+$/.test(baseSha)) return null;

  try {
    return JSON.parse(git('show', `${baseSha}:package.json`)).version;
  } catch {
    return null;
  }
}

function isAppRuntimePath(path) {
  return path === '.dockerignore'
    || path === '.nvmrc'
    || path === 'docker/Dockerfile'
    || path === 'package.json'
    || path === 'package-lock.json'
    || path === 'tools/healthcheck.js'
    || path === 'tools/demo-exec-probe.js'
    || ['demo-fixtures/', 'proto/', 'public/', 'src/', 'views/'].some((prefix) => path.startsWith(prefix));
}

function isChartPath(path) {
  return path.startsWith('charts/pacman/');
}

export function classifyReleasePaths(paths) {
  return {
    appRuntimeChanged: paths.some(isAppRuntimePath),
    chartChanged: paths.some(isChartPath),
  };
}

function changedPaths(baseSha, currentSha) {
  if (!baseSha || /^0+$/.test(baseSha)) {
    return gitRaw('ls-tree', '-r', '--name-only', '-z', currentSha).split('\0').filter(Boolean);
  }
  return gitRaw('diff', '--name-only', '--no-renames', '-z', baseSha, currentSha).split('\0').filter(Boolean);
}

function tagReleases() {
  return git('tag', '--list', 'pacman-v*', '--sort=-version:refname')
    .split('\n')
    .filter(Boolean)
    .map((tag) => ({
      tag,
      version: tag.replace(/^pacman-v/, ''),
      sourceSha: git('rev-list', '-n', '1', tag),
    }))
    .map((release) => ({
      ...release,
      parsedVersion: parseVersion(release.version, 'release tag'),
    }));
}

function resultOutputs({
  version = '',
  source,
  existingRelease = false,
  currentVersion,
  previousVersion,
  latestRelease,
  tag = '',
  appReleaseEligible,
  chartChanged,
  releaseReason,
}) {
  return {
    version,
    source,
    existing_release: String(existingRelease),
    current_version: currentVersion,
    previous_version: previousVersion ?? 'none',
    latest_release: latestRelease ?? 'none',
    tag,
    app_release_eligible: String(appReleaseEligible),
    chart_changed: String(chartChanged),
    release_reason: releaseReason,
  };
}

function resolveReleaseVersion(environment = process.env) {
  const packageJson = readJson('package.json');
  const packageLock = readJson('package-lock.json');
  const currentVersion = formatVersion(parseVersion(packageJson.version, 'package.json version'));
  const lockfileVersion = packageLock.packages?.['']?.version;

  if (lockfileVersion !== packageJson.version) {
    throw new Error(`package-lock.json version ${lockfileVersion} does not match package.json version ${packageJson.version}`);
  }

  const currentCommit = environment.GITHUB_SHA;
  if (!currentCommit) throw new Error('GITHUB_SHA is required to resolve a release');
  const baseSha = environment.RELEASE_BASE_SHA ?? '';
  const eventName = environment.GITHUB_EVENT_NAME ?? 'push';
  const manual = eventName === 'workflow_dispatch';
  const manualBump = environment.RELEASE_BUMP ?? '';

  if (manual && !bumps.has(manualBump)) {
    throw new Error(`manual release requires an explicit patch, minor, or major bump: ${manualBump}`);
  }

  const releases = tagReleases();
  const latest = releases[0] ?? null;
  const previousVersion = readPreviousPackageVersion(baseSha);
  const paths = manual ? [] : changedPaths(baseSha, currentCommit);
  const pathClassification = classifyReleasePaths(paths);
  const appReleaseCandidate = manual || pathClassification.appRuntimeChanged;
  const latestRelease = latest?.version ?? null;

  if (!appReleaseCandidate) {
    const releaseReason = pathClassification.chartChanged ? 'chart-only' : 'no-runtime-change';
    return resultOutputs({
      source: releaseReason,
      currentVersion,
      previousVersion,
      latestRelease,
      appReleaseEligible: false,
      chartChanged: pathClassification.chartChanged,
      releaseReason,
    });
  }

  const existingRelease = releases.find((release) => release.sourceSha === currentCommit);
  if (existingRelease) {
    return resultOutputs({
      version: existingRelease.version,
      source: 'existing release',
      existingRelease: true,
      currentVersion,
      previousVersion,
      latestRelease,
      tag: existingRelease.tag,
      appReleaseEligible: true,
      chartChanged: pathClassification.chartChanged,
      releaseReason: 'existing-release',
    });
  }

  if (latest && !isAncestor(latest.sourceSha, currentCommit)) {
    if (isAncestor(currentCommit, latest.sourceSha)) {
      return resultOutputs({
        source: 'older source retry',
        currentVersion,
        previousVersion,
        latestRelease,
        appReleaseEligible: false,
        chartChanged: pathClassification.chartChanged,
        releaseReason: 'older-source',
      });
    }
    throw new Error(`release source ${currentCommit} diverges from latest published source ${latest.sourceSha}`);
  }

  const hasPackageVersionOverride = previousVersion !== null && previousVersion !== packageJson.version;
  const baseVersion = latest && compareVersions(latest.parsedVersion, parseVersion(currentVersion, 'package.json version')) > 0
    ? latest.parsedVersion
    : parseVersion(currentVersion, 'package.json version');
  let releaseVersion;
  let source;

  if (hasPackageVersionOverride) {
    releaseVersion = parseVersion(currentVersion, 'package.json override');
    source = 'package.json override';
  } else if (manual) {
    releaseVersion = bumpVersion(latest?.parsedVersion ?? baseVersion, manualBump);
    source = `manual ${manualBump} release`;
  } else {
    releaseVersion = bumpVersion(baseVersion, 'patch');
    source = 'automatic patch increment';
  }

  if (latest && compareVersions(releaseVersion, latest.parsedVersion) <= 0) {
    throw new Error(`release version ${formatVersion(releaseVersion)} is not newer than ${latestRelease}`);
  }

  const version = formatVersion(releaseVersion);
  return resultOutputs({
    version,
    source,
    currentVersion,
    previousVersion,
    latestRelease,
    tag: `pacman-v${version}`,
    appReleaseEligible: true,
    chartChanged: pathClassification.chartChanged,
    releaseReason: manual ? `manual-${manualBump}` : 'runtime-change',
  });
}

function main() {
  const output = resolveReleaseVersion();
  for (const [name, value] of Object.entries(output)) console.log(`${name}=${value}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
