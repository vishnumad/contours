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

export function createWaterState(rows: number): WaterState {
  return {
    geometry: {
      pointVertices: null,
      rowSlices: Array.from({ length: rows }, () => null),
    },
    renderResources: {
      points: createRenderResourceSlot(),
    },
  };
}

export function populateWaterGeometry(currentScene: SceneState) {
  const { config } = currentScene;
  const pointVertices: number[] = [];
  const rowSlices = currentScene.water.geometry.rowSlices;
  const waterZ = config.contours.landThreshold * config.terrain.elevationMultiplier + config.terrain.verticalBias;

  for (let row = getInitialWaterRow(currentScene.rows, config); row >= 0; row -= config.water.sampleStep) {
    const startVertex = pointVertices.length / 3;

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

    const vertexCount = pointVertices.length / 3 - startVertex;
    rowSlices[row] = {
      startVertex,
      vertexCount,
    };
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
