// The browser loads this classic script before pacman-canvas.js. Importing the
// same file here keeps Node tests on the exact helpers used by the game.
import '../../public/js/movement.js';

const movement = globalThis.PacmanMovement;

export const GRID_WIDTH = movement.GRID_WIDTH;
export const GRID_HEIGHT = movement.GRID_HEIGHT;
export const wrapCoord = movement.wrapCoord;
export const getMapContent = movement.getMapContent;
export const canMoveTo = movement.canMoveTo;
export const wrapPosition = movement.wrapPosition;
export const getGhostTarget = movement.getGhostTarget;
export const chooseGhostDirection = movement.chooseGhostDirection;

export default movement;
