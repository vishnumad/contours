import type { SketchConfig, SketchConfigInvalidation } from './types';

export function getConfigInvalidation(
  previousConfig: SketchConfig,
  nextConfig: SketchConfig,
): SketchConfigInvalidation {
  const changedPaths = getChangedPaths(previousConfig, nextConfig);

  return {
    scope: changedPaths.length === 0 ? 'none' : 'rebuild-scene',
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
