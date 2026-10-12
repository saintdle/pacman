/* Shared browser and Node movement/pathfinding helpers. Keep this file a
 * classic script so the game can load it synchronously before initialization. */
(function (root) {
  'use strict';

  var GRID_WIDTH = 18;
  var GRID_HEIGHT = 13;
  var DEFAULT_DIRECTIONS = [
    { dirX: 0, dirY: -1 },
    { dirX: 0, dirY: 1 },
    { dirX: 1, dirY: 0 },
    { dirX: -1, dirY: 0 },
  ];

  function mapSize(map, bounds) {
    var rows = map && Array.isArray(map.posY) ? map.posY : [];
    var firstRow = rows[0] && Array.isArray(rows[0].posX) ? rows[0].posX : [];
    return {
      width: bounds && bounds.width ? bounds.width : (firstRow.length || GRID_WIDTH),
      height: bounds && bounds.height ? bounds.height : (rows.length || GRID_HEIGHT),
    };
  }

  function wrapCoord(value, size) {
    if (!Number.isFinite(value) || !Number.isFinite(size) || size <= 0) return value;
    return ((value % size) + size) % size;
  }

  function getMapContent(map, x, y, bounds) {
    var size = mapSize(map, bounds);
    var wrappedX = wrapCoord(x, size.width);
    var wrappedY = wrapCoord(y, size.height);
    var row = map && map.posY && map.posY[wrappedY];
    var cell = row && row.posX && row.posX[wrappedX];
    return cell ? cell.type : 'wall';
  }

  function canMoveTo(map, from, direction, options) {
    var bounds = options || {};
    var type = getMapContent(map, from.x + direction.dirX, from.y + direction.dirY, bounds);
    return type !== 'wall' && (bounds.allowDoor !== false || type !== 'door');
  }

  function wrapPosition(position, width, height, radius) {
    var x = position.x;
    var y = position.y;
    if (x >= width - radius) x = 0;
    else if (x <= -radius) x = width - 2 * radius;
    if (y >= height - radius) y = 0;
    else if (y <= -radius) y = height - 2 * radius;
    return { x: x, y: y };
  }

  function getGhostTarget(options) {
    var ghost = options.ghost;
    var pacman = options.pacman;
    var blinky = options.blinky || { x: 0, y: 0 };
    if (ghost.dead) return { x: ghost.startX, y: ghost.startY };
    // Frightened mode changes ghost appearance and collision behavior today;
    // retain the existing scatter/chase target while that effect is active.
    if (options.ghostMode === 0) return { x: ghost.homeX, y: ghost.homeY };
    if (options.ghostMode !== 1 || !pacman) return null;

    var direction = pacman.direction || { dirX: 0, dirY: 0 };
    if (ghost.name === 'pinky') {
      var leftX = direction.dirX === 0 ? -direction.dirY : direction.dirX;
      var leftY = direction.dirY === 0 ? -direction.dirX : direction.dirY;
      return { x: pacman.x + leftX * 4, y: pacman.y + leftY * 4 };
    }
    if (ghost.name === 'blinky') return { x: pacman.x, y: pacman.y };
    if (ghost.name === 'inky') {
      var aheadX = pacman.x + 2 * direction.dirX;
      var aheadY = pacman.y + 2 * direction.dirY;
      return {
        x: Math.abs(blinky.x + (aheadX - blinky.x) * 2),
        y: Math.abs(blinky.y + (aheadY - blinky.y) * 2),
      };
    }
    if (ghost.name === 'clyde') {
      var dx = ghost.x - pacman.x;
      var dy = ghost.y - pacman.y;
      if (Math.sqrt(dx * dx + dy * dy) < 5) return { x: ghost.homeX, y: ghost.homeY };
      return { x: pacman.x, y: pacman.y };
    }
    return { x: pacman.x, y: pacman.y };
  }

  function pathCell(map, x, y, size, allowDoor) {
    if (y < 0 || y >= size.height) return 'wall';
    var wrappedX = wrapCoord(x, size.width);
    var row = map && map.posY && map.posY[y];
    var cell = row && row.posX && row.posX[wrappedX];
    if (!cell || cell.type === 'wall' || (!allowDoor && cell.type === 'door')) return 'wall';
    return cell.type;
  }

  function pathNeighbors(x, y, size) {
    var neighbors = [[wrapCoord(x + 1, size.width), y], [wrapCoord(x - 1, size.width), y]];
    if (y + 1 < size.height) neighbors.push([x, y + 1]);
    if (y - 1 >= 0) neighbors.push([x, y - 1]);
    return neighbors;
  }

  function distancesToTarget(map, target, size, allowDoor) {
    var distances = Array.from({ length: size.height }, function () {
      return Array(size.width).fill(Infinity);
    });
    var tx = wrapCoord(Math.round(target.x), size.width);
    var ty = Math.max(0, Math.min(size.height - 1, Math.round(target.y)));
    var queue = [];
    var search = [[tx, ty, 0]];
    var visited = Array.from({ length: size.height }, function () {
      return Array(size.width).fill(false);
    });
    var nearestOpenDistance = null;
    visited[ty][tx] = true;

    // Scatter targets can be buried several wall cells deep (the shipped
    // Blinky corner is one). Search the bounded, tunnel-wrapped grid outward
    // and seed every passable cell in the first open distance layer.
    for (var searchHead = 0; searchHead < search.length; searchHead++) {
      var searchCell = search[searchHead];
      var searchX = searchCell[0];
      var searchY = searchCell[1];
      var searchDistance = searchCell[2];
      if (nearestOpenDistance !== null && searchDistance > nearestOpenDistance) break;

      if (pathCell(map, searchX, searchY, size, allowDoor) !== 'wall') {
        if (nearestOpenDistance === null) nearestOpenDistance = searchDistance;
        distances[searchY][searchX] = searchDistance;
        queue.push([searchX, searchY]);
        continue;
      }

      var searchNeighbors = pathNeighbors(searchX, searchY, size);
      for (var searchIndex = 0; searchIndex < searchNeighbors.length; searchIndex++) {
        var nextSearchX = searchNeighbors[searchIndex][0];
        var nextSearchY = searchNeighbors[searchIndex][1];
        if (visited[nextSearchY][nextSearchX]) continue;
        visited[nextSearchY][nextSearchX] = true;
        search.push([nextSearchX, nextSearchY, searchDistance + 1]);
      }
    }

    for (var head = 0; head < queue.length; head++) {
      var current = queue[head];
      var nextDistance = distances[current[1]][current[0]] + 1;
      var neighbors = pathNeighbors(current[0], current[1], size);
      for (var j = 0; j < neighbors.length; j++) {
        var nx = neighbors[j][0];
        var ny = neighbors[j][1];
        if (distances[ny][nx] !== Infinity || pathCell(map, nx, ny, size, allowDoor) === 'wall') continue;
        distances[ny][nx] = nextDistance;
        queue.push([nx, ny]);
      }
    }
    return distances;
  }

  function sameDirection(a, b) {
    return !!a && !!b && a.dirX === b.dirX && a.dirY === b.dirY;
  }

  function chooseGhostDirection(map, from, currentDirection, target, options) {
    var settings = options || {};
    var size = mapSize(map);
    var directions = settings.directions || DEFAULT_DIRECTIONS;
    var opposite = currentDirection && { dirX: -currentDirection.dirX, dirY: -currentDirection.dirY };
    var x = wrapCoord(Math.round(from.x), size.width);
    var y = Math.max(0, Math.min(size.height - 1, Math.round(from.y)));
    var distances = target && Number.isFinite(target.x) && Number.isFinite(target.y)
      ? distancesToTarget(map, target, size, settings.allowDoor === true)
      : null;
    var candidates = [];

    for (var i = 0; i < directions.length; i++) {
      var direction = directions[i];
      if (sameDirection(direction, opposite)) continue;
      var nx = wrapCoord(x + direction.dirX, size.width);
      var ny = y + direction.dirY;
      if (pathCell(map, nx, ny, size, settings.allowDoor === true) === 'wall') continue;
      var distance = distances ? distances[ny][nx] : Infinity;
      candidates.push({ direction: direction, distance: distance });
    }

    // Direction order is up, down, right, left; strict comparison keeps that
    // stable tie break. If a target is unreachable, choose the first legal exit.
    var best = null;
    var bestDistance = Infinity;
    for (var j = 0; j < candidates.length; j++) {
      if (best === null || candidates[j].distance < bestDistance) {
        best = candidates[j].direction;
        bestDistance = candidates[j].distance;
      }
    }

    if (best === null && opposite) {
      var reverseX = wrapCoord(x + opposite.dirX, size.width);
      var reverseY = y + opposite.dirY;
      if (pathCell(map, reverseX, reverseY, size, settings.allowDoor === true) !== 'wall') {
        for (var k = 0; k < directions.length; k++) {
          if (sameDirection(directions[k], opposite)) {
            best = directions[k];
            break;
          }
        }
      }
    }
    return best || currentDirection || directions[0];
  }

  root.PacmanMovement = {
    GRID_WIDTH: GRID_WIDTH,
    GRID_HEIGHT: GRID_HEIGHT,
    wrapCoord: wrapCoord,
    getMapContent: getMapContent,
    canMoveTo: canMoveTo,
    wrapPosition: wrapPosition,
    getGhostTarget: getGhostTarget,
    chooseGhostDirection: chooseGhostDirection,
  };
})(globalThis);
