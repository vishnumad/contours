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
import { createSceneProfile, exposeSceneProfile, finalizeSceneProfile, recordThresholdProfile } from './sketch/profile/sceneProfile';
import { createSketchRenderContext } from './sketch/runtime/renderContext';
import { buildSceneState } from './sketch/scene/buildSceneState';
import type { ContourLayer, ContourLayerStats, SceneState } from './sketch/scene/types';
import { getSampledWaterRowCount } from './sketch/terrain/elevation';
import { disposeWaterState } from './sketch/water/geometry';
import { createWaterRenderer } from './sketch/water/renderRetained';

const sketchController = createSketchController(defaultSketchConfig);
const renderContext = createSketchRenderContext();
const contourRenderer = createContourRenderer(renderContext);
const waterRenderer = createWaterRenderer(renderContext);

let scene: SceneState | null = null;
let unsubscribeController: (() => void) | null = null;

exposeSketchController();

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
    applyConfigChange(event);
    return;
  }

  const seed = event.options.reseed ? event.options.seed : scene?.seed ?? event.options.seed;
  resetScene(event.options.reseed, seed);
}

function applyConfigChange(event: Extract<SketchControllerEvent, { type: 'config' }>) {
  if (event.invalidation.scope === 'none') {
    return;
  }

  resetScene(false, scene?.seed ?? Date.now());
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

function exposeSketchController() {
  if (!import.meta.env.DEV) {
    delete window.__CONTOUR_CONTROLLER__;
    return;
  }

  window.__CONTOUR_CONTROLLER__ = {
    getConfig: () => sketchController.getConfig(),
    updateConfig: (patch) => sketchController.updateConfig(patch),
    reset: (options) => sketchController.reset(options),
  };
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
