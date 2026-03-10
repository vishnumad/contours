export type SketchTerrainConfig = {
  spacing: number;
  noiseScale: number;
  noiseOffset: number;
  noiseOctaves: readonly number[];
  verticalBias: number;
  elevationMultiplier: number;
  viewportScale: number;
  minSize: number;
  maxSize: number;
  padding: number;
};

export type SketchContoursConfig = {
  landThreshold: number;
  isolineIncrement: number;
  lineWeight: number;
  fullCellFillEpsilon: number;
};

export type SketchWaterConfig = {
  sampleStep: number;
  pointSize: number;
};

export type SketchCameraConfig = {
  rotationX: number;
  rotationZ: number;
};

export type SketchColorsConfig = {
  background: string;
  outline: string;
  water: string;
};

export type SketchProfileConfig = {
  queryParam: string;
  storageKey: string;
};

export type SketchConfig = {
  terrain: SketchTerrainConfig;
  contours: SketchContoursConfig;
  water: SketchWaterConfig;
  camera: SketchCameraConfig;
  colors: SketchColorsConfig;
  profile: SketchProfileConfig;
};
