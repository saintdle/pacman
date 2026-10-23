import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { executeReleasePolicy } from '../tools/release-policy.js';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const allGatesPassed = { lint: 'success', unit: 'success', mongo: 'success', postgres: 'success' };
const digestA = `sha256:${'a'.repeat(64)}`;
const digestB = `sha256:${'b'.repeat(64)}`;
const policyScript = fileURLToPath(new URL('../tools/release-policy.js', import.meta.url));

function workflowJobs(workflow) {
  const jobsStart = workflow.indexOf('\njobs:\n');
  assert.notEqual(jobsStart, -1, 'workflow must declare jobs');
  const jobs = workflow.slice(jobsStart + '\njobs:\n'.length);
  const names = [...jobs.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((match) => match[1]);

  return new Map(names.map((name, index) => {
    const start = jobs.indexOf(`  ${name}:\n`);
    const next = index + 1 < names.length ? jobs.indexOf(`  ${names[index + 1]}:\n`, start + 1) : -1;
    return [name, jobs.slice(start, next === -1 ? undefined : next)];
  }));
}

function needsFor(job) {
  const match = /^ {4}needs:\s*(.*)$/m.exec(job);
  if (!match) return [];
  if (match[1]) return match[1].replaceAll('[', '').replaceAll(']', '').split(',').map((value) => value.trim());
  return [...job.matchAll(/^ {6}- ([a-z][a-z0-9-]*)$/gm)].map((value) => value[1]);
}

function checkoutRefIsCurrentSha(job) {
  const checkout = /uses: actions\/checkout@[^\n]*\n\s+with:\n([\s\S]*?)(?=\n\s{6}- |$)/.exec(job);
  return checkout?.[1].includes('ref: ${{ github.sha }}') ?? false;
}

function assertReleaseWorkflowFailClosed(workflow) {
  const jobs = workflowJobs(workflow);
  const releaseJob = jobs.get('release');
  assert.ok(jobs.has('validate'), 'release must have a validation job');
  assert.ok(releaseJob, 'release must have one publication job');
  assert.deepEqual(needsFor(releaseJob), ['validate']);
  assert.doesNotMatch(releaseJob, /^ {4}if:.*always\(\)/m, 'job-level always() must not bypass validation');

  const policyStep = /- name: Gate release effects\n([\s\S]*?)(?=\n\s{6}- name:|$)/.exec(releaseJob)?.[1];
  assert.ok(policyStep, 'release must call the production release policy');
  assert.match(policyStep, /RELEASE_VALIDATION_RESULT: \$\{\{ needs\.validate\.result \}\}/);
  assert.match(policyStep, /APP_RELEASE_ELIGIBLE: \$\{\{ steps\.version\.outputs\.app_release_eligible \}\}/);
  assert.match(policyStep, /run: node tools\/release-policy\.js/);

  assert.match(releaseJob, /Build and publish multi-architecture image\n\s+id: build\n\s+if: steps\.policy\.outputs\.publish == 'true'/);
  assert.match(releaseJob, /Create GitHub release\n\s+if: steps\.policy\.outputs\.create_release == 'true'/);
  assert.match(releaseJob, /Dispatch Helm chart promotion\n\s+if: steps\.policy\.outputs\.dispatch == 'true' && steps\.image\.outcome == 'success'/);
  assert.match(releaseJob, /Set up Docker Buildx\n\s+if: steps\.policy\.outputs\.verify_image == 'true'/);
  assert.match(releaseJob, /Verify published manifest list\n\s+id: image\n\s+if: steps\.policy\.outputs\.verify_image == 'true'/);
  assert.match(releaseJob, /node tools\/release-policy\.js verify-digest/);
  assert.match(releaseJob, /Resolve immutable app release record\n\s+id: record\n\s+if: steps\.policy\.outputs\.verify_image == 'true' && steps\.image\.outcome == 'success'/);
  assert.match(releaseJob, /node tools\/release-records\.js verify-app/);
  assert.match(releaseJob, /node tools\/release-records\.js verify-legacy/);
  assert.match(releaseJob, /node tools\/release-records\.js write-app/);
  assert.match(releaseJob, /gh release create [\s\S]*?release-metadata\.json [\s\S]*?app-release-record\.json/);
  assert.match(releaseJob, /--arg version "\$RELEASE_VERSION"[\s\S]*?--arg tag "\$RELEASE_TAG"[\s\S]*?--arg commit "\$SOURCE_COMMIT"[\s\S]*?--arg app_record_ref/);
  assert.match(releaseJob, /app_record_ref: \$app_record_ref, app_record_sha256: \$app_record_sha256/);
  assert.doesNotMatch(releaseJob, /gh release upload|--clobber/, 'release replay must not replace immutable assets');
  const stepOrder = [
    'Sign published image digest',
    'Resolve immutable app release record',
    'Write release metadata',
    'Create GitHub release',
    'Dispatch Helm chart promotion',
  ].map((name) => releaseJob.indexOf(`- name: ${name}`));
  assert.ok(stepOrder.every((index) => index >= 0), 'record and release steps must all be present');
  assert.deepEqual(stepOrder, [...stepOrder].sort((left, right) => left - right), 'records follow successful signing and precede release publication and dispatch');
  assert.doesNotMatch(releaseJob, /if:.*always\(\)/, 'release side effects must not override policy outputs with always()');
  assert.deepEqual([...jobs.keys()].sort(), ['release', 'validate']);
  return releaseJob;
}

function stubEffects() {
  const events = [];
  return {
    events,
    effects: {
      verifyImage: () => events.push('verify-image'),
      publish: () => events.push('push-image', 'move-latest'),
      createRelease: () => events.push('create-release'),
      dispatch: () => events.push('dispatch'),
    },
  };
}

test('release runs lint, unit, Mongo, and PostgreSQL gates for its exact SHA', () => {
  assert.match(ci, /^ {2}workflow_call:\s*$/m, 'CI must be reusable by the release workflow');

  const ciJobs = workflowJobs(ci);
  for (const name of ['lint-and-unit', 'adapter-tests']) {
    assert.ok(ciJobs.has(name), `CI must contain ${name}`);
    assert.ok(checkoutRefIsCurrentSha(ciJobs.get(name)), `${name} must check out github.sha`);
    assert.match(ciJobs.get(name), /^ {4}permissions:\n {6}contents: read/m);
  }

  const adapters = ciJobs.get('adapter-tests');
  assert.match(adapters, /needs: lint-and-unit/);
  assert.match(adapters, /adapter: \[mongo, postgres\]/);
  assert.match(adapters, /RUN_ADAPTER_TESTS: '1'/);

  const releaseJob = assertReleaseWorkflowFailClosed(release);
  assert.match(workflowJobs(release).get('validate'), /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(releaseJob, /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n {6}id-token: write\n {6}attestations: write/m);
  assert.doesNotMatch(releaseJob, /npm run lint|npm test/);
});

test('the fail-closed workflow contract detects a job-level always bypass', () => {
  const bypassed = release.replace('    needs: validate\n', '    needs: validate\n    if: ${{ always() }}\n');
  assert.notEqual(bypassed, release, 'test mutation must change the release job');
  assert.throws(() => assertReleaseWorkflowFailClosed(bypassed), /always\(\)/);
});

test('workflow-facing policy outputs match failure, publication, and replay decisions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pacman-release-policy-'));
  const outputPath = join(directory, 'github-output.txt');

  try {
    const cases = [
      {
        validation: 'failure', existing: 'false', version: '0.8.1', latest: '0.8.0',
        expected: 'verify_image=false\npublish=false\ncreate_release=false\ndispatch=false\n',
      },
      {
        validation: 'success', existing: 'false', version: '0.8.1', latest: '0.8.0',
        expected: 'verify_image=true\npublish=true\ncreate_release=true\ndispatch=true\n',
      },
      {
        validation: 'success', existing: 'true', version: '0.7.15', latest: '0.7.17',
        expected: 'verify_image=true\npublish=false\ncreate_release=false\ndispatch=false\n',
      },
      {
        validation: 'success', existing: 'true', version: '0.7.17', latest: '0.7.17',
        expected: 'verify_image=true\npublish=false\ncreate_release=false\ndispatch=true\n',
      },
    ];

    for (const scenario of cases) {
      writeFileSync(outputPath, '');
      const result = spawnSync(process.execPath, [policyScript], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          RELEASE_VALIDATION_RESULT: scenario.validation,
          APP_RELEASE_ELIGIBLE: 'true',
          EXISTING_RELEASE: scenario.existing,
          RELEASE_VERSION: scenario.version,
          LATEST_RELEASE: scenario.latest,
        },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(outputPath, 'utf8'), scenario.expected);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('each failed mandatory gate executes no publication, latest mutation, release, or dispatch', async () => {
  for (const failedGate of ['lint', 'unit', 'mongo', 'postgres']) {
    const validation = { ...allGatesPassed, [failedGate]: 'failure' };
    const { events, effects } = stubEffects();
    const plan = await executeReleasePolicy({
      validation,
      appReleaseEligible: true,
      existingRelease: false,
      version: '0.8.1',
      latestRelease: '0.8.0',
    }, effects);

    assert.deepEqual(plan, { verifyImage: false, publish: false, createRelease: false, dispatch: false });
    assert.deepEqual(events, [], `${failedGate} failure must leave every side-effect boundary untouched`);
  }
});

test('a successful candidate requests one image publication and one downstream dispatch', async () => {
  const { events, effects } = stubEffects();
  const plan = await executeReleasePolicy({
    validation: allGatesPassed,
    appReleaseEligible: true,
    existingRelease: false,
    version: '0.8.1',
    latestRelease: '0.8.0',
  }, effects);

  assert.deepEqual(plan, { verifyImage: true, publish: true, createRelease: true, dispatch: true });
  assert.equal(events.filter((event) => event === 'push-image').length, 1);
  assert.equal(events.filter((event) => event === 'move-latest').length, 1);
  assert.equal(events.filter((event) => event === 'create-release').length, 1);
  assert.equal(events.filter((event) => event === 'dispatch').length, 1);
});

test('an older immutable replay verifies its image without pushing, moving latest, or dispatching', async () => {
  const { events, effects } = stubEffects();
  const plan = await executeReleasePolicy({
    validation: allGatesPassed,
    appReleaseEligible: true,
    existingRelease: true,
    version: '0.7.15',
    latestRelease: '0.7.17',
    recordedDigest: digestA,
    imageDigest: digestA,
  }, effects);

  assert.deepEqual(plan, { verifyImage: true, publish: false, createRelease: false, dispatch: false });
  assert.deepEqual(events, ['verify-image']);
});

test('replaying the newest immutable release verifies its digest and dispatches once', async () => {
  const { events, effects } = stubEffects();
  const plan = await executeReleasePolicy({
    validation: allGatesPassed,
    appReleaseEligible: true,
    existingRelease: true,
    version: '0.7.17',
    latestRelease: '0.7.17',
    recordedDigest: digestA,
    imageDigest: digestA,
  }, effects);

  assert.deepEqual(plan, { verifyImage: true, publish: false, createRelease: false, dispatch: true });
  assert.deepEqual(events, ['verify-image', 'dispatch']);
});

test('an immutable replay with a digest mismatch fails before any effect', async () => {
  const { events, effects } = stubEffects();
  await assert.rejects(executeReleasePolicy({
    validation: allGatesPassed,
    appReleaseEligible: true,
    existingRelease: true,
    version: '0.7.17',
    latestRelease: '0.7.17',
    recordedDigest: digestA,
    imageDigest: digestB,
  }, effects), /Immutable release digest mismatch/);
  assert.deepEqual(events, []);
});

test('docs and chart-only changes request no app publication or promotion effects', async () => {
  const { events, effects } = stubEffects();
  const plan = await executeReleasePolicy({
    validation: allGatesPassed,
    appReleaseEligible: false,
    existingRelease: false,
    version: 'not-a-version',
    latestRelease: 'not-a-version',
  }, effects);

  assert.deepEqual(plan, { verifyImage: false, publish: false, createRelease: false, dispatch: false });
  assert.deepEqual(events, []);
});

test('push filters include app build inputs and the future co-located chart path', () => {
  const push = /\n {2}push:\n([\s\S]*?)(?=\n {2}workflow_dispatch:)/.exec(release)?.[1];
  assert.ok(push, 'release workflow must retain main push triggering');
  assert.match(push, /branches: \[main\]/);
  for (const path of [
    "'.dockerignore'",
    "'.nvmrc'",
    "'docker/Dockerfile'",
    "'package.json'",
    "'package-lock.json'",
    "'proto/**'",
    "'public/**'",
    "'src/**'",
    "'tools/healthcheck.js'",
    "'tools/demo-exec-probe.js'",
    "'demo-fixtures/**'",
    "'views/**'",
    "'charts/pacman/**'",
  ]) {
    assert.ok(push.includes(path), `release trigger must include ${path}`);
  }

  const manual = /\n {2}workflow_dispatch:\n([\s\S]*?)(?=\n\nconcurrency:)/.exec(release)?.[1];
  assert.ok(manual, 'workflow_dispatch must remain enabled');
  assert.match(manual, /release_bump:/);
  assert.match(manual, /options:\s*\[patch, minor, major\]/);
  assert.match(release, /RELEASE_BUMP: \$\{\{ inputs\.release_bump \}\}/);
  assert.match(release, /concurrency:\n {2}group: pacman-release\n {2}cancel-in-progress: false/);
});
