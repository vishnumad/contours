import './style.css';
import { initP5 } from './p5/init';
import {
  createContourGeometryStats,
  createContourLayer,
  disposeContourLayer,
  updateContourLayerGeometry,
  updateContourLayerStats,
} from './sketch/contours/layer';
import { createContourLineTransform } from './sketch/contours/lineTransform';
import { collectCellGeometry } from './sketch/contours/marchingSquares';
import { createContourRenderer } from './sketch/contours/renderRetained';
import { createSketchController } from './sketch/config/controller';
import type { SketchControllerEvent } from './sketch/config/controller';
import { defaultSketchConfig } from './sketch/config/defaults';
import type { SketchConfig } from './sketch/config/types';
import { createSketchRenderContext } from './sketch/runtime/renderContext';
import { buildSceneState } from './sketch/scene/buildSceneState';
import type {
  ContourLayer,
  ContourLayerStats,
  SceneProfile,
  SceneState,
  ThresholdProfile,
} from './sketch/scene/types';
import { getSampledWaterRowCount } from './sketch/terrain/elevation';
import { disposeWaterState } from './sketch/water/geometry';
import { createWaterRenderer } from './sketch/water/renderRetained';

const sketchController = createSketchController(defaultSketchConfig);
const renderContext = createSketchRenderContext();
const contourRenderer = createContourRenderer(renderContext);
const waterRenderer = createWaterRenderer(renderContext);

let scene: SceneState | null = null;
let unsubscribeController: (() => void) | null = null;

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
    const nextScene = buildSceneState({
      seed,
      config,
      viewportSize: renderContext.getSize(),
      noiseSeed,
      noise,
      createSceneProfile,
      exposeSceneProfile,
      createContourLayer,
    });

    scene = nextScene;
    applyProjection(nextScene);
    clear();
    background(config.colors.background);
    loop();
  } catch (error) {
    contourRenderer.dispose();
    waterRenderer.dispose();
    exposeSceneProfile(null);
    clear();
    background(config.colors.background);
    noLoop();
    throw error;
  }
}

function drawWaterRows(currentScene: SceneState) {
  const waterStart = performance.now();

  push();
  applyProjection(currentScene);
  applyTerrainTransform(currentScene);

  const waterPoints = waterRenderer.draw(currentScene);

  pop();

  currentScene.waterRow = -1;

  if (currentScene.profile) {
    currentScene.profile.waterRowsDrawn += getSampledWaterRowCount(currentScene.rows, currentScene.config);
    currentScene.profile.waterPointsDrawn += waterPoints;
    currentScene.profile.waterDrawMs += performance.now() - waterStart;
  }
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
    const contourLineTransform = createContourLineTransform(renderContext, currentScene.config.camera);
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
  const renderMetrics = contourRenderer.drawLayer(currentScene, contourLayer);
  uploadMs += renderMetrics.uploadMs;
  fillUploadMs += renderMetrics.fillUploadMs;
  lineUploadMs += renderMetrics.lineUploadMs;
  fillDrawMs = renderMetrics.fillDrawMs;
  lineDrawMs = renderMetrics.lineDrawMs;

  pop();

  const drawMs = performance.now() - drawStart;
  const stats: ContourLayerStats = {
    geometryMs,
    uploadMs,
    fillUploadMs,
    lineUploadMs,
    drawMs,
    fillDrawMs,
    lineDrawMs,
    fillVertexCount: renderMetrics.fillVertexCount,
    lineVertexCount: renderMetrics.lineVertexCount,
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

  contourRenderer.dispose();
  waterRenderer.dispose();
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
