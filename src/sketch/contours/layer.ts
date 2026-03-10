import type {
  ContourGeometryStats,
  ContourLayer,
  ContourLayerResourceSlot,
  ContourLayerStats,
  ContourVertexData,
} from '../scene/types';

export function createContourGeometryStats(): ContourGeometryStats {
  return {
    activeCellCount: 0,
    fillCellCount: 0,
    lineCellCount: 0,
    fullCellCount: 0,
    triangleCount: 0,
    segmentCount: 0,
  };
}

export function createContourLayerStats(): ContourLayerStats {
  return {
    ...createContourGeometryStats(),
    geometryMs: 0,
    uploadMs: 0,
    fillUploadMs: 0,
    lineUploadMs: 0,
    drawMs: 0,
    fillDrawMs: 0,
    lineDrawMs: 0,
    fillVertexCount: 0,
    lineVertexCount: 0,
  };
}

export function createContourLayerResourceSlot(): ContourLayerResourceSlot {
  return {
    handle: null,
    dispose: null,
  };
}

export function createContourLayer(threshold: number): ContourLayer {
  return {
    threshold,
    readiness: 'pending',
    geometry: {
      fillVertices: null,
      lineVertices: null,
    },
    stats: createContourLayerStats(),
    renderResources: {
      fill: createContourLayerResourceSlot(),
      line: createContourLayerResourceSlot(),
    },
  };
}

export function updateContourLayerStats(contourLayer: ContourLayer, stats: ContourLayerStats) {
  contourLayer.stats = stats;
}

export function updateContourLayerGeometry(
  contourLayer: ContourLayer,
  fillVertices: ContourVertexData,
  lineVertices: ContourVertexData,
) {
  disposeContourLayerResourceSlot(contourLayer.renderResources.fill);
  disposeContourLayerResourceSlot(contourLayer.renderResources.line);
  releaseContourLayerCpuGeometry(contourLayer);
  contourLayer.geometry.fillVertices = fillVertices;
  contourLayer.geometry.lineVertices = lineVertices;
  contourLayer.readiness = 'geometry-ready';
}

export function releaseContourLayerCpuGeometry(contourLayer: ContourLayer) {
  contourLayer.geometry.fillVertices = null;
  contourLayer.geometry.lineVertices = null;
}

export function markContourLayerRenderReady(contourLayer: ContourLayer) {
  contourLayer.readiness = 'render-ready';
  releaseContourLayerCpuGeometry(contourLayer);
}

export function disposeContourLayerResourceSlot(resourceSlot: ContourLayerResourceSlot) {
  resourceSlot.handle = null;
  const dispose = resourceSlot.dispose;
  resourceSlot.dispose = null;

  dispose?.();
}

export function disposeContourLayer(contourLayer: ContourLayer) {
  releaseContourLayerCpuGeometry(contourLayer);
  disposeContourLayerResourceSlot(contourLayer.renderResources.fill);
  disposeContourLayerResourceSlot(contourLayer.renderResources.line);
  contourLayer.readiness = 'disposed';
}
