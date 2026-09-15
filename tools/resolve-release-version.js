import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(value, source) {
  const match = versionPattern.exec(value);
  if (!match) {
    throw new Error(`${source} must use MAJOR.MINOR.PATCH format: ${value}`);
  }
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

function patchVersion(version) {
  return [version[0], version[1], version[2] + 1];
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function git(...argumentsList) {
  return execFileSync('git', argumentsList, { encoding: 'utf8' }).trim();
}

function readPreviousPackageVersion() {
  const baseSha = process.env.RELEASE_BASE_SHA;
  if (!baseSha || /^0+$/.test(baseSha)) return null;

  try {
    const packageJson = git('show', `${baseSha}:package.json`);
    return readJsonFromString(packageJson).version;
  } catch {
    return null;
  }
}

function readJsonFromString(value) {
  return JSON.parse(value);
}

const packageJson = readJson('package.json');
const packageLock = readJson('package-lock.json');
const currentVersion = parseVersion(packageJson.version, 'package.json version');
const lockfileVersion = packageLock.packages?.['']?.version;

if (lockfileVersion !== packageJson.version) {
  throw new Error(`package-lock.json version ${lockfileVersion} does not match package.json version ${packageJson.version}`);
}

const previousVersionValue = readPreviousPackageVersion();
if (previousVersionValue) parseVersion(previousVersionValue, 'previous package.json version');
const hasOverride = previousVersionValue !== null && previousVersionValue !== packageJson.version;

const releaseTags = git('tag', '--list', 'pacman-v*', '--sort=-version:refname')
  .split('\n')
  .filter(Boolean)
  .map((tag) => tag.replace(/^pacman-v/, ''))
  .map((version) => parseVersion(version, 'release tag'));

const currentCommit = process.env.GITHUB_SHA;
const existingRelease = currentCommit
  ? releaseTags.find((version) => git('rev-list', '-n', '1', `pacman-v${formatVersion(version)}`) === currentCommit)
  : null;
const latestRelease = releaseTags[0] ?? null;
const releaseVersion = existingRelease ?? (hasOverride ? currentVersion : patchVersion(latestRelease && compareVersions(latestRelease, currentVersion) > 0 ? latestRelease : currentVersion));

if (!existingRelease && latestRelease && compareVersions(releaseVersion, latestRelease) <= 0) {
  throw new Error(`release version ${formatVersion(releaseVersion)} is not newer than ${formatVersion(latestRelease)}`);
}

const output = {
  version: formatVersion(releaseVersion),
  source: existingRelease ? 'existing release' : hasOverride ? 'package.json override' : 'automatic patch increment',
  existing_release: existingRelease ? 'true' : 'false',
  current_version: packageJson.version,
  previous_version: previousVersionValue ?? 'none',
  latest_release: latestRelease ? formatVersion(latestRelease) : 'none',
  tag: `pacman-v${formatVersion(releaseVersion)}`,
};

for (const [name, value] of Object.entries(output)) {
  console.log(`${name}=${value}`);
}