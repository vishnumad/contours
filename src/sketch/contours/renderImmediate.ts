import type { SketchRenderContext } from '../runtime/renderContext';
import type { ContourLayer, SceneState } from '../scene/types';
import { emitVertices } from '../shared/geometry';

export function drawContourLayerImmediate(
  currentScene: SceneState,
  contourLayer: ContourLayer,
  renderContext: SketchRenderContext,
) {
  drawContourFillImmediate(currentScene, contourLayer, renderContext);
  drawContourLineImmediate(currentScene, contourLayer, renderContext);
}

export function drawContourFillImmediate(
  currentScene: SceneState,
  contourLayer: ContourLayer,
  renderContext: SketchRenderContext,
) {
  const sketch = renderContext.getP5();
  if (!sketch || !contourLayer.geometry.fillVertices || contourLayer.geometry.fillVertices.length === 0) {
    return;
  }

  sketch.noStroke();
  sketch.fill(currentScene.config.colors.background);
  sketch.beginShape(sketch.TRIANGLES);
  emitVertices(contourLayer.geometry.fillVertices, (x, y, z) => {
    sketch.vertex(x, y, z);
  });
  sketch.endShape();
}

export function drawContourLineImmediate(
  currentScene: SceneState,
  contourLayer: ContourLayer,
  renderContext: SketchRenderContext,
) {
  const sketch = renderContext.getP5();
  if (!sketch || !contourLayer.geometry.lineVertices || contourLayer.geometry.lineVertices.length === 0) {
    return;
  }

  sketch.noStroke();
  sketch.fill(currentScene.config.colors.outline);
  sketch.beginShape(sketch.TRIANGLES);
  emitVertices(contourLayer.geometry.lineVertices, (x, y, z) => {
    sketch.vertex(x, y, z);
  });
  sketch.endShape();
}
