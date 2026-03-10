import type { SketchConfig } from './types';

export const defaultSketchConfig: SketchConfig = {
  terrain: {
    spacing: 4,
    noiseScale: 0.0095,
    noiseOffset: 150,
    noiseOctaves: [1, 0.5, 0.25, 0.125],
    verticalBias: 0,
    elevationMultiplier: 475,
    viewportScale: 1.2,
    minSize: 720,
    maxSize: 2000,
    padding: 4,
  },
  contours: {
    landThreshold: 0.45,
    isolineIncrement: 0.004,
    lineWeight: 1.25,
    fullCellFillEpsilon: 0.025,
  },
  water: {
    sampleStep: 2,
    pointSize: 1.7,
  },
  camera: {
    rotationX: (65 * Math.PI) / 180,
    rotationZ: (45 * Math.PI) / 180,
  },
  colors: {
    background: '#fef0d9',
    outline: '#c0526e',
    water: '#00b4d8',
  },
};
