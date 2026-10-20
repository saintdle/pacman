import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const NODE_PATH = '/nodejs/bin/node';
const EXEC_PROBE_MARKER = 'PACMAN_DEMO_EXEC_PROBE_V1';
const FIXTURE_MARKER = 'PACMAN-DEMO-SYNTHETIC-SECRET-v1';

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim();
}

function parseTarget(value) {
  const separator = value.indexOf('=');
  if (separator < 0) throw new Error(`Expected platform=image, received: ${value}`);
  const platform = value.slice(0, separator);
  const image = value.slice(separator + 1);
  if (!['linux/amd64', 'linux/arm64'].includes(platform) || !image) {
    throw new Error(`Expected linux/amd64=image or linux/arm64=image, received: ${value}`);
  }
  return { platform, image };
}

async function waitForRuntimeHealth(name, port) {
  const deadline = Date.now() + 60_000;
  let response;
  let health = 'starting';

  while (Date.now() < deadline) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
    } catch {
      response = undefined;
    }
    health = docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}', name]);
    if (response?.status === 200 && health === 'healthy') return;
    if (health === 'unhealthy') throw new Error(`${name} became unhealthy`);
    await delay(500);
  }

  throw new Error(`${name} did not serve /healthz and pass its image healthcheck (status: ${health})`);
}

async function smokeImage({ platform, image }) {
  const expectedArch = platform.split('/')[1];
  const containerName = `pacman-image-smoke-${expectedArch}-${process.pid}`;
  const inspect = docker([
    'image', 'inspect', '--format',
    '{{.Os}}|{{.Architecture}}|{{.Config.User}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}|{{json .Config.Healthcheck.Test}}',
    image,
  ]).split('|');
  const [os, architecture, defaultUser, rawEntrypoint, rawCommand, rawHealthcheck] = inspect;
  const entrypoint = JSON.parse(rawEntrypoint);
  const command = JSON.parse(rawCommand);
  const healthcheck = JSON.parse(rawHealthcheck);

  assert.equal(os, 'linux', `${image} must be a Linux image`);
  assert.equal(architecture, expectedArch, `${image} must target ${platform}`);
  assert.ok(Number(defaultUser.split(':')[0]) > 0, `${image} must default to a nonroot UID`);
  assert.equal(entrypoint[0], NODE_PATH, `${image} must start Node directly`);
  assert.ok(command.includes('src/server.js'), `${image} must default to the server entrypoint`);
  assert.ok(healthcheck.join(' ').includes('tools/healthcheck.js'), `${image} must use its Node healthcheck`);

  const nodeCheck = `const fs=require('node:fs');const h=process.report.getReport().header;const forbidden=['/bin/sh','/bin/bash','/usr/bin/sh','/usr/bin/bash','/usr/bin/npm','/usr/local/bin/npm','/usr/bin/npx','/usr/local/bin/npx','/usr/bin/wget','/usr/bin/curl','/usr/local/bin/wget','/usr/local/bin/curl','/app/tools/check-container-image-contract.js','/app/tools/smoke-container-images.js'];const present=forbidden.filter(p=>fs.existsSync(p));const fixture=fs.readFileSync('/app/demo-fixtures/synthetic-secret.txt','utf8').trim();const execProbeExecutable=(fs.statSync('/app/tools/demo-exec-probe.js').mode&0o111)!==0;if(!h.glibcVersionRuntime||present.length||!fixture.includes('${FIXTURE_MARKER}')||!execProbeExecutable)process.exit(1);console.log(JSON.stringify({node:process.version,glibc:h.glibcVersionRuntime,forbidden:present,fixturePresent:true,execProbeExecutable}));`;
  const runtimeInfo = JSON.parse(docker([
    'run', '--rm', '--platform', platform, '--user', '12345:23456', '--entrypoint', NODE_PATH,
    image, '-e', nodeCheck,
  ]));
  assert.match(runtimeInfo.glibc, /^\d+\.\d+$/, `${image} must run against glibc`);
  assert.deepEqual(runtimeInfo.forbidden, [], `${image} must exclude shell/npm/wget/curl`);

  const namedNodeVersion = docker([
    'run', '--rm', '--platform', platform, '--user', '12345:23456', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,size=64m', '--entrypoint', 'node', image, '--version',
  ]);
  assert.match(namedNodeVersion, /^v22\./, `${image} must resolve the Node executable by name under an arbitrary UID`);

  const probe = docker([
    'run', '--rm', '--platform', platform, '--user', '12345:23456', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,size=64m', '--entrypoint', '/app/tools/demo-exec-probe.js', image,
  ]);
  assert.equal(probe, EXEC_PROBE_MARKER, `${image} must include and run the fixed marked exec probe`);

  try {
    docker([
      'run', '--detach', '--platform', platform, '--name', containerName, '--user', '12345:23456',
      '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=64m', '--publish', '127.0.0.1::8080', image,
    ]);
    const port = docker([
      'inspect', '--format', '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}', containerName,
    ]);
    await waitForRuntimeHealth(containerName, port);
  } finally {
    try {
      docker(['rm', '--force', containerName]);
    } catch {
      // The container may not have started if Docker rejected the image.
    }
  }

  const emulation = expectedArch === 'amd64' && process.arch === 'arm64' ? ' (emulated on arm64)' : '';
  console.log(`${platform}${emulation}: nonroot, arbitrary UID, read-only HTTP/healthcheck, glibc, tools, fixtures passed`);
}

async function main() {
  const targets = process.argv.slice(2).map(parseTarget);
  assert.ok(targets.length > 0, 'pass one or more platform=image targets');
  for (const target of targets) await smokeImage(target);
}

main().catch((error) => {
  console.error(`Container image smoke check failed: ${error.message}`);
  process.exitCode = 1;
});
