import type { SketchCameraConfig } from '../config/types';
import type { SketchRenderContext } from '../runtime/renderContext';
import type { ContourLineTransform } from '../scene/types';
import { multiplyMat4, projectToScreen, toFloat32Array } from '../shared/math';
import { getDerivedCamera } from '../terrain/projection';

export function createContourLineTransform(
  renderContext: SketchRenderContext,
  camera: SketchCameraConfig,
): ContourLineTransform {
  const renderer = renderContext.getRenderer();

  if (!renderer) {
    return createFallbackContourLineTransform(camera);
  }

  const projectionMatrix = toFloat32Array(renderer.uPMatrix.mat4);
  const modelViewMatrix = toFloat32Array(renderer.uMVMatrix.mat4);
  const clipMatrix = multiplyMat4(projectionMatrix, modelViewMatrix);
  const viewportSize = renderContext.getSize();
  const origin = projectToScreen(clipMatrix, 0, 0, 0, viewportSize);
  const unitX = projectToScreen(clipMatrix, 1, 0, 0, viewportSize);
  const unitY = projectToScreen(clipMatrix, 0, 1, 0, viewportSize);

  return createContourLineTransformFromBasis(
    unitX.x - origin.x,
    unitX.y - origin.y,
    unitY.x - origin.x,
    unitY.y - origin.y,
  );
}

export function createContourLineTransformFromBasis(
  screenBasisXX: number,
  screenBasisXY: number,
  screenBasisYX: number,
  screenBasisYY: number,
): ContourLineTransform {
  const determinant = screenBasisXX * screenBasisYY - screenBasisYX * screenBasisXY;

  if (Math.abs(determinant) < Number.EPSILON) {
    return {
      screenBasisXX,
      screenBasisXY,
      screenBasisYX,
      screenBasisYY,
      terrainBasisXX: 1,
      terrainBasisXY: 0,
      terrainBasisYX: 0,
      terrainBasisYY: 1,
    };
  }

  const inverseDeterminant = 1 / determinant;

  return {
    screenBasisXX,
    screenBasisXY,
    screenBasisYX,
    screenBasisYY,
    terrainBasisXX: screenBasisYY * inverseDeterminant,
    terrainBasisXY: -screenBasisYX * inverseDeterminant,
    terrainBasisYX: -screenBasisXY * inverseDeterminant,
    terrainBasisYY: screenBasisXX * inverseDeterminant,
  };
}

export function screenToTerrainDeltaX(contourLineTransform: ContourLineTransform, screenDx: number, screenDy: number) {
  return screenDx * contourLineTransform.terrainBasisXX + screenDy * contourLineTransform.terrainBasisXY;
}

export function screenToTerrainDeltaY(contourLineTransform: ContourLineTransform, screenDx: number, screenDy: number) {
  return screenDx * contourLineTransform.terrainBasisYX + screenDy * contourLineTransform.terrainBasisYY;
}

function createFallbackContourLineTransform(camera: SketchCameraConfig) {
  const derivedCamera = getDerivedCamera(camera);
  const screenBasisXX = derivedCamera.rotationZCos;
  const screenBasisXY = derivedCamera.rotationZSin;
  const screenBasisYX = -derivedCamera.rotationZSin * derivedCamera.rotationXCos;
  const screenBasisYY = derivedCamera.rotationZCos * derivedCamera.rotationXCos;

  return createContourLineTransformFromBasis(screenBasisXX, screenBasisXY, screenBasisYX, screenBasisYY);
}
