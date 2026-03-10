import type { ContourLineTransform } from '../scene/types';

export type ViewportSize = {
  width: number;
  height: number;
};

export function toFloat32Array(values: ArrayLike<number>) {
  return values instanceof Float32Array ? values : new Float32Array(values);
}

export function multiplyMat4(left: ArrayLike<number>, right: ArrayLike<number>) {
  const result = new Float32Array(16);

  for (let column = 0; column < 4; column += 1) {
    const rightColumnOffset = column * 4;
    for (let row = 0; row < 4; row += 1) {
      result[rightColumnOffset + row] =
        left[row] * right[rightColumnOffset]
        + left[row + 4] * right[rightColumnOffset + 1]
        + left[row + 8] * right[rightColumnOffset + 2]
        + left[row + 12] * right[rightColumnOffset + 3];
    }
  }

  return result;
}

export function projectToScreen(
  matrix: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  viewportSize: ViewportSize,
) {
  const clipX = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
  const clipY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
  const clipW = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
  const reciprocalW = Math.abs(clipW) < Number.EPSILON ? 1 : 1 / clipW;
  const ndcX = clipX * reciprocalW;
  const ndcY = clipY * reciprocalW;

  return {
    x: (ndcX * 0.5 + 0.5) * viewportSize.width,
    y: (0.5 - ndcY * 0.5) * viewportSize.height,
  };
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

export function getInterpolationPercent(threshold: number, start: number, end: number) {
  const range = end - start;

  if (Math.abs(range) < Number.EPSILON) {
    return 0.5;
  }

  return Math.min(Math.max((threshold - start) / range, 0), 1);
}

export function binaryToDecimal(a: number, b: number, c: number, d: number, threshold: number) {
  const aBit = a > threshold ? 8 : 0;
  const bBit = b > threshold ? 4 : 0;
  const cBit = c > threshold ? 2 : 0;
  const dBit = d > threshold ? 1 : 0;

  return aBit + bBit + cBit + dBit;
}
