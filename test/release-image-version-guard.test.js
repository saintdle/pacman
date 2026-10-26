import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertReleaseImageTagAbsent, inspectDockerHubReleaseTag } from '../tools/guard-release-image-version.js';

const resolver = fileURLToPath(new URL('../tools/resolve-release-version.js', import.meta.url));
const policy = fileURLToPath(new URL('../tools/release-policy.js', import.meta.url));
const syntheticCredentials = { username: 'fixture-user', password: 'fixture-token' };
const imageName = 'docker.io/saintdle/pacman';

function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

function createRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'pacman-partial-image-release-'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '0.7.7' }));
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: { '': { version: '0.7.7' } } }));
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src/app.js'), 'export const version = 1;\n');
  git(directory, '-c', 'init.defaultBranch=main', 'init');
  git(directory, 'config', 'user.name', 'Release regression test');
  git(directory, 'config', 'user.email', 'release-test@example.invalid');
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'initial source');
  const base = git(directory, 'rev-parse', 'HEAD');
  writeFileSync(join(directory, 'src/app.js'), 'export const version = 2;\n');
  git(directory, 'add', 'src/app.js');
  git(directory, 'commit', '-m', 'runtime release source');
  return { directory, base, source: git(directory, 'rev-parse', 'HEAD') };
}

function response(status, jsonValue) {
  return {
    status,
    json: async () => jsonValue,
  };
}

function mockFetch(manifestStatus, { tokenStatus = 200, networkFailureAt } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (calls.length === networkFailureAt) throw new Error('synthetic DNS failure');
    if (calls.length === 1) {
      return response(tokenStatus, { token: 'synthetic-bearer-token' });
    }
    return response(manifestStatus);
  };
  return { calls, fetchImpl };
}

function resolverResult(directory, sha, base) {
  return spawnSync(process.execPath, [resolver], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_SHA: sha,
      GITHUB_EVENT_NAME: 'push',
      RELEASE_BASE_SHA: base,
      RELEASE_BUMP: '',
    },
  });
}

test('a tag left behind after the image push blocks the missing GitHub release-tag retry', async () => {
  const { directory, base, source } = createRepository();
  try {
    const resolved = resolverResult(directory, source, base);
    assert.equal(resolved.status, 0, resolved.stderr);
    assert.match(resolved.stdout, /^version=0\.7\.8$/m);
    assert.match(resolved.stdout, /^existing_release=false$/m);

    const plan = spawnSync(process.execPath, [policy], {
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_VALIDATION_RESULT: 'success',
        APP_RELEASE_ELIGIBLE: 'true',
        EXISTING_RELEASE: 'false',
        RELEASE_VERSION: '0.7.8',
        LATEST_RELEASE: '0.7.7',
      },
    });
    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /^publish=true$/m);

    const { calls, fetchImpl } = mockFetch(200);
    await assert.rejects(assertReleaseImageTagAbsent({
      imageName,
      version: '0.7.8',
      ...syntheticCredentials,
      fetchImpl,
    }), /already contains docker\.io\/saintdle\/pacman:0\.7\.8; refusing release publication/);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.hostname, 'auth.docker.io');
    assert.equal(calls[0].url.searchParams.get('scope'), 'repository:saintdle/pacman:pull');
    assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from('fixture-user:fixture-token').toString('base64')}`);
    assert.equal(calls[1].url.hostname, 'registry-1.docker.io');
    assert.equal(calls[1].options.method, 'HEAD');
    assert.equal(calls[1].options.headers.Authorization, 'Bearer synthetic-bearer-token');
    assert.equal(calls[1].url.pathname, '/v2/saintdle/pacman/manifests/0.7.8');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only a registry manifest 404 proves a new version tag is absent', async () => {
  const { calls, fetchImpl } = mockFetch(404);
  const result = await assertReleaseImageTagAbsent({
    imageName,
    version: '0.7.8',
    ...syntheticCredentials,
    fetchImpl,
  });

  assert.deepEqual(result, { exists: false });
  assert.equal(calls.length, 2);
});

test('authentication, rate-limit, unknown-status, and network failures fail closed', async () => {
  const tokenFailure = mockFetch(404, { tokenStatus: 401 });
  await assert.rejects(inspectDockerHubReleaseTag({
    imageName,
    version: '0.7.8',
    ...syntheticCredentials,
    fetchImpl: tokenFailure.fetchImpl,
  }), /token request returned HTTP 401/);
  assert.equal(tokenFailure.calls.length, 1, 'manifest lookup must not follow token authentication failure');

  for (const status of [401, 403, 429, 500, 503]) {
    const { fetchImpl } = mockFetch(status);
    await assert.rejects(inspectDockerHubReleaseTag({
      imageName,
      version: '0.7.8',
      ...syntheticCredentials,
      fetchImpl,
    }), new RegExp(`manifest request returned HTTP ${status}; tag availability is unknown`));
  }

  const networkFailure = mockFetch(404, { networkFailureAt: 2 });
  await assert.rejects(inspectDockerHubReleaseTag({
    imageName,
    version: '0.7.8',
    ...syntheticCredentials,
    fetchImpl: networkFailure.fetchImpl,
  }), /Docker Hub manifest request failed; refusing release publication/);
});

test('invalid image references, versions, and missing credentials fail before registry access', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response(404);
  };

  await assert.rejects(inspectDockerHubReleaseTag({
    imageName: 'ghcr.io/saintdle/pacman',
    version: '0.7.8',
    ...syntheticCredentials,
    fetchImpl,
  }), /IMAGE_NAME must be a Docker Hub image/);
  await assert.rejects(inspectDockerHubReleaseTag({
    imageName,
    version: '0.7.08',
    ...syntheticCredentials,
    fetchImpl,
  }), /VERSION_TAG must be canonical/);
  await assert.rejects(inspectDockerHubReleaseTag({ imageName, version: '0.7.8', fetchImpl }), /credentials are unavailable/);
  assert.equal(calls, 0);
});
