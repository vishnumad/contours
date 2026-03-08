import './style.css';
import { initP5 } from './p5/init';

const SPACING = 3;
const NOISE_SCALE = 0.0065;
const LAND_THRESHOLD = 0.45;
const ISOLINE_INCREMENT = 0.0065;

const VERTICAL_BIAS = -175;
const ELEVATION_MULTIPLIER = 250;

const BACKGROUND_COLOR = '#fef0d9';
const OUTLINE_COLOR = '#c0526e';
const WATER_COLOR = '#00b4d8';

const WATER_SAMPLE_STEP = 2;
const CAMERA_ROTATION_X = (65 * Math.PI) / 180;
const CAMERA_ROTATION_Z = (45 * Math.PI) / 180;

const TERRAIN_VIEWPORT_SCALE = 1.8;
const TERRAIN_MIN_SIZE = 720;
const TERRAIN_MAX_SIZE = 1200;
const TERRAIN_PADDING = SPACING;
const FULL_CELL_FILL_EPSILON = 0.025;
const NOISE_OCTAVE_SUM = 1 + 0.5 + 0.25 + 0.125;

type RenderPhase = 'water' | 'contours' | 'complete';

type SceneState = {
  seed: number;
  cols: number;
  rows: number;
  worldWidth: number;
  worldHeight: number;
  elevations: Float32Array;
  maxElevation: number;
  contourThresholds: number[];
  waterRow: number;
  contourIndex: number;
  phase: RenderPhase;
};

let scene: SceneState | null = null;

function setup() {
  const root = document.querySelector<HTMLDivElement>('#app');
  const canvas = createCanvas(windowWidth, windowHeight, WEBGL);

  canvas.parent(root!);
  pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
  smooth();
  strokeCap(ROUND);
  strokeJoin(ROUND);

  resetScene(true);
}

function draw() {
  if (!scene) {
    return;
  }

  if (scene.phase === 'water') {
    if (scene.waterRow < 0) {
      scene.phase = 'contours';
      return;
    }

    drawWaterRow(scene, scene.waterRow);
    scene.waterRow -= WATER_SAMPLE_STEP;

    if (scene.waterRow < 0) {
      scene.phase = 'contours';
    }

    return;
  }

  if (scene.phase === 'contours') {
    if (scene.contourIndex >= scene.contourThresholds.length) {
      scene.phase = 'complete';
      noLoop();
      return;
    }

    drawContourThreshold(scene, scene.contourThresholds[scene.contourIndex]);
    scene.contourIndex += 1;

    if (scene.contourIndex >= scene.contourThresholds.length) {
      scene.phase = 'complete';
      noLoop();
    }
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
  resetScene(false);
}

function keyPressed() {
  if (key === 'r' || key === 'R') {
    resetScene(true);
  }
}

function resetScene(reseed: boolean) {
  const seed = reseed || !scene ? Date.now() : scene.seed;

  scene = buildSceneState(seed);
  applyProjection(scene);
  clear();
  background(BACKGROUND_COLOR);
  loop();
}

function buildSceneState(seed: number): SceneState {
  noiseSeed(seed);

  const worldSize = getWorldSize();
  const cols = Math.floor(worldSize / SPACING) + 1;
  const rows = Math.floor(worldSize / SPACING) + 1;
  const elevations = new Float32Array(cols * rows);
  let maxElevation = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const elevation = sampleLayeredElevation(col, row);
      elevations[getElevationIndex(col, row, cols)] = elevation;
      maxElevation = Math.max(maxElevation, elevation);
    }
  }

  const contourThresholds: number[] = [];
  for (let threshold = LAND_THRESHOLD; threshold <= maxElevation + ISOLINE_INCREMENT * 0.5; threshold += ISOLINE_INCREMENT) {
    contourThresholds.push(Number(threshold.toFixed(6)));
  }

  return {
    seed,
    cols,
    rows,
    worldWidth: (cols - 1) * SPACING,
    worldHeight: (rows - 1) * SPACING,
    elevations,
    maxElevation,
    contourThresholds,
    waterRow: rows - 1 - ((rows - 1) % WATER_SAMPLE_STEP),
    contourIndex: 0,
    phase: 'water',
  };
}

function getWorldSize() {
  const viewportBase = Math.min(windowWidth, windowHeight);
  const scaled = viewportBase * TERRAIN_VIEWPORT_SCALE;
  const clamped = Math.min(Math.max(scaled, TERRAIN_MIN_SIZE), TERRAIN_MAX_SIZE);
  const snapped = Math.floor(clamped / SPACING) * SPACING;

  return Math.max(snapped, TERRAIN_MIN_SIZE + TERRAIN_PADDING);
}

function sampleLayeredElevation(x: number, y: number) {
  const octave1 = sampleNoise(x, y);
  const octave2 = sampleNoise(x * 2, y * 2);
  const octave3 = sampleNoise(x * 4, y * 4);
  const octave4 = sampleNoise(x * 8, y * 8);

  return (octave1 + 0.5 * octave2 + 0.25 * octave3 + 0.125 * octave4) / NOISE_OCTAVE_SUM;
}

function sampleNoise(x: number, y: number) {
  return noise(x * NOISE_SCALE + 150, y * NOISE_SCALE + 150);
}

function drawWaterRow(currentScene: SceneState, row: number) {
  const waterZ = LAND_THRESHOLD * ELEVATION_MULTIPLIER + VERTICAL_BIAS;

  push();
  applyProjection(currentScene);
  applyTerrainTransform();
  stroke(WATER_COLOR);
  strokeWeight(2);

  for (let col = 0; col < currentScene.cols; col += WATER_SAMPLE_STEP) {
    if (getElevation(currentScene, col, row) < LAND_THRESHOLD) {
      point(
        col * SPACING - currentScene.worldWidth / 2,
        row * SPACING - currentScene.worldHeight / 2,
        waterZ,
      );
    }
  }

  pop();
}

function drawContourThreshold(currentScene: SceneState, threshold: number) {
  const fillVertices: number[] = [];
  const lineVertices: number[] = [];

  for (let col = 0; col < currentScene.cols - 1; col += 1) {
    for (let row = 0; row < currentScene.rows - 1; row += 1) {
      collectCellGeometry(currentScene, threshold, col, row, fillVertices, lineVertices);
    }
  }

  push();
  applyProjection(currentScene);
  applyTerrainTransform();

  if (fillVertices.length > 0) {
    noStroke();
    fill(BACKGROUND_COLOR);
    beginShape(TRIANGLES);
    emitVertices(fillVertices);
    endShape();
  }

  if (lineVertices.length > 0) {
    noFill();
    stroke(OUTLINE_COLOR);
    strokeWeight(1.5);
    beginShape(LINES);
    emitVertices(lineVertices);
    endShape();
  }

  pop();
}

function collectCellGeometry(
  currentScene: SceneState,
  threshold: number,
  col: number,
  row: number,
  fillVertices: number[],
  lineVertices: number[],
) {
  const x = col * SPACING - currentScene.worldWidth / 2;
  const y = row * SPACING - currentScene.worldHeight / 2;

  const nw = getElevation(currentScene, col, row);
  const ne = getElevation(currentScene, col + 1, row);
  const sw = getElevation(currentScene, col, row + 1);
  const se = getElevation(currentScene, col + 1, row + 1);

  const ax = lerp(x, x + SPACING, getInterpolationPercent(threshold, nw, ne));
  const ay = y;

  const bx = x + SPACING;
  const by = lerp(y, y + SPACING, getInterpolationPercent(threshold, ne, se));

  const cx = lerp(x, x + SPACING, getInterpolationPercent(threshold, sw, se));
  const cy = y + SPACING;

  const dx = x;
  const dy = lerp(y, y + SPACING, getInterpolationPercent(threshold, nw, sw));

  const contourZ = threshold * ELEVATION_MULTIPLIER + VERTICAL_BIAS;
  const fillZ = contourZ - 1.5;
  const caseIndex = binaryToDecimal(nw, ne, se, sw, threshold);

  switch (caseIndex) {
    case 0:
      break;
    case 1:
      addTriangle(fillVertices, cx, cy, fillZ, dx, dy, fillZ, x, y + SPACING, fillZ);
      addSegment(lineVertices, cx, cy, contourZ, dx, dy, contourZ);
      break;
    case 2:
      addTriangle(fillVertices, bx, by, fillZ, cx, cy, fillZ, x + SPACING, y + SPACING, fillZ);
      addSegment(lineVertices, bx, by, contourZ, cx, cy, contourZ);
      break;
    case 3:
      addTriangle(fillVertices, bx, by, fillZ, dx, dy, fillZ, x, y + SPACING, fillZ);
      addTriangle(fillVertices, x, y + SPACING, fillZ, x + SPACING, y + SPACING, fillZ, bx, by, fillZ);
      addSegment(lineVertices, bx, by, contourZ, dx, dy, contourZ);
      break;
    case 4:
      addTriangle(fillVertices, ax, ay, fillZ, bx, by, fillZ, x + SPACING, y, fillZ);
      addSegment(lineVertices, ax, ay, contourZ, bx, by, contourZ);
      break;
    case 5:
      addTriangle(fillVertices, ax, ay, fillZ, bx, by, fillZ, x + SPACING, y, fillZ);
      addTriangle(fillVertices, cx, cy, fillZ, dx, dy, fillZ, x, y + SPACING, fillZ);
      addTriangle(fillVertices, cx, cy, fillZ, dx, dy, fillZ, ax, ay, fillZ);
      addTriangle(fillVertices, cx, cy, fillZ, bx, by, fillZ, ax, ay, fillZ);
      addSegment(lineVertices, ax, ay, contourZ, dx, dy, contourZ);
      addSegment(lineVertices, bx, by, contourZ, cx, cy, contourZ);
      break;
    case 6:
      addTriangle(fillVertices, ax, ay, fillZ, cx, cy, fillZ, x + SPACING, y + SPACING, fillZ);
      addTriangle(fillVertices, ax, ay, fillZ, x + SPACING, y, fillZ, x + SPACING, y + SPACING, fillZ);
      addSegment(lineVertices, ax, ay, contourZ, cx, cy, contourZ);
      break;
    case 7:
      addTriangle(fillVertices, ax, ay, fillZ, x + SPACING, y, fillZ, x + SPACING, y + SPACING, fillZ);
      addTriangle(fillVertices, dx, dy, fillZ, x, y + SPACING, fillZ, x + SPACING, y + SPACING, fillZ);
      addTriangle(fillVertices, ax, ay, fillZ, dx, dy, fillZ, x + SPACING, y + SPACING, fillZ);
      addSegment(lineVertices, ax, ay, contourZ, dx, dy, contourZ);
      break;
    case 8:
      addTriangle(fillVertices, ax, ay, fillZ, dx, dy, fillZ, x, y, fillZ);
      addSegment(lineVertices, ax, ay, contourZ, dx, dy, contourZ);
      break;
    case 9:
      addTriangle(fillVertices, x, y, fillZ, ax, ay, fillZ, cx, cy, fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, y + SPACING, fillZ, cx, cy, fillZ);
      addSegment(lineVertices, ax, ay, contourZ, cx, cy, contourZ);
      break;
    case 10:
      addTriangle(fillVertices, x, y, fillZ, ax, ay, fillZ, dx, dy, fillZ);
      addTriangle(fillVertices, bx, by, fillZ, cx, cy, fillZ, x + SPACING, y + SPACING, fillZ);
      addTriangle(fillVertices, bx, by, fillZ, cx, cy, fillZ, dx, dy, fillZ);
      addTriangle(fillVertices, ax, ay, fillZ, bx, by, fillZ, dx, dy, fillZ);
      addSegment(lineVertices, ax, ay, contourZ, bx, by, contourZ);
      addSegment(lineVertices, cx, cy, contourZ, dx, dy, contourZ);
      break;
    case 11:
      addTriangle(fillVertices, x, y, fillZ, ax, ay, fillZ, x, y + SPACING, fillZ);
      addTriangle(fillVertices, bx, by, fillZ, x + SPACING, y + SPACING, fillZ, x, y + SPACING, fillZ);
      addTriangle(fillVertices, ax, ay, fillZ, bx, by, fillZ, x, y + SPACING, fillZ);
      addSegment(lineVertices, ax, ay, contourZ, bx, by, contourZ);
      break;
    case 12:
      addTriangle(fillVertices, x, y, fillZ, x + SPACING, y, fillZ, bx, by, fillZ);
      addTriangle(fillVertices, x, y, fillZ, dx, dy, fillZ, bx, by, fillZ);
      addSegment(lineVertices, bx, by, contourZ, dx, dy, contourZ);
      break;
    case 13:
      addTriangle(fillVertices, x, y, fillZ, x + SPACING, y, fillZ, bx, by, fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, y + SPACING, fillZ, cx, cy, fillZ);
      addTriangle(fillVertices, bx, by, fillZ, cx, cy, fillZ, x, y, fillZ);
      addSegment(lineVertices, bx, by, contourZ, cx, cy, contourZ);
      break;
    case 14:
      addTriangle(fillVertices, dx, dy, fillZ, x, y, fillZ, x + SPACING, y, fillZ);
      addTriangle(fillVertices, cx, cy, fillZ, x + SPACING, y, fillZ, x + SPACING, y + SPACING, fillZ);
      addTriangle(fillVertices, cx, cy, fillZ, dx, dy, fillZ, x + SPACING, y, fillZ);
      addSegment(lineVertices, cx, cy, contourZ, dx, dy, contourZ);
      break;
    case 15:
      if (Math.abs(threshold - nw) < FULL_CELL_FILL_EPSILON) {
        addTriangle(fillVertices, x, y, fillZ, x + SPACING, y, fillZ, x + SPACING, y + SPACING, fillZ);
        addTriangle(fillVertices, x, y, fillZ, x, y + SPACING, fillZ, x + SPACING, y + SPACING, fillZ);
      }
      break;
    default:
      break;
  }
}

function emitVertices(vertices: number[]) {
  for (let index = 0; index < vertices.length; index += 3) {
    vertex(vertices[index], vertices[index + 1], vertices[index + 2]);
  }
}

function addTriangle(
  vertices: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
) {
  vertices.push(ax, ay, az, bx, by, bz, cx, cy, cz);
}

function addSegment(
  vertices: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
) {
  vertices.push(ax, ay, az, bx, by, bz);
}

function getInterpolationPercent(threshold: number, start: number, end: number) {
  const range = end - start;

  if (Math.abs(range) < Number.EPSILON) {
    return 0.5;
  }

  return constrain((threshold - start) / range, 0, 1);
}

function binaryToDecimal(a: number, b: number, c: number, d: number, threshold: number) {
  const aBit = a > threshold ? 8 : 0;
  const bBit = b > threshold ? 4 : 0;
  const cBit = c > threshold ? 2 : 0;
  const dBit = d > threshold ? 1 : 0;

  return aBit + bBit + cBit + dBit;
}

function getElevation(currentScene: SceneState, col: number, row: number) {
  return currentScene.elevations[getElevationIndex(col, row, currentScene.cols)];
}

function getElevationIndex(col: number, row: number, cols: number) {
  return row * cols + col;
}

function applyProjection(currentScene: SceneState) {
  const depth = Math.max(currentScene.worldWidth, currentScene.worldHeight) * 2;
  ortho(-width / 2, width / 2, -height / 2, height / 2, -depth, depth);
}

function applyTerrainTransform() {
  rotateX(CAMERA_ROTATION_X);
  rotateZ(CAMERA_ROTATION_Z);
}

initP5({ setup, draw, windowResized, keyPressed });
