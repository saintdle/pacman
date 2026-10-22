import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function normalizeImageId(value) {
  return value.match(/sha256:[a-f0-9]{64}$/)?.[0] ?? value;
}

export function assertPodImageIdentity(pod, {
  containerName = 'pacman',
  image,
  imageId,
  role,
  revision,
  version,
} = {}) {
  const name = pod.metadata?.name ?? '<unnamed pod>';
  const container = pod.spec?.containers?.find((item) => item.name === containerName);
  const status = pod.status?.containerStatuses?.find((item) => item.name === containerName);

  assert.ok(container, `${name} must define the ${containerName} container`);
  assert.equal(container.image, image, `container image identity mismatch for ${name}`);
  assert.ok(status, `${name} must report the ${containerName} container status`);
  assert.equal(
    normalizeImageId(status.imageID ?? ''),
    normalizeImageId(imageId),
    `container image identity mismatch for ${name}: ${status.imageID}`,
  );

  if (version !== undefined) {
    assert.equal(version.app, 'pacman', `${name} must report the Pac-Man runtime`);
    assert.equal(version.role, role, `${name} runtime role must be ${role}`);
    assert.equal(version.commit, revision, `${name} runtime commit must be ${revision}`);
  }
}

function kubectl(kubeconfig, namespace, args) {
  return execFileSync('kubectl', [
    '--kubeconfig', kubeconfig,
    '--namespace', namespace,
    ...args,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
}

function option(args, name) {
  const index = args.indexOf(name);
  assert.ok(index >= 0 && args[index + 1], `pass ${name} <value>`);
  return args[index + 1];
}

function readRuntimeInfo(kubeconfig, namespace, podName) {
  const code = "Promise.all(['/healthz', '/readyz', '/version'].map(async (path) => { const response = await fetch('http://127.0.0.1:8080' + path); if (!response.ok) throw new Error('GET ' + path + ' returned ' + response.status); return [path, path === '/version' ? await response.json() : response.status]; })).then((results) => console.log(JSON.stringify(Object.fromEntries(results)))).catch((error) => { console.error(error.message); process.exitCode = 1; });";
  const output = kubectl(kubeconfig, namespace, [
    'exec', podName,
    '--container', 'pacman',
    '--', 'node', '-e', code,
  ]);
  return JSON.parse(output);
}

function verifyRole(args) {
  const kubeconfig = option(args, '--kubeconfig');
  const namespace = option(args, '--namespace');
  const selector = option(args, '--selector');
  const role = option(args, '--role');
  const image = option(args, '--image');
  const imageId = option(args, '--image-id');
  const revision = option(args, '--revision');
  const pods = JSON.parse(kubectl(kubeconfig, namespace, ['get', 'pods', '-l', selector, '-o', 'json'])).items
    .filter((pod) => pod.status?.phase === 'Running' && !pod.metadata?.deletionTimestamp);
  assert.ok(pods.length > 0, `no running pods found for role ${role}`);

  for (const pod of pods) {
    const runtime = readRuntimeInfo(kubeconfig, namespace, pod.metadata.name);
    assert.equal(runtime['/healthz'], 200, `${pod.metadata.name} /healthz must be healthy`);
    assert.equal(runtime['/readyz'], 200, `${pod.metadata.name} /readyz must be ready`);
    assertPodImageIdentity(pod, { image, imageId, role, revision, version: runtime['/version'] });
    console.log(`${role}: ${pod.metadata.name} source=${revision} image=${normalizeImageId(pod.status.containerStatuses.find((item) => item.name === 'pacman').imageID)}`);
  }
}

function verifyMigration(args) {
  const kubeconfig = option(args, '--kubeconfig');
  const namespace = option(args, '--namespace');
  const jobName = option(args, '--job');
  const image = option(args, '--image');
  const imageId = option(args, '--image-id');
  const job = JSON.parse(kubectl(kubeconfig, namespace, ['get', 'job', jobName, '-o', 'json']));
  assert.ok(job.status?.succeeded > 0, `${jobName} must complete before its image identity is accepted`);
  const selector = `batch.kubernetes.io/job-name=${jobName}`;
  const pods = JSON.parse(kubectl(kubeconfig, namespace, ['get', 'pods', '-l', selector, '-o', 'json'])).items;
  const pod = pods.find((item) => item.status?.phase === 'Succeeded');
  assert.ok(pod, `${jobName} must have a succeeded pod`);
  assertPodImageIdentity(pod, { containerName: 'migrate', image, imageId });
  console.log(`migration: ${jobName} source image ID=${normalizeImageId(pod.status.containerStatuses.find((item) => item.name === 'migrate').imageID)}`);
}

function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'role') return verifyRole(args);
  if (mode === 'migration') return verifyMigration(args);
  throw new Error('usage: check-kubernetes-image-identity.js role|migration [options]');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    console.error(`Kubernetes container image identity check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
