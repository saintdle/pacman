/**
 * Pure helpers extracted from public/pacman-canvas.js so the wall/teleport
 * rules can be unit-tested deterministically.
 *
 * The game map is structured as:
 *   { posY: [ { posX: [ { type: 'wall' | 'pill' | 'powerpill' | 'null' | 'door' }, ... ] }, ... ] }
 *
 * Grid is 18 wide x 13 tall (matches public/data/map.json).
 */

export const GRID_WIDTH = 18;
export const GRID_HEIGHT = 13;

/**
 * Wrap a grid coordinate around the board, so moving off the left edge
 * appears on the right edge (classic Pac-Man tunnel behaviour).
 *
 * The original code had two bugs in this exact spot:
 *   1. Upward wrap assigned to `x` instead of `y`.
 *   2. Downward wrap used the typo `game.heigth`.
 * Either bug let a stray input teleport Pac-Man horizontally across the
 * middle of the board.
 */
export function wrapCoord(value, max) {
  if (value <= -1) return max - 1;
  if (value >= max) return 0;
  return value;
}

/**
 * Returns true if the entity can move from its current grid cell in the
 * requested direction without ending up on a wall.
 *
 * @param {{posY: Array<{posX: Array<{type: string}>}>}} map
 * @param {{x: number, y: number}} from - current grid position
 * @param {{dirX: number, dirY: number}} dir - delta (one of -1/0/1 per axis)
 * @param {{width?: number, height?: number}} [bounds]
 * @returns {boolean}
 */
export function canMoveTo(map, from, dir, bounds = {}) {
  const width = bounds.width ?? GRID_WIDTH;
  const height = bounds.height ?? GRID_HEIGHT;

  const nx = wrapCoord(from.x + dir.dirX, width);
  const ny = wrapCoord(from.y + dir.dirY, height);

  const row = map.posY?.[ny];
  if (!row) return false;
  const cell = row.posX?.[nx];
  if (!cell) return false;
  return cell.type !== 'wall';
}

export default { canMoveTo, wrapCoord, GRID_WIDTH, GRID_HEIGHT };
