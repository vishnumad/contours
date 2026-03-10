import type { SketchRenderContext } from '../runtime/renderContext';
import type { SceneState } from '../scene/types';
import { getElevation, getInitialWaterRow } from '../terrain/elevation';

export function drawWaterImmediate(currentScene: SceneState, renderContext: SketchRenderContext) {
  const sketch = renderContext.getP5();
  if (!sketch) {
    return 0;
  }

  const { config } = currentScene;
  const waterZ = config.contours.landThreshold * config.terrain.elevationMultiplier + config.terrain.verticalBias;
  let waterPoints = 0;

  sketch.stroke(config.colors.water);
  sketch.strokeWeight(config.water.pointSize);

  for (let row = getInitialWaterRow(currentScene.rows, config); row >= 0; row -= config.water.sampleStep) {
    for (let col = 0; col < currentScene.cols; col += config.water.sampleStep) {
      if (getElevation(currentScene, col, row) < config.contours.landThreshold) {
        waterPoints += 1;
        sketch.point(
          col * config.terrain.spacing - currentScene.worldWidth / 2,
          row * config.terrain.spacing - currentScene.worldHeight / 2,
          waterZ,
        );
      }
    }
  }

  return waterPoints;
}
