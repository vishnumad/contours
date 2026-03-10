import type { SketchConfig } from '../config/types';
import type { SceneState } from './types';
import { getTerrainScreenOffset } from '../terrain/projection';
import {
  getElevationIndex,
  getWorldSize,
  sampleLayeredElevation,
} from '../terrain/elevation';
import { createWaterState, populateWaterGeometry } from '../water/geometry';

export type BuildSceneStateOptions = {
  seed: number;
  config: SketchConfig;
  viewportSize: {
    width: number;
    height: number;
  };
  noiseSeed: (seed: number) => void;
  noise: (x: number, y: number) => number;
  createContourLayer: (threshold: number) => SceneState['contourLayers'][number];
};

export function createContourThresholds(maxElevation: number, config: SketchConfig) {
  const contourThresholds: number[] = [];

  for (
    let threshold = config.contours.landThreshold;
    threshold <= maxElevation + config.contours.isolineIncrement * 0.5;
    threshold += config.contours.isolineIncrement
  ) {
    contourThresholds.push(Number(threshold.toFixed(6)));
  }

  return contourThresholds;
}

export function buildSceneState({
  seed,
  config,
  viewportSize,
  noiseSeed,
  noise,
  createContourLayer,
}: BuildSceneStateOptions): SceneState {
  noiseSeed(seed);

  const worldSize = getWorldSize(config, viewportSize);
  const cols = Math.floor(worldSize / config.terrain.spacing) + 1;
  const rows = Math.floor(worldSize / config.terrain.spacing) + 1;
  const elevations = new Float32Array(cols * rows);
  let maxElevation = 0;

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const elevation = sampleLayeredElevation(col, row, config, noise);
      elevations[getElevationIndex(col, row, cols)] = elevation;
      maxElevation = Math.max(maxElevation, elevation);
    }
  }

  const contourThresholds = createContourThresholds(maxElevation, config);
  const contourLayers = contourThresholds.map((threshold) => createContourLayer(threshold));
  const water = createWaterState();

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
    contourIndex: 0,
    phase: 'water',
  };

  populateWaterGeometry(nextScene);

  return nextScene;
}
