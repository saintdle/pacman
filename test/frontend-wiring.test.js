import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { chooseGhostDirection } from '../src/client/movement.js';

const html = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');
const game = readFileSync(fileURLToPath(new URL('../public/pacman-canvas.js', import.meta.url)), 'utf8');
const sharedWrapper = readFileSync(fileURLToPath(new URL('../src/client/movement.js', import.meta.url)), 'utf8');
const ciliumPolicy = readFileSync(fileURLToPath(new URL('../k8s/examples/cilium-l7-policy.yaml', import.meta.url)), 'utf8');

test('the browser loads the same movement helpers before initializing the game', () => {
  const helperScript = html.indexOf('<script src="js/movement.js"');
  const gameScript = html.indexOf('<script src="pacman-canvas.js"');
  assert.notEqual(helperScript, -1);
  assert.notEqual(gameScript, -1);
  assert.ok(helperScript < gameScript, 'shared movement helpers must load before game startup');
  assert.match(sharedWrapper, /import '\.\.\/\.\.\/public\/js\/movement\.js'/);
  assert.equal(globalThis.PacmanMovement.chooseGhostDirection, chooseGhostDirection);

  for (const helper of ['getMapContent', 'canMoveTo', 'wrapPosition', 'getGhostTarget', 'chooseGhostDirection']) {
    assert.ok(game.includes(`PacmanMovement.${helper}`), `browser game should call ${helper}`);
  }
  assert.ok((game.match(/PacmanMovement\.wrapPosition/g) || []).length >= 3,
    'Pac-Man, Figure, and Ghost movement should share grid-aligned wrapping');
});

test('the shared browser helper stays available at the public /js path', async () => {
  const app = createApp({ db: {} });
  const response = await request(app).get('/js/movement.js');
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /javascript/);
  assert.match(response.text, /root\.PacmanMovement/);
  assert.match(ciliumPolicy, /path: "\/js\/\.\*"/);
});

test('instruction screenshots switch with the existing Pac-Man/eBee theme setting', () => {
  assert.match(game, /instructions_' \+ theme \+ 'scatter\.svg/);
  assert.match(game, /instructions_' \+ theme \+ 'chase\.svg/);
  assert.match(game, /instructions_' \+ theme \+ 'powerpill\.svg/);
  for (const name of ['instructions_scatter.svg', 'instructions_chase.svg', 'instructions_powerpill.svg']) {
    assert.ok(html.includes(name), `${name} should be the page default`);
  }
});
