import './style.css';
import type p5 from 'p5';
import { initP5 } from './p5/init';

const SPACING = 4;
const NOISE_SCALE = 0.0085;
const LAND_THRESHOLD = 0.47;
const ISOLINE_INCREMENT = 0.003;
const CONTOUR_LINE_WEIGHT = 1.25;

const VERTICAL_BIAS = 0;
const ELEVATION_MULTIPLIER = 475;

const BACKGROUND_COLOR = '#fef0d9';
const OUTLINE_COLOR = '#c0526e';
const WATER_COLOR = '#00b4d8';

const WATER_SAMPLE_STEP = 2;
const WATER_POINT_SIZE = 1.7;
const CAMERA_ROTATION_X = (65 * Math.PI) / 180;
const CAMERA_ROTATION_Z = (45 * Math.PI) / 180;

const TERRAIN_VIEWPORT_SCALE = 1.2;
const TERRAIN_MIN_SIZE = 720;
const TERRAIN_MAX_SIZE = 2000;
const TERRAIN_PADDING = SPACING;
const FULL_CELL_FILL_EPSILON = 0.025;
const NOISE_OCTAVE_SUM = 1 + 0.5 + 0.25 + 0.125;
const PROFILE_QUERY_PARAM = 'profile';
const PROFILE_STORAGE_KEY = 'contour-profile';

type RenderPhase = 'water' | 'contours' | 'complete';
type ContourLayerReadiness = 'pending' | 'geometry-ready' | 'render-ready' | 'disposed';

type ContourVertexData = number[] | Float32Array;

type ContourGeometryStats = {
  activeCellCount: number;
  fillCellCount: number;
  lineCellCount: number;
  fullCellCount: number;
  triangleCount: number;
  segmentCount: number;
};

type ContourLayerStats = ContourGeometryStats & {
  geometryMs: number;
  uploadMs: number;
  fillUploadMs: number;
  lineUploadMs: number;
  drawMs: number;
  fillDrawMs: number;
  lineDrawMs: number;
  fillVertexCount: number;
  lineVertexCount: number;
};

type ThresholdProfile = {
  threshold: number;
} & ContourLayerStats;

type ContourLayerGeometry = {
  fillVertices: ContourVertexData | null;
  lineVertices: ContourVertexData | null;
};

type ContourLayerResourceSlot = {
  handle: unknown;
  dispose: (() => void) | null;
};

type ContourRenderBuffer = {
  buffer: WebGLBuffer;
  vertexCount: number;
  drawMode: number;
};

type ContourRetainedBackend = {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  program: WebGLProgram;
  positionLocation: number;
  projectionMatrixLocation: WebGLUniformLocation;
  modelViewMatrixLocation: WebGLUniformLocation;
  colorLocation: WebGLUniformLocation;
};

type P5MatrixLike = {
  mat4: ArrayLike<number>;
};

type P5RendererLike = {
  uPMatrix: P5MatrixLike;
  uMVMatrix: P5MatrixLike;
};

type ContourLineTransform = {
  screenBasisXX: number;
  screenBasisXY: number;
  screenBasisYX: number;
  screenBasisYY: number;
  terrainBasisXX: number;
  terrainBasisXY: number;
  terrainBasisYX: number;
  terrainBasisYY: number;
};

type TerrainScreenOffset = {
  x: number;
  y: number;
};

type ContourLayerRenderResources = {
  fill: ContourLayerResourceSlot;
  line: ContourLayerResourceSlot;
};

type ContourLayer = {
  threshold: number;
  readiness: ContourLayerReadiness;
  geometry: ContourLayerGeometry;
  stats: ContourLayerStats;
  renderResources: ContourLayerRenderResources;
};

type WaterRowSlice = {
  startVertex: number;
  vertexCount: number;
};

type WaterGeometry = {
  pointVertices: Float32Array | null;
  rowSlices: Array<WaterRowSlice | null>;
};

type WaterRenderResources = {
  points: ContourLayerResourceSlot;
};

type WaterState = {
  geometry: WaterGeometry;
  renderResources: WaterRenderResources;
};

type WaterRetainedBackend = {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  program: WebGLProgram;
  positionLocation: number;
  projectionMatrixLocation: WebGLUniformLocation;
  modelViewMatrixLocation: WebGLUniformLocation;
  colorLocation: WebGLUniformLocation;
  pointSizeLocation: WebGLUniformLocation;
};

type SceneProfile = {
  enabled: boolean;
  seed: number;
  worldSize: number;
  cols: number;
  rows: number;
  totalCells: number;
  thresholdCount: number;
  sceneBuildMs: number;
  elevationSampleMs: number;
  waterDrawMs: number;
  waterRowsDrawn: number;
  waterPointsDrawn: number;
  contourGeometryMs: number;
  contourUploadMs: number;
  contourDrawMs: number;
  revealTotalMs: number;
  contours: ThresholdProfile[];
  summaryLogged: boolean;
  startedAtMs: number;
};

type SceneState = {
  seed: number;
  cols: number;
  rows: number;
  worldWidth: number;
  worldHeight: number;
  elevations: Float32Array;
  maxElevation: number;
  terrainScreenOffset: TerrainScreenOffset;
  water: WaterState;
  contourLayers: ContourLayer[];
  waterRow: number;
  contourIndex: number;
  phase: RenderPhase;
  profile: SceneProfile | null;
};

declare global {
  interface Window {
    __CONTOUR_PROFILE__?: SceneProfile;
    __CONTOUR_PROFILE_DEBUG__?: boolean;
  }
}

let scene: SceneState | null = null;
let contourRetainedBackend: ContourRetainedBackend | null = null;
let waterRetainedBackend: WaterRetainedBackend | null = null;

const RETAINED_CONTOUR_VERTEX_SHADER = `
attribute vec3 aPosition;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;

void main() {
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}
`;

const RETAINED_CONTOUR_FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 uColor;

void main() {
  gl_FragColor = uColor;
}
`;

const RETAINED_WATER_VERTEX_SHADER = `
attribute vec3 aPosition;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
uniform float uPointSize;

void main() {
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
  gl_PointSize = uPointSize;
}
`;

const RETAINED_WATER_FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 uColor;

void main() {
  vec2 centeredCoord = gl_PointCoord - vec2(0.5);
  if (dot(centeredCoord, centeredCoord) > 0.25) {
    discard;
  }

  gl_FragColor = uColor;
}
`;

const CAMERA_ROTATION_X_COS = Math.cos(CAMERA_ROTATION_X);
const CAMERA_ROTATION_X_SIN = Math.sin(CAMERA_ROTATION_X);
const CAMERA_ROTATION_Z_COS = Math.cos(CAMERA_ROTATION_Z);
const CAMERA_ROTATION_Z_SIN = Math.sin(CAMERA_ROTATION_Z);
const FILL_COLOR_RGBA = hexToNormalizedRgba(BACKGROUND_COLOR);
const OUTLINE_COLOR_RGBA = hexToNormalizedRgba(OUTLINE_COLOR);
const WATER_COLOR_RGBA = hexToNormalizedRgba(WATER_COLOR);

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

    drawWaterRows(scene);
    scene.phase = 'contours';

    return;
  }

  if (scene.phase === 'contours') {
    if (scene.contourIndex >= scene.contourLayers.length) {
      scene.phase = 'complete';
      finalizeSceneProfile(scene);
      noLoop();
      return;
    }

    drawContourLayer(scene, scene.contourLayers[scene.contourIndex]);
    scene.contourIndex += 1;

    if (scene.contourIndex >= scene.contourLayers.length) {
      scene.phase = 'complete';
      finalizeSceneProfile(scene);
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
  const previousScene = scene;

  scene = null;
  disposeSceneState(previousScene);

  try {
    const nextScene = buildSceneState(seed);

    scene = nextScene;
    applyProjection(nextScene);
    clear();
    background(BACKGROUND_COLOR);
    loop();
  } catch (error) {
    destroyContourRetainedBackend();
    exposeSceneProfile(null);
    clear();
    background(BACKGROUND_COLOR);
    noLoop();
    throw error;
  }
}

function buildSceneState(seed: number): SceneState {
  const profile = createSceneProfile(seed);
  const sceneBuildStart = performance.now();

  noiseSeed(seed);

  const worldSize = getWorldSize();
  const cols = Math.floor(worldSize / SPACING) + 1;
  const rows = Math.floor(worldSize / SPACING) + 1;
  const elevations = new Float32Array(cols * rows);
  let maxElevation = 0;
  const elevationStart = performance.now();

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const elevation = sampleLayeredElevation(col, row);
      elevations[getElevationIndex(col, row, cols)] = elevation;
      maxElevation = Math.max(maxElevation, elevation);
    }
  }

  if (profile) {
    profile.elevationSampleMs = performance.now() - elevationStart;
  }

  const contourThresholds: number[] = [];
  for (let threshold = LAND_THRESHOLD; threshold <= maxElevation + ISOLINE_INCREMENT * 0.5; threshold += ISOLINE_INCREMENT) {
    contourThresholds.push(Number(threshold.toFixed(6)));
  }

  const contourLayers = contourThresholds.map((threshold) => createContourLayer(threshold));
  const water = createWaterState(rows);

  const nextScene: SceneState = {
    seed,
    cols,
    rows,
    worldWidth: (cols - 1) * SPACING,
    worldHeight: (rows - 1) * SPACING,
    elevations,
    maxElevation,
    terrainScreenOffset: getTerrainScreenOffset((cols - 1) * SPACING, (rows - 1) * SPACING),
    water,
    contourLayers,
    waterRow: getInitialWaterRow(rows),
    contourIndex: 0,
    phase: 'water',
    profile,
  };

  populateWaterGeometry(nextScene);

  if (profile) {
    profile.worldSize = worldSize;
    profile.cols = cols;
    profile.rows = rows;
    profile.totalCells = (cols - 1) * (rows - 1);
    profile.thresholdCount = contourLayers.length;
    profile.sceneBuildMs = performance.now() - sceneBuildStart;
  }

  exposeSceneProfile(profile);

  return nextScene;
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

function drawWaterRows(currentScene: SceneState) {
  const waterStart = performance.now();
  const retainedBackend = getWaterRetainedBackend();
  let waterPoints = 0;

  push();
  applyProjection(currentScene);
  applyTerrainTransform(currentScene);

  if (retainedBackend && ensureWaterRenderResources(retainedBackend, currentScene.water)) {
    waterPoints = drawWaterRetained(retainedBackend, currentScene.water);
  } else {
    waterPoints = drawWaterImmediate(currentScene);
  }

  pop();

  currentScene.waterRow = -1;

  if (currentScene.profile) {
    currentScene.profile.waterRowsDrawn += getSampledWaterRowCount(currentScene.rows);
    currentScene.profile.waterPointsDrawn += waterPoints;
    currentScene.profile.waterDrawMs += performance.now() - waterStart;
  }
}

function drawWaterImmediate(currentScene: SceneState) {
  const waterZ = LAND_THRESHOLD * ELEVATION_MULTIPLIER + VERTICAL_BIAS;
  let waterPoints = 0;

  stroke(WATER_COLOR);
  strokeWeight(WATER_POINT_SIZE);

  for (let row = getInitialWaterRow(currentScene.rows); row >= 0; row -= WATER_SAMPLE_STEP) {
    for (let col = 0; col < currentScene.cols; col += WATER_SAMPLE_STEP) {
      if (getElevation(currentScene, col, row) < LAND_THRESHOLD) {
        waterPoints += 1;
        point(
          col * SPACING - currentScene.worldWidth / 2,
          row * SPACING - currentScene.worldHeight / 2,
          waterZ,
        );
      }
    }
  }

  return waterPoints;
}

function drawContourLayer(currentScene: SceneState, contourLayer: ContourLayer) {
  if (contourLayer.readiness === 'disposed') {
    return;
  }

  const { threshold } = contourLayer;
  let geometryMs = contourLayer.stats.geometryMs;
  let uploadMs = contourLayer.stats.uploadMs;
  let fillUploadMs = contourLayer.stats.fillUploadMs;
  let lineUploadMs = contourLayer.stats.lineUploadMs;
  let geometryStats = {
    activeCellCount: contourLayer.stats.activeCellCount,
    fillCellCount: contourLayer.stats.fillCellCount,
    lineCellCount: contourLayer.stats.lineCellCount,
    fullCellCount: contourLayer.stats.fullCellCount,
    triangleCount: contourLayer.stats.triangleCount,
    segmentCount: contourLayer.stats.segmentCount,
  };

  if (contourLayer.readiness === 'pending') {
    const fillVertices: number[] = [];
    const lineVertices: number[] = [];
    geometryStats = createContourGeometryStats();
    const geometryStart = performance.now();

    push();
    applyProjection(currentScene);
    applyTerrainTransform(currentScene);
    const contourLineTransform = createContourLineTransform();
    pop();

    for (let col = 0; col < currentScene.cols - 1; col += 1) {
      for (let row = 0; row < currentScene.rows - 1; row += 1) {
        collectCellGeometry(currentScene, threshold, col, row, fillVertices, lineVertices, geometryStats, contourLineTransform);
      }
    }

    geometryMs = performance.now() - geometryStart;
    updateContourLayerGeometry(contourLayer, new Float32Array(fillVertices), new Float32Array(lineVertices));
  }

  let fillDrawMs = 0;
  let lineDrawMs = 0;
  const drawStart = performance.now();

  push();
  applyProjection(currentScene);
  applyTerrainTransform(currentScene);

  const retainedBackend = getContourRetainedBackend();
  if (retainedBackend) {
    const uploadMetrics = ensureContourLayerRenderResources(retainedBackend, contourLayer);
    uploadMs += uploadMetrics.uploadMs;
    fillUploadMs += uploadMetrics.fillUploadMs;
    lineUploadMs += uploadMetrics.lineUploadMs;

    if (contourLayer.readiness === 'render-ready') {
      fillDrawMs = drawContourFillRetained(retainedBackend, contourLayer);
      lineDrawMs = drawContourLineRetained(retainedBackend, contourLayer);
    } else {
      const drawMetrics = drawContourLayerImmediate(contourLayer);
      fillDrawMs = drawMetrics.fillDrawMs;
      lineDrawMs = drawMetrics.lineDrawMs;
    }
  } else {
    const drawMetrics = drawContourLayerImmediate(contourLayer);
    fillDrawMs = drawMetrics.fillDrawMs;
    lineDrawMs = drawMetrics.lineDrawMs;
  }

  pop();

  const drawMs = performance.now() - drawStart;
  const fillVertexCount = getContourLayerVertexCount(
    contourLayer.renderResources.fill,
    contourLayer.geometry.fillVertices,
    contourLayer.stats.fillVertexCount,
  );
  const lineVertexCount = getContourLayerVertexCount(
    contourLayer.renderResources.line,
    contourLayer.geometry.lineVertices,
    contourLayer.stats.lineVertexCount,
  );
  const stats: ContourLayerStats = {
    geometryMs,
    uploadMs,
    fillUploadMs,
    lineUploadMs,
    drawMs,
    fillDrawMs,
    lineDrawMs,
    fillVertexCount,
    lineVertexCount,
    activeCellCount: geometryStats.activeCellCount,
    fillCellCount: geometryStats.fillCellCount,
    lineCellCount: geometryStats.lineCellCount,
    fullCellCount: geometryStats.fullCellCount,
    triangleCount: geometryStats.triangleCount,
    segmentCount: geometryStats.segmentCount,
  };

  updateContourLayerStats(contourLayer, stats);
  recordThresholdProfile(currentScene, {
    threshold,
    ...stats,
  });
}

function collectCellGeometry(
  currentScene: SceneState,
  threshold: number,
  col: number,
  row: number,
  fillVertices: number[],
  lineVertices: number[],
  geometryStats: ContourGeometryStats,
  contourLineTransform: ContourLineTransform,
) {
  const nw = getElevation(currentScene, col, row);
  const ne = getElevation(currentScene, col + 1, row);
  const sw = getElevation(currentScene, col, row + 1);
  const se = getElevation(currentScene, col + 1, row + 1);
  const caseIndex = binaryToDecimal(nw, ne, se, sw, threshold);

  if (caseIndex === 0) {
    return;
  }

  geometryStats.activeCellCount += 1;

  if (caseIndex === 15) {
    geometryStats.fullCellCount += 1;
    if (Math.abs(threshold - nw) < FULL_CELL_FILL_EPSILON) {
      const fillZ = threshold * ELEVATION_MULTIPLIER + VERTICAL_BIAS - 1.5;
      const x = col * SPACING - currentScene.worldWidth / 2;
      const y = row * SPACING - currentScene.worldHeight / 2;
      const maxX = x + SPACING;
      const maxY = y + SPACING;

      addTriangle(fillVertices, x, y, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, maxY, fillZ, maxX, maxY, fillZ);
      geometryStats.fillCellCount += 1;
      geometryStats.triangleCount += 2;
    }
    return;
  }

  const fillZ = threshold * ELEVATION_MULTIPLIER + VERTICAL_BIAS - 1.5;
  const x = col * SPACING - currentScene.worldWidth / 2;
  const y = row * SPACING - currentScene.worldHeight / 2;
  const maxX = x + SPACING;
  const maxY = y + SPACING;
  const contourZ = fillZ + 1.5;

  let ax = 0;
  let by = 0;
  let cx = 0;
  let dy = 0;
  let hasTopIntersection = false;
  let hasRightIntersection = false;
  let hasBottomIntersection = false;
  let hasLeftIntersection = false;

  const getTopIntersectionX = () => {
    if (!hasTopIntersection) {
      ax = lerp(x, maxX, getInterpolationPercent(threshold, nw, ne));
      hasTopIntersection = true;
    }

    return ax;
  };

  const getRightIntersectionY = () => {
    if (!hasRightIntersection) {
      by = lerp(y, maxY, getInterpolationPercent(threshold, ne, se));
      hasRightIntersection = true;
    }

    return by;
  };

  const getBottomIntersectionX = () => {
    if (!hasBottomIntersection) {
      cx = lerp(x, maxX, getInterpolationPercent(threshold, sw, se));
      hasBottomIntersection = true;
    }

    return cx;
  };

  const getLeftIntersectionY = () => {
    if (!hasLeftIntersection) {
      dy = lerp(y, maxY, getInterpolationPercent(threshold, nw, sw));
      hasLeftIntersection = true;
    }

    return dy;
  };

  switch (caseIndex) {
    case 1:
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ, x, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, getBottomIntersectionX(), maxY, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 2:
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, getBottomIntersectionX(), maxY, fillZ, maxX, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, maxX, getRightIntersectionY(), contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 3:
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, x, getLeftIntersectionY(), fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, x, maxY, fillZ, maxX, maxY, fillZ, maxX, getRightIntersectionY(), fillZ);
      addSegment(lineVertices, contourLineTransform, maxX, getRightIntersectionY(), contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 4:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, getRightIntersectionY(), fillZ, maxX, y, fillZ);
      addSegment(lineVertices, contourLineTransform, getTopIntersectionX(), y, contourZ, maxX, getRightIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 5:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, getRightIntersectionY(), fillZ, maxX, y, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ, getTopIntersectionX(), y, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, maxX, getRightIntersectionY(), fillZ, getTopIntersectionX(), y, fillZ);
      addSegment(lineVertices, contourLineTransform, getTopIntersectionX(), y, contourZ, x, getLeftIntersectionY(), contourZ);
      addSegment(lineVertices, contourLineTransform, maxX, getRightIntersectionY(), contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 4;
      geometryStats.segmentCount += 2;
      break;
    case 6:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, getBottomIntersectionX(), maxY, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, getTopIntersectionX(), y, contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 7:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, x, getLeftIntersectionY(), fillZ, x, maxY, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, x, getLeftIntersectionY(), fillZ, maxX, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, getTopIntersectionX(), y, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    case 8:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, x, getLeftIntersectionY(), fillZ, x, y, fillZ);
      addSegment(lineVertices, contourLineTransform, getTopIntersectionX(), y, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 9:
      addTriangle(fillVertices, x, y, fillZ, getTopIntersectionX(), y, fillZ, getBottomIntersectionX(), maxY, fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, maxY, fillZ, getBottomIntersectionX(), maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, getTopIntersectionX(), y, contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 10:
      addTriangle(fillVertices, x, y, fillZ, getTopIntersectionX(), y, fillZ, x, getLeftIntersectionY(), fillZ);
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, getBottomIntersectionX(), maxY, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, getRightIntersectionY(), fillZ, x, getLeftIntersectionY(), fillZ);
      addSegment(lineVertices, contourLineTransform, getTopIntersectionX(), y, contourZ, maxX, getRightIntersectionY(), contourZ);
      addSegment(lineVertices, contourLineTransform, getBottomIntersectionX(), maxY, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 4;
      geometryStats.segmentCount += 2;
      break;
    case 11:
      addTriangle(fillVertices, x, y, fillZ, getTopIntersectionX(), y, fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, maxX, maxY, fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, getRightIntersectionY(), fillZ, x, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, getTopIntersectionX(), y, contourZ, maxX, getRightIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    case 12:
      addTriangle(fillVertices, x, y, fillZ, maxX, y, fillZ, maxX, getRightIntersectionY(), fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, getLeftIntersectionY(), fillZ, maxX, getRightIntersectionY(), fillZ);
      addSegment(lineVertices, contourLineTransform, maxX, getRightIntersectionY(), contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 13:
      addTriangle(fillVertices, x, y, fillZ, maxX, y, fillZ, maxX, getRightIntersectionY(), fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, maxY, fillZ, getBottomIntersectionX(), maxY, fillZ);
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, getBottomIntersectionX(), maxY, fillZ, x, y, fillZ);
      addSegment(lineVertices, contourLineTransform, maxX, getRightIntersectionY(), contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    case 14:
      addTriangle(fillVertices, x, getLeftIntersectionY(), fillZ, x, y, fillZ, maxX, y, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ, maxX, y, fillZ);
      addSegment(lineVertices, contourLineTransform, getBottomIntersectionX(), maxY, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    default:
      break;
  }
}

function createContourGeometryStats(): ContourGeometryStats {
  return {
    activeCellCount: 0,
    fillCellCount: 0,
    lineCellCount: 0,
    fullCellCount: 0,
    triangleCount: 0,
    segmentCount: 0,
  };
}

function createContourLayerStats(): ContourLayerStats {
  return {
    ...createContourGeometryStats(),
    geometryMs: 0,
    uploadMs: 0,
    fillUploadMs: 0,
    lineUploadMs: 0,
    drawMs: 0,
    fillDrawMs: 0,
    lineDrawMs: 0,
    fillVertexCount: 0,
    lineVertexCount: 0,
  };
}

function createWaterState(rows: number): WaterState {
  return {
    geometry: {
      pointVertices: null,
      rowSlices: Array.from({ length: rows }, () => null),
    },
    renderResources: {
      points: createContourLayerResourceSlot(),
    },
  };
}

function populateWaterGeometry(currentScene: SceneState) {
  const pointVertices: number[] = [];
  const rowSlices = currentScene.water.geometry.rowSlices;
  const waterZ = LAND_THRESHOLD * ELEVATION_MULTIPLIER + VERTICAL_BIAS;

  for (let row = getInitialWaterRow(currentScene.rows); row >= 0; row -= WATER_SAMPLE_STEP) {
    const startVertex = pointVertices.length / 3;

    for (let col = 0; col < currentScene.cols; col += WATER_SAMPLE_STEP) {
      if (getElevation(currentScene, col, row) >= LAND_THRESHOLD) {
        continue;
      }

      pointVertices.push(
        col * SPACING - currentScene.worldWidth / 2,
        row * SPACING - currentScene.worldHeight / 2,
        waterZ,
      );
    }

    const vertexCount = pointVertices.length / 3 - startVertex;
    rowSlices[row] = {
      startVertex,
      vertexCount,
    };
  }

  currentScene.water.geometry.pointVertices = new Float32Array(pointVertices);
}

function releaseWaterCpuGeometry(water: WaterState) {
  water.geometry.pointVertices = null;
}

function disposeWaterState(water: WaterState) {
  releaseWaterCpuGeometry(water);
  disposeContourLayerResourceSlot(water.renderResources.points);
}

function createContourLayerResourceSlot(): ContourLayerResourceSlot {
  return {
    handle: null,
    dispose: null,
  };
}

function createContourLayer(threshold: number): ContourLayer {
  return {
    threshold,
    readiness: 'pending',
    geometry: {
      fillVertices: null,
      lineVertices: null,
    },
    stats: createContourLayerStats(),
    renderResources: {
      fill: createContourLayerResourceSlot(),
      line: createContourLayerResourceSlot(),
    },
  };
}

function updateContourLayerStats(contourLayer: ContourLayer, stats: ContourLayerStats) {
  contourLayer.stats = stats;
}

function updateContourLayerGeometry(contourLayer: ContourLayer, fillVertices: ContourVertexData, lineVertices: ContourVertexData) {
  disposeContourLayerResourceSlot(contourLayer.renderResources.fill);
  disposeContourLayerResourceSlot(contourLayer.renderResources.line);
  releaseContourLayerCpuGeometry(contourLayer);
  contourLayer.geometry.fillVertices = fillVertices;
  contourLayer.geometry.lineVertices = lineVertices;
  contourLayer.readiness = 'geometry-ready';
}

function releaseContourLayerCpuGeometry(contourLayer: ContourLayer) {
  contourLayer.geometry.fillVertices = null;
  contourLayer.geometry.lineVertices = null;
}

function markContourLayerRenderReady(contourLayer: ContourLayer) {
  contourLayer.readiness = 'render-ready';
  releaseContourLayerCpuGeometry(contourLayer);
}

function disposeContourLayerResourceSlot(resourceSlot: ContourLayerResourceSlot) {
  resourceSlot.handle = null;
  const dispose = resourceSlot.dispose;
  resourceSlot.dispose = null;

  dispose?.();
}

function disposeContourLayer(contourLayer: ContourLayer) {
  releaseContourLayerCpuGeometry(contourLayer);
  disposeContourLayerResourceSlot(contourLayer.renderResources.fill);
  disposeContourLayerResourceSlot(contourLayer.renderResources.line);
  contourLayer.readiness = 'disposed';
}

function destroyContourRetainedBackend() {
  if (!contourRetainedBackend) {
    return;
  }

  const backend = contourRetainedBackend;
  contourRetainedBackend = null;
  backend.gl.deleteProgram(backend.program);
}

function destroyWaterRetainedBackend() {
  if (!waterRetainedBackend) {
    return;
  }

  const backend = waterRetainedBackend;
  waterRetainedBackend = null;
  backend.gl.deleteProgram(backend.program);
}

function disposeSceneState(currentScene: SceneState | null) {
  if (!currentScene) {
    return;
  }

  disposeWaterState(currentScene.water);

  for (const contourLayer of currentScene.contourLayers) {
    disposeContourLayer(contourLayer);
  }

  currentScene.elevations = new Float32Array(0);
  currentScene.water.geometry.rowSlices = [];
  currentScene.contourLayers = [];
  currentScene.waterRow = -1;
  currentScene.contourIndex = 0;
  currentScene.phase = 'complete';
  currentScene.profile = null;

  destroyContourRetainedBackend();
  destroyWaterRetainedBackend();
  exposeSceneProfile(null);
}

function createSceneProfile(seed: number): SceneProfile | null {
  if (!isProfilingEnabled()) {
    return null;
  }

  return {
    enabled: true,
    seed,
    worldSize: 0,
    cols: 0,
    rows: 0,
    totalCells: 0,
    thresholdCount: 0,
    sceneBuildMs: 0,
    elevationSampleMs: 0,
    waterDrawMs: 0,
    waterRowsDrawn: 0,
    waterPointsDrawn: 0,
    contourGeometryMs: 0,
    contourUploadMs: 0,
    contourDrawMs: 0,
    revealTotalMs: 0,
    contours: [],
    summaryLogged: false,
    startedAtMs: performance.now(),
  };
}

function exposeSceneProfile(profile: SceneProfile | null) {
  if (profile) {
    window.__CONTOUR_PROFILE__ = profile;
  } else {
    delete window.__CONTOUR_PROFILE__;
  }
}

function isProfilingEnabled() {
  const query = new URLSearchParams(window.location.search);

  return query.has(PROFILE_QUERY_PARAM)
    || window.__CONTOUR_PROFILE_DEBUG__ === true
    || window.localStorage.getItem(PROFILE_STORAGE_KEY) === '1';
}

function recordThresholdProfile(currentScene: SceneState, thresholdProfile: ThresholdProfile) {
  if (!currentScene.profile) {
    return;
  }

  currentScene.profile.contours.push(thresholdProfile);
  currentScene.profile.contourGeometryMs += thresholdProfile.geometryMs;
  currentScene.profile.contourUploadMs += thresholdProfile.uploadMs;
  currentScene.profile.contourDrawMs += thresholdProfile.drawMs;
}

function finalizeSceneProfile(currentScene: SceneState) {
  if (!currentScene.profile || currentScene.profile.summaryLogged) {
    return;
  }

  currentScene.profile.revealTotalMs = performance.now() - currentScene.profile.startedAtMs;
  currentScene.profile.summaryLogged = true;
  logSceneProfile(currentScene.profile);
}

function logSceneProfile(profile: SceneProfile) {
  const slowestGeometry = getTopThresholds(profile.contours, (entry) => entry.geometryMs);
  const slowestUpload = getTopThresholds(profile.contours, (entry) => entry.uploadMs);
  const slowestDraw = getTopThresholds(profile.contours, (entry) => entry.drawMs);
  const densestFill = getTopThresholds(profile.contours, (entry) => entry.fillVertexCount);
  const densestLine = getTopThresholds(profile.contours, (entry) => entry.lineVertexCount);

  console.groupCollapsed(
    `[contour-profile] seed=${profile.seed} size=${profile.worldSize} grid=${profile.cols}x${profile.rows} thresholds=${profile.thresholdCount}`,
  );
  console.log({
    largestSupportedWorldSize: TERRAIN_MAX_SIZE,
    worldSize: profile.worldSize,
    cols: profile.cols,
    rows: profile.rows,
    totalCells: profile.totalCells,
    thresholdCount: profile.thresholdCount,
    sceneBuildMs: roundProfileValue(profile.sceneBuildMs),
    elevationSampleMs: roundProfileValue(profile.elevationSampleMs),
    waterDrawMs: roundProfileValue(profile.waterDrawMs),
    waterRowsDrawn: profile.waterRowsDrawn,
    waterPointsDrawn: profile.waterPointsDrawn,
    contourGeometryMs: roundProfileValue(profile.contourGeometryMs),
    contourUploadMs: roundProfileValue(profile.contourUploadMs),
    contourDrawMs: roundProfileValue(profile.contourDrawMs),
    revealTotalMs: roundProfileValue(profile.revealTotalMs),
  });
  console.table(profile.contours.map((entry) => formatThresholdProfile(entry)));
  console.log('slowest geometry thresholds', slowestGeometry.map((entry) => formatThresholdProfile(entry)));
  console.log('slowest upload thresholds', slowestUpload.map((entry) => formatThresholdProfile(entry)));
  console.log('slowest draw thresholds', slowestDraw.map((entry) => formatThresholdProfile(entry)));
  console.log('largest fill thresholds', densestFill.map((entry) => formatThresholdProfile(entry)));
  console.log('largest line thresholds', densestLine.map((entry) => formatThresholdProfile(entry)));
  console.log('full profile object available at window.__CONTOUR_PROFILE__');
  console.groupEnd();
}

function getTopThresholds(entries: ThresholdProfile[], metric: (entry: ThresholdProfile) => number) {
  return [...entries]
    .sort((left, right) => metric(right) - metric(left))
    .slice(0, 5);
}

function formatThresholdProfile(entry: ThresholdProfile) {
  return {
    threshold: entry.threshold,
    geometryMs: roundProfileValue(entry.geometryMs),
    uploadMs: roundProfileValue(entry.uploadMs),
    fillUploadMs: roundProfileValue(entry.fillUploadMs),
    lineUploadMs: roundProfileValue(entry.lineUploadMs),
    drawMs: roundProfileValue(entry.drawMs),
    fillDrawMs: roundProfileValue(entry.fillDrawMs),
    lineDrawMs: roundProfileValue(entry.lineDrawMs),
    fillVertexCount: entry.fillVertexCount,
    lineVertexCount: entry.lineVertexCount,
    activeCellCount: entry.activeCellCount,
    fillCellCount: entry.fillCellCount,
    lineCellCount: entry.lineCellCount,
    fullCellCount: entry.fullCellCount,
    triangleCount: entry.triangleCount,
    segmentCount: entry.segmentCount,
  };
}

function roundProfileValue(value: number) {
  return Number(value.toFixed(3));
}

function getContourRetainedBackend() {
  if (contourRetainedBackend && isContourRetainedBackendValid(contourRetainedBackend)) {
    return contourRetainedBackend;
  }

  destroyContourRetainedBackend();

  if (!isWebGLContext(drawingContext)) {
    return null;
  }

  const gl = drawingContext;
  const program = createContourProgram(gl);
  if (!program) {
    return null;
  }

  const positionLocation = gl.getAttribLocation(program, 'aPosition');
  const projectionMatrixLocation = gl.getUniformLocation(program, 'uProjectionMatrix');
  const modelViewMatrixLocation = gl.getUniformLocation(program, 'uModelViewMatrix');
  const colorLocation = gl.getUniformLocation(program, 'uColor');

  if (
    positionLocation < 0
    || !projectionMatrixLocation
    || !modelViewMatrixLocation
    || !colorLocation
  ) {
    gl.deleteProgram(program);
    return null;
  }

  contourRetainedBackend = {
    gl,
    program,
    positionLocation,
    projectionMatrixLocation,
    modelViewMatrixLocation,
    colorLocation,
  };

  return contourRetainedBackend;
}

function getWaterRetainedBackend() {
  if (waterRetainedBackend && isWaterRetainedBackendValid(waterRetainedBackend)) {
    return waterRetainedBackend;
  }

  destroyWaterRetainedBackend();

  if (!isWebGLContext(drawingContext)) {
    return null;
  }

  const gl = drawingContext;
  const program = createWaterProgram(gl);
  if (!program) {
    return null;
  }

  const positionLocation = gl.getAttribLocation(program, 'aPosition');
  const projectionMatrixLocation = gl.getUniformLocation(program, 'uProjectionMatrix');
  const modelViewMatrixLocation = gl.getUniformLocation(program, 'uModelViewMatrix');
  const colorLocation = gl.getUniformLocation(program, 'uColor');
  const pointSizeLocation = gl.getUniformLocation(program, 'uPointSize');

  if (
    positionLocation < 0
    || !projectionMatrixLocation
    || !modelViewMatrixLocation
    || !colorLocation
    || !pointSizeLocation
  ) {
    gl.deleteProgram(program);
    return null;
  }

  waterRetainedBackend = {
    gl,
    program,
    positionLocation,
    projectionMatrixLocation,
    modelViewMatrixLocation,
    colorLocation,
    pointSizeLocation,
  };

  return waterRetainedBackend;
}

function isContourRetainedBackendValid(backend: ContourRetainedBackend) {
  if (!isWebGLContext(drawingContext) || backend.gl !== drawingContext) {
    return false;
  }

  return typeof backend.gl.isContextLost !== 'function' || !backend.gl.isContextLost();
}

function isWaterRetainedBackendValid(backend: WaterRetainedBackend) {
  if (!isWebGLContext(drawingContext) || backend.gl !== drawingContext) {
    return false;
  }

  return typeof backend.gl.isContextLost !== 'function' || !backend.gl.isContextLost();
}

function createContourProgram(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, RETAINED_CONTOUR_VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, RETAINED_CONTOUR_FRAGMENT_SHADER);

  if (!vertexShader || !fragmentShader) {
    if (vertexShader) {
      gl.deleteShader(vertexShader);
    }

    if (fragmentShader) {
      gl.deleteShader(fragmentShader);
    }

    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('Failed to link retained contour shader program', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  return program;
}

function createWaterProgram(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, RETAINED_WATER_VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, RETAINED_WATER_FRAGMENT_SHADER);

  if (!vertexShader || !fragmentShader) {
    if (vertexShader) {
      gl.deleteShader(vertexShader);
    }

    if (fragmentShader) {
      gl.deleteShader(fragmentShader);
    }

    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('Failed to link retained water shader program', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  return program;
}

function compileShader(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  shaderType: number,
  source: string,
) {
  const shader = gl.createShader(shaderType);
  if (!shader) {
    return null;
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Failed to compile retained contour shader', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function ensureContourLayerRenderResources(
  backend: ContourRetainedBackend,
  contourLayer: ContourLayer,
) {
  if (contourLayer.readiness !== 'geometry-ready') {
    return {
      uploadMs: 0,
      fillUploadMs: 0,
      lineUploadMs: 0,
    };
  }

  const fillUploadMs = uploadContourLayerResource(
    backend.gl,
    contourLayer.renderResources.fill,
    contourLayer.geometry.fillVertices,
    backend.gl.TRIANGLES,
  );
  const lineUploadMs = uploadContourLayerResource(
    backend.gl,
    contourLayer.renderResources.line,
    contourLayer.geometry.lineVertices,
    backend.gl.TRIANGLES,
  );

  const fillReady = Boolean(contourLayer.renderResources.fill.handle) || !hasContourVertices(contourLayer.geometry.fillVertices);
  const lineReady = Boolean(contourLayer.renderResources.line.handle) || !hasContourVertices(contourLayer.geometry.lineVertices);

  if (fillReady && lineReady) {
    markContourLayerRenderReady(contourLayer);
  }

  return {
    uploadMs: fillUploadMs + lineUploadMs,
    fillUploadMs,
    lineUploadMs,
  };
}

function ensureWaterRenderResources(
  backend: WaterRetainedBackend,
  water: WaterState,
) {
  const handle = water.renderResources.points.handle as ContourRenderBuffer | null;
  if (handle) {
    return true;
  }

  uploadContourLayerResource(
    backend.gl,
    water.renderResources.points,
    water.geometry.pointVertices,
    backend.gl.POINTS,
  );

  if (water.renderResources.points.handle) {
    releaseWaterCpuGeometry(water);
    return true;
  }

  return false;
}

function uploadContourLayerResource(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  resourceSlot: ContourLayerResourceSlot,
  vertices: ContourVertexData | null,
  drawMode: number,
) {
  disposeContourLayerResourceSlot(resourceSlot);

  if (!vertices || vertices.length === 0) {
    return 0;
  }

  const buffer = gl.createBuffer();
  if (!buffer) {
    return 0;
  }

  const data = vertices instanceof Float32Array ? vertices : new Float32Array(vertices);
  const uploadStart = performance.now();

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const handle: ContourRenderBuffer = {
    buffer,
    vertexCount: data.length / 3,
    drawMode,
  };

  resourceSlot.handle = handle;
  resourceSlot.dispose = () => {
    gl.deleteBuffer(buffer);
  };

  return performance.now() - uploadStart;
}

function drawContourFillRetained(backend: ContourRetainedBackend, contourLayer: ContourLayer) {
  const renderer = getP5Renderer();
  if (!renderer) {
    return drawContourFillImmediate(contourLayer);
  }

  const { gl } = backend;
  const fillHandle = contourLayer.renderResources.fill.handle as ContourRenderBuffer | null;
  const wasCullFaceEnabled = gl.isEnabled(gl.CULL_FACE);
  const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const wasPositionAttribEnabled = Boolean(gl.getVertexAttrib(backend.positionLocation, gl.VERTEX_ATTRIB_ARRAY_ENABLED));

  if (wasCullFaceEnabled) {
    gl.disable(gl.CULL_FACE);
  }

  gl.useProgram(backend.program);
  gl.uniformMatrix4fv(backend.projectionMatrixLocation, false, toFloat32Array(renderer.uPMatrix.mat4));
  gl.uniformMatrix4fv(backend.modelViewMatrixLocation, false, toFloat32Array(renderer.uMVMatrix.mat4));

  let fillDrawMs = 0;

  if (fillHandle) {
    const fillStart = performance.now();
    drawContourRenderBuffer(backend, fillHandle, FILL_COLOR_RGBA);
    fillDrawMs = performance.now() - fillStart;
  } else {
    fillDrawMs = drawContourFillImmediate(contourLayer);
  }

  if (previousArrayBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer);
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  if (!wasPositionAttribEnabled) {
    gl.disableVertexAttribArray(backend.positionLocation);
  }

  gl.useProgram(previousProgram);

  if (wasCullFaceEnabled) {
    gl.enable(gl.CULL_FACE);
  }

  return fillDrawMs;
}

function drawContourLineRetained(backend: ContourRetainedBackend, contourLayer: ContourLayer) {
  const renderer = getP5Renderer();
  if (!renderer) {
    return drawContourLineImmediate(contourLayer);
  }

  const { gl } = backend;
  const lineHandle = contourLayer.renderResources.line.handle as ContourRenderBuffer | null;
  const wasCullFaceEnabled = gl.isEnabled(gl.CULL_FACE);
  const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const wasPositionAttribEnabled = Boolean(gl.getVertexAttrib(backend.positionLocation, gl.VERTEX_ATTRIB_ARRAY_ENABLED));

  if (wasCullFaceEnabled) {
    gl.disable(gl.CULL_FACE);
  }

  gl.useProgram(backend.program);
  gl.uniformMatrix4fv(backend.projectionMatrixLocation, false, toFloat32Array(renderer.uPMatrix.mat4));
  gl.uniformMatrix4fv(backend.modelViewMatrixLocation, false, toFloat32Array(renderer.uMVMatrix.mat4));

  let lineDrawMs = 0;

  if (lineHandle) {
    const lineStart = performance.now();
    drawContourRenderBuffer(backend, lineHandle, OUTLINE_COLOR_RGBA);
    lineDrawMs = performance.now() - lineStart;
  } else {
    lineDrawMs = drawContourLineImmediate(contourLayer);
  }

  if (previousArrayBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer);
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  if (!wasPositionAttribEnabled) {
    gl.disableVertexAttribArray(backend.positionLocation);
  }

  gl.useProgram(previousProgram);

  if (wasCullFaceEnabled) {
    gl.enable(gl.CULL_FACE);
  }

  return lineDrawMs;
}

function drawContourRenderBuffer(
  backend: ContourRetainedBackend,
  handle: ContourRenderBuffer,
  color: [number, number, number, number],
) {
  const { gl } = backend;

  gl.bindBuffer(gl.ARRAY_BUFFER, handle.buffer);
  gl.enableVertexAttribArray(backend.positionLocation);
  gl.vertexAttribPointer(backend.positionLocation, 3, gl.FLOAT, false, 0, 0);
  gl.uniform4fv(backend.colorLocation, color);
  gl.drawArrays(handle.drawMode, 0, handle.vertexCount);
}

function drawWaterRetained(
  backend: WaterRetainedBackend,
  water: WaterState,
) {
  const renderer = getP5Renderer();
  const handle = water.renderResources.points.handle as ContourRenderBuffer | null;

  if (!renderer || !handle) {
    return 0;
  }

  const { gl } = backend;
  const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const wasPositionAttribEnabled = Boolean(gl.getVertexAttrib(backend.positionLocation, gl.VERTEX_ATTRIB_ARRAY_ENABLED));
  const pointSize = Math.max(1, WATER_POINT_SIZE * pixelDensity());

  gl.useProgram(backend.program);
  gl.uniformMatrix4fv(backend.projectionMatrixLocation, false, toFloat32Array(renderer.uPMatrix.mat4));
  gl.uniformMatrix4fv(backend.modelViewMatrixLocation, false, toFloat32Array(renderer.uMVMatrix.mat4));
  gl.uniform4fv(backend.colorLocation, WATER_COLOR_RGBA);
  gl.uniform1f(backend.pointSizeLocation, pointSize);
  gl.bindBuffer(gl.ARRAY_BUFFER, handle.buffer);
  gl.enableVertexAttribArray(backend.positionLocation);
  gl.vertexAttribPointer(backend.positionLocation, 3, gl.FLOAT, false, 0, 0);
  gl.drawArrays(handle.drawMode, 0, handle.vertexCount);

  if (previousArrayBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer);
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  if (!wasPositionAttribEnabled) {
    gl.disableVertexAttribArray(backend.positionLocation);
  }

  gl.useProgram(previousProgram);

  return handle.vertexCount;
}

function drawContourLayerImmediate(contourLayer: ContourLayer) {
  const fillDrawMs = drawContourFillImmediate(contourLayer);
  const lineDrawMs = drawContourLineImmediate(contourLayer);

  return {
    fillDrawMs,
    lineDrawMs,
  };
}

function drawContourFillImmediate(contourLayer: ContourLayer) {
  if (!contourLayer.geometry.fillVertices || contourLayer.geometry.fillVertices.length === 0) {
    return 0;
  }

  noStroke();
  fill(BACKGROUND_COLOR);
  const fillStart = performance.now();
  beginShape(TRIANGLES);
  emitVertices(contourLayer.geometry.fillVertices);
  endShape();

  return performance.now() - fillStart;
}

function drawContourLineImmediate(contourLayer: ContourLayer) {
  if (!contourLayer.geometry.lineVertices || contourLayer.geometry.lineVertices.length === 0) {
    return 0;
  }

  noStroke();
  fill(OUTLINE_COLOR);
  const lineStart = performance.now();
  beginShape(TRIANGLES);
  emitVertices(contourLayer.geometry.lineVertices);
  endShape();

  return performance.now() - lineStart;
}

function getContourLayerVertexCount(
  resourceSlot: ContourLayerResourceSlot,
  vertices: ContourVertexData | null,
  fallbackCount: number,
) {
  if (vertices) {
    return vertices.length / 3;
  }

  const handle = resourceSlot.handle as ContourRenderBuffer | null;
  if (handle) {
    return handle.vertexCount;
  }

  return fallbackCount;
}

function getP5Renderer() {
  const renderer = (window.__CONTOUR_P5__ as p5 | undefined as (p5 & { _renderer?: P5RendererLike }) | undefined)?._renderer;

  return renderer ?? null;
}

function toFloat32Array(values: ArrayLike<number>) {
  return values instanceof Float32Array ? values : new Float32Array(values);
}

function isWebGLContext(
  context: RenderingContext | null,
): context is WebGLRenderingContext | WebGL2RenderingContext {
  return context instanceof WebGLRenderingContext || context instanceof WebGL2RenderingContext;
}

function hexToNormalizedRgba(hex: string): [number, number, number, number] {
  const normalizedHex = hex.startsWith('#') ? hex.slice(1) : hex;
  const red = Number.parseInt(normalizedHex.slice(0, 2), 16) / 255;
  const green = Number.parseInt(normalizedHex.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(normalizedHex.slice(4, 6), 16) / 255;

  return [red, green, blue, 1];
}

function emitVertices(vertices: ContourVertexData | null) {
  if (!vertices) {
    return;
  }

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
  contourLineTransform: ContourLineTransform,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
) {
  const dx = bx - ax;
  const dy = by - ay;
  const screenDx = dx * contourLineTransform.screenBasisXX + dy * contourLineTransform.screenBasisYX;
  const screenDy = dx * contourLineTransform.screenBasisXY + dy * contourLineTransform.screenBasisYY;
  const screenLength = Math.hypot(screenDx, screenDy);

  if (screenLength < Number.EPSILON) {
    return;
  }

  const halfWidth = CONTOUR_LINE_WEIGHT * 0.5;
  const directionScreenX = screenDx / screenLength;
  const directionScreenY = screenDy / screenLength;
  const normalScreenX = -directionScreenY;
  const normalScreenY = directionScreenX;

  const offsetX = screenToTerrainDeltaX(contourLineTransform, normalScreenX * halfWidth, normalScreenY * halfWidth);
  const offsetY = screenToTerrainDeltaY(contourLineTransform, normalScreenX * halfWidth, normalScreenY * halfWidth);
  const extensionX = screenToTerrainDeltaX(contourLineTransform, directionScreenX * halfWidth, directionScreenY * halfWidth);
  const extensionY = screenToTerrainDeltaY(contourLineTransform, directionScreenX * halfWidth, directionScreenY * halfWidth);

  const startX = ax - extensionX;
  const startY = ay - extensionY;
  const endX = bx + extensionX;
  const endY = by + extensionY;

  addTriangle(
    vertices,
    startX + offsetX,
    startY + offsetY,
    az,
    startX - offsetX,
    startY - offsetY,
    az,
    endX + offsetX,
    endY + offsetY,
    bz,
  );
  addTriangle(
    vertices,
    startX - offsetX,
    startY - offsetY,
    az,
    endX - offsetX,
    endY - offsetY,
    bz,
    endX + offsetX,
    endY + offsetY,
    bz,
  );
}

function hasContourVertices(vertices: ContourVertexData | null) {
  return Boolean(vertices && vertices.length > 0);
}

function createContourLineTransform() {
  const renderer = getP5Renderer();

  if (!renderer) {
    return createFallbackContourLineTransform();
  }

  const projectionMatrix = toFloat32Array(renderer.uPMatrix.mat4);
  const modelViewMatrix = toFloat32Array(renderer.uMVMatrix.mat4);
  const clipMatrix = multiplyMat4(projectionMatrix, modelViewMatrix);
  const origin = projectToScreen(clipMatrix, 0, 0, 0);
  const unitX = projectToScreen(clipMatrix, 1, 0, 0);
  const unitY = projectToScreen(clipMatrix, 0, 1, 0);

  return createContourLineTransformFromBasis(
    unitX.x - origin.x,
    unitX.y - origin.y,
    unitY.x - origin.x,
    unitY.y - origin.y,
  );
}

function createFallbackContourLineTransform() {
  const screenBasisXX = CAMERA_ROTATION_Z_COS;
  const screenBasisXY = CAMERA_ROTATION_Z_SIN;
  const screenBasisYX = -CAMERA_ROTATION_Z_SIN * CAMERA_ROTATION_X_COS;
  const screenBasisYY = CAMERA_ROTATION_Z_COS * CAMERA_ROTATION_X_COS;

  return createContourLineTransformFromBasis(screenBasisXX, screenBasisXY, screenBasisYX, screenBasisYY);
}

function createContourLineTransformFromBasis(
  screenBasisXX: number,
  screenBasisXY: number,
  screenBasisYX: number,
  screenBasisYY: number,
): ContourLineTransform {
  const determinant = screenBasisXX * screenBasisYY - screenBasisYX * screenBasisXY;

  if (Math.abs(determinant) < Number.EPSILON) {
    return {
      screenBasisXX,
      screenBasisXY,
      screenBasisYX,
      screenBasisYY,
      terrainBasisXX: 1,
      terrainBasisXY: 0,
      terrainBasisYX: 0,
      terrainBasisYY: 1,
    };
  }

  const inverseDeterminant = 1 / determinant;

  return {
    screenBasisXX,
    screenBasisXY,
    screenBasisYX,
    screenBasisYY,
    terrainBasisXX: screenBasisYY * inverseDeterminant,
    terrainBasisXY: -screenBasisYX * inverseDeterminant,
    terrainBasisYX: -screenBasisXY * inverseDeterminant,
    terrainBasisYY: screenBasisXX * inverseDeterminant,
  };
}

function multiplyMat4(left: ArrayLike<number>, right: ArrayLike<number>) {
  const result = new Float32Array(16);

  for (let column = 0; column < 4; column += 1) {
    const rightColumnOffset = column * 4;
    for (let row = 0; row < 4; row += 1) {
      result[rightColumnOffset + row] =
        left[row] * right[rightColumnOffset]
        + left[row + 4] * right[rightColumnOffset + 1]
        + left[row + 8] * right[rightColumnOffset + 2]
        + left[row + 12] * right[rightColumnOffset + 3];
    }
  }

  return result;
}

function projectToScreen(matrix: ArrayLike<number>, x: number, y: number, z: number) {
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const reciprocalW = Math.abs(clipW) < Number.EPSILON ? 1 : 1 / clipW;
  const ndcX = clipX * reciprocalW;
  const ndcY = clipY * reciprocalW;

  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (0.5 - ndcY * 0.5) * height,
  };
}

function screenToTerrainDeltaX(contourLineTransform: ContourLineTransform, screenDx: number, screenDy: number) {
  return screenDx * contourLineTransform.terrainBasisXX + screenDy * contourLineTransform.terrainBasisXY;
}

function screenToTerrainDeltaY(contourLineTransform: ContourLineTransform, screenDx: number, screenDy: number) {
  return screenDx * contourLineTransform.terrainBasisYX + screenDy * contourLineTransform.terrainBasisYY;
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

function getInitialWaterRow(rows: number) {
  return rows - 1 - ((rows - 1) % WATER_SAMPLE_STEP);
}

function getSampledWaterRowCount(rows: number) {
  const initialWaterRow = getInitialWaterRow(rows);

  return initialWaterRow < 0 ? 0 : Math.floor(initialWaterRow / WATER_SAMPLE_STEP) + 1;
}

function getElevationIndex(col: number, row: number, cols: number) {
  return row * cols + col;
}

function getTerrainScreenOffset(worldWidth: number, worldHeight: number): TerrainScreenOffset {
  const halfWorldWidth = worldWidth * 0.5;
  const halfWorldHeight = worldHeight * 0.5;
  const waterPlaneZ = LAND_THRESHOLD * ELEVATION_MULTIPLIER + VERTICAL_BIAS;
  const corners = [
    [-halfWorldWidth, -halfWorldHeight, waterPlaneZ],
    [halfWorldWidth, -halfWorldHeight, waterPlaneZ],
    [-halfWorldWidth, halfWorldHeight, waterPlaneZ],
    [halfWorldWidth, halfWorldHeight, waterPlaneZ],
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [x, y, z] of corners) {
    const projected = rotateTerrainPoint(x, y, z);

    minX = Math.min(minX, projected.x);
    maxX = Math.max(maxX, projected.x);
    minY = Math.min(minY, projected.y);
    maxY = Math.max(maxY, projected.y);
  }

  return {
    x: (minX + maxX) * 0.5,
    y: (minY + maxY) * 0.5,
  };
}

function rotateTerrainPoint(x: number, y: number, z: number) {
  const rotatedX = x * CAMERA_ROTATION_Z_COS - y * CAMERA_ROTATION_Z_SIN;
  const rotatedYBeforeTilt = x * CAMERA_ROTATION_Z_SIN + y * CAMERA_ROTATION_Z_COS;

  return {
    x: rotatedX,
    y: rotatedYBeforeTilt * CAMERA_ROTATION_X_COS - z * CAMERA_ROTATION_X_SIN,
  };
}

function applyProjection(currentScene: SceneState) {
  const depth = Math.max(currentScene.worldWidth, currentScene.worldHeight) * 2;
  ortho(-width / 2, width / 2, -height / 2, height / 2, -depth, depth);
}

function applyTerrainTransform(currentScene: SceneState) {
  translate(-currentScene.terrainScreenOffset.x, -currentScene.terrainScreenOffset.y, 0);
  rotateX(CAMERA_ROTATION_X);
  rotateZ(CAMERA_ROTATION_Z);
}

initP5({ setup, draw, windowResized, keyPressed });
