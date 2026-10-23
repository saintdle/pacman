import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { planChartSourceProposal, planChartSourcePromotion, promoteChartSourceMetadata, resolveNextChartVersion, selectPendingChartSourceProposalState } from '../tools/pacman-chart-source-promotion.mjs';

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
  assert.throws(() => planChartSourceProposal({ mode: 'resume', candidate: rollback, current, state: { mode: 'automatic' } }), /pending rollback/);
});

test('workflow gates proposal creation on the guard output and exposes verified rollback and resume controls', () => {
  const workflow = readFileSync(new URL('../.github/workflows/chart-source-promotion.yml', import.meta.url), 'utf8');
  assert.match(workflow, /id: proposal/);
  assert.match(workflow, /Preserve only a verified pending chart source proposal/);
  assert.match(workflow, /Read the merged promotion state/);
  assert.match(workflow, /CURRENT_STATE: \$\{\{ steps\.current-state\.outputs\.state \|\| '' \}\}/);
  assert.match(workflow, /--json state,headRefName,headRefOid,baseRefName,baseRefOid,isCrossRepository/);
  assert.match(workflow, /echo "create=false" >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow, /if: steps\.plan\.outputs\.action != 'noop' && steps\.proposal\.outputs\.create == 'true' && steps\.pending\.outputs\.open != 'true'/);
  assert.match(workflow, /options: \[reconcile, rollback, resume\]/);
  assert.match(workflow, /rollback_app_record_ref/);
  assert.match(workflow, /Rollback identity does not match the verified app release record/);
  assert.match(workflow, /branch="\$branch-\$APP_VERSION"/);
});
