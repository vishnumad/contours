import type { SketchConfig } from '../config/types';
import type { SceneState } from '../scene/types';

type ViewportSize = {
  width: number;
  height: number;
};

type NoiseSampler = (x: number, y: number) => number;

export function getWorldSize(config: SketchConfig, viewportSize: ViewportSize) {
  const viewportBase = Math.min(viewportSize.width, viewportSize.height);
  const scaled = viewportBase * config.terrain.viewportScale;
  const clamped = Math.min(Math.max(scaled, config.terrain.minSize), config.terrain.maxSize);
  const snapped = Math.floor(clamped / config.terrain.spacing) * config.terrain.spacing;

  return Math.max(snapped, config.terrain.minSize + config.terrain.padding);
}

export function sampleNoise(x: number, y: number, config: SketchConfig, sample: NoiseSampler) {
  return sample(
    x * config.terrain.noiseScale + config.terrain.noiseOffset,
    y * config.terrain.noiseScale + config.terrain.noiseOffset,
  );
}

export function sampleLayeredElevation(x: number, y: number, config: SketchConfig, sample: NoiseSampler) {
  const [octave1Weight, octave2Weight, octave3Weight, octave4Weight] = config.terrain.noiseOctaves;
  const octave1 = sampleNoise(x, y, config, sample);
  const octave2 = sampleNoise(x * 2, y * 2, config, sample);
  const octave3 = sampleNoise(x * 4, y * 4, config, sample);
  const octave4 = sampleNoise(x * 8, y * 8, config, sample);
  const octaveSum = octave1Weight + octave2Weight + octave3Weight + octave4Weight;

  return (octave1Weight * octave1 + octave2Weight * octave2 + octave3Weight * octave3 + octave4Weight * octave4) / octaveSum;
}

export function getElevationIndex(col: number, row: number, cols: number) {
  return row * cols + col;
}

export function getElevation(currentScene: Pick<SceneState, 'elevations' | 'cols'>, col: number, row: number) {
  return currentScene.elevations[getElevationIndex(col, row, currentScene.cols)];
}

export function getInitialWaterRow(rows: number, config: SketchConfig) {
  return rows - 1 - ((rows - 1) % config.water.sampleStep);
}

export function getSampledWaterRowCount(rows: number, config: SketchConfig) {
  const initialWaterRow = getInitialWaterRow(rows, config);

  return initialWaterRow < 0 ? 0 : Math.floor(initialWaterRow / config.water.sampleStep) + 1;
}
