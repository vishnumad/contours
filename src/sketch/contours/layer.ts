import type {
  ContourLayer,
  ContourLayerResourceSlot,
  ContourVertexData,
} from '../scene/types';

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
    renderResources: {
      fill: createContourLayerResourceSlot(),
      line: createContourLayerResourceSlot(),
    },
  };
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
  contourLayer.readiness = 'gpu-ready';
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
