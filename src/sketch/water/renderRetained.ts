import type { SketchRenderContext } from '../runtime/renderContext';
import type {
  ContourLayerResourceSlot,
  ContourRenderBuffer,
  SceneState,
  WaterRetainedBackend,
  WaterState,
} from '../scene/types';
import { hexToNormalizedRgba } from '../shared/color';
import { toFloat32Array } from '../shared/math';
import { releaseWaterCpuGeometry } from './geometry';
import { drawWaterImmediate } from './renderImmediate';

const RETAINED_WATER_VERTEX_SHADER = `
attribute vec3 aPosition;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;
uniform float uPointSize;

void main() {
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
  gl_PointSize = uPointSize;
}
`;

const RETAINED_WATER_FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 uColor;

void main() {
  vec2 centeredCoord = gl_PointCoord - vec2(0.5);
  if (dot(centeredCoord, centeredCoord) > 0.25) {
    discard;
  }

  gl_FragColor = uColor;
}
`;

export type WaterRenderer = {
  draw: (scene: SceneState) => number;
  dispose: () => void;
};

export function createWaterRenderer(renderContext: SketchRenderContext): WaterRenderer {
  let waterRetainedBackend: WaterRetainedBackend | null = null;

  function destroyWaterRetainedBackend() {
    if (!waterRetainedBackend) {
      return;
    }

    const backend = waterRetainedBackend;
    waterRetainedBackend = null;
    backend.gl.deleteProgram(backend.program);
  }

  function isWaterRetainedBackendValid(backend: WaterRetainedBackend) {
    const drawingContext = renderContext.getDrawingContext();
    if (!isWebGLContext(drawingContext) || backend.gl !== drawingContext) {
      return false;
    }

    return typeof backend.gl.isContextLost !== 'function' || !backend.gl.isContextLost();
  }

  function getWaterRetainedBackend() {
    if (waterRetainedBackend && isWaterRetainedBackendValid(waterRetainedBackend)) {
      return waterRetainedBackend;
    }

    destroyWaterRetainedBackend();

    const drawingContext = renderContext.getDrawingContext();
    if (!isWebGLContext(drawingContext)) {
      return null;
    }

    const gl = drawingContext;
    const program = createWaterProgram(gl);
    if (!program) {
      return null;
    }

    const positionLocation = gl.getAttribLocation(program, 'aPosition');
    const projectionMatrixLocation = gl.getUniformLocation(program, 'uProjectionMatrix');
    const modelViewMatrixLocation = gl.getUniformLocation(program, 'uModelViewMatrix');
    const colorLocation = gl.getUniformLocation(program, 'uColor');
    const pointSizeLocation = gl.getUniformLocation(program, 'uPointSize');

    if (
      positionLocation < 0
      || !projectionMatrixLocation
      || !modelViewMatrixLocation
      || !colorLocation
      || !pointSizeLocation
    ) {
      gl.deleteProgram(program);
      return null;
    }

    waterRetainedBackend = {
      gl,
      program,
      positionLocation,
      projectionMatrixLocation,
      modelViewMatrixLocation,
      colorLocation,
      pointSizeLocation,
    };

    return waterRetainedBackend;
  }

  return {
    draw(currentScene: SceneState) {
      const retainedBackend = getWaterRetainedBackend();

      if (retainedBackend && ensureWaterRenderResources(retainedBackend, currentScene.water)) {
        return drawWaterRetained(retainedBackend, currentScene, renderContext);
      }

      return drawWaterImmediate(currentScene, renderContext);
    },
    dispose() {
      destroyWaterRetainedBackend();
    },
  };
}

function createWaterProgram(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, RETAINED_WATER_VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, RETAINED_WATER_FRAGMENT_SHADER);

  if (!vertexShader || !fragmentShader) {
    if (vertexShader) {
      gl.deleteShader(vertexShader);
    }

    if (fragmentShader) {
      gl.deleteShader(fragmentShader);
    }

    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn('Failed to link retained water shader program', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }

  return program;
}

function compileShader(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  shaderType: number,
  source: string,
) {
  const shader = gl.createShader(shaderType);
  if (!shader) {
    return null;
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Failed to compile retained water shader', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function ensureWaterRenderResources(
  backend: WaterRetainedBackend,
  water: WaterState,
) {
  const handle = water.renderResources.points.handle as ContourRenderBuffer | null;
  if (handle) {
    return true;
  }

  uploadWaterRenderResource(
    backend.gl,
    water.renderResources.points,
    water.geometry.pointVertices,
    backend.gl.POINTS,
  );

  if (water.renderResources.points.handle) {
    releaseWaterCpuGeometry(water);
    return true;
  }

  return false;
}

function uploadWaterRenderResource(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  resourceSlot: ContourLayerResourceSlot,
  vertices: Float32Array | null,
  drawMode: number,
) {
  disposeRenderResourceSlot(resourceSlot);

  if (!vertices || vertices.length === 0) {
    return;
  }

  const buffer = gl.createBuffer();
  if (!buffer) {
    return;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const handle: ContourRenderBuffer = {
    buffer,
    vertexCount: vertices.length / 3,
    drawMode,
  };

  resourceSlot.handle = handle;
  resourceSlot.dispose = () => {
    gl.deleteBuffer(buffer);
  };
}

function drawWaterRetained(
  backend: WaterRetainedBackend,
  currentScene: SceneState,
  renderContext: SketchRenderContext,
) {
  const renderer = renderContext.getRenderer();
  const handle = currentScene.water.renderResources.points.handle as ContourRenderBuffer | null;

  if (!renderer || !handle) {
    return 0;
  }

  const { gl } = backend;
  const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const wasPositionAttribEnabled = Boolean(gl.getVertexAttrib(backend.positionLocation, gl.VERTEX_ATTRIB_ARRAY_ENABLED));
  const pointSize = Math.max(1, currentScene.config.water.pointSize * renderContext.getPixelDensity());

  gl.useProgram(backend.program);
  gl.uniformMatrix4fv(backend.projectionMatrixLocation, false, toFloat32Array(renderer.uPMatrix.mat4));
  gl.uniformMatrix4fv(backend.modelViewMatrixLocation, false, toFloat32Array(renderer.uMVMatrix.mat4));
  gl.uniform4fv(backend.colorLocation, hexToNormalizedRgba(currentScene.config.colors.water));
  gl.uniform1f(backend.pointSizeLocation, pointSize);
  gl.bindBuffer(gl.ARRAY_BUFFER, handle.buffer);
  gl.enableVertexAttribArray(backend.positionLocation);
  gl.vertexAttribPointer(backend.positionLocation, 3, gl.FLOAT, false, 0, 0);
  gl.drawArrays(handle.drawMode, 0, handle.vertexCount);

  if (previousArrayBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer);
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  if (!wasPositionAttribEnabled) {
    gl.disableVertexAttribArray(backend.positionLocation);
  }

  gl.useProgram(previousProgram);

  return handle.vertexCount;
}

function disposeRenderResourceSlot(resourceSlot: ContourLayerResourceSlot) {
  resourceSlot.handle = null;
  const dispose = resourceSlot.dispose;
  resourceSlot.dispose = null;

  dispose?.();
}

function isWebGLContext(
  context: RenderingContext | null,
): context is WebGLRenderingContext | WebGL2RenderingContext {
  return context instanceof WebGLRenderingContext || context instanceof WebGL2RenderingContext;
}
