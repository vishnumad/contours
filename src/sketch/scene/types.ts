import type { DeepPartial, SketchConfig } from '../config/types';

export type RenderPhase = 'water' | 'contours' | 'complete';
export type ContourLayerReadiness = 'pending' | 'geometry-ready' | 'gpu-ready' | 'disposed';

export type ContourVertexData = number[] | Float32Array;

export type ContourLayerGeometry = {
  fillVertices: ContourVertexData | null;
  lineVertices: ContourVertexData | null;
};

export type ContourLayerResourceSlot = {
  handle: unknown;
  dispose: (() => void) | null;
};

export type ContourRenderBuffer = {
  buffer: WebGLBuffer;
  vertexCount: number;
  drawMode: number;
};

export type ContourShaderBackend = {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  program: WebGLProgram;
  positionLocation: number;
  projectionMatrixLocation: WebGLUniformLocation;
  modelViewMatrixLocation: WebGLUniformLocation;
  colorLocation: WebGLUniformLocation;
};

export type WaterShaderBackend = {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  program: WebGLProgram;
  positionLocation: number;
  projectionMatrixLocation: WebGLUniformLocation;
  modelViewMatrixLocation: WebGLUniformLocation;
  colorLocation: WebGLUniformLocation;
  pointSizeLocation: WebGLUniformLocation;
};

export type P5MatrixLike = {
  mat4: ArrayLike<number>;
};

export type P5RendererLike = {
  uPMatrix: P5MatrixLike;
  uMVMatrix: P5MatrixLike;
};

export type ContourLineTransform = {
  screenBasisXX: number;
  screenBasisXY: number;
  screenBasisYX: number;
  screenBasisYY: number;
  terrainBasisXX: number;
  terrainBasisXY: number;
  terrainBasisYX: number;
  terrainBasisYY: number;
};

export type TerrainScreenOffset = {
  x: number;
  y: number;
};

export type ContourLayerRenderResources = {
  fill: ContourLayerResourceSlot;
  line: ContourLayerResourceSlot;
};

export type ContourLayer = {
  threshold: number;
  readiness: ContourLayerReadiness;
  geometry: ContourLayerGeometry;
  renderResources: ContourLayerRenderResources;
};

export type WaterGeometry = {
  pointVertices: Float32Array | null;
};

export type WaterRenderResources = {
  points: ContourLayerResourceSlot;
};

export type WaterState = {
  geometry: WaterGeometry;
  renderResources: WaterRenderResources;
};

export type SceneState = {
  config: SketchConfig;
  seed: number;
  cols: number;
  rows: number;
  worldWidth: number;
  worldHeight: number;
  elevations: Float32Array;
  maxElevation: number;
  terrainScreenOffset: TerrainScreenOffset;
  water: WaterState;
  contourLayers: ContourLayer[];
  contourIndex: number;
  phase: RenderPhase;
};

declare global {
  interface Window {
    __CONTOUR_CONTROLLER__?: {
      getConfig: () => SketchConfig;
      updateConfig: (patch: DeepPartial<SketchConfig>) => unknown;
      reset: (options?: { reseed?: boolean; seed?: number }) => unknown;
    };
  }
}
