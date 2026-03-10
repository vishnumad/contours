import './style.css';
import { initP5 } from './p5/init';
import { createSketchController } from './sketch/config/controller';
import type { SketchControllerEvent } from './sketch/config/controller';
import { defaultSketchConfig } from './sketch/config/defaults';
import type { SketchCameraConfig, SketchConfig } from './sketch/config/types';
import { createSketchRenderContext } from './sketch/runtime/renderContext';
import type {
  ContourGeometryStats,
  ContourLayer,
  ContourLayerResourceSlot,
  ContourLayerStats,
  ContourLineTransform,
  ContourRenderBuffer,
  ContourRetainedBackend,
  ContourVertexData,
  P5RendererLike,
  SceneProfile,
  SceneState,
  TerrainScreenOffset,
  ThresholdProfile,
  WaterRetainedBackend,
  WaterState,
} from './sketch/scene/types';
import { hexToNormalizedRgba } from './sketch/shared/color';
import { addSegment, addTriangle, emitVertices, hasContourVertices } from './sketch/shared/geometry';
import {
  binaryToDecimal,
  createContourLineTransformFromBasis,
  getElevationIndex,
  getInterpolationPercent,
  multiplyMat4,
  projectToScreen,
  toFloat32Array,
} from './sketch/shared/math';
import { getDerivedCamera, getTerrainScreenOffset } from './sketch/terrain/projection';

const sketchController = createSketchController(defaultSketchConfig);
const renderContext = createSketchRenderContext();

let scene: SceneState | null = null;
let contourRetainedBackend: ContourRetainedBackend | null = null;
let waterRetainedBackend: WaterRetainedBackend | null = null;
let unsubscribeController: (() => void) | null = null;

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

function setup() {
  const root = document.querySelector<HTMLDivElement>('#app');
  const canvas = createCanvas(windowWidth, windowHeight, WEBGL);

  canvas.parent(root!);
  pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
  smooth();
  strokeCap(ROUND);
  strokeJoin(ROUND);

  unsubscribeController?.();
  unsubscribeController = sketchController.subscribe(handleControllerEvent);
  sketchController.reset({ reseed: true });
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
  sketchController.reset({ reseed: false });
}

function keyPressed() {
  if (key === 'r' || key === 'R') {
    sketchController.reset({ reseed: true });
  }
}

function handleControllerEvent(event: SketchControllerEvent) {
  if (event.type === 'config') {
    if (event.invalidation.scope === 'none') {
      return;
    }

    resetScene(false, scene?.seed ?? Date.now());
    return;
  }

  const seed = event.options.reseed ? event.options.seed : scene?.seed ?? event.options.seed;
  resetScene(event.options.reseed, seed);
}

function resetScene(reseed: boolean, explicitSeed?: number) {
  const config = sketchController.getConfig();
  const seed = explicitSeed ?? (reseed || !scene ? Date.now() : scene.seed);
  const previousScene = scene;

  scene = null;
  disposeSceneState(previousScene);

  try {
    const nextScene = buildSceneState(seed, config);

    scene = nextScene;
    applyProjection(nextScene);
    clear();
    background(config.colors.background);
    loop();
  } catch (error) {
    destroyContourRetainedBackend();
    exposeSceneProfile(null);
    clear();
    background(config.colors.background);
    noLoop();
    throw error;
  }
}

function buildSceneState(seed: number, config: SketchConfig): SceneState {
  const profile = createSceneProfile(seed, config);
  const sceneBuildStart = performance.now();

  noiseSeed(seed);

  const worldSize = getWorldSize(config);
  const cols = Math.floor(worldSize / config.terrain.spacing) + 1;
  const rows = Math.floor(worldSize / config.terrain.spacing) + 1;
  const elevations = new Float32Array(cols * rows);
  let maxElevation = 0;
  const elevationStart = performance.now();

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const elevation = sampleLayeredElevation(col, row, config);
      elevations[getElevationIndex(col, row, cols)] = elevation;
      maxElevation = Math.max(maxElevation, elevation);
    }
  }

  if (profile) {
    profile.elevationSampleMs = performance.now() - elevationStart;
  }

  const contourThresholds: number[] = [];
  for (
    let threshold = config.contours.landThreshold;
    threshold <= maxElevation + config.contours.isolineIncrement * 0.5;
    threshold += config.contours.isolineIncrement
  ) {
    contourThresholds.push(Number(threshold.toFixed(6)));
  }

  const contourLayers = contourThresholds.map((threshold) => createContourLayer(threshold));
  const water = createWaterState(rows);

  const nextScene: SceneState = {
    config,
    seed,
    cols,
    rows,
    worldWidth: (cols - 1) * config.terrain.spacing,
    worldHeight: (rows - 1) * config.terrain.spacing,
    elevations,
    maxElevation,
    terrainScreenOffset: getTerrainScreenOffset(
      (cols - 1) * config.terrain.spacing,
      (rows - 1) * config.terrain.spacing,
      config,
    ),
    water,
    contourLayers,
    waterRow: getInitialWaterRow(rows, config),
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

function getWorldSize(config: SketchConfig) {
  const viewportBase = Math.min(windowWidth, windowHeight);
  const scaled = viewportBase * config.terrain.viewportScale;
  const clamped = Math.min(Math.max(scaled, config.terrain.minSize), config.terrain.maxSize);
  const snapped = Math.floor(clamped / config.terrain.spacing) * config.terrain.spacing;

  return Math.max(snapped, config.terrain.minSize + config.terrain.padding);
}

function sampleLayeredElevation(x: number, y: number, config: SketchConfig) {
  const [octave1Weight, octave2Weight, octave3Weight, octave4Weight] = config.terrain.noiseOctaves;
  const octave1 = sampleNoise(x, y, config);
  const octave2 = sampleNoise(x * 2, y * 2, config);
  const octave3 = sampleNoise(x * 4, y * 4, config);
  const octave4 = sampleNoise(x * 8, y * 8, config);
  const octaveSum = octave1Weight + octave2Weight + octave3Weight + octave4Weight;

  return (octave1Weight * octave1 + octave2Weight * octave2 + octave3Weight * octave3 + octave4Weight * octave4) / octaveSum;
}

function sampleNoise(x: number, y: number, config: SketchConfig) {
  return noise(
    x * config.terrain.noiseScale + config.terrain.noiseOffset,
    y * config.terrain.noiseScale + config.terrain.noiseOffset,
  );
}

function drawWaterRows(currentScene: SceneState) {
  const waterStart = performance.now();
  const retainedBackend = getWaterRetainedBackend();
  let waterPoints = 0;

  push();
  applyProjection(currentScene);
  applyTerrainTransform(currentScene);

  if (retainedBackend && ensureWaterRenderResources(retainedBackend, currentScene.water)) {
    waterPoints = drawWaterRetained(retainedBackend, currentScene);
  } else {
    waterPoints = drawWaterImmediate(currentScene);
  }

  pop();

  currentScene.waterRow = -1;

  if (currentScene.profile) {
    currentScene.profile.waterRowsDrawn += getSampledWaterRowCount(currentScene.rows, currentScene.config);
    currentScene.profile.waterPointsDrawn += waterPoints;
    currentScene.profile.waterDrawMs += performance.now() - waterStart;
  }
}

function drawWaterImmediate(currentScene: SceneState) {
  const { config } = currentScene;
  const waterZ = config.contours.landThreshold * config.terrain.elevationMultiplier + config.terrain.verticalBias;
  let waterPoints = 0;

  stroke(config.colors.water);
  strokeWeight(config.water.pointSize);

  for (let row = getInitialWaterRow(currentScene.rows, config); row >= 0; row -= config.water.sampleStep) {
    for (let col = 0; col < currentScene.cols; col += config.water.sampleStep) {
      if (getElevation(currentScene, col, row) < config.contours.landThreshold) {
        waterPoints += 1;
        point(
          col * config.terrain.spacing - currentScene.worldWidth / 2,
          row * config.terrain.spacing - currentScene.worldHeight / 2,
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
    const contourLineTransform = createContourLineTransform(currentScene.config.camera);
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
      fillDrawMs = drawContourFillRetained(retainedBackend, currentScene, contourLayer);
      lineDrawMs = drawContourLineRetained(retainedBackend, currentScene, contourLayer);
    } else {
      const drawMetrics = drawContourLayerImmediate(currentScene, contourLayer);
      fillDrawMs = drawMetrics.fillDrawMs;
      lineDrawMs = drawMetrics.lineDrawMs;
    }
  } else {
    const drawMetrics = drawContourLayerImmediate(currentScene, contourLayer);
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
    if (Math.abs(threshold - nw) < currentScene.config.contours.fullCellFillEpsilon) {
      const fillZ = threshold * currentScene.config.terrain.elevationMultiplier + currentScene.config.terrain.verticalBias - 1.5;
      const x = col * currentScene.config.terrain.spacing - currentScene.worldWidth / 2;
      const y = row * currentScene.config.terrain.spacing - currentScene.worldHeight / 2;
      const maxX = x + currentScene.config.terrain.spacing;
      const maxY = y + currentScene.config.terrain.spacing;

      addTriangle(fillVertices, x, y, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, maxY, fillZ, maxX, maxY, fillZ);
      geometryStats.fillCellCount += 1;
      geometryStats.triangleCount += 2;
    }
    return;
  }

  const fillZ = threshold * currentScene.config.terrain.elevationMultiplier + currentScene.config.terrain.verticalBias - 1.5;
  const x = col * currentScene.config.terrain.spacing - currentScene.worldWidth / 2;
  const y = row * currentScene.config.terrain.spacing - currentScene.worldHeight / 2;
  const maxX = x + currentScene.config.terrain.spacing;
  const maxY = y + currentScene.config.terrain.spacing;
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
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getBottomIntersectionX(), maxY, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 2:
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, getBottomIntersectionX(), maxY, fillZ, maxX, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, maxX, getRightIntersectionY(), contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 3:
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, x, getLeftIntersectionY(), fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, x, maxY, fillZ, maxX, maxY, fillZ, maxX, getRightIntersectionY(), fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, maxX, getRightIntersectionY(), contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 4:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, getRightIntersectionY(), fillZ, maxX, y, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, maxX, getRightIntersectionY(), contourZ);
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
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, x, getLeftIntersectionY(), contourZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, maxX, getRightIntersectionY(), contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 4;
      geometryStats.segmentCount += 2;
      break;
    case 6:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, getBottomIntersectionX(), maxY, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 7:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, x, getLeftIntersectionY(), fillZ, x, maxY, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, x, getLeftIntersectionY(), fillZ, maxX, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    case 8:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, x, getLeftIntersectionY(), fillZ, x, y, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 9:
      addTriangle(fillVertices, x, y, fillZ, getTopIntersectionX(), y, fillZ, getBottomIntersectionX(), maxY, fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, maxY, fillZ, getBottomIntersectionX(), maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, getBottomIntersectionX(), maxY, contourZ);
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
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, maxX, getRightIntersectionY(), contourZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getBottomIntersectionX(), maxY, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 4;
      geometryStats.segmentCount += 2;
      break;
    case 11:
      addTriangle(fillVertices, x, y, fillZ, getTopIntersectionX(), y, fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, maxX, maxY, fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, getRightIntersectionY(), fillZ, x, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, maxX, getRightIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    case 12:
      addTriangle(fillVertices, x, y, fillZ, maxX, y, fillZ, maxX, getRightIntersectionY(), fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, getLeftIntersectionY(), fillZ, maxX, getRightIntersectionY(), fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, maxX, getRightIntersectionY(), contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 13:
      addTriangle(fillVertices, x, y, fillZ, maxX, y, fillZ, maxX, getRightIntersectionY(), fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, maxY, fillZ, getBottomIntersectionX(), maxY, fillZ);
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, getBottomIntersectionX(), maxY, fillZ, x, y, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, maxX, getRightIntersectionY(), contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    case 14:
      addTriangle(fillVertices, x, getLeftIntersectionY(), fillZ, x, y, fillZ, maxX, y, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ, maxX, y, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getBottomIntersectionX(), maxY, contourZ, x, getLeftIntersectionY(), contourZ);
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
  const { config } = currentScene;
  const pointVertices: number[] = [];
  const rowSlices = currentScene.water.geometry.rowSlices;
  const waterZ = config.contours.landThreshold * config.terrain.elevationMultiplier + config.terrain.verticalBias;

  for (let row = getInitialWaterRow(currentScene.rows, config); row >= 0; row -= config.water.sampleStep) {
    const startVertex = pointVertices.length / 3;

    for (let col = 0; col < currentScene.cols; col += config.water.sampleStep) {
      if (getElevation(currentScene, col, row) >= config.contours.landThreshold) {
        continue;
      }

      pointVertices.push(
        col * config.terrain.spacing - currentScene.worldWidth / 2,
        row * config.terrain.spacing - currentScene.worldHeight / 2,
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

function createSceneProfile(seed: number, config: SketchConfig): SceneProfile | null {
  if (!isProfilingEnabled(config)) {
    return null;
  }

  return {
    enabled: true,
    seed,
    maxWorldSize: config.terrain.maxSize,
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

function isProfilingEnabled(config: SketchConfig) {
  const query = new URLSearchParams(window.location.search);

  return query.has(config.profile.queryParam)
    || window.__CONTOUR_PROFILE_DEBUG__ === true
    || window.localStorage.getItem(config.profile.storageKey) === '1';
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
    largestSupportedWorldSize: profile.maxWorldSize,
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

  const drawingContext = renderContext.getDrawingContext();
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

  const drawingContext = renderContext.getDrawingContext();
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
  const drawingContext = renderContext.getDrawingContext();
  if (!isWebGLContext(drawingContext) || backend.gl !== drawingContext) {
    return false;
  }

  return typeof backend.gl.isContextLost !== 'function' || !backend.gl.isContextLost();
}

function isWaterRetainedBackendValid(backend: WaterRetainedBackend) {
  const drawingContext = renderContext.getDrawingContext();
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

function drawContourFillRetained(backend: ContourRetainedBackend, currentScene: SceneState, contourLayer: ContourLayer) {
  const renderer = renderContext.getRenderer();
  if (!renderer) {
    return drawContourFillImmediate(currentScene, contourLayer);
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
    drawContourRenderBuffer(backend, fillHandle, hexToNormalizedRgba(currentScene.config.colors.background));
    fillDrawMs = performance.now() - fillStart;
  } else {
    fillDrawMs = drawContourFillImmediate(currentScene, contourLayer);
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

function drawContourLineRetained(backend: ContourRetainedBackend, currentScene: SceneState, contourLayer: ContourLayer) {
  const renderer = renderContext.getRenderer();
  if (!renderer) {
    return drawContourLineImmediate(currentScene, contourLayer);
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
    drawContourRenderBuffer(backend, lineHandle, hexToNormalizedRgba(currentScene.config.colors.outline));
    lineDrawMs = performance.now() - lineStart;
  } else {
    lineDrawMs = drawContourLineImmediate(currentScene, contourLayer);
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
  currentScene: SceneState,
) {
  const renderer = renderContext.getRenderer();
  const handle = currentScene.water.renderResources.points.handle as ContourRenderBuffer | null;

  if (!renderer || !handle) {
    return 0;
  }

  const { gl } = backend;
  const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const wasPositionAttribEnabled = Boolean(gl.getVertexAttrib(backend.positionLocation, gl.VERTEX_ATTRIB_ARRAY_ENABLED));
  const pointSize = Math.max(1, currentScene.config.water.pointSize * renderContext.getPixelDensity());

  gl.useProgram(backend.program);
  gl.uniformMatrix4fv(backend.projectionMatrixLocation, false, toFloat32Array(renderer.uPMatrix.mat4));
  gl.uniformMatrix4fv(backend.modelViewMatrixLocation, false, toFloat32Array(renderer.uMVMatrix.mat4));
  gl.uniform4fv(backend.colorLocation, hexToNormalizedRgba(currentScene.config.colors.water));
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

function drawContourLayerImmediate(currentScene: SceneState, contourLayer: ContourLayer) {
  const fillDrawMs = drawContourFillImmediate(currentScene, contourLayer);
  const lineDrawMs = drawContourLineImmediate(currentScene, contourLayer);

  return {
    fillDrawMs,
    lineDrawMs,
  };
}

function drawContourFillImmediate(currentScene: SceneState, contourLayer: ContourLayer) {
  if (!contourLayer.geometry.fillVertices || contourLayer.geometry.fillVertices.length === 0) {
    return 0;
  }

  noStroke();
  fill(currentScene.config.colors.background);
  const fillStart = performance.now();
  beginShape(TRIANGLES);
  emitVertices(contourLayer.geometry.fillVertices, vertex);
  endShape();

  return performance.now() - fillStart;
}

function drawContourLineImmediate(currentScene: SceneState, contourLayer: ContourLayer) {
  if (!contourLayer.geometry.lineVertices || contourLayer.geometry.lineVertices.length === 0) {
    return 0;
  }

  noStroke();
  fill(currentScene.config.colors.outline);
  const lineStart = performance.now();
  beginShape(TRIANGLES);
  emitVertices(contourLayer.geometry.lineVertices, vertex);
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

function isWebGLContext(
  context: RenderingContext | null,
): context is WebGLRenderingContext | WebGL2RenderingContext {
  return context instanceof WebGLRenderingContext || context instanceof WebGL2RenderingContext;
}

function createContourLineTransform(camera: SketchCameraConfig) {
  const renderer = renderContext.getRenderer();

  if (!renderer) {
    return createFallbackContourLineTransform(camera);
  }

  const projectionMatrix = toFloat32Array(renderer.uPMatrix.mat4);
  const modelViewMatrix = toFloat32Array(renderer.uMVMatrix.mat4);
  const clipMatrix = multiplyMat4(projectionMatrix, modelViewMatrix);
  const viewportSize = renderContext.getSize();
  const origin = projectToScreen(clipMatrix, 0, 0, 0, viewportSize);
  const unitX = projectToScreen(clipMatrix, 1, 0, 0, viewportSize);
  const unitY = projectToScreen(clipMatrix, 0, 1, 0, viewportSize);

  return createContourLineTransformFromBasis(
    unitX.x - origin.x,
    unitX.y - origin.y,
    unitY.x - origin.x,
    unitY.y - origin.y,
  );
}

function createFallbackContourLineTransform(camera: SketchCameraConfig) {
  const derivedCamera = getDerivedCamera(camera);
  const screenBasisXX = derivedCamera.rotationZCos;
  const screenBasisXY = derivedCamera.rotationZSin;
  const screenBasisYX = -derivedCamera.rotationZSin * derivedCamera.rotationXCos;
  const screenBasisYY = derivedCamera.rotationZCos * derivedCamera.rotationXCos;

  return createContourLineTransformFromBasis(screenBasisXX, screenBasisXY, screenBasisYX, screenBasisYY);
}

function getElevation(currentScene: SceneState, col: number, row: number) {
  return currentScene.elevations[getElevationIndex(col, row, currentScene.cols)];
}

function getInitialWaterRow(rows: number, config: SketchConfig) {
  return rows - 1 - ((rows - 1) % config.water.sampleStep);
}

function getSampledWaterRowCount(rows: number, config: SketchConfig) {
  const initialWaterRow = getInitialWaterRow(rows, config);

  return initialWaterRow < 0 ? 0 : Math.floor(initialWaterRow / config.water.sampleStep) + 1;
}

function applyProjection(currentScene: SceneState) {
  const viewportSize = renderContext.getSize();
  const depth = Math.max(currentScene.worldWidth, currentScene.worldHeight) * 2;
  ortho(-viewportSize.width / 2, viewportSize.width / 2, -viewportSize.height / 2, viewportSize.height / 2, -depth, depth);
}

function applyTerrainTransform(currentScene: SceneState) {
  translate(-currentScene.terrainScreenOffset.x, -currentScene.terrainScreenOffset.y, 0);
  rotateX(currentScene.config.camera.rotationX);
  rotateZ(currentScene.config.camera.rotationZ);
}

initP5({ setup, draw, windowResized, keyPressed });
