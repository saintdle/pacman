import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyChartSourcePromotion, planChartSourceProposal, planChartSourcePromotion, promoteChartSourceMetadata, readChartSourceMetadata, resolveNextChartVersion, selectPendingChartSourceProposalState } from '../tools/pacman-chart-source-promotion.mjs';

const digest = (letter) => `sha256:${letter.repeat(64)}`;

test('chart source promotion preserves independent versions and skips already released versions', () => {
  assert.equal(resolveNextChartVersion('0.7.18', '0.7.17', ['pacman-0.7.18']), '0.7.19');
  assert.deepEqual(planChartSourcePromotion({
    appVersion: '0.7.18', imageDigest: digest('b'),
    currentAppVersion: '0.7.16', currentImageDigest: digest('a'), currentChartVersion: '0.7.17',
    releasedTags: ['pacman-0.7.18'],
  }), { promotion: 'update', reason: 'newer-app-release', chartVersion: '0.7.19' });
});

test('chart source promotion is monotonic under replay and out-of-order releases', () => {
  assert.deepEqual(planChartSourcePromotion({
    appVersion: '0.7.15', imageDigest: digest('a'),
    currentAppVersion: '0.7.16', currentImageDigest: digest('b'), currentChartVersion: '0.7.17',
  }), { promotion: 'noop', reason: 'older-app-release' });
  assert.deepEqual(planChartSourcePromotion({
    appVersion: '0.7.16', imageDigest: digest('b'),
    currentAppVersion: '0.7.16', currentImageDigest: digest('b'), currentChartVersion: '0.7.17',
  }), { promotion: 'noop', reason: 'already-promoted' });
  assert.throws(() => planChartSourcePromotion({
    appVersion: '0.7.16', imageDigest: digest('c'),
    currentAppVersion: '0.7.16', currentImageDigest: digest('b'), currentChartVersion: '0.7.17',
  }), /conflicting image digest/);
});

test('source promotion edits only chart version, app version, and image digest', () => {
  const chartYaml = [
    'apiVersion: v2', 'name: pacman', 'version: 0.7.17', 'appVersion: "0.7.16"',
    'description: keep this text', 'templates: untouched', '',
  ].join('\n');
  const valuesYaml = ['image:', '  repository: docker.io/saintdle/pacman', `  digest: "${digest('a')}"`, 'replicaCount: 1', ''].join('\n');
  const result = promoteChartSourceMetadata(chartYaml, valuesYaml, {
    appVersion: '0.7.18', chartVersion: '0.7.19', imageDigest: digest('b'),
  });

  assert.equal(result.chartYaml, chartYaml.replace('version: 0.7.17', 'version: 0.7.19').replace('appVersion: "0.7.16"', 'appVersion: "0.7.18"'));
  assert.equal(result.valuesYaml, valuesYaml.replace(digest('a'), digest('b')));
  assert.throws(() => promoteChartSourceMetadata(`${chartYaml}version: 1.0.0\n`, valuesYaml, {
    appVersion: '0.7.18', chartVersion: '0.7.19', imageDigest: digest('b'),
  }), /chart version must appear exactly once/);
});

test('managed raw examples follow chart image metadata across independent app and chart promotions', () => {
  const baseChart = ['apiVersion: v2', 'name: pacman', 'version: 0.7.17', 'appVersion: "0.7.16"', ''].join('\n');
  const baseValues = ['image:', '  repository: docker.io/saintdle/pacman', `  digest: "${digest('a')}"`, ''].join('\n');
  const sourceMulti = readFileSync(new URL('../k8s/examples/multi-role-deployment.yaml', import.meta.url), 'utf8')
    .replaceAll(/image: docker\.io\/saintdle\/pacman(?:@sha256:[a-f0-9]{64}|:latest)/g, 'image: docker.io/saintdle/pacman:latest');
  const sourcePostgres = readFileSync(new URL('../k8s/examples/postgres-example.yaml', import.meta.url), 'utf8')
    .replaceAll(/image: docker\.io\/saintdle\/pacman(?:@sha256:[a-f0-9]{64}|:latest)/g, 'image: docker.io/saintdle/pacman:latest');
  const cases = [
    { appVersion: '0.7.18', chartVersion: '0.7.17', imageDigest: digest('b') },
    { appVersion: '0.7.16', chartVersion: '0.7.18', imageDigest: digest('a') },
  ];
  for (const candidate of cases) {
    const directory = mkdtempSync(join(tmpdir(), 'pacman-example-generation-'));
    try {
      const chartPath = join(directory, 'Chart.yaml');
      const valuesPath = join(directory, 'values.yaml');
      const multiRolePath = join(directory, 'multi-role-deployment.yaml');
      const postgresPath = join(directory, 'postgres-example.yaml');
      writeFileSync(chartPath, baseChart);
      writeFileSync(valuesPath, baseValues);
      writeFileSync(multiRolePath, sourceMulti);
      writeFileSync(postgresPath, sourcePostgres);
      applyChartSourcePromotion({ chartPath, valuesPath, ...candidate, consumerPaths: { multiRolePath, postgresPath } });
      const metadata = readChartSourceMetadata(chartPath, valuesPath);
      assert.equal(metadata.chartVersion, candidate.chartVersion);
      assert.equal(metadata.appVersion, candidate.appVersion);
      const image = `docker.io/saintdle/pacman@${candidate.imageDigest}`;
      assert.equal(readFileSync(multiRolePath, 'utf8'), sourceMulti.replaceAll('image: docker.io/saintdle/pacman:latest', `image: ${image}`));
      assert.equal(readFileSync(postgresPath, 'utf8'), sourcePostgres.replaceAll('image: docker.io/saintdle/pacman:latest', `image: ${image}`));
      assert.match(readFileSync(multiRolePath, 'utf8'), /name: pacman-web[\s\S]*name: pacman-score[\s\S]*name: pacman-user/);
      assert.match(readFileSync(postgresPath, 'utf8'), /name: pacman-postgres-secret[\s\S]*name: pacman-postgres-data[\s\S]*name: pacman-postgres/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
});

test('tracked generic raw app images conform to the authoritative chart repository and digest', () => {
  const metadata = readChartSourceMetadata(new URL('../charts/pacman/Chart.yaml', import.meta.url), new URL('../charts/pacman/values.yaml', import.meta.url));
  const expected = `${metadata.imageRepository}@${metadata.imageDigest}`;
  for (const [file, count] of [['multi-role-deployment.yaml', 3], ['postgres-example.yaml', 2]]) {
    const content = readFileSync(new URL(`../k8s/examples/${file}`, import.meta.url), 'utf8');
    const images = [...content.matchAll(/^\s*image:\s*(docker\.io\/saintdle\/pacman\S*)\s*$/gm)].map(([, image]) => image);
    assert.equal(images.length, count, `${file} retains all named app image slots`);
    assert.ok(images.every((image) => image === expected), `${file} matches chart values.yaml`);
  }
});

test('a verified open proposal preserves ordering and rejects conflicting immutable identity', () => {
  const candidate = { version: '0.7.18', imageDigest: digest('b'), reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.18/app-release-record.json', sha256: 'a'.repeat(64), sourceCommit: 'c'.repeat(40) };
  const pending = { schema_version: 1, kind: 'pacman-chart-source-promotion-state', mode: 'automatic', app: candidate, chartVersion: '0.7.19' };
  const proposal = { state: 'OPEN', isCrossRepository: false, headRefName: 'automation/pacman-chart-source', headRefOid: 'd'.repeat(40), baseRefName: 'main', baseRefOid: 'e'.repeat(40) };
  assert.deepEqual(selectPendingChartSourceProposalState({ state: pending, pullRequests: [proposal], branchSha: 'd'.repeat(40), baseSha: 'e'.repeat(40) }), pending);
  assert.equal(planChartSourceProposal({ candidate, pending, current: { appVersion: '0.7.16', imageDigest: digest('a'), chartVersion: '0.7.17' } }).reason, 'same-pending-promotion');
  assert.throws(() => planChartSourceProposal({ candidate: { ...candidate, sha256: 'f'.repeat(64) }, pending, current: { appVersion: '0.7.16', imageDigest: digest('a'), chartVersion: '0.7.17' } }), /conflicts/);
  assert.equal(selectPendingChartSourceProposalState({ state: pending, pullRequests: [{ ...proposal, state: 'CLOSED' }], branchSha: 'd'.repeat(40), baseSha: 'e'.repeat(40) }), null);
});

test('rollback is a verified proposal and resume requires its pending state', () => {
  const rollback = { version: '0.7.15', imageDigest: digest('a'), reference: 'https://github.com/saintdle/pacman/releases/download/pacman-v0.7.15/app-release-record.json', sha256: 'b'.repeat(64), sourceCommit: 'c'.repeat(40) };
  const current = { appVersion: '0.7.16', imageDigest: digest('d'), chartVersion: '0.7.17' };
  const proposal = planChartSourceProposal({ mode: 'rollback', candidate: rollback, current, rollbackReason: 'Restore the verified previous release' });
  assert.equal(proposal.action, 'rollback-proposal');
  assert.equal(proposal.candidate.reference, rollback.reference);
  assert.equal(planChartSourceProposal({ mode: 'resume', candidate: rollback, current: { appVersion: rollback.version, imageDigest: rollback.imageDigest, chartVersion: proposal.chartVersion }, state: { mode: 'rollback' } }).action, 'resume');
  assert.deepEqual(planChartSourceProposal({ mode: 'resume', candidate: rollback, current: { appVersion: '0.9.0', imageDigest: digest('e'), chartVersion: '3.0.0' }, state: { mode: 'rollback' } }), { action: 'noop', reason: 'resume-target-is-older-than-current' });
  assert.throws(() => planChartSourceProposal({ mode: 'resume', candidate: rollback, current, state: { mode: 'automatic' } }), /pending rollback/);
});

test('workflow gates proposal creation on the guard output and exposes verified rollback and resume controls', () => {
  const workflow = readFileSync(new URL('../.github/workflows/chart-source-promotion.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^  repository_dispatch:\n    types: \[pacman-release\]$/m, 'same-repository release notifications must wake the app-owned promoter');
  assert.match(workflow, /^  release:\n    types: \[published\]$/m, 'release publication must remain a promoter trigger');
  assert.match(workflow, /^  schedule:\n    - cron: '37 \* \* \* \*'$/m, 'scheduled reconciliation must remain enabled');
  assert.match(workflow, /^  workflow_dispatch:\n/m, 'manual reconciliation and rollback controls must remain enabled');
  assert.match(workflow, /EVENT_RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \|\| '' \}\}/);
  assert.match(workflow, /if \[\[ -z "\$release_tag" \]\]; then[\s\S]*?gh release list --repo saintdle\/pacman --limit 1/);
  assert.match(workflow, /node tools\/release-records\.js verify-app/);
  assert.doesNotMatch(workflow, /github\.event\.client_payload/, 'dispatch payload must not select or supply release authority');
  assert.match(workflow, /id: proposal/);
  assert.match(workflow, /Preserve only a verified pending chart source proposal/);
  assert.match(workflow, /Read the merged promotion state/);
  assert.match(workflow, /CURRENT_STATE: \$\{\{ steps\.current-state\.outputs\.state \|\| '' \}\}/);
  assert.match(workflow, /--json state,headRefName,headRefOid,baseRefName,baseRefOid,isCrossRepository/);
  assert.match(workflow, /echo "create=false" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /if: steps\.authority\.outputs\.active == 'true' && steps\.plan\.outputs\.action != '' && steps\.plan\.outputs\.action != 'noop'/);
  assert.match(workflow, /if: steps\.authority\.outputs\.active == 'true' && steps\.plan\.outputs\.action != '' && steps\.plan\.outputs\.action != 'noop' && steps\.proposal\.outputs\.create == 'true' && steps\.pending\.outputs\.open != 'true'/);
  assert.match(workflow, /options: \[reconcile, rollback, resume\]/);
  assert.match(workflow, /rollback_app_record_ref/);
  assert.match(workflow, /Rollback identity does not match the verified app release record/);
  assert.match(workflow, /branch="\$branch-\$APP_VERSION"/);
  assert.match(workflow, /git add charts\/pacman\/Chart\.yaml charts\/pacman\/values\.yaml k8s\/examples\/multi-role-deployment\.yaml k8s\/examples\/postgres-example\.yaml pacman-chart-source-promotion-state\.json/);
});

test('source proposal workflow commits with the configured GitHub bot author and committer', () => {
  const workflow = readFileSync(new URL('../.github/workflows/chart-source-promotion.yml', import.meta.url), 'utf8');
  const proposalStart = workflow.indexOf('      - name: Create the app-owned chart source proposal\n');
  assert.notEqual(proposalStart, -1, 'workflow must include the guarded proposal step');
  const proposal = workflow.slice(proposalStart);
  const commitPosition = proposal.search(/^[ ]{10}git commit /m);
  assert.notEqual(commitPosition, -1, 'proposal step must include its commit command');
  const preCommitCommands = proposal.slice(0, commitPosition);
  const identityCommands = [...preCommitCommands.matchAll(/^[ ]{10}git config --local user\.(?:name|email) .+$/gm)]
    .map(([command]) => command.trim());

  const directory = mkdtempSync(join(tmpdir(), 'pacman-chart-source-identity-'));
  const repository = join(directory, 'repository');
  const globalConfig = join(directory, 'global-gitconfig');
  mkdirSync(repository);
  writeFileSync(globalConfig, '');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'EMAIL')),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const runGit = (args) => spawnSync('git', args, { cwd: repository, env, encoding: 'utf8' });

  try {
    const initialized = runGit(['init', '--quiet']);
    assert.equal(initialized.status, 0, initialized.stderr);
    writeFileSync(join(repository, 'proposal.txt'), 'chart source proposal\n');
    const staged = runGit(['add', 'proposal.txt']);
    assert.equal(staged.status, 0, staged.stderr);

    const committed = spawnSync('bash', ['-euo', 'pipefail', '-c', `${identityCommands.join('\n')}\ngit commit -m "chart source proposal"`], {
      cwd: repository,
      env,
      encoding: 'utf8',
    });
    assert.equal(committed.status, 0, committed.stderr);

    const identity = runGit(['show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', 'HEAD']);
    assert.equal(identity.status, 0, identity.stderr);
    assert.deepEqual(identity.stdout.trim().split('\0'), [
      'github-actions[bot]',
      '41898282+github-actions[bot]@users.noreply.github.com',
      'github-actions[bot]',
      '41898282+github-actions[bot]@users.noreply.github.com',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
