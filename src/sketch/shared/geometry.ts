import type { ContourLineTransform, ContourVertexData } from '../scene/types';
import { screenToTerrainDeltaX, screenToTerrainDeltaY } from './math';

export function emitVertices(
  vertices: ContourVertexData | null,
  emitVertex: (x: number, y: number, z: number) => void,
) {
  if (!vertices) {
    return;
  }

  for (let index = 0; index < vertices.length; index += 3) {
    emitVertex(vertices[index], vertices[index + 1], vertices[index + 2]);
  }
}

export function addTriangle(
  vertices: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
) {
  vertices.push(ax, ay, az, bx, by, bz, cx, cy, cz);
}

export function addSegment(
  vertices: number[],
  contourLineTransform: ContourLineTransform,
  lineWeight: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
) {
  const dx = bx - ax;
  const dy = by - ay;
  const screenDx = dx * contourLineTransform.screenBasisXX + dy * contourLineTransform.screenBasisYX;
  const screenDy = dx * contourLineTransform.screenBasisXY + dy * contourLineTransform.screenBasisYY;
  const screenLength = Math.hypot(screenDx, screenDy);

  if (screenLength < Number.EPSILON) {
    return;
  }

  const halfWidth = lineWeight * 0.5;
  const directionScreenX = screenDx / screenLength;
  const directionScreenY = screenDy / screenLength;
  const normalScreenX = -directionScreenY;
  const normalScreenY = directionScreenX;

  const offsetX = screenToTerrainDeltaX(contourLineTransform, normalScreenX * halfWidth, normalScreenY * halfWidth);
  const offsetY = screenToTerrainDeltaY(contourLineTransform, normalScreenX * halfWidth, normalScreenY * halfWidth);
  const extensionX = screenToTerrainDeltaX(contourLineTransform, directionScreenX * halfWidth, directionScreenY * halfWidth);
  const extensionY = screenToTerrainDeltaY(contourLineTransform, directionScreenX * halfWidth, directionScreenY * halfWidth);

  const startX = ax - extensionX;
  const startY = ay - extensionY;
  const endX = bx + extensionX;
  const endY = by + extensionY;

  addTriangle(
    vertices,
    startX + offsetX,
    startY + offsetY,
    az,
    startX - offsetX,
    startY - offsetY,
    az,
    endX + offsetX,
    endY + offsetY,
    bz,
  );
  addTriangle(
    vertices,
    startX - offsetX,
    startY - offsetY,
    az,
    endX - offsetX,
    endY - offsetY,
    bz,
    endX + offsetX,
    endY + offsetY,
    bz,
  );
}

export function hasContourVertices(vertices: ContourVertexData | null) {
  return Boolean(vertices && vertices.length > 0);
}
