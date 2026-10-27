import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { classifyReleasePaths } from '../tools/resolve-release-version.js';

const resolver = fileURLToPath(new URL('../tools/resolve-release-version.js', import.meta.url));

function git(directory, ...args) {
  return execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
}

function createRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'pacman-release-version-'));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '0.7.7' }));
  writeFileSync(join(directory, 'package-lock.json'), JSON.stringify({ packages: { '': { version: '0.7.7' } } }));
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src/app.js'), 'export const version = 1;\n');
  git(directory, '-c', 'init.defaultBranch=main', 'init');
  git(directory, 'config', 'user.name', 'Release regression test');
  git(directory, 'config', 'user.email', 'release-test@example.invalid');
  git(directory, 'add', '.');
  git(directory, 'commit', '-m', 'initial source');
  return { directory, initialSha: git(directory, 'rev-parse', 'HEAD') };
}

function commitFiles(directory, changes, message) {
  for (const [path, content] of changes) {
    const fullPath = join(directory, path);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
    git(directory, 'add', path);
  }
  git(directory, 'commit', '-m', message);
  return git(directory, 'rev-parse', 'HEAD');
}

function commitFile(directory, path, content, message = `change ${path}`) {
  return commitFiles(directory, [[path, content]], message);
}

function runResolver(directory, { sha, base = '', event = 'push', bump = '' }) {
  const result = spawnSync(process.execPath, [resolver], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_SHA: sha,
      GITHUB_EVENT_NAME: event,
      RELEASE_BASE_SHA: base,
      RELEASE_BUMP: bump,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    values: Object.fromEntries((result.stdout ?? '').trim().split('\n').filter(Boolean).map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    })),
  };
}

test('release path fixtures distinguish docs, tests, runtime, mixed, and future chart-only changes', () => {
  for (const path of [
    '.dockerignore',
    '.nvmrc',
    'docker/Dockerfile',
    'package.json',
    'package-lock.json',
    'proto/pacman.proto',
    'public/index.html',
    'src/app.js',
    'tools/healthcheck.js',
    'tools/demo-exec-probe.js',
    'demo-fixtures/synthetic-secret.txt',
    'views/index.pug',
  ]) {
    assert.equal(classifyReleasePaths([path]).appRuntimeChanged, true, `${path} is an app build/runtime input`);
  }
  for (const path of ['tools/check-container-image-contract.js', 'tools/smoke-container-images.js', 'test/release-version.test.js']) {
    assert.equal(classifyReleasePaths([path]).appRuntimeChanged, false, `${path} is test-only tooling`);
  }
  assert.deepEqual(classifyReleasePaths(['charts/pacman/Chart.yaml']), {
    appRuntimeChanged: false,
    chartChanged: true,
  });

  const { directory, initialSha } = createRepository();
  try {
    const docsAndTests = commitFile(directory, 'docs/guide.md', 'guide\n');
    const testOnly = commitFile(directory, 'test/example.test.js', 'test(true);\n');
    const runtime = commitFile(directory, 'src/app.js', 'export const version = 2;\n');
    const chartOnly = commitFile(directory, 'charts/pacman/Chart.yaml', 'apiVersion: v2\n');
    const mixed = commitFiles(directory, [
      ['docs/combined.md', 'runtime docs\n'],
      ['src/app.js', 'export const version = 3;\n'],
    ], 'mixed docs and runtime');
    const healthcheck = commitFile(directory, 'tools/healthcheck.js', 'process.exit(0);\n');
    const demoProbe = commitFile(directory, 'tools/demo-exec-probe.js', 'process.exit(0);\n');
    const fixture = commitFile(directory, 'demo-fixtures/synthetic-secret.txt', 'synthetic marker\n');
    const testToolOnly = commitFile(directory, 'tools/check-container-image-contract.js', 'process.exit(0);\n');

    const docsResult = runResolver(directory, { sha: docsAndTests, base: initialSha });
    const testsResult = runResolver(directory, { sha: testOnly, base: docsAndTests });
    const runtimeResult = runResolver(directory, { sha: runtime, base: testOnly });
    const chartResult = runResolver(directory, { sha: chartOnly, base: runtime });
    const mixedResult = runResolver(directory, { sha: mixed, base: chartOnly });
    const healthcheckResult = runResolver(directory, { sha: healthcheck, base: mixed });
    const demoProbeResult = runResolver(directory, { sha: demoProbe, base: healthcheck });
    const fixtureResult = runResolver(directory, { sha: fixture, base: demoProbe });
    const testToolResult = runResolver(directory, { sha: testToolOnly, base: fixture });

    assert.equal(docsResult.status, 0, docsResult.stderr);
    assert.equal(docsResult.values.app_release_eligible, 'false');
    assert.equal(docsResult.values.chart_changed, 'false');
    assert.equal(testsResult.values.app_release_eligible, 'false');
    assert.equal(runtimeResult.values.app_release_eligible, 'true');
    assert.equal(runtimeResult.values.chart_changed, 'false');
    assert.equal(chartResult.values.app_release_eligible, 'false');
    assert.equal(chartResult.values.chart_changed, 'true');
    assert.equal(mixedResult.values.app_release_eligible, 'true');
    assert.equal(mixedResult.values.chart_changed, 'false');
    assert.equal(healthcheckResult.values.app_release_eligible, 'true');
    assert.equal(demoProbeResult.values.app_release_eligible, 'true');
    assert.equal(fixtureResult.values.app_release_eligible, 'true');
    assert.equal(testToolResult.values.app_release_eligible, 'false');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a runtime source older than the latest published source cannot mint a release on retry', () => {
  const { directory, initialSha } = createRepository();
  try {
    const sourceA = commitFile(directory, 'src/app.js', 'export const version = 2;\n', 'runtime source A');
    const sourceB = commitFile(directory, 'src/app.js', 'export const version = 3;\n', 'runtime source B');
    git(directory, 'tag', 'pacman-v0.7.8', sourceB);

    const result = runResolver(directory, { sha: sourceA, base: initialSha });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.values.app_release_eligible, 'false');
    assert.equal(result.values.release_reason, 'older-source');
    assert.equal(result.values.existing_release, 'false');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a divergent runtime source fails closed against the latest published source', () => {
  const { directory, initialSha } = createRepository();
  try {
    git(directory, 'branch', 'published');
    const published = commitFile(directory, 'src/app.js', 'export const version = 2;\n', 'published source');
    git(directory, 'tag', 'pacman-v0.7.8', published);
    git(directory, 'checkout', '-b', 'divergent', initialSha);
    const divergent = commitFile(directory, 'src/app.js', 'export const version = 99;\n', 'divergent source');

    const result = runResolver(directory, { sha: divergent, base: initialSha });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /diverges from latest published source/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a forward runtime retry remains valid when main later advances with docs only', () => {
  const { directory } = createRepository();
  try {
    const published = commitFile(directory, 'src/app.js', 'export const version = 2;\n', 'published source');
    git(directory, 'tag', 'pacman-v0.7.8', published);
    const forwardRuntime = commitFile(directory, 'src/app.js', 'export const version = 3;\n', 'forward runtime source');
    const newerDocsMain = commitFile(directory, 'docs/guide.md', 'new docs\n', 'newer docs-only main');

    assert.equal(git(directory, 'rev-parse', 'HEAD'), newerDocsMain);
    const result = runResolver(directory, { sha: forwardRuntime, base: published });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.values.app_release_eligible, 'true');
    assert.equal(result.values.version, '0.7.9');
    assert.equal(result.values.release_reason, 'runtime-change');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manual main release accepts explicit minor and major intent', () => {
  const { directory } = createRepository();
  try {
    const published = commitFile(directory, 'src/app.js', 'export const version = 2;\n', 'published source');
    git(directory, 'tag', 'pacman-v0.7.8', published);
    const manualSource = commitFile(directory, 'src/app.js', 'export const version = 3;\n', 'manual source');

    const minor = runResolver(directory, { sha: manualSource, event: 'workflow_dispatch', bump: 'minor' });
    const major = runResolver(directory, { sha: manualSource, event: 'workflow_dispatch', bump: 'major' });
    assert.equal(minor.status, 0, minor.stderr);
    assert.equal(minor.values.version, '0.8.0');
    assert.equal(minor.values.release_reason, 'manual-minor');
    assert.equal(major.status, 0, major.stderr);
    assert.equal(major.values.version, '1.0.0');
    assert.equal(major.values.release_reason, 'manual-major');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('queued runtime releases advance from the prior result and duplicates replay it', () => {
  const { directory } = createRepository();
  try {
    const firstPublished = commitFile(directory, 'src/app.js', 'export const version = 2;\n', 'first published source');
    git(directory, 'tag', 'pacman-v0.7.8', firstPublished);
    const queuedA = commitFile(directory, 'src/app.js', 'export const version = 3;\n', 'queued runtime A');
    const queuedB = commitFile(directory, 'src/app.js', 'export const version = 4;\n', 'queued runtime B');

    const firstRun = runResolver(directory, { sha: queuedA, base: firstPublished });
    assert.equal(firstRun.status, 0, firstRun.stderr);
    assert.equal(firstRun.values.version, '0.7.9');
    git(directory, 'tag', 'pacman-v0.7.9', queuedA);

    const duplicateRun = runResolver(directory, { sha: queuedA, base: firstPublished });
    const secondRun = runResolver(directory, { sha: queuedB, base: queuedA });
    assert.equal(duplicateRun.status, 0, duplicateRun.stderr);
    assert.equal(duplicateRun.values.existing_release, 'true');
    assert.equal(duplicateRun.values.version, '0.7.9');
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.equal(secondRun.values.version, '0.7.10');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('release replay resolves the immutable source tag when latest has advanced', () => {
  const { directory } = createRepository();
  try {
    const releasedSha = git(directory, 'rev-parse', 'HEAD');
    git(directory, 'tag', 'pacman-v0.7.7', releasedSha);
    const newer = commitFile(directory, 'src/app.js', 'export const version = 2;\n', 'later source');
    git(directory, 'tag', 'pacman-v0.8.0', newer);

    const result = runResolver(directory, { sha: releasedSha, event: 'workflow_dispatch', bump: 'patch' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.values.version, '0.7.7');
    assert.equal(result.values.existing_release, 'true');
    assert.equal(result.values.tag, 'pacman-v0.7.7');
    assert.equal(result.values.latest_release, '0.8.0');
    assert.equal(result.values.app_release_eligible, 'true');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
