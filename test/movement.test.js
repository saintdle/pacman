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
