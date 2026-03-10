import type { ContourLayerResourceSlot, SceneState, WaterState } from '../scene/types';
import { getElevation, getInitialWaterRow } from '../terrain/elevation';

function createRenderResourceSlot(): ContourLayerResourceSlot {
  return {
    handle: null,
    dispose: null,
  };
}

function disposeRenderResourceSlot(resourceSlot: ContourLayerResourceSlot) {
  resourceSlot.handle = null;
  const dispose = resourceSlot.dispose;
  resourceSlot.dispose = null;

  dispose?.();
}

export function createWaterState(): WaterState {
  return {
    geometry: {
      pointVertices: null,
    },
    renderResources: {
      points: createRenderResourceSlot(),
    },
  };
}

export function populateWaterGeometry(currentScene: SceneState) {
  const { config } = currentScene;
  const pointVertices: number[] = [];
  const waterZ = config.contours.landThreshold * config.terrain.elevationMultiplier + config.terrain.verticalBias;

  for (let row = getInitialWaterRow(currentScene.rows, config); row >= 0; row -= config.water.sampleStep) {
    for (let col = 0; col < currentScene.cols; col += config.water.sampleStep) {
      if (getElevation(currentScene, col, row) >= config.contours.landThreshold) {
        continue;
      }

      pointVertices.push(
        col * config.terrain.spacing - currentScene.worldWidth / 2,
        row * config.terrain.spacing - currentScene.worldHeight / 2,
        waterZ,
      );
    }

  }

  currentScene.water.geometry.pointVertices = new Float32Array(pointVertices);
}

export function releaseWaterCpuGeometry(water: WaterState) {
  water.geometry.pointVertices = null;
}

export function disposeWaterState(water: WaterState) {
  releaseWaterCpuGeometry(water);
  disposeRenderResourceSlot(water.renderResources.points);
}
