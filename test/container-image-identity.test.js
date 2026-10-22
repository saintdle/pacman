import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertPodImageIdentity } from '../tools/check-kubernetes-image-identity.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runSmoke(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      'tools/smoke-container-images.js',
      '--expected-revision',
      'a'.repeat(40),
      'linux/arm64=pacman:healthy-stale',
    ], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('error', reject);
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

test('container smoke rejects a healthy image from a different source revision', async () => {
  const expectedRevision = 'a'.repeat(40);
  const imageRevision = 'b'.repeat(40);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url === '/healthz'
      ? { status: 'ok', commit: imageRevision }
      : { app: 'pacman', role: 'web', commit: imageRevision }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pacman-fake-docker-'));
  const fakeDocker = path.join(tempDir, 'docker');
  writeFileSync(fakeDocker, `#!/usr/bin/env node
const args = process.argv.slice(2);
const revision = process.env.PACMAN_TEST_IMAGE_REVISION;
const imageId = process.env.PACMAN_TEST_IMAGE_ID;
const write = (value) => process.stdout.write(value);

if (args[0] === 'image' && args[1] === 'inspect') {
  write([
    'linux',
    'arm64',
    '65532:65532',
    JSON.stringify(['/nodejs/bin/node']),
    JSON.stringify(['src/server.js']),
    JSON.stringify(['CMD', '/nodejs/bin/node', 'tools/healthcheck.js']),
    revision,
    imageId,
  ].join('|'));
} else if (args[0] === 'run' && args.includes('--entrypoint')) {
  const entrypoint = args[args.indexOf('--entrypoint') + 1];
  if (entrypoint === '/nodejs/bin/node') {
    write(JSON.stringify({
      node: 'v22.22.3',
      glibc: '2.36',
      forbidden: [],
      fixturePresent: true,
      execProbeExecutable: true,
    }));
  } else if (entrypoint === 'node') {
    write('v22.22.3');
  } else {
    write('PACMAN_DEMO_EXEC_PROBE_V1');
  }
} else if (args[0] === 'run' && args.includes('--detach')) {
  write('fake-container-id');
} else if (args[0] === 'inspect') {
  const format = args[args.indexOf('--format') + 1];
  write(format.includes('.NetworkSettings.Ports')
    ? process.env.PACMAN_TEST_PORT
    : 'healthy');
} else if (args[0] === 'rm') {
  write('fake-container-id');
} else {
  process.stderr.write('unexpected fake docker args: ' + args.join(' '));
  process.exitCode = 2;
}
`);
  chmodSync(fakeDocker, 0o755);

  try {
    const port = server.address().port;
    const result = await runSmoke({
      ...process.env,
      PATH: `${tempDir}:${process.env.PATH}`,
      PACMAN_TEST_IMAGE_REVISION: imageRevision,
      PACMAN_TEST_IMAGE_ID: `sha256:${'c'.repeat(64)}`,
      PACMAN_TEST_PORT: String(port),
    });

    assert.equal(result.status, 1, `${result.signal ?? ''}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /container image identity mismatch/i);
    assert.deepEqual(requests, ['/healthz', '/version']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Kubernetes pod identity checks the running image ID and runtime source', () => {
  const digest = 'c'.repeat(64);
  const revision = 'a'.repeat(40);
  const pod = {
    metadata: { name: 'pacman-web-0' },
    spec: { containers: [{ name: 'pacman', image: 'docker.io/library/pacman:ci-candidate' }] },
    status: { containerStatuses: [{ name: 'pacman', imageID: `containerd://sha256:${digest}` }] },
  };
  const expected = {
    image: 'docker.io/library/pacman:ci-candidate',
    imageId: `sha256:${digest}`,
    role: 'web',
    revision,
    version: { app: 'pacman', role: 'web', commit: revision },
  };

  assert.doesNotThrow(() => assertPodImageIdentity(pod, expected));
  assert.throws(
    () => assertPodImageIdentity({
      ...pod,
      status: { containerStatuses: [{ name: 'pacman', imageID: `containerd://sha256:${'d'.repeat(64)}` }] },
    }, expected),
    /container image identity mismatch/,
  );
  assert.throws(
    () => assertPodImageIdentity(pod, {
      ...expected,
      version: { ...expected.version, commit: 'b'.repeat(40) },
    }),
    /runtime commit/,
  );
});
