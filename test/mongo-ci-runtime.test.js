import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lifecycleScript = 'tools/check-pacman-lifecycle.sh';
const compatibleRuntime = {
  kernelRelease: '6.8.0-1064-azure',
  versionSignature: 'Ubuntu 6.8.0-1064.67~22.04.1 6.8.0-1064.67~22.04.1',
  imageOS: 'ubuntu22',
  imageVersion: '20261023.322.3',
};

function stepBlock(workflow, name) {
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `workflow must define the ${name} step`);
  const next = workflow.indexOf('\n      - ', start + marker.length);
  return workflow.slice(start, next === -1 ? undefined : next);
}

function stepRun(workflow, name) {
  const block = stepBlock(workflow, name);
  const run = block.match(/^\s+run:\s+(.+)$/m)?.[1];
  assert.ok(run, `${name} must have a shell command`);
  return run;
}

function fixtureDirectory(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pacman-mongo-ci-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  return { root, bin };
}

function writeExecutable(filePath, contents) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function runWorkflowCommand(command, bin, env = {}) {
  return spawnSync('bash', ['-c', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
  });
}

function hostFixture(t, overrides = {}) {
  const { bin } = fixtureDirectory(t);
writeExecutable(path.join(bin, 'uname'), `#!/bin/sh
if [ "\${1:-}" = "-r" ]; then
  printf '%s\\n' "$FIXTURE_KERNEL_RELEASE"
else
  exec /usr/bin/uname "$@"
fi
`);
writeExecutable(path.join(bin, 'cat'), `#!/bin/sh
if [ "\${1:-}" = "/proc/version_signature" ]; then
  if [ "\${FIXTURE_SIGNATURE_MISSING:-0}" = "1" ]; then exit 1; fi
  printf '%s\\n' "$FIXTURE_VERSION_SIGNATURE"
else
  exec /bin/cat "$@"
fi
`);
  return {
    bin,
    env: {
      FIXTURE_KERNEL_RELEASE: overrides.kernelRelease ?? compatibleRuntime.kernelRelease,
      FIXTURE_VERSION_SIGNATURE: overrides.versionSignature ?? compatibleRuntime.versionSignature,
      FIXTURE_SIGNATURE_MISSING: overrides.signatureMissing ? '1' : '0',
      ImageOS: overrides.imageOS ?? compatibleRuntime.imageOS,
      ImageVersion: overrides.imageVersion ?? compatibleRuntime.imageVersion,
    },
  };
}

function recordFrom(stdout, record) {
  const line = stdout.split('\n').find((item) => item.startsWith(`{"record":"${record}"`));
  assert.ok(line, `diagnostic output must include ${record}`);
  return JSON.parse(line);
}

test('Mongo CI workflows qualify the real runner and record bounded database identity on either outcome', (t) => {
  const chartWorkflow = readFileSync(path.join(repoRoot, '.github/workflows/chart-ci.yml'), 'utf8');
  const ciWorkflow = readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const preflightCommand = 'bash tools/check-pacman-lifecycle.sh --mongo-runtime-preflight';
  const adapterMetadataCommand = 'bash tools/check-pacman-lifecycle.sh --mongo-runtime-metadata adapter';

  assert.match(chartWorkflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(chartWorkflow, /database: \[mongo, postgres\][\s\S]*?database: mongo\n\s+runner: ubuntu-22\.04[\s\S]*?database: postgres\n\s+runner: ubuntu-latest/);
  assert.match(chartWorkflow, /2027-04-17/);
  assert.match(chartWorkflow, /https:\/\/github\.com\/actions\/runner-images\/issues\/14254/);
  assert.match(chartWorkflow, /https:\/\/raw\.githubusercontent\.com\/actions\/runner-images\/main\/images\/ubuntu\/Ubuntu2204-Readme\.md/);
  assert.equal(stepRun(chartWorkflow, 'Preflight Mongo CI runtime'), preflightCommand);
  assert.match(stepBlock(chartWorkflow, 'Preflight Mongo CI runtime'), /matrix\.database == 'mongo'/);

  assert.match(ciWorkflow, /runs-on: \$\{\{ matrix\.runner \}\}/);
  assert.match(ciWorkflow, /adapter: \[mongo, postgres\][\s\S]*?adapter: mongo\n\s+runner: ubuntu-22\.04[\s\S]*?adapter: postgres\n\s+runner: ubuntu-latest/);
  assert.match(ciWorkflow, /2027-04-17/);
  assert.equal(stepRun(ciWorkflow, 'Preflight Mongo CI runtime'), preflightCommand);
  assert.match(stepBlock(ciWorkflow, 'Preflight Mongo CI runtime'), /matrix\.adapter == 'mongo'/);
  assert.equal(stepRun(ciWorkflow, 'Record Mongo CI runtime metadata'), adapterMetadataCommand);
  assert.match(stepBlock(ciWorkflow, 'Record Mongo CI runtime metadata'), /always\(\)/);
  assert.match(stepBlock(ciWorkflow, 'Record Mongo CI runtime metadata'), /matrix\.adapter == 'mongo'/);
  assert.match(stepBlock(ciWorkflow, 'Record Mongo CI runtime metadata'), /PACMAN_MONGO_CI_STATUS: \$\{\{ job\.status \}\}/);

  const compatible = hostFixture(t);
  const compatibleResult = runWorkflowCommand(preflightCommand, compatible.bin, compatible.env);
  assert.equal(compatibleResult.status, 0, compatibleResult.stderr);
  const hostRecord = recordFrom(compatibleResult.stdout, 'host-runtime');
  assert.equal(hostRecord.kernel_release, compatibleRuntime.kernelRelease);
  assert.equal(hostRecord.proc_version_signature, compatibleRuntime.versionSignature);
  assert.equal(hostRecord.runner_image_os, compatibleRuntime.imageOS);
  assert.equal(hostRecord.runner_image_version, compatibleRuntime.imageVersion);

  const incompatible = hostFixture(t, {
    kernelRelease: '6.19.0-1-azure',
    versionSignature: 'Ubuntu 6.19.0-1.1 6.19.0-1.1',
  });
  const incompatibleResult = runWorkflowCommand(preflightCommand, incompatible.bin, incompatible.env);
  assert.notEqual(incompatibleResult.status, 0, 'unsupported kernels must fail before Mongo tests start');
  assert.match(incompatibleResult.stderr, /unsupported Mongo CI runtime/);
  assert.doesNotMatch(incompatibleResult.stderr, /helm|kind|docker build/i);

  const mismatchedKernelIdentity = hostFixture(t, {
    versionSignature: 'Ubuntu 6.8.0-9999.1~22.04.1 6.8.0-9999.1~22.04.1',
  });
  const mismatchedKernelResult = runWorkflowCommand(preflightCommand, mismatchedKernelIdentity.bin, mismatchedKernelIdentity.env);
  assert.notEqual(mismatchedKernelResult.status, 0, 'kernel release and proc signature must identify the same 6.8 build');
  assert.match(mismatchedKernelResult.stderr, /unsupported Mongo CI runtime/);

  const missingRuntimeIdentity = hostFixture(t, { signatureMissing: true });
  const missingRuntimeResult = runWorkflowCommand(preflightCommand, missingRuntimeIdentity.bin, missingRuntimeIdentity.env);
  assert.notEqual(missingRuntimeResult.status, 0, 'missing kernel identity must fail closed');
  assert.match(missingRuntimeResult.stderr, /missing Mongo CI runtime identity/);
  assert.doesNotMatch(missingRuntimeResult.stderr, /helm|kind|docker build/i);

  const adapter = hostFixture(t);
writeExecutable(path.join(adapter.bin, 'docker'), `#!/bin/sh
if [ "\${1:-}" = "image" ] && [ "\${2:-}" = "inspect" ]; then
  if [ "\${FIXTURE_IMAGE_ID_MISSING:-0}" = "1" ]; then exit 1; fi
  case "\${4:-}" in
    *RepoDigests*) printf '%s\\n' "$FIXTURE_REPO_DIGEST" ;;
    *) printf '%s\\n' "$FIXTURE_IMAGE_ID" ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "run" ]; then
  printf 'db version v%s\\n' "$FIXTURE_SERVER_VERSION"
  exit 0
fi
exit 97
`);
  const adapterEnv = {
    ...adapter.env,
    FIXTURE_IMAGE_ID: `sha256:${'a'.repeat(64)}`,
    FIXTURE_REPO_DIGEST: `docker.io/library/mongo@sha256:${'b'.repeat(64)}`,
    FIXTURE_SERVER_VERSION: '8.0.16',
    PACMAN_MONGO_CI_STATUS: 'success',
  };
  const adapterResult = runWorkflowCommand(adapterMetadataCommand, adapter.bin, adapterEnv);
  assert.equal(adapterResult.status, 0, adapterResult.stderr);
  const adapterRecord = recordFrom(adapterResult.stdout, 'mongo-image');
  assert.equal(adapterRecord.consumer, 'adapter');
  assert.equal(adapterRecord.image, 'mongo:8');
  assert.equal(adapterRecord.image_id, `sha256:${'a'.repeat(64)}`);
  assert.equal(adapterRecord.image_digest, `sha256:${'b'.repeat(64)}`);
  assert.equal(adapterRecord.server_version, '8.0.16');
  assert.equal(adapterRecord.capture_status, 'success');
  assert.doesNotMatch(adapterResult.stdout, /password|token|secret|authorization/i);

  const adapterFailureResult = runWorkflowCommand(adapterMetadataCommand, adapter.bin, {
    ...adapterEnv,
    PACMAN_MONGO_CI_STATUS: 'failure',
  });
  assert.equal(adapterFailureResult.status, 0, adapterFailureResult.stderr);
  assert.equal(recordFrom(adapterFailureResult.stdout, 'mongo-image').capture_status, 'failure');

  const missingAdapterIdentity = hostFixture(t);
writeExecutable(path.join(missingAdapterIdentity.bin, 'docker'), `#!/bin/sh
if [ "\${1:-}" = "image" ] && [ "\${2:-}" = "inspect" ]; then
  if [ "\${4:-}" = "{{.Id}}" ]; then printf '%s\\n' "$FIXTURE_IMAGE_ID"; exit 0; fi
  exit 1
fi
if [ "\${1:-}" = "run" ]; then exit 1; fi
exit 97
`);
  const missingAdapterResult = runWorkflowCommand(adapterMetadataCommand, missingAdapterIdentity.bin, {
    ...missingAdapterIdentity.env,
    FIXTURE_IMAGE_ID: '',
  });
  assert.notEqual(missingAdapterResult.status, 0, 'missing database image identity must fail closed');
  const missingAdapterRecord = recordFrom(missingAdapterResult.stdout, 'mongo-image');
  assert.equal(missingAdapterRecord.image_id, 'unavailable');
  assert.equal(missingAdapterRecord.image_digest, 'unavailable');

  const lifecycleMetadataCommand = `bash ${lifecycleScript} --mongo-runtime-metadata lifecycle pcl-mongo-default success`;
  const lifecycle = hostFixture(t);
  writeExecutable(path.join(lifecycle.bin, 'kubectl'), `#!/bin/sh
case " $* " in
  *" get pods "*)
    printf '%s\\n' "$FIXTURE_POD_JSON"
    ;;
  *" mongod --version "*)
    printf 'db version v%s\\n' "$FIXTURE_SERVER_VERSION"
    ;;
  *) exit 97 ;;
esac
`);
  const lifecycleEnv = {
    ...lifecycle.env,
    FIXTURE_POD_JSON: JSON.stringify({
      items: [{
        metadata: { name: 'pcl-mongo-default-pacman-mongo-abcde' },
        spec: { containers: [{ name: 'mongo', image: 'mongo:8' }] },
        status: { containerStatuses: [{ name: 'mongo', imageID: `docker-pullable://docker.io/library/mongo@sha256:${'c'.repeat(64)}` }] },
      }],
    }),
    FIXTURE_SERVER_VERSION: '8.0.16',
  };
  const lifecycleResult = runWorkflowCommand(lifecycleMetadataCommand, lifecycle.bin, lifecycleEnv);
  assert.equal(lifecycleResult.status, 0, `${lifecycleResult.stderr}\n${lifecycleResult.stdout}`);
  const lifecycleRecord = recordFrom(lifecycleResult.stdout, 'mongo-image');
  assert.equal(lifecycleRecord.consumer, 'chart-lifecycle');
  assert.equal(lifecycleRecord.namespace, 'pcl-mongo-default');
  assert.equal(lifecycleRecord.image, 'mongo:8');
  assert.equal(lifecycleRecord.image_digest, `sha256:${'c'.repeat(64)}`);
  assert.equal(lifecycleRecord.server_version, '8.0.16');
  assert.equal(lifecycleRecord.capture_status, 'success');
  assert.doesNotMatch(lifecycleResult.stdout, /password|token|secret|authorization/i);

  const missingLifecycleIdentity = hostFixture(t);
  writeExecutable(path.join(missingLifecycleIdentity.bin, 'kubectl'), `#!/bin/sh
if [ " $* " = " -n pcl-mongo-default get pods -o json " ]; then
  printf '%s\\n' "$FIXTURE_POD_JSON"
  exit 0
fi
exit 97
`);
  const missingLifecycleResult = runWorkflowCommand(
    lifecycleMetadataCommand.replace(/ success$/, ' failed'),
    missingLifecycleIdentity.bin,
    {
    ...missingLifecycleIdentity.env,
    FIXTURE_POD_JSON: JSON.stringify({ items: [] }),
    },
  );
  assert.notEqual(missingLifecycleResult.status, 0, 'missing lifecycle image identity must fail closed');
  const missingLifecycleRecord = recordFrom(missingLifecycleResult.stdout, 'mongo-image');
  assert.equal(missingLifecycleRecord.image_id, 'unavailable');
  assert.equal(missingLifecycleRecord.image_digest, 'unavailable');
  assert.equal(missingLifecycleRecord.capture_status, 'failed');
});
