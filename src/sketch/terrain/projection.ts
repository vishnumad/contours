import type { SketchCameraConfig, SketchConfig } from '../config/types';
import type { TerrainScreenOffset } from '../scene/types';

type DerivedCamera = {
  rotationXCos: number;
  rotationXSin: number;
  rotationZCos: number;
  rotationZSin: number;
};

export function getTerrainScreenOffset(worldWidth: number, worldHeight: number, config: SketchConfig): TerrainScreenOffset {
  const halfWorldWidth = worldWidth * 0.5;
  const halfWorldHeight = worldHeight * 0.5;
  const waterPlaneZ = config.contours.landThreshold * config.terrain.elevationMultiplier + config.terrain.verticalBias;
  const corners = [
    [-halfWorldWidth, -halfWorldHeight, waterPlaneZ],
    [halfWorldWidth, -halfWorldHeight, waterPlaneZ],
    [-halfWorldWidth, halfWorldHeight, waterPlaneZ],
    [halfWorldWidth, halfWorldHeight, waterPlaneZ],
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const [x, y, z] of corners) {
    const projected = rotateTerrainPoint(x, y, z, config.camera);

    minX = Math.min(minX, projected.x);
    maxX = Math.max(maxX, projected.x);
    minY = Math.min(minY, projected.y);
    maxY = Math.max(maxY, projected.y);
  }

  return {
    x: (minX + maxX) * 0.5,
    y: (minY + maxY) * 0.5,
  };
}

export function rotateTerrainPoint(x: number, y: number, z: number, camera: SketchCameraConfig) {
  const derivedCamera = getDerivedCamera(camera);
  const rotatedX = x * derivedCamera.rotationZCos - y * derivedCamera.rotationZSin;
  const rotatedYBeforeTilt = x * derivedCamera.rotationZSin + y * derivedCamera.rotationZCos;

  return {
    x: rotatedX,
    y: rotatedYBeforeTilt * derivedCamera.rotationXCos - z * derivedCamera.rotationXSin,
  };
}

export function getDerivedCamera(camera: SketchCameraConfig): DerivedCamera {
  return {
    rotationXCos: Math.cos(camera.rotationX),
    rotationXSin: Math.sin(camera.rotationX),
    rotationZCos: Math.cos(camera.rotationZ),
    rotationZSin: Math.sin(camera.rotationZ),
  };
}
