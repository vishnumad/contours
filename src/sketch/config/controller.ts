import { defaultSketchConfig } from './defaults';
import type {
  DeepPartial,
  SketchConfig,
  SketchConfigInvalidation,
  SketchResetOptions,
} from './types';
import { getConfigInvalidation } from './invalidation';

export type SketchConfigChangeEvent = {
  type: 'config';
  config: SketchConfig;
  previousConfig: SketchConfig;
  patch: DeepPartial<SketchConfig>;
  invalidation: SketchConfigInvalidation;
};

export type SketchResetEvent = {
  type: 'reset';
  config: SketchConfig;
  options: Required<SketchResetOptions>;
};

export type SketchControllerEvent = SketchConfigChangeEvent | SketchResetEvent;

type ConfigListener = (event: SketchControllerEvent) => void;

export type SketchController = {
  getConfig: () => SketchConfig;
  updateConfig: (patch: DeepPartial<SketchConfig>) => SketchConfigChangeEvent;
  reset: (options?: SketchResetOptions) => SketchResetEvent;
  subscribe: (listener: ConfigListener) => () => void;
};

export function createSketchController(initialConfig: SketchConfig = defaultSketchConfig): SketchController {
  let config = cloneConfig(initialConfig);
  const listeners = new Set<ConfigListener>();

  const emit = (event: SketchControllerEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return {
    getConfig: () => cloneConfig(config),
    updateConfig: (patch) => {
      const previousConfig = cloneConfig(config);
      const nextConfig = mergeConfig(previousConfig, patch);
      const invalidation = getConfigInvalidation(previousConfig, nextConfig);

      config = nextConfig;

      const event: SketchConfigChangeEvent = {
        type: 'config',
        config: cloneConfig(nextConfig),
        previousConfig,
        patch,
        invalidation,
      };

      emit(event);
      return event;
    },
    reset: (options = {}) => {
      const event: SketchResetEvent = {
        type: 'reset',
        config: cloneConfig(config),
        options: {
          reseed: options.reseed ?? false,
          seed: options.seed ?? Date.now(),
        },
      };

      emit(event);
      return event;
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function cloneConfig(config: SketchConfig): SketchConfig {
  return {
    terrain: {
      ...config.terrain,
      noiseOctaves: [...config.terrain.noiseOctaves],
    },
    contours: { ...config.contours },
    water: { ...config.water },
    camera: { ...config.camera },
    colors: { ...config.colors },
  };
}

function mergeConfig(config: SketchConfig, patch: DeepPartial<SketchConfig>): SketchConfig {
  return {
    terrain: {
      ...config.terrain,
      ...omitUndefined(patch.terrain),
    },
    contours: {
      ...config.contours,
      ...omitUndefined(patch.contours),
    },
    water: {
      ...config.water,
      ...omitUndefined(patch.water),
    },
    camera: {
      ...config.camera,
      ...omitUndefined(patch.camera),
    },
    colors: {
      ...config.colors,
      ...omitUndefined(patch.colors),
    },
  };
}

function omitUndefined<T extends object>(patch: DeepPartial<T> | undefined): Partial<T> {
  if (!patch) {
    return {};
  }

  const nextSection: Partial<T> = {};

  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      nextSection[key as keyof T] = value as T[keyof T];
    }
  }

  return nextSection;
}
