import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const checksumPattern = /^[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;
const stateKind = 'pacman-chart-source-promotion-state';

function fail(message) {
  throw new Error(message);
}

function parseVersion(value, source) {
  const match = typeof value === 'string' ? versionPattern.exec(value) : null;
  if (!match) fail(`${source} must use canonical MAJOR.MINOR.PATCH format`);
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

export function resolveNextChartVersion(appVersionValue, currentChartVersionValue, releasedTags) {
  const appVersion = parseVersion(appVersionValue, 'app version');
  const currentChartVersion = parseVersion(currentChartVersionValue, 'current chart version');
  let candidate = compareVersions(appVersion, currentChartVersion) > 0 ? appVersion : patchVersion(currentChartVersion);
  while (releasedTags.includes(`pacman-${formatVersion(candidate)}`)) candidate = patchVersion(candidate);
  if (compareVersions(candidate, currentChartVersion) <= 0) fail('resolved chart version must be newer than the current chart version');
  return formatVersion(candidate);
}

export function planChartSourcePromotion({ appVersion, imageDigest, currentAppVersion, currentImageDigest, currentChartVersion, releasedTags = [] }) {
  const app = parseVersion(appVersion, 'app version');
  const currentApp = parseVersion(currentAppVersion, 'current app version');
  const chart = parseVersion(currentChartVersion, 'current chart version');
  if (!digestPattern.test(imageDigest ?? '') || !digestPattern.test(currentImageDigest ?? '')) fail('image digests must be SHA-256 digests');
  const comparison = compareVersions(app, currentApp);
  if (comparison < 0) return { promotion: 'noop', reason: 'older-app-release' };
  if (comparison === 0) {
    if (imageDigest !== currentImageDigest) fail('same app version has a conflicting image digest');
    return { promotion: 'noop', reason: 'already-promoted' };
  }
  return {
    promotion: 'update',
    reason: 'newer-app-release',
    chartVersion: resolveNextChartVersion(appVersion, currentChartVersion, releasedTags),
  };
}

function requireAppIdentity(identity, name) {
  if (!identity || !versionPattern.test(identity.version ?? '') || !digestPattern.test(identity.imageDigest ?? '')
    || typeof identity.reference !== 'string' || !checksumPattern.test(identity.sha256 ?? '')
    || !commitPattern.test(identity.sourceCommit ?? '')) fail(`${name} must contain a verified immutable app identity`);
}

export function preservePendingChartSourcePromotion({ pending, candidate }) {
  requireAppIdentity(pending, 'pending promotion');
  requireAppIdentity(candidate, 'candidate promotion');
  const comparison = compareVersions(parseVersion(pending.version, 'pending app version'), parseVersion(candidate.version, 'candidate app version'));
  if (comparison > 0) return 'newer-pending-promotion';
  if (comparison === 0) {
    for (const field of ['imageDigest', 'reference', 'sha256', 'sourceCommit']) {
      if (pending[field] !== candidate[field]) fail(`pending promotion conflicts with the verified app ${field}`);
    }
    return 'same-pending-promotion';
  }
  return null;
}

export function rollbackChartSourceProposal({ candidate, chartVersion, reason }) {
  requireAppIdentity(candidate, 'rollback candidate');
  if (!versionPattern.test(chartVersion ?? '') || typeof reason !== 'string' || reason.trim().length < 8) {
    fail('rollback proposal requires a verified immutable app identity, chart version, and reason');
  }
  return { action: 'rollback-proposal', reason: 'explicit-rollback-proposal', rollbackReason: reason.trim(), candidate, chartVersion };
}

export function resumeChartSourceRollback({ state, candidate, chartVersion }) {
  if (state?.mode !== 'rollback') fail('resume requires a pending rollback proposal');
  requireAppIdentity(candidate, 'resume candidate');
  if (!versionPattern.test(chartVersion ?? '')) fail('resume requires a canonical chart version');
  return { action: 'resume', reason: 'explicit-resume-after-rollback', candidate, chartVersion };
}

export function selectPendingChartSourceProposalState({ state, pullRequests, branchSha, baseSha }) {
  if (!state || state.schema_version !== 1 || state.kind !== stateKind || !['automatic', 'rollback'].includes(state.mode)
    || !Array.isArray(pullRequests) || !versionPattern.test(state.chartVersion ?? '')) return null;
  try { requireAppIdentity(state.app, 'pending proposal'); } catch { return null; }
  const matches = pullRequests.filter((proposal) => proposal?.state === 'OPEN' && proposal.isCrossRepository === false
    && proposal.headRefName === 'automation/pacman-chart-source' && proposal.headRefOid === branchSha
    && proposal.baseRefName === 'main' && proposal.baseRefOid === baseSha);
  return matches.length === 1 ? state : null;
}

export function writeChartSourcePromotionState(plan) {
  if (!plan || !['promotion', 'rollback-proposal', 'resume'].includes(plan.action)) fail('promotion state requires an actionable plan');
  return {
    schema_version: 1,
    kind: stateKind,
    mode: plan.action === 'rollback-proposal' ? 'rollback' : 'automatic',
    app: plan.candidate,
    chartVersion: plan.chartVersion,
    ...(plan.rollbackReason ? { rollback: { targetReference: plan.candidate.reference, targetSha256: plan.candidate.sha256, reason: plan.rollbackReason } } : {}),
  };
}

export function planChartSourceProposal({ mode = 'reconcile', candidate, current, releasedTags = [], pending, state, rollbackReason = '' }) {
  requireAppIdentity(candidate, 'candidate promotion');
  if (!['reconcile', 'rollback', 'resume'].includes(mode)) fail('unsupported promotion mode');
  if (mode === 'resume' && state?.mode !== 'rollback') fail('resume requires a pending rollback proposal');
  if (state?.mode === 'rollback' && mode === 'reconcile') return { action: 'noop', reason: 'rollback-state-requires-explicit-resume' };
  if (mode === 'reconcile' && pending) {
    const decision = preservePendingChartSourcePromotion({ pending: pending.app, candidate });
    if (decision) return { action: 'noop', reason: decision };
  }
  const floor = pending && compareVersions(parseVersion(pending.chartVersion, 'pending chart version'), parseVersion(current.chartVersion, 'current chart version')) > 0
    ? pending.chartVersion : current.chartVersion;
  if (mode === 'rollback') {
    if (compareVersions(parseVersion(candidate.version, 'rollback app version'), parseVersion(current.appVersion, 'current app version')) >= 0) fail('rollback target must be older than the current app version');
    return rollbackChartSourceProposal({ candidate, chartVersion: resolveNextChartVersion(candidate.version, floor, releasedTags), reason: rollbackReason });
  }
  const promotion = planChartSourcePromotion({ appVersion: candidate.version, imageDigest: candidate.imageDigest,
    currentAppVersion: current.appVersion, currentImageDigest: current.imageDigest, currentChartVersion: floor, releasedTags });
  if (promotion.promotion === 'noop') {
    if (mode === 'resume' && state?.mode === 'rollback') return resumeChartSourceRollback({ state, candidate, chartVersion: current.chartVersion });
    return { action: 'noop', reason: promotion.reason };
  }
  return { action: 'promotion', reason: promotion.reason, candidate, chartVersion: promotion.chartVersion };
}

function replaceOne(text, expression, value, name) {
  const matches = text.match(expression);
  if (!matches || matches.length !== 1) fail(`${name} must appear exactly once in chart metadata`);
  return text.replace(expression, (line) => line.replace(/(:\s*)(?:(["'])(.*?)\2|([^\s#]+))/, (_match, separator, quote, _quoted, bare) => {
    const wrapper = quote ?? '';
    return `${separator}${wrapper}${value}${wrapper}`;
  }));
}

export function promoteChartSourceMetadata(chartYaml, valuesYaml, { appVersion, chartVersion, imageDigest }) {
  parseVersion(appVersion, 'app version');
  parseVersion(chartVersion, 'chart version');
  if (!digestPattern.test(imageDigest ?? '')) fail('image digest must be a SHA-256 digest');
  const nextChart = replaceOne(chartYaml, /^version:\s*(?:"[^"]*"|'[^']*'|[^\s#]+).*$/gm, chartVersion, 'chart version');
  const nextApp = replaceOne(nextChart, /^appVersion:\s*(?:"[^"]*"|'[^']*'|[^\s#]+).*$/gm, appVersion, 'app version');
  const nextValues = replaceOne(valuesYaml, /^\s+digest:\s*(?:"[^"]*"|'[^']*'|[^\s#]+).*$/gm, imageDigest, 'image digest');
  return { chartYaml: nextApp, valuesYaml: nextValues };
}

export function readChartSourceMetadata(chartPath, valuesPath) {
  const chartYaml = readFileSync(chartPath, 'utf8');
  const valuesYaml = readFileSync(valuesPath, 'utf8');
  const chartVersion = chartYaml.match(/^version:\s*(\S+)/m)?.[1]?.replace(/^['"]|['"]$/g, '');
  const appVersion = chartYaml.match(/^appVersion:\s*['"]?(\S+?)['"]?\s*$/m)?.[1];
  const imageDigest = valuesYaml.match(/^\s+digest:\s*['"]?(sha256:[a-f0-9]{64})['"]?\s*$/m)?.[1];
  return { chartYaml, valuesYaml, chartVersion, appVersion, imageDigest };
}

export function applyChartSourcePromotion({ chartPath, valuesPath, appVersion, chartVersion, imageDigest }) {
  const current = readChartSourceMetadata(chartPath, valuesPath);
  const next = promoteChartSourceMetadata(current.chartYaml, current.valuesYaml, { appVersion, chartVersion, imageDigest });
  writeFileSync(chartPath, next.chartYaml);
  writeFileSync(valuesPath, next.valuesYaml);
  return next;
}

async function main() {
  const [command, chartPath, valuesPath] = process.argv.slice(2);
  if (command === 'read') {
    const state = readChartSourceMetadata(chartPath, valuesPath);
    console.log(`chart_version=${state.chartVersion}`);
    console.log(`app_version=${state.appVersion}`);
    console.log(`image_digest=${state.imageDigest}`);
    return;
  }
  if (command === 'plan') {
    const plan = planChartSourceProposal({
      mode: process.env.PROMOTION_MODE || 'reconcile',
      candidate: { version: process.env.APP_VERSION, imageDigest: process.env.IMAGE_DIGEST, reference: process.env.APP_RECORD_REFERENCE, sha256: process.env.APP_RECORD_SHA256, sourceCommit: process.env.SOURCE_COMMIT },
      current: { appVersion: process.env.CURRENT_APP_VERSION, imageDigest: process.env.CURRENT_IMAGE_DIGEST, chartVersion: process.env.CURRENT_CHART_VERSION },
      releasedTags: process.env.RELEASED_CHART_TAGS?.split(',').filter(Boolean) ?? [],
      pending: process.env.PENDING_STATE ? JSON.parse(process.env.PENDING_STATE) : undefined,
      state: process.env.CURRENT_STATE ? JSON.parse(process.env.CURRENT_STATE) : undefined,
      rollbackReason: process.env.ROLLBACK_REASON,
    });
    console.log(`action=${plan.action}`);
    console.log(`reason=${plan.reason}`);
    if (plan.chartVersion) console.log(`chart_version=${plan.chartVersion}`);
    if (plan.action !== 'noop') console.log(`state=${JSON.stringify(writeChartSourcePromotionState(plan))}`);
    return;
  }
  if (command === 'filter-pending') {
    const state = JSON.parse(readFileSync(chartPath, 'utf8'));
    const pullRequests = JSON.parse(readFileSync(valuesPath, 'utf8'));
    const selected = selectPendingChartSourceProposalState({ state, pullRequests,
      branchSha: process.env.PENDING_BRANCH_SHA, baseSha: process.env.PENDING_BASE_SHA });
    console.log(JSON.stringify(selected));
    return;
  }
  if (command === 'apply') {
    applyChartSourcePromotion({
      chartPath,
      valuesPath,
      appVersion: process.env.APP_VERSION,
      chartVersion: process.env.CHART_VERSION,
      imageDigest: process.env.IMAGE_DIGEST,
    });
    return;
  }
  fail('usage: pacman-chart-source-promotion.mjs read <Chart.yaml> <values.yaml> | plan | filter-pending <state.json> <pull-requests.json> | apply <Chart.yaml> <values.yaml>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
