import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMoveTo, wrapCoord, GRID_WIDTH, GRID_HEIGHT } from '../src/client/movement.js';

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

test('canMoveTo respects walls at wrap destination', () => {
  const map = makeMap({ walls: [[5, GRID_HEIGHT - 1]] });
  // Moving up from y=0 column 5 should wrap to y=12 col 5, which is now a wall.
  assert.equal(canMoveTo(map, { x: 5, y: 0 }, UP), false);
});
