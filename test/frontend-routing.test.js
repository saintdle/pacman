import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseGhostDirection, getGhostTarget } from '../src/client/movement.js';

const UP = { name: 'up', dirX: 0, dirY: -1 };
const DOWN = { name: 'down', dirX: 0, dirY: 1 };
const RIGHT = { name: 'right', dirX: 1, dirY: 0 };
const LEFT = { name: 'left', dirX: -1, dirY: 0 };
const DIRECTIONS = [UP, DOWN, RIGHT, LEFT];

function makeMap(width, height, walls = [], doors = []) {
  const posY = Array.from({ length: height }, () => ({
    posX: Array.from({ length: width }, () => ({ type: 'null' })),
  }));
  for (const [x, y] of walls) posY[y].posX[x].type = 'wall';
  for (const [x, y] of doors) posY[y].posX[x].type = 'door';
  return { posY };
}

function route(map, from, current, target, options) {
  return chooseGhostDirection(map, from, current, target, {
    directions: DIRECTIONS,
    ...options,
  });
}

test('maze distance chooses the shorter route around a wall, with stable ties', () => {
  const map = makeMap(7, 5, [[3, 1], [3, 2]]);
  // Euclidean distance ties up and down, while the lower corridor is shorter.
  assert.equal(route(map, { x: 2, y: 2 }, RIGHT, { x: 4, y: 2 }), DOWN);

  const openMap = makeMap(5, 5);
  assert.equal(route(openMap, { x: 2, y: 2 }, RIGHT, { x: 1, y: 1 }), UP);
});

test('a ghost may reverse when its only legal exit is a dead-end reversal', () => {
  const map = makeMap(3, 1, [[2, 0]]);
  assert.equal(route(map, { x: 1, y: 0 }, RIGHT, { x: 0, y: 0 }), LEFT);
});

test('ghost routing treats horizontal tunnels as adjacent cells', () => {
  const map = makeMap(4, 1);
  assert.equal(route(map, { x: 0, y: 0 }, LEFT, { x: 3, y: 0 }), LEFT);
});

test('living and frightened ghosts avoid the ghost-house door; dead ghosts can return', () => {
  const map = makeMap(5, 1, [], [[3, 0]]);
  const from = { x: 2, y: 0 };
  const target = { x: 4, y: 0 };

  assert.equal(route(map, from, UP, target), LEFT);
  assert.equal(route(map, from, UP, target, { frightened: true }), LEFT);
  assert.equal(route(map, from, UP, target, { allowDoor: true }), RIGHT);
});

test('wall and off-map targets fall back to reachable cells within map bounds', () => {
  const map = makeMap(5, 3, [[3, 1]]);
  assert.equal(route(map, { x: 1, y: 1 }, RIGHT, { x: 3, y: 1 }), RIGHT);
  assert.equal(route(map, { x: 0, y: 1 }, LEFT, { x: -1, y: 1 }), LEFT);
  assert.equal(route(map, { x: 2, y: 0 }, RIGHT, { x: 4, y: -10 }), RIGHT);
});

test('Blinky scatter routing resolves the shipped wall corner to its nearest maze cells', () => {
  const map = JSON.parse(readFileSync(new URL('../public/data/map.json', import.meta.url), 'utf8'));
  assert.equal(map.posY[0].posX[13].type, 'wall');
  assert.equal(route(map, { x: 9, y: 1 }, RIGHT, { x: 13, y: 0 }), RIGHT);
});

test('blocked targets resolve through more than one wall layer', () => {
  const map = makeMap(7, 7, [[3, 3], [3, 2], [2, 3], [4, 3], [3, 4]]);
  assert.equal(route(map, { x: 2, y: 1 }, RIGHT, { x: 3, y: 3 }), DOWN);
});

test('ghost targets preserve scatter, chase, dead, and frightened mode behavior', () => {
  const ghost = {
    name: 'blinky',
    x: 2,
    y: 2,
    homeX: 6,
    homeY: 0,
    startX: 3,
    startY: 4,
    dead: false,
  };
  const pacman = { x: 1, y: 3, direction: RIGHT };
  const context = { ghost, pacman, blinky: ghost };

  assert.deepEqual(getGhostTarget({ ...context, ghostMode: 0 }), { x: 6, y: 0 });
  assert.deepEqual(getGhostTarget({ ...context, ghostMode: 1 }), { x: 1, y: 3 });
  assert.deepEqual(getGhostTarget({ ...context, ghostMode: 1, frightened: true }), { x: 1, y: 3 });
  assert.deepEqual(getGhostTarget({ ...context, ghost: { ...ghost, dead: true }, ghostMode: 1 }), { x: 3, y: 4 });
});

test('Pinky, Inky, and Clyde keep their existing chase target rules', () => {
  const pacman = { x: 5, y: 5, direction: RIGHT };
  const blinky = { x: 2, y: 2 };
  const common = { pacman, blinky, ghostMode: 1 };

  assert.deepEqual(getGhostTarget({ ...common, ghost: { name: 'pinky', homeX: 0, homeY: 0 } }), { x: 9, y: 1 });
  assert.deepEqual(getGhostTarget({ ...common, ghost: { name: 'inky', homeX: 0, homeY: 0 } }), { x: 12, y: 8 });
  assert.deepEqual(getGhostTarget({ ...common, ghost: { name: 'clyde', x: 3, y: 5, homeX: 1, homeY: 6 } }), { x: 1, y: 6 });
  assert.deepEqual(getGhostTarget({ ...common, ghost: { name: 'clyde', x: 0, y: 0, homeX: 1, homeY: 6 } }), { x: 5, y: 5 });
});
