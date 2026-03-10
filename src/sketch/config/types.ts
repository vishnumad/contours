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

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type SketchInvalidationScope = 'none' | 'rebuild-scene';

export type SketchConfigInvalidation = {
  scope: SketchInvalidationScope;
  changedPaths: string[];
};

export type SketchResetOptions = {
  reseed?: boolean;
  seed?: number;
};

export type SketchConfig = {
  terrain: SketchTerrainConfig;
  contours: SketchContoursConfig;
  water: SketchWaterConfig;
  camera: SketchCameraConfig;
  colors: SketchColorsConfig;
  profile: SketchProfileConfig;
};
