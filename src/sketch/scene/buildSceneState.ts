import type { SketchConfig } from '../config/types';
import type { SceneProfile, SceneState } from './types';
import { getTerrainScreenOffset } from '../terrain/projection';
import {
  getElevationIndex,
  getInitialWaterRow,
  getWorldSize,
  sampleLayeredElevation,
} from '../terrain/elevation';

export type BuildSceneStateOptions = {
  seed: number;
  config: SketchConfig;
  viewportSize: {
    width: number;
    height: number;
  };
  noiseSeed: (seed: number) => void;
  noise: (x: number, y: number) => number;
  createSceneProfile: (seed: number, config: SketchConfig) => SceneProfile | null;
  exposeSceneProfile: (profile: SceneProfile | null) => void;
  createContourLayer: (threshold: number) => SceneState['contourLayers'][number];
  createWaterState: (rows: number) => SceneState['water'];
  populateWaterGeometry: (scene: SceneState) => void;
};

export function buildSceneState({
  seed,
  config,
  viewportSize,
  noiseSeed,
  noise,
  createSceneProfile,
  exposeSceneProfile,
  createContourLayer,
  createWaterState,
  populateWaterGeometry,
}: BuildSceneStateOptions): SceneState {
  const profile = createSceneProfile(seed, config);
  const sceneBuildStart = performance.now();

  noiseSeed(seed);

  const worldSize = getWorldSize(config, viewportSize);
  const cols = Math.floor(worldSize / config.terrain.spacing) + 1;
  const rows = Math.floor(worldSize / config.terrain.spacing) + 1;
  const elevations = new Float32Array(cols * rows);
  let maxElevation = 0;
  const elevationStart = performance.now();

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const elevation = sampleLayeredElevation(col, row, config, noise);
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
