#!/usr/bin/env node
// Regenerate the normal and eBee instruction illustrations from the shipped
// map, wall layout, and visual rules in public/pacman-canvas.js:
//   node tools/generate-instruction-screenshots.js

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const map = JSON.parse(readFileSync(join(root, 'public/data/map.json'), 'utf8'));
const cell = 30;
const radius = 15;
const width = map.posY[0].posX.length;
const height = map.posY.length;
const canvasWidth = width * cell;
const canvasHeight = height * cell;
const footerHeight = 52;

// buildWalls() rectangles from public/pacman-canvas.js, expressed as grid cells.
const walls = [
  [0, 0, 18, 1], [0, 12, 18, 1],
  [0, 0, 1, 6], [0, 7, 1, 6], [17, 0, 1, 6], [17, 7, 1, 6],
  [7, 4, 1, 1], [6, 5, 1, 2], [10, 4, 1, 1], [11, 5, 1, 2], [6, 6, 6, 1],
  [4, 0, 1, 2], [13, 0, 1, 2],
  [2, 2, 1, 2], [6, 2, 2, 1], [15, 2, 1, 2], [10, 2, 2, 1],
  [2, 3, 2, 1], [14, 3, 2, 1], [5, 3, 1, 1], [12, 3, 1, 1], [3, 3, 1, 3], [14, 3, 1, 3],
  [3, 4, 1, 1], [14, 4, 1, 1],
  [0, 5, 2, 1], [3, 5, 2, 1], [16, 5, 2, 1], [13, 5, 2, 1],
  [0, 7, 2, 2], [16, 7, 2, 2], [3, 7, 2, 2], [13, 7, 2, 2],
  [4, 8, 2, 2], [12, 8, 2, 2], [5, 8, 3, 1], [10, 8, 3, 1],
  [2, 10, 1, 1], [15, 10, 1, 1], [7, 10, 4, 1],
  [4, 11, 2, 2], [12, 11, 2, 2],
];

const sprites = {
  blinky: '#ca1111',
  pinky: '#f27bbd',
  inky: '#00a6d6',
  clyde: '#f7a21b',
};
const ciliumSource = readFileSync(join(root, 'public/img/cilium-light.svg'), 'utf8');
const ciliumPaths = (ciliumSource.match(/<path\b[^>]*\/>/g) || []).join('');
const pills = [];
const powerpills = [];

for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const type = map.posY[y].posX[x].type;
    if (type === 'pill') pills.push([x, y]);
    if (type === 'powerpill') powerpills.push([x, y]);
  }
}

const cx = x => x * cell + cell / 2;
const cy = y => y * cell + cell / 2;

function wallRect([gridX, gridY, gridWidth, gridHeight], color) {
  return `<rect x="${radius / 2 + gridX * cell}" y="${radius / 2 + gridY * cell}" width="${(2 * gridWidth - 1) * radius}" height="${(2 * gridHeight - 1) * radius}" rx="4" fill="${color}"/>`;
}

function ghost(x, y, name, dazzled, ebee) {
  const xPos = cx(x);
  const yPos = cy(y);
  if (ebee) {
    const petal = dazzled ? '#2f80ff' : ({ blinky: '#ff4d6d', pinky: '#ff8bd1', inky: '#40d6ff', clyde: '#ffb347' }[name]);
    const center = dazzled ? '#4a90e2' : '#ffea00';
    const u = radius / 7;
    const blocks = [
      [-1, 3, 2, 5, '#36b24a'], [-4, 5, 3, 2, '#36b24a'], [1, 4, 3, 2, '#36b24a'],
      [-2, -7, 4, 4, petal], [-7, -2, 4, 4, petal], [3, -2, 4, 4, petal], [-2, 3, 4, 4, petal],
      [-4, -4, 3, 3, petal], [1, -4, 3, 3, petal], [-4, 1, 3, 3, petal], [1, 1, 3, 3, petal],
      [-2, -2, 4, 4, center], [-1, -1, 1, 1, '#161616'], [1, -1, 1, 1, '#161616'],
    ];
    return `<g transform="translate(${xPos} ${yPos})">${blocks.map(([bx, by, bw, bh, fill]) => `<rect x="${bx * u}" y="${by * u}" width="${bw * u}" height="${bh * u}" fill="${fill}"/>`).join('')}</g>`;
  }

  const color = dazzled ? '#2121de' : sprites[name];
  return `<g transform="translate(${xPos} ${yPos})">
    <path d="M -12 3 A 12 12 0 0 1 12 3 L 12 10 L 8 12 L 4 10 L 0 12 L -4 10 L -8 12 L -12 10 Z" fill="${color}"/>
    <ellipse cx="-5" cy="-2" rx="3.5" ry="4.5" fill="#fff"/><ellipse cx="5" cy="-2" rx="3.5" ry="4.5" fill="#fff"/>
    <circle cx="-4" cy="-1" r="1.7" fill="${dazzled ? '#fff' : '#1111a8'}"/><circle cx="6" cy="-1" r="1.7" fill="${dazzled ? '#fff' : '#1111a8'}"/>
  </g>`;
}

function pacman(x, y, ebee) {
  const xPos = cx(x);
  const yPos = cy(y);
  if (!ebee) return `<path d="M ${xPos} ${yPos} L ${xPos + 12} ${yPos - 6} A 13 13 0 1 1 ${xPos + 12} ${yPos + 6} Z" fill="#ffe600"/>`;

  const u = radius / 8;
  const blocks = [
    [-7, -7, 4, 3, '#bff3ff'], [-7, 4, 4, 3, '#bff3ff'], [-6, -6, 2, 1, '#fff'], [-6, 5, 2, 1, '#fff'],
    [-5, -5, 9, 10, '#f6c915'], [-3, -5, 2, 10, '#161616'], [1, -5, 2, 10, '#161616'],
    [4, -3, 2, 6, '#f6c915'], [5, -2, 1, 4, '#161616'], [-6, -4, 1, 8, '#161616'],
    [5, -5, 2, 2, '#f6c915'], [6, -4, 1, 1, '#161616'], [4, -7, 1, 2, '#161616'],
    [6, -7, 1, 2, '#161616'], [3, 3, 1, 1, '#00a6d6'],
  ];
  return `<g transform="translate(${xPos} ${yPos})">${blocks.map(([bx, by, bw, bh, fill]) => `<rect x="${bx * u}" y="${by * u}" width="${bw * u}" height="${bh * u}" fill="${fill}"/>`).join('')}</g>`;
}

function ciliumPill(x, y) {
  return `<svg x="${cx(x) - 10}" y="${cy(y) - 11}" width="20" height="22" viewBox="1.77 -0.02 65.46 69.04">${ciliumPaths}</svg>`;
}

function nearestOpen(position, used = new Set()) {
  const candidates = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const type = map.posY[y].posX[x].type;
      const key = `${x},${y}`;
      if (type === 'wall' || type === 'door' || used.has(key)) continue;
      candidates.push({ x, y, distance: Math.abs(x - position[0]) + Math.abs(y - position[1]) });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x);
  const point = candidates[0];
  if (!point) throw new Error(`No open map cell near ${position.join(',')}`);
  used.add(`${point.x},${point.y}`);
  return point;
}

function scene({ kind, ebee }) {
  const wallColor = kind === 'chase' ? '#ff0000' : '#0000ff';
  const modeLabel = kind === 'scatter'
    ? 'SCATTER MODE · BLUE WALLS · GHOSTS HEAD TO HOME CORNERS'
    : kind === 'chase'
      ? 'CHASE MODE · RED WALLS · GHOSTS CHASE THE PLAYER'
      : (ebee ? 'CILIUM POWERPILL IN SCATTER · FLOWER GHOSTS TURN BLUE' : 'POWERPILL IN SCATTER · GHOSTS TURN BLUE');
  const used = new Set();
  const player = nearestOpen(kind === 'powerpill' ? [1, 11] : [2, 6], used);
  const preferredGhosts = kind === 'scatter'
    ? [[2, 2], [13, 0], [13, 11], [2, 11]]
    : kind === 'chase'
      ? [[4, 6], [2, 4], [7, 6], [2, 8]]
      : [[4, 10], [8, 5], [13, 6], [5, 8]];
  const names = ['pinky', 'blinky', 'inky', 'clyde'];
  const ghosts = preferredGhosts.map((position, index) => {
    const point = nearestOpen(position, used);
    return ghost(point.x, point.y, names[index], kind === 'powerpill', ebee);
  }).join('\n');
  const pillMarkup = pills.map(([x, y]) => `<circle cx="${cx(x)}" cy="${cy(y)}" r="2.5" fill="#fff"/>`).join('\n');
  const powerMarkup = powerpills.map(([x, y], index) => {
    if (ebee) return ciliumPill(x, y);
    const highlight = kind === 'powerpill' && index === 0;
    return `${highlight ? `<circle cx="${cx(x)}" cy="${cy(y)}" r="13" fill="#ffe600" opacity=".18"/>` : ''}<circle cx="${cx(x)}" cy="${cy(y)}" r="${highlight ? 8 : 6}" fill="#ffcca8"/>`;
  }).join('\n');
  const door = `<rect x="240" y="132.5" width="60" height="1" fill="#ffd2ff"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight + footerHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight + footerHeight}" role="img" aria-label="${modeLabel}">
  <rect width="100%" height="100%" fill="#000"/>
  <g>${pillMarkup}</g>
  <g>${powerMarkup}</g>
  <g>${walls.map(wall => wallRect(wall, wallColor)).join('\n')}</g>
  ${door}
  ${ghosts}
  ${pacman(player.x, player.y, ebee)}
  <path d="M 8 ${canvasHeight + 1} H ${canvasWidth - 8}" stroke="#444"/>
  <text x="${canvasWidth / 2}" y="${canvasHeight + 18}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="bold" fill="#fff">${modeLabel}</text>
  <g font-family="Arial, sans-serif" font-size="10" fill="#ddd">
    <circle cx="70" cy="${canvasHeight + 36}" r="4" fill="${ebee ? '#f6c915' : '#ffe600'}"/><text x="79" y="${canvasHeight + 40}">${ebee ? 'eBee' : 'Pac-Man'}</text>
    <circle cx="174" cy="${canvasHeight + 36}" r="4" fill="${ebee ? '#2f80ff' : '#f27bbd'}"/><text x="183" y="${canvasHeight + 40}">${ebee ? 'flower ghosts' : 'ghosts'}</text>
    <circle cx="292" cy="${canvasHeight + 36}" r="2.5" fill="#fff"/><text x="300" y="${canvasHeight + 40}">pill</text>
    ${ebee ? `<svg x="376" y="${canvasHeight + 27}" width="12" height="13" viewBox="1.77 -0.02 65.46 69.04">${ciliumPaths}</svg>` : `<circle cx="382" cy="${canvasHeight + 36}" r="4" fill="#ffcca8"/>`}
    <text x="391" y="${canvasHeight + 40}">${ebee ? 'Cilium pill' : 'powerpill'}</text>
  </g>
</svg>
`;
}

const outputDirectory = join(root, 'public/img/instructions');
for (const ebee of [false, true]) {
  for (const kind of ['scatter', 'chase', 'powerpill']) {
    const theme = ebee ? 'ebee_' : '';
    const outputPath = join(outputDirectory, `instructions_${theme}${kind}.svg`);
    writeFileSync(outputPath, scene({ kind, ebee }));
  }
}
console.log('Wrote six Pac-Man and eBee instruction screenshots to public/img/instructions.');
