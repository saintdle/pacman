import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  canMoveTo,
  getMapContent,
  wrapCoord,
  wrapPosition,
  GRID_WIDTH,
  GRID_HEIGHT,
  GHOST_DIFFICULTIES,
  getGhostSettings,
  ghostMayLeaveHouse,
} from '../src/client/movement.js';

function makeMap({ walls = [] } = {}) {
  const posY = [];
  for (let y = 0; y < GRID_HEIGHT; y++) {
    const posX = [];
    for (let x = 0; x < GRID_WIDTH; x++) {
      posX.push({ type: 'null' });
    }
    posY.push({ posX });
  }
  for (const [x, y] of walls) posY[y].posX[x].type = 'wall';
  return { posY };
}

const RIGHT = { dirX: 1, dirY: 0 };
const LEFT = { dirX: -1, dirY: 0 };
const UP = { dirX: 0, dirY: -1 };
const DOWN = { dirX: 0, dirY: 1 };
const shippedMap = JSON.parse(readFileSync(fileURLToPath(new URL('../public/data/map.json', import.meta.url)), 'utf8'));

test('canMoveTo allows movement into open cells', () => {
  const map = makeMap();
  assert.equal(canMoveTo(map, { x: 5, y: 5 }, RIGHT), true);
  assert.equal(canMoveTo(map, { x: 5, y: 5 }, DOWN), true);
});

test('canMoveTo blocks movement into walls', () => {
  const map = makeMap({ walls: [[6, 5]] });
  assert.equal(canMoveTo(map, { x: 5, y: 5 }, RIGHT), false);
  assert.equal(canMoveTo(map, { x: 5, y: 5 }, LEFT), true);
});

test('wrapCoord wraps the X axis around the board', () => {
  // Bug fix #1: horizontal wrap kept working; assert baseline.
  assert.equal(wrapCoord(-1, GRID_WIDTH), GRID_WIDTH - 1);
  assert.equal(wrapCoord(GRID_WIDTH, GRID_WIDTH), 0);
});

test('wrapCoord wraps the Y axis around the board (regression: was broken by `x = ...` typo)', () => {
  // Bug fix #2: vertical wrap previously assigned to the wrong variable,
  // making the player teleport horizontally instead of wrapping vertically.
  assert.equal(wrapCoord(-1, GRID_HEIGHT), GRID_HEIGHT - 1);
  assert.equal(wrapCoord(GRID_HEIGHT, GRID_HEIGHT), 0);
});

test('canMoveTo wraps vertically when moving up off the top edge', () => {
  const map = makeMap();
  // Moving up from y=0 should land in y=GRID_HEIGHT-1 in the same column.
  assert.equal(canMoveTo(map, { x: 5, y: 0 }, UP), true);
});

test('canMoveTo wraps vertically when moving down off the bottom edge', () => {
  // Regression for the `game.heigth` typo: this wrap previously never fired.
  const map = makeMap();
  assert.equal(canMoveTo(map, { x: 5, y: GRID_HEIGHT - 1 }, DOWN), true);
});

test('map lookups wrap by the map dimensions on every edge', () => {
  const map = makeMap();
  map.posY[6].posX[17].type = 'right-edge';
  map.posY[6].posX[0].type = 'left-edge';
  map.posY[12].posX[4].type = 'bottom-edge';
  map.posY[0].posX[4].type = 'top-edge';

  assert.equal(getMapContent(map, -1, 6), 'right-edge');
  assert.equal(getMapContent(map, GRID_WIDTH, 6), 'left-edge');
  assert.equal(getMapContent(map, 4, -1), 'bottom-edge');
  assert.equal(getMapContent(map, 4, GRID_HEIGHT), 'top-edge');
});

test('Pac-Man and shared figures land on grid-aligned cells when wrapping', () => {
  const wrappedRight = wrapPosition({ x: 525, y: 180 }, 540, 390, 15);
  const wrappedLeft = wrapPosition({ x: -15, y: 180 }, 540, 390, 15);
  const wrappedDown = wrapPosition({ x: 240, y: 375 }, 540, 390, 15);
  const wrappedUp = wrapPosition({ x: 240, y: -15 }, 540, 390, 15);

  assert.deepEqual(wrappedRight, { x: 0, y: 180 });
  assert.deepEqual(wrappedLeft, { x: 510, y: 180 });
  assert.deepEqual(wrappedDown, { x: 240, y: 0 });
  assert.deepEqual(wrappedUp, { x: 240, y: 360 });
  for (const { x, y } of [wrappedRight, wrappedLeft, wrappedDown, wrappedUp]) {
    assert.equal(x % 30, 0);
    assert.equal(y % 30, 0);
  }
});

test('horizontal tunnel wraps reach an open local-map cell without sticking', () => {
  const map = makeMap({ walls: Array.from({ length: GRID_WIDTH * GRID_HEIGHT }, (_, index) => [index % GRID_WIDTH, Math.floor(index / GRID_WIDTH)]) });
  for (const x of [0, 1, 16, 17]) map.posY[6].posX[x].type = 'pill';

  assert.equal(canMoveTo(map, { x: 0, y: 6 }, LEFT), true);
  assert.equal(canMoveTo(map, { x: 17, y: 6 }, RIGHT), true);
  assert.equal(wrapPosition({ x: -15, y: 180 }, 540, 390, 15).x, 510);
  assert.equal(wrapPosition({ x: 525, y: 180 }, 540, 390, 15).x, 0);
});

test('the shipped tunnel row has open, grid-aligned wrap destinations', () => {
  const tunnelY = 6;
  assert.equal(getMapContent(shippedMap, 0, tunnelY), 'pill');
  assert.equal(getMapContent(shippedMap, GRID_WIDTH - 1, tunnelY), 'pill');
  assert.equal(canMoveTo(shippedMap, { x: 0, y: tunnelY }, LEFT), true);
  assert.equal(canMoveTo(shippedMap, { x: GRID_WIDTH - 1, y: tunnelY }, RIGHT), true);
  assert.deepEqual(wrapPosition({ x: -15, y: tunnelY * 30 }, 540, 390, 15), { x: 510, y: 180 });
  assert.deepEqual(wrapPosition({ x: 525, y: tunnelY * 30 }, 540, 390, 15), { x: 0, y: 180 });
});

test('canMoveTo respects walls at wrap destination', () => {
  const map = makeMap({ walls: [[5, GRID_HEIGHT - 1]] });
  // Moving up from y=0 column 5 should wrap to y=12 col 5, which is now a wall.
  assert.equal(canMoveTo(map, { x: 5, y: 0 }, UP), false);
});

test('classic ghost difficulty reproduces the historical timings and speed', () => {
  for (const level of [1, 4, 5, 9, 12]) {
    assert.deepEqual(getGhostSettings('classic', level), {
      speed: 2,
      scatterFrames: 200,
      chaseFrames: 650,
      frightenedFrames: 240,
      modeSwitchMinLevel: 2,
    });
  }
  assert.deepEqual(getGhostSettings(undefined, 3), getGhostSettings('classic', 3));
});

test('every ghost difficulty uses a speed that divides the 30px grid', () => {
  for (const difficulty of GHOST_DIFFICULTIES) {
    for (let level = 1; level <= 15; level++) {
      const { speed } = getGhostSettings(difficulty, level);
      assert.equal(30 % speed, 0, `${difficulty} level ${level} speed ${speed} must divide 30`);
      assert.ok(speed <= 5, 'ghosts should never be faster than Pac-Man');
    }
  }
});

test('harder ghost difficulties are strictly harder than classic', () => {
  const classic = getGhostSettings('classic', 5);
  const hard = getGhostSettings('hard', 5);
  const insane = getGhostSettings('insane', 5);
  assert.ok(hard.speed > classic.speed);
  assert.ok(insane.speed >= hard.speed);
  assert.ok(hard.scatterFrames < classic.scatterFrames);
  assert.ok(insane.scatterFrames < hard.scatterFrames);
  assert.ok(hard.frightenedFrames < classic.frightenedFrames);
  assert.ok(insane.frightenedFrames < hard.frightenedFrames);
  assert.equal(hard.modeSwitchMinLevel, 1);
});

test('ghostMayLeaveHouse keeps the Inky and Clyde conditions by default', () => {
  const base = { releaseAll: false };
  assert.equal(ghostMayLeaveHouse({ ...base, name: 'blinky', level: 1, pillCount: 104 }), true);
  assert.equal(ghostMayLeaveHouse({ ...base, name: 'pinky', level: 1, pillCount: 104 }), true);

  assert.equal(ghostMayLeaveHouse({ ...base, name: 'inky', level: 2, pillCount: 0 }), false);
  assert.equal(ghostMayLeaveHouse({ ...base, name: 'inky', level: 3, pillCount: 75 }), false);
  assert.equal(ghostMayLeaveHouse({ ...base, name: 'inky', level: 3, pillCount: 74 }), true);

  assert.equal(ghostMayLeaveHouse({ ...base, name: 'clyde', level: 3, pillCount: 0 }), false);
  assert.equal(ghostMayLeaveHouse({ ...base, name: 'clyde', level: 4, pillCount: 35 }), false);
  assert.equal(ghostMayLeaveHouse({ ...base, name: 'clyde', level: 4, pillCount: 34 }), true);
});

test('ghostMayLeaveHouse releases all four ghosts immediately when releaseAll is set', () => {
  for (const name of ['blinky', 'pinky', 'inky', 'clyde']) {
    assert.equal(ghostMayLeaveHouse({ name, level: 1, pillCount: 104, releaseAll: true }), true, name);
  }
});
