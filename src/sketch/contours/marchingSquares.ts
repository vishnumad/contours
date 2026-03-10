import type { ContourGeometryStats, ContourLineTransform, SceneState } from '../scene/types';
import { addSegment, addTriangle } from '../shared/geometry';
import { binaryToDecimal, getInterpolationPercent } from '../shared/math';
import { getElevation } from '../terrain/elevation';

export function collectCellGeometry(
  currentScene: SceneState,
  threshold: number,
  col: number,
  row: number,
  fillVertices: number[],
  lineVertices: number[],
  geometryStats: ContourGeometryStats,
  contourLineTransform: ContourLineTransform,
) {
  const nw = getElevation(currentScene, col, row);
  const ne = getElevation(currentScene, col + 1, row);
  const sw = getElevation(currentScene, col, row + 1);
  const se = getElevation(currentScene, col + 1, row + 1);
  const caseIndex = binaryToDecimal(nw, ne, se, sw, threshold);

  if (caseIndex === 0) {
    return;
  }

  geometryStats.activeCellCount += 1;

  if (caseIndex === 15) {
    geometryStats.fullCellCount += 1;
    if (Math.abs(threshold - nw) < currentScene.config.contours.fullCellFillEpsilon) {
      const fillZ = threshold * currentScene.config.terrain.elevationMultiplier + currentScene.config.terrain.verticalBias - 1.5;
      const x = col * currentScene.config.terrain.spacing - currentScene.worldWidth / 2;
      const y = row * currentScene.config.terrain.spacing - currentScene.worldHeight / 2;
      const maxX = x + currentScene.config.terrain.spacing;
      const maxY = y + currentScene.config.terrain.spacing;

      addTriangle(fillVertices, x, y, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, maxY, fillZ, maxX, maxY, fillZ);
      geometryStats.fillCellCount += 1;
      geometryStats.triangleCount += 2;
    }
    return;
  }

  const fillZ = threshold * currentScene.config.terrain.elevationMultiplier + currentScene.config.terrain.verticalBias - 1.5;
  const x = col * currentScene.config.terrain.spacing - currentScene.worldWidth / 2;
  const y = row * currentScene.config.terrain.spacing - currentScene.worldHeight / 2;
  const maxX = x + currentScene.config.terrain.spacing;
  const maxY = y + currentScene.config.terrain.spacing;
  const contourZ = fillZ + 1.5;

  let ax = 0;
  let by = 0;
  let cx = 0;
  let dy = 0;
  let hasTopIntersection = false;
  let hasRightIntersection = false;
  let hasBottomIntersection = false;
  let hasLeftIntersection = false;

  const getTopIntersectionX = () => {
    if (!hasTopIntersection) {
      ax = lerpNumber(x, maxX, getInterpolationPercent(threshold, nw, ne));
      hasTopIntersection = true;
    }

    return ax;
  };

  const getRightIntersectionY = () => {
    if (!hasRightIntersection) {
      by = lerpNumber(y, maxY, getInterpolationPercent(threshold, ne, se));
      hasRightIntersection = true;
    }

    return by;
  };

  const getBottomIntersectionX = () => {
    if (!hasBottomIntersection) {
      cx = lerpNumber(x, maxX, getInterpolationPercent(threshold, sw, se));
      hasBottomIntersection = true;
    }

    return cx;
  };

  const getLeftIntersectionY = () => {
    if (!hasLeftIntersection) {
      dy = lerpNumber(y, maxY, getInterpolationPercent(threshold, nw, sw));
      hasLeftIntersection = true;
    }

    return dy;
  };

  switch (caseIndex) {
    case 1:
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ, x, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getBottomIntersectionX(), maxY, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 2:
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, getBottomIntersectionX(), maxY, fillZ, maxX, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, maxX, getRightIntersectionY(), contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 3:
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, x, getLeftIntersectionY(), fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, x, maxY, fillZ, maxX, maxY, fillZ, maxX, getRightIntersectionY(), fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, maxX, getRightIntersectionY(), contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 4:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, getRightIntersectionY(), fillZ, maxX, y, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, maxX, getRightIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 5:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, getRightIntersectionY(), fillZ, maxX, y, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ, getTopIntersectionX(), y, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, maxX, getRightIntersectionY(), fillZ, getTopIntersectionX(), y, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, x, getLeftIntersectionY(), contourZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, maxX, getRightIntersectionY(), contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 4;
      geometryStats.segmentCount += 2;
      break;
    case 6:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, getBottomIntersectionX(), maxY, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 7:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, x, getLeftIntersectionY(), fillZ, x, maxY, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, x, getLeftIntersectionY(), fillZ, maxX, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    case 8:
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, x, getLeftIntersectionY(), fillZ, x, y, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 1;
      geometryStats.segmentCount += 1;
      break;
    case 9:
      addTriangle(fillVertices, x, y, fillZ, getTopIntersectionX(), y, fillZ, getBottomIntersectionX(), maxY, fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, maxY, fillZ, getBottomIntersectionX(), maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 10:
      addTriangle(fillVertices, x, y, fillZ, getTopIntersectionX(), y, fillZ, x, getLeftIntersectionY(), fillZ);
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, getBottomIntersectionX(), maxY, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, getRightIntersectionY(), fillZ, x, getLeftIntersectionY(), fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, maxX, getRightIntersectionY(), contourZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getBottomIntersectionX(), maxY, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 4;
      geometryStats.segmentCount += 2;
      break;
    case 11:
      addTriangle(fillVertices, x, y, fillZ, getTopIntersectionX(), y, fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, maxX, maxY, fillZ, x, maxY, fillZ);
      addTriangle(fillVertices, getTopIntersectionX(), y, fillZ, maxX, getRightIntersectionY(), fillZ, x, maxY, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getTopIntersectionX(), y, contourZ, maxX, getRightIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    case 12:
      addTriangle(fillVertices, x, y, fillZ, maxX, y, fillZ, maxX, getRightIntersectionY(), fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, getLeftIntersectionY(), fillZ, maxX, getRightIntersectionY(), fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, maxX, getRightIntersectionY(), contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 2;
      geometryStats.segmentCount += 1;
      break;
    case 13:
      addTriangle(fillVertices, x, y, fillZ, maxX, y, fillZ, maxX, getRightIntersectionY(), fillZ);
      addTriangle(fillVertices, x, y, fillZ, x, maxY, fillZ, getBottomIntersectionX(), maxY, fillZ);
      addTriangle(fillVertices, maxX, getRightIntersectionY(), fillZ, getBottomIntersectionX(), maxY, fillZ, x, y, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, maxX, getRightIntersectionY(), contourZ, getBottomIntersectionX(), maxY, contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    case 14:
      addTriangle(fillVertices, x, getLeftIntersectionY(), fillZ, x, y, fillZ, maxX, y, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, maxX, y, fillZ, maxX, maxY, fillZ);
      addTriangle(fillVertices, getBottomIntersectionX(), maxY, fillZ, x, getLeftIntersectionY(), fillZ, maxX, y, fillZ);
      addSegment(lineVertices, contourLineTransform, currentScene.config.contours.lineWeight, getBottomIntersectionX(), maxY, contourZ, x, getLeftIntersectionY(), contourZ);
      geometryStats.fillCellCount += 1;
      geometryStats.lineCellCount += 1;
      geometryStats.triangleCount += 3;
      geometryStats.segmentCount += 1;
      break;
    default:
      break;
  }
}

function lerpNumber(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}
