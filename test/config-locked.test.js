import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The src/config module reads process.env once at import time, so to exercise
// ALLOW_CLIENT_* overrides we spin up short Node subprocesses with those env
// vars set and assert on their JSON output.
function runWithEnv(env, code) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    // LOG_LEVEL=silent keeps pino output from polluting stdout so the JSON
    // payload at the end of the child script is the only thing we parse.
    env: { ...process.env, LOG_LEVEL: 'silent', ...env },
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`subprocess exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim());
}

const childScript = `
import request from 'supertest';
import { MemoryAdapter } from './src/db/memory.js';
import { createApp } from './src/app.js';

const db = new MemoryAdapter();
await db.connect();
const app = createApp({ db });

const getRes = await request(app).get('/config');
const postPayload = process.env.POST_MODE === 'ebee' ? { ebeeMode: 'false' } : { maxLevel: '7' };
const postRes = await request(app).post('/config').type('form').send(postPayload);

await db.disconnect();
process.stdout.write(JSON.stringify({
  getStatus: getRes.status,
  getBody: getRes.body,
  postStatus: postRes.status,
  postBody: postRes.body,
}));
`;

test('GET /config advertises allowClientOverride=false when locked', () => {
  const out = runWithEnv({ ALLOW_CLIENT_CONFIG_OVERRIDE: 'false' }, childScript);
  assert.equal(out.getStatus, 200);
  assert.equal(out.getBody.allowClientOverride, false);
});

test('POST /config returns 403 when overrides are disabled', () => {
  const out = runWithEnv({ ALLOW_CLIENT_CONFIG_OVERRIDE: 'false' }, childScript);
  assert.equal(out.postStatus, 403);
  assert.match(out.postBody.error, /disabled/);
});

test('GET /config advertises server-controlled eBee mode when locked', () => {
  const out = runWithEnv({ EBEE_MODE: 'true', ALLOW_CLIENT_EBEE_MODE_OVERRIDE: 'false' }, childScript);
  assert.equal(out.getStatus, 200);
  assert.equal(out.getBody.ebeeMode, true);
  assert.equal(out.getBody.allowEbeeModeOverride, false);
});

test('POST /config returns 403 when eBee mode overrides are disabled', () => {
  const out = runWithEnv({ EBEE_MODE: 'true', ALLOW_CLIENT_EBEE_MODE_OVERRIDE: 'false', POST_MODE: 'ebee' }, childScript);
  assert.equal(out.postStatus, 403);
  assert.match(out.postBody.error, /disabled/);
});
