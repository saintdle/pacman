import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');

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

function simulateReleaseEffects(validationConclusion, releaseNeeds, releaseJob) {
  const successfulJobs = new Set(validationConclusion === 'success' ? ['validate'] : []);
  if (!releaseNeeds.every((dependency) => successfulJobs.has(dependency))) return [];

  return [
    ...(releaseJob.includes('docker/build-push-action') ? ['push-image'] : []),
    ...(releaseJob.includes('gh release create') ? ['create-release'] : []),
    ...(releaseJob.includes('helm-charts/dispatches') ? ['dispatch-downstream'] : []),
  ];
}

test('release runs the lint, unit, Mongo, and PostgreSQL gates for its exact SHA', () => {
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

  const releaseJobs = workflowJobs(release);
  assert.ok(releaseJobs.has('validate'), 'release must call the shared CI workflow');
  assert.match(releaseJobs.get('validate'), /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(releaseJobs.get('validate'), /^ {4}permissions:\n {6}contents: read\n {6}security-events: write/m);
  assert.ok(releaseJobs.has('release'), 'release must have one publication job');
  assert.deepEqual([...releaseJobs.keys()].sort(), ['release', 'validate']);
  assert.deepEqual(needsFor(releaseJobs.get('release')), ['validate']);
  assert.ok(checkoutRefIsCurrentSha(releaseJobs.get('release')));
  assert.match(releaseJobs.get('release'), /^ {4}permissions:\n {6}contents: write\n {6}issues: write\n {6}id-token: write\n {6}attestations: write/m);
  assert.doesNotMatch(releaseJobs.get('release'), /npm run lint|npm test/);
});

test('a failed Mongo or PostgreSQL gate causes no release side effects', () => {
  const ciJobs = workflowJobs(ci);
  const adapterJob = ciJobs.get('adapter-tests');
  assert.match(adapterJob, /adapter: \[mongo, postgres\]/);

  const releaseJobs = workflowJobs(release);
  const releaseJob = releaseJobs.get('release');
  const needs = needsFor(releaseJob);
  assert.equal((releaseJob.match(/docker\/build-push-action@/g) ?? []).length, 1);
  assert.equal((releaseJob.match(/gh release create/g) ?? []).length, 1);
  assert.equal((releaseJob.match(/helm-charts\/dispatches/g) ?? []).length, 1);
  assert.match(releaseJob, /push: true/);

  for (const failedAdapter of ['mongo', 'postgres']) {
    assert.deepEqual(
      simulateReleaseEffects('failure', needs, releaseJob),
      [],
      `a failed ${failedAdapter} matrix job must block image pushes, release creation, and dispatch`,
    );
  }

  assert.deepEqual(
    simulateReleaseEffects('success', needs, releaseJob),
    ['push-image', 'create-release', 'dispatch-downstream'],
    'a passing validation run permits the one release job to publish and dispatch',
  );
});

test('replaying an existing release uses its recorded digest without moving latest', () => {
  const releaseJob = workflowJobs(release).get('release');
  assert.match(releaseJob, /existing_release/);
  assert.match(releaseJob, /gh release view/);
  assert.match(releaseJob, /sha256:\[0-9a-f\]\{64\}/);
  assert.match(releaseJob, /RELEASE_TAG/);
  assert.match(releaseJob, /Build and publish multi-architecture image[\s\S]*?if: steps\.version\.outputs\.existing_release != 'true'/);
  assert.match(releaseJob, /Create GitHub release[\s\S]*?if: steps\.version\.outputs\.existing_release != 'true'/);

  const replayBranch = /if \[\[ "\$EXISTING_RELEASE" == "true" \]\]; then([\s\S]*?)\n\s*else\n/.exec(releaseJob);
  assert.ok(replayBranch, 'manifest verification must separate existing-release replay from first publication');
  assert.doesNotMatch(replayBranch[1], /latest/);
});
