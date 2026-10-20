import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';

function runWithEnv(env, code) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, LOG_LEVEL: 'silent', ...env },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`subprocess exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

// Starts a persistent backend "role" process and resolves once it reports the
// port it bound, so a separate web-role process can forward real HTTP calls
// to it (mirrors two separate Kubernetes role deployments).
function startBackend(env) {
  const script = `
import { MemoryAdapter } from './src/db/memory.js';
import { createApp } from './src/app.js';
const db = new MemoryAdapter();
await db.connect();
const app = createApp({ db });
const server = app.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\\n');
});
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, LOG_LEVEL: 'silent', ...env },
  });
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: child.stdout });
    child.once('error', reject);
    rl.once('line', (line) => {
      rl.close();
      resolve({ child, port: JSON.parse(line).port });
    });
  });
}

function stopBackend(child) {
  child.kill();
}

const demoEnv = { DEMO_SECURITY_MODE: 'true', DEMO_TOKEN: 'secret-demo' };

test('DEMO_SECURITY_MODE requires a nonempty DEMO_TOKEN', () => {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', "import('./src/config/index.js')"], {
    env: { ...process.env, LOG_LEVEL: 'silent', DEMO_SECURITY_MODE: 'true', DEMO_TOKEN: '' },
    encoding: 'utf8',
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Invalid environment configuration/);
});

test('fixed probes run their fixtures only when explicitly enabled, and the demo token is redacted from logs', () => {
  const script = `
import request from 'supertest';
import { MemoryAdapter } from './src/db/memory.js';
import { createApp } from './src/app.js';
const db = new MemoryAdapter();
await db.connect();
const app = createApp({ db });
const fileRes = await request(app).post('/demo/incidents/file-probe').set('x-demo-token', 'secret-demo');
const execRes = await request(app).post('/demo/incidents/exec-probe').set('x-demo-token', 'secret-demo');
await request(app).get('/version').set('x-demo-token', 'secret-demo');
await db.disconnect();
// Pino logs land on stdout asynchronously and can interleave with this
// result line, so tag it to find it regardless of ordering.
process.stdout.write('RESULT_JSON:' + JSON.stringify({
  file: { status: fileRes.status, body: fileRes.body },
  exec: { status: execRes.status, body: execRes.body },
}) + '\\n');
`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      LOG_LEVEL: 'info',
      ...demoEnv,
      DEMO_FILE_PROBE_ENABLED: 'true',
      DEMO_EXEC_PROBE_ENABLED: 'true',
    },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!res.stdout.includes('secret-demo'), 'raw demo token leaked into logs');
  assert.ok(res.stdout.includes('[redacted]'), 'expected redacted token marker in logs');

  const resultLine = res.stdout.split('\n').find((line) => line.startsWith('RESULT_JSON:'));
  const out = JSON.parse(resultLine.slice('RESULT_JSON:'.length));
  assert.equal(out.file.status, 200);
  assert.equal(out.file.body.content, 'PACMAN-DEMO-SYNTHETIC-SECRET-v1');
  assert.equal(out.exec.status, 200);
  assert.equal(out.exec.body.output, 'PACMAN_DEMO_EXEC_PROBE_V1');
});

test('fixed probes are disabled by default even when demo security mode is on', () => {
  const script = `
import request from 'supertest';
import { MemoryAdapter } from './src/db/memory.js';
import { createApp } from './src/app.js';
const db = new MemoryAdapter();
await db.connect();
const app = createApp({ db });
const fileRes = await request(app).post('/demo/incidents/file-probe').set('x-demo-token', 'secret-demo');
const execRes = await request(app).post('/demo/incidents/exec-probe').set('x-demo-token', 'secret-demo');
await db.disconnect();
process.stdout.write(JSON.stringify({ fileStatus: fileRes.status, execStatus: execRes.status }));
`;
  const out = runWithEnv(demoEnv, script);
  assert.equal(out.fileStatus, 404);
  assert.equal(out.execStatus, 404);
});

test('web forwards an unconsumed fault to the matching backend role, and mismatched roles pass real responses through', async () => {
  const { child, port } = await startBackend({ ...demoEnv, APP_ROLE: 'score' });
  try {
    const script = `
import request from 'supertest';
import { MemoryAdapter } from './src/db/memory.js';
import { createApp } from './src/app.js';
const db = new MemoryAdapter();
await db.connect();
const app = createApp({ db });

const matched = await request(app)
  .get('/highscores/list')
  .set('x-demo-token', 'secret-demo')
  .set('x-demo-fault-role', 'score')
  .set('x-demo-fault-operation', 'scoreRead')
  .set('x-demo-fault-status', '503');

const mismatched = await request(app)
  .get('/highscores/list')
  .set('x-demo-token', 'secret-demo')
  .set('x-demo-fault-role', 'user')
  .set('x-demo-fault-operation', 'scoreRead')
  .set('x-demo-fault-status', '503');

const unreachableWeb = await request(app).get('/highscores/list');

await db.disconnect();
process.stdout.write(JSON.stringify({
  matched: { status: matched.status, body: matched.body },
  mismatched: { status: mismatched.status, body: mismatched.body },
  unreachableWeb: { status: unreachableWeb.status },
}));
`;
    const out = runWithEnv({ ...demoEnv, APP_ROLE: 'web', SCORE_SERVICE_URL: `http://127.0.0.1:${port}` }, script);

    assert.equal(out.matched.status, 503);
    assert.equal(out.matched.body.error, 'demo fault injected');

    assert.equal(out.mismatched.status, 200);
    assert.ok(Array.isArray(out.mismatched.body));

    assert.equal(out.unreachableWeb.status, 200);
  } finally {
    stopBackend(child);
  }
});

test('an unreachable real backend still returns a genuine 5xx, not a demo fault body', () => {
  const script = `
import request from 'supertest';
import { MemoryAdapter } from './src/db/memory.js';
import { createApp } from './src/app.js';
const db = new MemoryAdapter();
await db.connect();
const app = createApp({ db });
const res = await request(app).get('/highscores/list');
await db.disconnect();
process.stdout.write(JSON.stringify({ status: res.status }));
`;
  const out = runWithEnv({ APP_ROLE: 'web', SCORE_SERVICE_URL: 'http://127.0.0.1:1' }, script);
  assert.ok(out.status >= 500 && out.status <= 599);
});
