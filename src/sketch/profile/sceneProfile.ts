import type { SketchConfig } from '../config/types';
import type { SceneProfile, SceneState, ThresholdProfile } from '../scene/types';

export function createSceneProfile(seed: number, config: SketchConfig): SceneProfile | null {
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

export function exposeSceneProfile(profile: SceneProfile | null) {
  if (profile) {
    window.__CONTOUR_PROFILE__ = profile;
  } else {
    delete window.__CONTOUR_PROFILE__;
  }
}

export function recordThresholdProfile(currentScene: SceneState, thresholdProfile: ThresholdProfile) {
  if (!currentScene.profile) {
    return;
  }

  currentScene.profile.contours.push(thresholdProfile);
  currentScene.profile.contourGeometryMs += thresholdProfile.geometryMs;
  currentScene.profile.contourUploadMs += thresholdProfile.uploadMs;
  currentScene.profile.contourDrawMs += thresholdProfile.drawMs;
}

export function finalizeSceneProfile(currentScene: SceneState) {
  if (!currentScene.profile || currentScene.profile.summaryLogged) {
    return;
  }

  currentScene.profile.revealTotalMs = performance.now() - currentScene.profile.startedAtMs;
  currentScene.profile.summaryLogged = true;
  logSceneProfile(currentScene.profile);
}

function isProfilingEnabled(config: SketchConfig) {
  const query = new URLSearchParams(window.location.search);

  return query.has(config.profile.queryParam)
    || window.__CONTOUR_PROFILE_DEBUG__ === true
    || window.localStorage.getItem(config.profile.storageKey) === '1';
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
