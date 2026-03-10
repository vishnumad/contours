import { disposeContourLayerResourceSlot, markContourLayerRenderReady } from './layer';
import { drawContourFillImmediate, drawContourLayerImmediate, drawContourLineImmediate } from './renderImmediate';
import type { SketchRenderContext } from '../runtime/renderContext';
import type {
  ContourLayer,
  ContourLayerResourceSlot,
  ContourRenderBuffer,
  ContourRetainedBackend,
  ContourVertexData,
  SceneState,
} from '../scene/types';
import { hexToNormalizedRgba } from '../shared/color';
import { hasContourVertices } from '../shared/geometry';
import { toFloat32Array } from '../shared/math';

const RETAINED_CONTOUR_VERTEX_SHADER = `
attribute vec3 aPosition;
uniform mat4 uProjectionMatrix;
uniform mat4 uModelViewMatrix;

void main() {
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}
`;

const RETAINED_CONTOUR_FRAGMENT_SHADER = `
precision mediump float;
uniform vec4 uColor;

void main() {
  gl_FragColor = uColor;
}
`;

export type ContourRenderer = {
  drawLayer: (scene: SceneState, contourLayer: ContourLayer) => void;
  dispose: () => void;
};

export function createContourRenderer(renderContext: SketchRenderContext): ContourRenderer {
  let contourRetainedBackend: ContourRetainedBackend | null = null;

  function destroyContourRetainedBackend() {
    if (!contourRetainedBackend) {
      return;
    }

    const backend = contourRetainedBackend;
    contourRetainedBackend = null;
    backend.gl.deleteProgram(backend.program);
  }

  function isContourRetainedBackendValid(backend: ContourRetainedBackend) {
    const drawingContext = renderContext.getDrawingContext();
    if (!isWebGLContext(drawingContext) || backend.gl !== drawingContext) {
      return false;
    }

    return typeof backend.gl.isContextLost !== 'function' || !backend.gl.isContextLost();
  }

  function getContourRetainedBackend() {
    if (contourRetainedBackend && isContourRetainedBackendValid(contourRetainedBackend)) {
      return contourRetainedBackend;
    }

    destroyContourRetainedBackend();

    const drawingContext = renderContext.getDrawingContext();
    if (!isWebGLContext(drawingContext)) {
      return null;
    }

    const gl = drawingContext;
    const program = createContourProgram(gl);
    if (!program) {
      return null;
    }

    const positionLocation = gl.getAttribLocation(program, 'aPosition');
    const projectionMatrixLocation = gl.getUniformLocation(program, 'uProjectionMatrix');
    const modelViewMatrixLocation = gl.getUniformLocation(program, 'uModelViewMatrix');
    const colorLocation = gl.getUniformLocation(program, 'uColor');

    if (
      positionLocation < 0
      || !projectionMatrixLocation
      || !modelViewMatrixLocation
      || !colorLocation
    ) {
      gl.deleteProgram(program);
      return null;
    }

    contourRetainedBackend = {
      gl,
      program,
      positionLocation,
      projectionMatrixLocation,
      modelViewMatrixLocation,
      colorLocation,
    };

    return contourRetainedBackend;
  }

  return {
    drawLayer(currentScene: SceneState, contourLayer: ContourLayer) {
      const retainedBackend = getContourRetainedBackend();

      if (retainedBackend) {
        ensureContourLayerRenderResources(retainedBackend, contourLayer);

        if (contourLayer.readiness === 'render-ready') {
          drawContourFillRetained(retainedBackend, currentScene, contourLayer, renderContext);
          drawContourLineRetained(retainedBackend, currentScene, contourLayer, renderContext);
        } else {
          drawContourLayerImmediate(currentScene, contourLayer, renderContext);
        }
      } else {
        drawContourLayerImmediate(currentScene, contourLayer, renderContext);
      }
    },
    dispose() {
      destroyContourRetainedBackend();
    },
  };
}

function createContourProgram(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, RETAINED_CONTOUR_VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, RETAINED_CONTOUR_FRAGMENT_SHADER);

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
    console.warn('Failed to link retained contour shader program', gl.getProgramInfoLog(program));
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
    console.warn('Failed to compile retained contour shader', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }

  return shader;
}

function ensureContourLayerRenderResources(
  backend: ContourRetainedBackend,
  contourLayer: ContourLayer,
) {
  if (contourLayer.readiness !== 'geometry-ready') {
    return;
  }

  uploadContourLayerResource(
    backend.gl,
    contourLayer.renderResources.fill,
    contourLayer.geometry.fillVertices,
    backend.gl.TRIANGLES,
  );
  uploadContourLayerResource(
    backend.gl,
    contourLayer.renderResources.line,
    contourLayer.geometry.lineVertices,
    backend.gl.TRIANGLES,
  );

  const fillReady = Boolean(contourLayer.renderResources.fill.handle) || !hasContourVertices(contourLayer.geometry.fillVertices);
  const lineReady = Boolean(contourLayer.renderResources.line.handle) || !hasContourVertices(contourLayer.geometry.lineVertices);

  if (fillReady && lineReady) {
    markContourLayerRenderReady(contourLayer);
  }
}

function uploadContourLayerResource(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  resourceSlot: ContourLayerResourceSlot,
  vertices: ContourVertexData | null,
  drawMode: number,
) {
  disposeContourLayerResourceSlot(resourceSlot);

  if (!vertices || vertices.length === 0) {
    return;
  }

  const buffer = gl.createBuffer();
  if (!buffer) {
    return;
  }

  const data = vertices instanceof Float32Array ? vertices : new Float32Array(vertices);

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  const handle: ContourRenderBuffer = {
    buffer,
    vertexCount: data.length / 3,
    drawMode,
  };

  resourceSlot.handle = handle;
  resourceSlot.dispose = () => {
    gl.deleteBuffer(buffer);
  };
}

function drawContourFillRetained(
  backend: ContourRetainedBackend,
  currentScene: SceneState,
  contourLayer: ContourLayer,
  renderContext: SketchRenderContext,
) {
  const renderer = renderContext.getRenderer();
  if (!renderer) {
    drawContourFillImmediate(currentScene, contourLayer, renderContext);
    return;
  }

  const { gl } = backend;
  const fillHandle = contourLayer.renderResources.fill.handle as ContourRenderBuffer | null;
  const wasCullFaceEnabled = gl.isEnabled(gl.CULL_FACE);
  const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const wasPositionAttribEnabled = Boolean(gl.getVertexAttrib(backend.positionLocation, gl.VERTEX_ATTRIB_ARRAY_ENABLED));

  if (wasCullFaceEnabled) {
    gl.disable(gl.CULL_FACE);
  }

  gl.useProgram(backend.program);
  gl.uniformMatrix4fv(backend.projectionMatrixLocation, false, toFloat32Array(renderer.uPMatrix.mat4));
  gl.uniformMatrix4fv(backend.modelViewMatrixLocation, false, toFloat32Array(renderer.uMVMatrix.mat4));

  if (fillHandle) {
    drawContourRenderBuffer(backend, fillHandle, hexToNormalizedRgba(currentScene.config.colors.background));
  } else {
    drawContourFillImmediate(currentScene, contourLayer, renderContext);
  }

  if (previousArrayBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer);
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  if (!wasPositionAttribEnabled) {
    gl.disableVertexAttribArray(backend.positionLocation);
  }

  gl.useProgram(previousProgram);

  if (wasCullFaceEnabled) {
    gl.enable(gl.CULL_FACE);
  }
}

function drawContourLineRetained(
  backend: ContourRetainedBackend,
  currentScene: SceneState,
  contourLayer: ContourLayer,
  renderContext: SketchRenderContext,
) {
  const renderer = renderContext.getRenderer();
  if (!renderer) {
    drawContourLineImmediate(currentScene, contourLayer, renderContext);
    return;
  }

  const { gl } = backend;
  const lineHandle = contourLayer.renderResources.line.handle as ContourRenderBuffer | null;
  const wasCullFaceEnabled = gl.isEnabled(gl.CULL_FACE);
  const previousProgram = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
  const previousArrayBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING) as WebGLBuffer | null;
  const wasPositionAttribEnabled = Boolean(gl.getVertexAttrib(backend.positionLocation, gl.VERTEX_ATTRIB_ARRAY_ENABLED));

  if (wasCullFaceEnabled) {
    gl.disable(gl.CULL_FACE);
  }

  gl.useProgram(backend.program);
  gl.uniformMatrix4fv(backend.projectionMatrixLocation, false, toFloat32Array(renderer.uPMatrix.mat4));
  gl.uniformMatrix4fv(backend.modelViewMatrixLocation, false, toFloat32Array(renderer.uMVMatrix.mat4));

  if (lineHandle) {
    drawContourRenderBuffer(backend, lineHandle, hexToNormalizedRgba(currentScene.config.colors.outline));
  } else {
    drawContourLineImmediate(currentScene, contourLayer, renderContext);
  }

  if (previousArrayBuffer) {
    gl.bindBuffer(gl.ARRAY_BUFFER, previousArrayBuffer);
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  if (!wasPositionAttribEnabled) {
    gl.disableVertexAttribArray(backend.positionLocation);
  }

  gl.useProgram(previousProgram);

  if (wasCullFaceEnabled) {
    gl.enable(gl.CULL_FACE);
  }
}

function drawContourRenderBuffer(
  backend: ContourRetainedBackend,
  handle: ContourRenderBuffer,
  color: [number, number, number, number],
) {
  const { gl } = backend;

  gl.bindBuffer(gl.ARRAY_BUFFER, handle.buffer);
  gl.enableVertexAttribArray(backend.positionLocation);
  gl.vertexAttribPointer(backend.positionLocation, 3, gl.FLOAT, false, 0, 0);
  gl.uniform4fv(backend.colorLocation, color);
  gl.drawArrays(handle.drawMode, 0, handle.vertexCount);
}

function isWebGLContext(
  context: RenderingContext | null,
): context is WebGLRenderingContext | WebGL2RenderingContext {
  return context instanceof WebGLRenderingContext || context instanceof WebGL2RenderingContext;
}
