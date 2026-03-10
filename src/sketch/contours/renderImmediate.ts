import type { SketchRenderContext } from '../runtime/renderContext';
import type { ContourLayer, SceneState } from '../scene/types';
import { emitVertices } from '../shared/geometry';

export type ContourImmediateDrawMetrics = {
  fillDrawMs: number;
  lineDrawMs: number;
};

export function drawContourLayerImmediate(
  currentScene: SceneState,
  contourLayer: ContourLayer,
  renderContext: SketchRenderContext,
): ContourImmediateDrawMetrics {
  const fillDrawMs = drawContourFillImmediate(currentScene, contourLayer, renderContext);
  const lineDrawMs = drawContourLineImmediate(currentScene, contourLayer, renderContext);

  return {
    fillDrawMs,
    lineDrawMs,
  };
}

export function drawContourFillImmediate(
  currentScene: SceneState,
  contourLayer: ContourLayer,
  renderContext: SketchRenderContext,
) {
  const sketch = renderContext.getP5();
  if (!sketch || !contourLayer.geometry.fillVertices || contourLayer.geometry.fillVertices.length === 0) {
    return 0;
  }

  sketch.noStroke();
  sketch.fill(currentScene.config.colors.background);
  const fillStart = performance.now();
  sketch.beginShape(sketch.TRIANGLES);
  emitVertices(contourLayer.geometry.fillVertices, (x, y, z) => {
    sketch.vertex(x, y, z);
  });
  sketch.endShape();

  return performance.now() - fillStart;
}

export function drawContourLineImmediate(
  currentScene: SceneState,
  contourLayer: ContourLayer,
  renderContext: SketchRenderContext,
) {
  const sketch = renderContext.getP5();
  if (!sketch || !contourLayer.geometry.lineVertices || contourLayer.geometry.lineVertices.length === 0) {
    return 0;
  }

  sketch.noStroke();
  sketch.fill(currentScene.config.colors.outline);
  const lineStart = performance.now();
  sketch.beginShape(sketch.TRIANGLES);
  emitVertices(contourLayer.geometry.lineVertices, (x, y, z) => {
    sketch.vertex(x, y, z);
  });
  sketch.endShape();

  return performance.now() - lineStart;
}
