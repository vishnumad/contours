import type { SketchConfig, SketchConfigInvalidation, SketchInvalidationScope } from './types';

const invalidationPriority: Record<SketchInvalidationScope, number> = {
  none: 0,
  'render-only': 1,
  'rebuild-contours': 2,
  'rebuild-layout': 3,
  'rebuild-scene': 4,
};

export function getConfigInvalidation(
  previousConfig: SketchConfig,
  nextConfig: SketchConfig,
): SketchConfigInvalidation {
  const changedPaths = getChangedPaths(previousConfig, nextConfig);
  let scope: SketchInvalidationScope = 'none';

  for (const path of changedPaths) {
    scope = maxScope(scope, getPathScope(path));
  }

  return {
    scope,
    changedPaths,
  };
}

function getChangedPaths(previousConfig: SketchConfig, nextConfig: SketchConfig) {
  const changedPaths: string[] = [];

  compareSection('terrain', previousConfig.terrain, nextConfig.terrain, changedPaths);
  compareSection('contours', previousConfig.contours, nextConfig.contours, changedPaths);
  compareSection('water', previousConfig.water, nextConfig.water, changedPaths);
  compareSection('camera', previousConfig.camera, nextConfig.camera, changedPaths);
  compareSection('colors', previousConfig.colors, nextConfig.colors, changedPaths);
  compareSection('profile', previousConfig.profile, nextConfig.profile, changedPaths);

  return changedPaths;
}

function compareSection(
  prefix: string,
  previousSection: Record<string, unknown>,
  nextSection: Record<string, unknown>,
  changedPaths: string[],
) {
  const keys = new Set([...Object.keys(previousSection), ...Object.keys(nextSection)]);

  for (const key of keys) {
    if (!isEqual(previousSection[key], nextSection[key])) {
      changedPaths.push(`${prefix}.${key}`);
    }
  }
}

function isEqual(left: unknown, right: unknown) {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
  }

  return Object.is(left, right);
}

function getPathScope(path: string): SketchInvalidationScope {
  switch (path) {
    case 'colors.background':
    case 'colors.outline':
    case 'colors.water':
    case 'water.pointSize':
      return 'render-only';
    case 'contours.lineWeight':
    case 'contours.fullCellFillEpsilon':
      return 'rebuild-contours';
    case 'camera.rotationX':
    case 'camera.rotationZ':
      return 'rebuild-layout';
    default:
      return 'rebuild-scene';
  }
}

function maxScope(left: SketchInvalidationScope, right: SketchInvalidationScope): SketchInvalidationScope {
  return invalidationPriority[right] > invalidationPriority[left] ? right : left;
}
