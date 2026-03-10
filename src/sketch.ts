import './style.css';
import { initP5 } from './p5/init';
import {
  createContourGeometryStats,
  createContourLayer,
  disposeContourLayer,
  disposeContourLayerResourceSlot,
  markContourLayerRenderReady,
  updateContourLayerGeometry,
  updateContourLayerStats,
} from './sketch/contours/layer';
import { createContourLineTransform } from './sketch/contours/lineTransform';
import { collectCellGeometry } from './sketch/contours/marchingSquares';
import { createSketchController } from './sketch/config/controller';
import type { SketchControllerEvent } from './sketch/config/controller';
import { defaultSketchConfig } from './sketch/config/defaults';
import type { SketchConfig } from './sketch/config/types';
import { createSketchRenderContext } from './sketch/runtime/renderContext';
import { buildSceneState } from './sketch/scene/buildSceneState';
import type {
  ContourLayer,
  ContourLayerResourceSlot,
  ContourLayerStats,
  ContourRenderBuffer,
  ContourRetainedBackend,
  ContourVertexData,
  SceneProfile,
  SceneState,
  ThresholdProfile,
} from './sketch/scene/types';
import { hexToNormalizedRgba } from './sketch/shared/color';
import { emitVertices, hasContourVertices } from './sketch/shared/geometry';
import { toFloat32Array } from './sketch/shared/math';
import { getSampledWaterRowCount } from './sketch/terrain/elevation';
import { disposeWaterState } from './sketch/water/geometry';
import { createWaterRenderer } from './sketch/water/renderRetained';

const sketchController = createSketchController(defaultSketchConfig);
const renderContext = createSketchRenderContext();
const waterRenderer = createWaterRenderer(renderContext);

let scene: SceneState | null = null;
let contourRetainedBackend: ContourRetainedBackend | null = null;
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
    destroyContourRetainedBackend();
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

function destroyContourRetainedBackend() {
  if (!contourRetainedBackend) {
    return;
  }

  const backend = contourRetainedBackend;
  contourRetainedBackend = null;
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

function isContourRetainedBackendValid(backend: ContourRetainedBackend) {
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
