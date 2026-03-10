import type p5 from 'p5';
import type { P5RendererLike } from '../scene/types';

export type SketchRenderContext = {
  getRenderer: () => P5RendererLike | null;
  getSize: () => { width: number; height: number };
  getPixelDensity: () => number;
  getDrawingContext: () => RenderingContext | null;
};

export function createSketchRenderContext(): SketchRenderContext {
  return {
    getRenderer: () => {
      const instance = window.__CONTOUR_P5__ as (p5 & { _renderer?: P5RendererLike }) | undefined;

      return instance?._renderer ?? null;
    },
    getSize: () => ({ width, height }),
    getPixelDensity: () => pixelDensity(),
    getDrawingContext: () => drawingContext,
  };
}
