import type p5 from "p5";
import type {
  InteractionFrame,
  ParticleCanvasHandle,
  Point2D,
  PersistentStroke,
  TraceStyle,
  UserSettings,
} from "../interaction/types";
import { INTERACTION_CONFIG, particleCountForDensity } from "../interaction/config";
import { createParticleColor, particleColorAt, type ParticleColorState } from "./particle-colors";
import {
  createFieldTransform,
  inverseTransformFieldPoint,
  transformFieldPoint,
  type FieldTransform,
} from "../interaction/field-transform";

// El shader de fondo se ejecuta en WebGL: calcula el color de los píxeles en
// la GPU. La matriz inversa mantiene el fondo alineado con el campo transformado.
const backgroundVertexShader = `
precision highp float;
attribute vec3 aPosition;
attribute vec2 aTexCoord;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
varying vec2 vUv;
void main() {
  vUv = aTexCoord;
  vec4 position = uModelViewMatrix * vec4(aPosition, 1.0);
  gl_Position = uProjectionMatrix * position;
}
`;

const backgroundFragmentShader = `
precision highp float;
uniform float uTime;
uniform vec2 uResolution;
uniform vec2 uFocus;
uniform float uIntensity;
uniform int uMode;
uniform vec4 uFieldInverse;
varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p *= 2.03;
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 uv = vUv;
  vec2 screenOffset = (vec2(uv.x, 1.0 - uv.y) - 0.5) * uResolution;
  vec2 worldOffset = vec2(
    uFieldInverse.x * screenOffset.x + uFieldInverse.z * screenOffset.y,
    uFieldInverse.y * screenOffset.x + uFieldInverse.w * screenOffset.y
  );
  vec2 worldUv = vec2(0.5 + worldOffset.x / uResolution.x, 0.5 - worldOffset.y / uResolution.y);
  vec2 aspectUv = vec2(worldUv.x * uResolution.x / uResolution.y, worldUv.y);
  float time = uTime * 0.035;
  float field = fbm(aspectUv * 2.2 + vec2(time, -time * 0.72));
  field += fbm(aspectUv * 4.1 - vec2(time * 0.6, time)) * 0.34;
  float cloud = smoothstep(0.36, 0.9, field);
  float distanceToFocus = distance(uv, uFocus);
  float focusGlow = exp(-distanceToFocus * 4.2) * 0.25;
  vec3 base = vec3(0.012, 0.014, 0.022);
  vec3 violet = vec3(0.075, 0.035, 0.17);
  vec3 lavender = vec3(0.11, 0.085, 0.16);
  vec3 green = vec3(0.035, 0.10, 0.06);
  vec3 color = mix(base, violet, cloud * 0.82);
  color = mix(color, lavender, smoothstep(0.58, 0.82, field) * 0.62);
  color += focusGlow * vec3(0.25, 0.18, 0.42) * uIntensity;
  if (uMode == 1) color = mix(base, green, cloud * 0.8);
  else if (uMode == 2) color = mix(base, vec3(0.09), cloud);
  else color += green * smoothstep(0.68, 0.92, fbm(aspectUv * 3.2 + time));
  float vignette = smoothstep(0.98, 0.18, distance(uv, vec2(0.5)));
  gl_FragColor = vec4(color * vignette, 1.0);
}
`;

interface EngineOptions {
  container: HTMLElement;
  interactionRef: { current: InteractionFrame };
  settingsRef: { current: UserSettings };
  onReady: (handle: ParticleCanvasHandle) => void;
}

export interface ParticlePerformanceSnapshot {
  fps: number | null;
  frameIntervalMs: number;
  drawTimeMs: number;
  simulationTimeMs: number;
  traceTimeMs: number;
  count: number;
  maximum: number;
  visible: number;
  scale: number;
  quality: string;
}

declare global {
  interface Window {
    __particleDiagnostics?: () => unknown;
    __particlePerformance?: () => ParticlePerformanceSnapshot;
  }
}

// Arrays tipados paralelos: cada índice representa una partícula. La capacidad
// se reserva al inicializarlos y está limitada por el presupuesto configurado.
interface ParticleBuffers {
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  trailX: Float32Array;
  trailY: Float32Array;
  trailTime: Float32Array;
  size: Float32Array;
  phase: Float32Array;
  alpha: Float32Array;
  color: ParticleColorState[];
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const segmentMayBeVisible = (
  x1: number, y1: number, x2: number, y2: number, width: number, height: number,
) => Math.max(x1, x2) >= -2 && Math.min(x1, x2) <= width + 2 &&
  Math.max(y1, y2) >= -2 && Math.min(y1, y2) <= height + 2;

interface TrailSample {
  position: Point2D;
  time: number;
}

interface TrailSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  time: number;
  intensity: number;
}

// Búfer circular acotado: guarda segmentos en pantalla, no geometría de TRACE.
// Los segmentos caducan por edad y, si se llena, se descarta el más antiguo.
class TrailHistory {
  private readonly segments: (TrailSegment | undefined)[];
  private start = 0;
  private length = 0;
  private generated = 0;
  private expired = 0;
  private dropped = 0;
  private cleared = 0;

  constructor(private readonly capacity: number) {
    this.segments = new Array(capacity);
  }

  clear() {
    if (process.env.NODE_ENV !== "production") this.cleared += this.length;
    this.segments.fill(undefined);
    this.start = 0;
    this.length = 0;
  }

  add(segment: TrailSegment) {
    if (this.length === this.capacity) {
      this.start = (this.start + 1) % this.capacity;
      this.length -= 1;
      if (process.env.NODE_ENV !== "production") this.dropped += 1;
    }
    this.segments[(this.start + this.length) % this.capacity] = segment;
    this.length += 1;
    if (process.env.NODE_ENV !== "production") this.generated += 1;
  }

  diagnostics(now: number) {
    const oldest = this.length > 0 ? this.segments[this.start] : undefined;
    return {
      active: this.length,
      capacity: this.capacity,
      generated: this.generated,
      expired: this.expired,
      dropped: this.dropped,
      cleared: this.cleared,
      oldestAgeSeconds: oldest ? now - oldest.time : null,
    };
  }

  render(layer: p5.Graphics, now: number, opacity: number, thickness: number) {
    const lifetime = INTERACTION_CONFIG.trails.lifetimeSeconds;
    while (this.length > 0) {
      const segment = this.segments[this.start]!;
      if (now - segment.time < lifetime) break;
      this.segments[this.start] = undefined;
      this.start = (this.start + 1) % this.capacity;
      this.length -= 1;
      if (process.env.NODE_ENV !== "production") this.expired += 1;
    }

    layer.clear();
    if (this.length === 0) return false;
    // Agrupar por opacidad permite dibujar muchos segmentos con menos llamadas.
    const paths: (Path2D | undefined)[] = new Array(16);
    for (let index = 0; index < this.length; index += 1) {
      const segment = this.segments[(this.start + index) % this.capacity]!;
      const strength = clamp((1 - (now - segment.time) / lifetime) * segment.intensity, 0, 1);
      if (strength <= 0) continue;
      const bucket = Math.min(paths.length - 1, Math.floor(strength * paths.length));
      const path = paths[bucket] ?? (paths[bucket] = new Path2D());
      path.moveTo(segment.x1, segment.y1);
      path.lineTo(segment.x2, segment.y2);
    }

    const context = layer.drawingContext as CanvasRenderingContext2D;
    context.save();
    context.lineWidth = thickness;
    context.lineCap = "round";
    context.strokeStyle = "#f2f0f5";
    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index];
      if (!path) continue;
      context.globalAlpha = clamp((opacity / 255) * (index + 0.5) / paths.length, 0, 1);
      context.stroke(path);
    }
    context.restore();
    return true;
  }
}

const inspectShader = (
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): string[] => {
  const errors: string[] = [];
  const vertex = gl.createShader(gl.VERTEX_SHADER);
  const fragment = gl.createShader(gl.FRAGMENT_SHADER);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return ["Unable to create WebGL shaders."];
  }
  for (const [shader, source, name] of [
    [vertex, vertexSource, "vertex"],
    [fragment, fragmentSource, "fragment"],
  ] as const) {
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      errors.push(`${name}: ${gl.getShaderInfoLog(shader) || "compilation failed"}`);
    }
  }
  if (errors.length === 0) {
    const program = gl.createProgram();
    if (!program) {
      errors.push("Unable to create WebGL program.");
    } else {
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        errors.push(`link: ${gl.getProgramInfoLog(program) || "link failed"}`);
      }
      gl.deleteProgram(program);
    }
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  return errors;
};

const drawStrokePoint = (
  context: CanvasRenderingContext2D,
  point: Point2D,
  style: TraceStyle,
  width: number,
  height: number,
) => {
  const x = point.x * width;
  const y = point.y * height;
  context.save();
  context.globalCompositeOperation = "lighter";
  context.fillStyle = style.color;
  context.shadowColor = style.color;
  context.shadowBlur = style.glow;
  context.globalAlpha = style.opacity;
  context.beginPath();
  context.arc(x, y, Math.max(0.45, style.thickness * 0.45), 0, Math.PI * 2);
  context.fill();
  context.restore();
};

interface CachedStrokePaths {
  points: Point2D[];
  count: number;
  radius: number;
  line: Path2D;
  dots: Path2D;
}

// Reutiliza los Path2D de cada trazo y añade solo los vértices nuevos.
const drawStroke = (
  context: CanvasRenderingContext2D,
  stroke: PersistentStroke,
  style: TraceStyle,
  width: number,
  height: number,
  cache: Map<string, CachedStrokePaths>,
) => {
  if (!stroke.points[0]) return;
  const radius = Math.max(0.45, style.thickness * 0.45);
  let paths = cache.get(stroke.id);
  if (!paths || paths.points !== stroke.points || paths.count > stroke.points.length || paths.radius !== radius) {
    paths = { points: stroke.points, count: 0, radius, line: new Path2D(), dots: new Path2D() };
    cache.set(stroke.id, paths);
  }
  for (let index = paths.count; index < stroke.points.length; index += 1) {
    const point = stroke.points[index];
    const x = point.x * width;
    const y = point.y * height;
    if (index === 0) {
      paths.line.moveTo(x, y);
    } else {
      paths.line.lineTo(x, y);
      paths.dots.moveTo(x + radius, y);
      paths.dots.arc(x, y, radius, 0, Math.PI * 2);
    }
  }
  paths.count = stroke.points.length;
  drawStrokePoint(context, stroke.points[0], style, width, height);
  if (paths.count < 2) return;
  context.save();
  context.globalCompositeOperation = "lighter";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = style.color;
  context.shadowColor = style.color;
  context.globalAlpha = style.opacity * 0.55;
  context.lineWidth = style.thickness + style.glow * 0.25;
  context.shadowBlur = style.glow;
  context.stroke(paths.line);
  context.globalAlpha = style.opacity;
  context.lineWidth = style.thickness;
  context.shadowBlur = style.glow * 0.35;
  context.stroke(paths.line);
  context.fillStyle = style.color;
  context.shadowBlur = style.glow * 0.5;
  context.fill(paths.dots);
  context.restore();
};

const applyFieldTransform = (
  layer: p5.Graphics,
  transform: FieldTransform,
) => {
  layer.applyMatrix(
    transform.a,
    transform.b,
    transform.c,
    transform.d,
    transform.e,
    transform.f,
  );
};

/**
 * Carga p5 y GSAP en el navegador, crea el lienzo y devuelve una función de
 * limpieza. Las refs aportan el estado más reciente sin reconstruir el motor.
 */
export async function createParticleEngine({
  container,
  interactionRef,
  settingsRef,
  onReady,
}: EngineOptions): Promise<() => void> {
  const [p5Module, gsapModule] = await Promise.all([import("p5"), import("gsap")]);
  const P5 = p5Module.default;
  const gsap = gsapModule.gsap;
  let particleCount = particleCountForDensity(settingsRef.current.density);
  let initializedParticleCount = particleCount;
  let particles: ParticleBuffers;
  let particleTrailLayer: p5.Graphics | null = null;
  let traceTrailLayer: p5.Graphics | null = null;
  let transformedDrawingLayer: p5.Graphics | null = null;
  let paused = false;
  let destroyed = false;
  let backgroundProgram: p5.Shader;
  let instance: p5 | null = null;
  let lastTime = 0;
  let lastStrokeVersion = -1;
  let lastClearVersion = 0;
  let lastTraceTrailStrokeVersion = -1;
  let lastTraceTrailScale = Number.NaN;
  let lastTraceTrailRotation = Number.NaN;
  let traceTrailStride: number = INTERACTION_CONFIG.trails.traceSampleStride;
  let lastDisplayedStrokeVersion = -1;
  let lastDisplayedScale = Number.NaN;
  let lastDisplayedRotation = Number.NaN;
  let clearingStartedAt: number | null = null;
  let completedFrames = 0;
  let lastCompletedFrameAt = 0;
  let lastFrameStartedAt = 0;
  let frameIntervalMs = 0;
  let drawTimeMs = 0;
  let simulationTimeMs = 0;
  let traceTimeMs = 0;
  let visibleParticleCount = 0;
  let diagnostics: (() => unknown) | undefined;
  let performanceSnapshot: (() => ParticlePerformanceSnapshot) | undefined;
  let visibleStrokes: PersistentStroke[] = [];
  const strokePaths = new Map<string, CachedStrokePaths>();
  const traceTrailPositions = new Map<string, TrailSample[]>();
  const particleHistory = new TrailHistory(12000);
  const traceHistory = new TrailHistory(12000);
  let lastMouseTrailSample: TrailSample | null = null;

  const initializeParticles = (buffers: ParticleBuffers, start: number, end: number, width: number, height: number) => {
    const now = instance ? instance.millis() * 0.001 : 0;
    for (let index = start; index < end; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.pow(Math.random(), 0.66) * 0.54;
      buffers.x[index] = width * (0.5 + Math.cos(angle) * radius);
      buffers.y[index] = height * (0.5 + Math.sin(angle) * radius);
      buffers.vx[index] = (Math.random() - 0.5) * 0.18;
      buffers.vy[index] = (Math.random() - 0.5) * 0.18;
      buffers.size[index] = Math.random() * 2.1 + 0.7;
      buffers.phase[index] = Math.random() * 1000;
      buffers.alpha[index] = 1;
      buffers.color[index] = createParticleColor(now);
    }
  };

  const makeParticles = (count: number, width: number, height: number) => {
    const capacity = INTERACTION_CONFIG.particles.maximumCount;
    const buffers: ParticleBuffers = {
      x: new Float32Array(capacity),
      y: new Float32Array(capacity),
      vx: new Float32Array(capacity),
      vy: new Float32Array(capacity),
      trailX: new Float32Array(capacity).fill(Number.NaN),
      trailY: new Float32Array(capacity).fill(Number.NaN),
      trailTime: new Float32Array(capacity).fill(Number.NaN),
      size: new Float32Array(capacity),
      phase: new Float32Array(capacity),
      alpha: new Float32Array(capacity),
      color: new Array<ParticleColorState>(capacity),
    };
    initializeParticles(buffers, 0, count, width, height);
    initializedParticleCount = count;
    return buffers;
  };
  particles = makeParticles(particleCount, 1, 1);

  // Al cambiar dimensiones se regeneran las partículas y las capas dependientes
  // de píxeles; los trazos persistentes siguen en el estado del reconocedor.
  const resizeCanvases = (width: number, height: number) => {
    if (!instance || destroyed) return;
    instance.resizeCanvas(width, height, true);
    particleTrailLayer?.resizeCanvas(width, height);
    particleTrailLayer?.clear();
    particleHistory.clear();
    traceTrailLayer?.resizeCanvas(width, height);
    traceTrailLayer?.clear();
    traceHistory.clear();
    traceTrailPositions.clear();
    lastMouseTrailSample = null;
    lastTraceTrailStrokeVersion = -1;
    lastTraceTrailScale = Number.NaN;
    lastTraceTrailRotation = Number.NaN;
    transformedDrawingLayer?.resizeCanvas(width, height);
    transformedDrawingLayer?.clear();
    strokePaths.clear();
    lastStrokeVersion = -1;
    lastDisplayedStrokeVersion = -1;
    lastDisplayedScale = Number.NaN;
    lastDisplayedRotation = Number.NaN;
    particles = makeParticles(particleCount, width, height);
  };

  const sketch = (p: p5) => {
    instance = p;

    // p5 llama setup una vez y draw en su bucle de animación del navegador.
    p.setup = () => {
      if (destroyed) return;
      const width = Math.max(container.clientWidth, window.innerWidth);
      const height = Math.max(container.clientHeight, window.innerHeight);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.75);
      p.pixelDensity(pixelRatio);
      p.createCanvas(width, height, p.WEBGL);
      p.noStroke();
      p.frameRate(60);
      particleTrailLayer = p.createGraphics(width, height);
      particleTrailLayer.pixelDensity(1);
      traceTrailLayer = p.createGraphics(width, height);
      traceTrailLayer.pixelDensity(1);
      transformedDrawingLayer = p.createGraphics(width, height);
      transformedDrawingLayer.pixelDensity(1);
      particles = makeParticles(particleCount, width, height);
      backgroundProgram = p.createShader(backgroundVertexShader, backgroundFragmentShader);
      if (process.env.NODE_ENV !== "production") {
        performanceSnapshot = () => ({
          fps: frameIntervalMs > 0 ? 1000 / frameIntervalMs : null,
          frameIntervalMs,
          drawTimeMs,
          simulationTimeMs,
          traceTimeMs,
          count: particleCount,
          maximum: INTERACTION_CONFIG.particles.maximumCount,
          visible: visibleParticleCount,
          scale: interactionRef.current.universeScale,
          quality: p.pixelDensity() > 1.25 ? "FULL" : "EFFICIENT",
        });
        window.__particlePerformance = performanceSnapshot;
        diagnostics = () => {
          const now = p.millis() * 0.001;
          const state = interactionRef.current;
          const transform = createFieldTransform(
            p.width, p.height, state.universeScale, state.universeRotation,
          );
          const point: Point2D = { x: 0, y: 0 };
          let invalidParticles = 0;
          let invalidTracePoints = 0;
          let tracePoints = 0;
          let outsideViewport = 0;
          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;
          const inspectPoint = (x: number, y: number) => {
            transformFieldPoint(x, y, transform, point);
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
            if (point.x < 0 || point.x > p.width || point.y < 0 || point.y > p.height) {
              outsideViewport += 1;
            }
            return true;
          };
          for (let index = 0; index < particleCount; index += 1) {
            if (!inspectPoint(particles.x[index], particles.y[index])) invalidParticles += 1;
          }
          for (const stroke of state.strokes) {
            for (const vertex of stroke.points) {
              tracePoints += 1;
              if (!inspectPoint(vertex.x * p.width, vertex.y * p.height)) invalidTracePoints += 1;
            }
          }
          const gl = p.drawingContext as WebGLRenderingContext | WebGL2RenderingContext;
          return {
            loop: {
              paused,
              scheduled: !paused && !destroyed,
              completedFrames,
              lastCompletedFrameAgeMs: lastCompletedFrameAt
                ? performance.now() - lastCompletedFrameAt
                : null,
              documentVisibility: document.visibilityState,
            },
            canvas: { width: p.width, height: p.height },
            particles: {
              count: particleCount,
              maximum: INTERACTION_CONFIG.particles.maximumCount,
              visible: visibleParticleCount,
              invalid: invalidParticles,
            },
            performance: performanceSnapshot?.(),
            trace: { strokes: state.strokes.length, points: tracePoints, invalid: invalidTracePoints },
            transformedOutsideViewport: outsideViewport,
            transformedBounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null,
            trails: { particle: particleHistory.diagnostics(now), trace: traceHistory.diagnostics(now) },
            webgl: {
              contextLost: gl.isContextLost(),
              error: gl.getError(),
              backgroundShaderErrors: inspectShader(gl, backgroundVertexShader, backgroundFragmentShader),
            },
          };
        };
        window.__particleDiagnostics = diagnostics;
      }
      onReady({
        pause: () => {
          paused = true;
          p.noLoop();
        },
        resume: () => {
          paused = false;
          p.loop();
        },
        reset: () => {
          particles = makeParticles(particleCount, p.width, p.height);
          particleTrailLayer?.clear();
          traceTrailLayer?.clear();
          particleHistory.clear();
          traceHistory.clear();
          traceTrailPositions.clear();
          lastMouseTrailSample = null;
          lastTraceTrailStrokeVersion = -1;
          lastTraceTrailScale = Number.NaN;
          lastTraceTrailRotation = Number.NaN;
          lastTime = 0;
        },
        capture: () => {
          p.saveCanvas("one-with-nothingness", "png");
        },
      });
    };

    // Cada fotograma toma una instantánea de las refs, simula, transforma y
    // compone las capas; delta acotado evita saltos grandes tras una pausa.
    p.draw = () => {
      if (paused || !particles || !particleTrailLayer || !traceTrailLayer || destroyed) return;
      const frameStartedAt = process.env.NODE_ENV !== "production" ? performance.now() : 0;
      const now = p.millis() * 0.001;
      const delta = lastTime ? clamp(now - lastTime, 0.001, 0.04) : 1 / 60;
      lastTime = now;
      const width = p.width;
      const height = p.height;
      const state = interactionRef.current;
      const fieldTransform = createFieldTransform(
        width,
        height,
        state.universeScale,
        state.universeRotation,
      );
      const { intensity, persistence, density, mode } = settingsRef.current;
      const trailLayer = particleTrailLayer;
      const traceLayer = traceTrailLayer;
      const activeHands = state.hands;
      const transformedPoint: Point2D = { x: 0, y: 0 };
      const focus =
        activeHands.find((hand) => hand.handedness === "Right")?.center ??
        activeHands[0]?.center ??
        state.mouse;
      const collapsing =
        !state.clearActive && activeHands.some((hand) => hand.interaction === "collapse");

      const requestedParticleCount = particleCountForDensity(density);
      if (requestedParticleCount !== particleCount) {
        if (requestedParticleCount > particleCount) {
          if (requestedParticleCount > initializedParticleCount) {
            initializeParticles(particles, initializedParticleCount, requestedParticleCount, width, height);
            initializedParticleCount = requestedParticleCount;
          }
          particles.trailX.fill(Number.NaN, particleCount, requestedParticleCount);
          particles.trailY.fill(Number.NaN, particleCount, requestedParticleCount);
          particles.trailTime.fill(Number.NaN, particleCount, requestedParticleCount);
        }
        particleCount = requestedParticleCount;
      }

      p.clear();
      p.shader(backgroundProgram);
      backgroundProgram.setUniform("uTime", now);
      backgroundProgram.setUniform("uResolution", [
        width * p.pixelDensity(),
        height * p.pixelDensity(),
      ]);
      backgroundProgram.setUniform("uFocus", [focus.x, 1 - focus.y]);
      backgroundProgram.setUniform("uIntensity", intensity / 100);
      backgroundProgram.setUniform("uMode", mode === "monochrome" ? 2 : mode === "filament" ? 1 : 0);
      const determinant = fieldTransform.a * fieldTransform.d - fieldTransform.b * fieldTransform.c;
      backgroundProgram.setUniform("uFieldInverse", [
        fieldTransform.d / determinant,
        -fieldTransform.b / determinant,
        -fieldTransform.c / determinant,
        fieldTransform.a / determinant,
      ]);
      p.rect(-width / 2, -height / 2, width, height);
      p.resetShader();

      const fieldScale = Math.hypot(fieldTransform.a, fieldTransform.b);
      const forceRange = Math.min(width, height) * INTERACTION_CONFIG.forces.rangeRatio / fieldScale;
      const forceRangeSquared = forceRange * forceRange;
      const minimumForceDistanceSquared = 2 / (fieldScale * fieldScale);
      const forceStrength =
        settingsRef.current.interaction.gravityStrength *
        (intensity / 100) *
        settingsRef.current.interaction.forceMultiplier / fieldScale;
      // Las fuerzas actúan en el espacio del campo, por eso los puntos de
      // pantalla de manos y ratón pasan primero por la matriz inversa.
      const forceTargets = activeHands.map((hand) => {
        const target = hand.interaction === "collapse" ? hand.pinchPoint : hand.center;
        const point: Point2D = { x: 0, y: 0 };
        inverseTransformFieldPoint(target.x * width, target.y * height, fieldTransform, point);
        return point;
      });
      const mouseTarget: Point2D = { x: 0, y: 0 };
      inverseTransformFieldPoint(
        state.mouse.x * width, state.mouse.y * height, fieldTransform, mouseTarget,
      );
      const trailIntensity =
        persistence / INTERACTION_CONFIG.trails.defaultIntensity;
      const particleTrailDistanceSquared =
        INTERACTION_CONFIG.trails.particleSampleDistance ** 2;
      const traceTrailDistanceSquared =
        INTERACTION_CONFIG.trails.traceSampleDistance ** 2;
      const particleTrailInterval =
        INTERACTION_CONFIG.trails.particleSampleIntervalSeconds;
      const traceTrailInterval =
        INTERACTION_CONFIG.trails.traceSampleIntervalSeconds;
      const particleTrailStride = INTERACTION_CONFIG.trails.particleSampleStride;
      const maximumTrailDistanceSquared = (Math.min(width, height) * 0.4) ** 2;
      const particleTrailAlpha =
        INTERACTION_CONFIG.trails.particleOpacity * trailIntensity;
      const traceTrailAlpha = INTERACTION_CONFIG.trails.traceOpacity;
      const damping = Math.pow(0.986, delta * 60);
      const phaseTime = now * 0.18;
      const flowTime = now * 0.15;
      const shimmerTime = now * 0.7;
      const simulationStartedAt = process.env.NODE_ENV !== "production" ? performance.now() : 0;

      // Las partículas mantienen posición y velocidad propias; GRAVITY y
      // COLLAPSE aplican atracción con caída gradual según la distancia.
      for (let index = 0; index < particleCount; index += 1) {
        let x = particles.x[index];
        let y = particles.y[index];
        let vx = particles.vx[index];
        let vy = particles.vy[index];
        const phase = particles.phase[index];
        const angle =
          Math.sin(y * 0.004 + phaseTime + phase) *
          Math.cos(x * 0.003 - flowTime);
        vx += Math.cos(angle) * 0.11 * delta;
        vy += Math.sin(angle) * 0.11 * delta;

        for (let handIndex = 0; !state.clearActive && handIndex < activeHands.length; handIndex += 1) {
          const hand = activeHands[handIndex];
          if (hand.forceMode === "none") continue;
          const target = forceTargets[handIndex];
          const dx = x - target.x;
          const dy = y - target.y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared > forceRangeSquared || distanceSquared < minimumForceDistanceSquared) continue;

          const distance = Math.sqrt(distanceSquared);
          const falloff = Math.pow(1 - distance / forceRange, 2);
          const gestureStrength = hand.interaction === "collapse"
            ? INTERACTION_CONFIG.forces.collapseMultiplier
            : 1;
          const acceleration = forceStrength * falloff * gestureStrength;
          vx -= (dx / distance) * acceleration * delta;
          vy -= (dy / distance) * acceleration * delta;
          if (hand.interaction === "collapse") {
            particles.alpha[index] = Math.max(0.12, particles.alpha[index] - 0.012);
          }
        }
        if (!collapsing) particles.alpha[index] = 1;

        if (state.mouseActive && activeHands.length === 0) {
          const dx = x - mouseTarget.x;
          const dy = y - mouseTarget.y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < forceRangeSquared && distanceSquared > minimumForceDistanceSquared) {
            const distance = Math.sqrt(distanceSquared);
            const force = (forceStrength * (1 - distance / forceRange) * delta) / distance;
            const direction = state.mousePressed ? -1 : 1;
            vx -= dx * force * 0.001 * direction;
            vy -= dy * force * 0.001 * direction;
          }
        }

        const maxSpeed = INTERACTION_CONFIG.forces.maximumSpeed;
        vx = clamp(vx * damping, -maxSpeed, maxSpeed);
        vy = clamp(vy * damping, -maxSpeed, maxSpeed);
        x += vx * delta;
        y += vy * delta;

        if (x < -12) x = width + 12;
        else if (x > width + 12) x = -12;
        if (y < -12) y = height + 12;
        else if (y > height + 12) y = -12;

        particles.x[index] = x;
        particles.y[index] = y;
        particles.vx[index] = vx;
        particles.vy[index] = vy;

        // Las estelas muestrean posiciones ya transformadas, con distancia y
        // tiempo mínimos. No se incorporan a la simulación ni a los trazos.
        if (index % particleTrailStride !== 0) continue;
        transformFieldPoint(x, y, fieldTransform, transformedPoint);
        const trailX = particles.trailX[index];
        const trailY = particles.trailY[index];
        const trailTime = particles.trailTime[index];
        if (
          !Number.isFinite(trailX) ||
          !Number.isFinite(trailY) ||
          !Number.isFinite(trailTime)
        ) {
          particles.trailX[index] = transformedPoint.x;
          particles.trailY[index] = transformedPoint.y;
          particles.trailTime[index] = now;
        } else {
          const dx = transformedPoint.x - trailX;
          const dy = transformedPoint.y - trailY;
          const distanceSquared = dx * dx + dy * dy;
          if (
            distanceSquared >= particleTrailDistanceSquared &&
            now - trailTime >= particleTrailInterval
          ) {
            if (
              distanceSquared <= maximumTrailDistanceSquared &&
              segmentMayBeVisible(trailX, trailY, transformedPoint.x, transformedPoint.y, width, height)
            ) {
              const sampleIntensity =
                particles.alpha[index] *
                (0.75 + 0.25 * Math.sin(shimmerTime + phase));
              particleHistory.add({
                x1: trailX, y1: trailY,
                x2: transformedPoint.x, y2: transformedPoint.y,
                time: now, intensity: sampleIntensity,
              });
            }
            particles.trailX[index] = transformedPoint.x;
            particles.trailY[index] = transformedPoint.y;
            particles.trailTime[index] = now;
          }
        }
      }

      const simulationEndedAt = process.env.NODE_ENV !== "production" ? performance.now() : 0;
      particleHistory.render(
        trailLayer, now, particleTrailAlpha, INTERACTION_CONFIG.trails.particleThickness,
      );
      // p5 POINTS usa su propio shader; dibujamos los puntos en la capa 2D.
      const particleContext = trailLayer.drawingContext as CanvasRenderingContext2D;
      particleContext.save();
      const particleScale = Math.hypot(fieldTransform.a, fieldTransform.b);
      let renderedParticles = 0;
      for (let index = 0; index < particleCount; index += 1) {
        transformFieldPoint(particles.x[index], particles.y[index], fieldTransform, transformedPoint);
        const radius = Math.max(0.35, particles.size[index] * particleScale / 2);
        if (
          transformedPoint.x + radius < 0 || transformedPoint.x - radius > width ||
          transformedPoint.y + radius < 0 || transformedPoint.y - radius > height
        ) continue;
        renderedParticles += 1;
        const phase = particles.phase[index];
        particleContext.fillStyle = particleColorAt(particles.color[index], now, mode);
        particleContext.globalAlpha = clamp(
          ((80 + Math.sin(shimmerTime + phase) * 45) * particles.alpha[index]) / 255,
          0,
          1,
        );
        particleContext.beginPath();
        particleContext.arc(
          transformedPoint.x, transformedPoint.y,
          radius, 0, Math.PI * 2,
        );
        particleContext.fill();
      }
      particleContext.restore();
      p.push();
      p.blendMode(p.ADD);
      p.image(trailLayer, -width / 2, -height / 2, width, height);
      p.blendMode(p.BLEND);
      p.pop();

      p.push();
      p.resetShader();
      p.noFill();
      p.stroke(160, 138, 191, 17);
      p.strokeWeight(0.55);
      p.beginShape(p.LINES);
      for (let index = 0; index < particleCount; index += 8) {
        const neighbor = index + 29;
        if (neighbor >= particleCount) continue;
        const dx = particles.x[neighbor] - particles.x[index];
        const dy = particles.y[neighbor] - particles.y[index];
        if (dx * dx + dy * dy >= 4100) continue;

        transformFieldPoint(
          particles.x[index],
          particles.y[index],
          fieldTransform,
          transformedPoint,
        );
        p.vertex(transformedPoint.x - width / 2, transformedPoint.y - height / 2);
        transformFieldPoint(
          particles.x[neighbor],
          particles.y[neighbor],
          fieldTransform,
          transformedPoint,
        );
        p.vertex(transformedPoint.x - width / 2, transformedPoint.y - height / 2);
      }
      p.endShape();
      p.pop();

      for (const hand of activeHands) {
        if (hand.interaction !== "collapse") continue;
        const x = hand.pinchPoint.x * width - width / 2;
        const y = hand.pinchPoint.y * height - height / 2;
        const pulse = 25 + Math.sin(now * 5) * 3;
        p.push();
        p.resetShader();
        p.noFill();
        p.stroke(154, 217, 108, 155);
        p.strokeWeight(1.5);
        p.ellipse(x, y, pulse, pulse);
        p.stroke(160, 138, 191, 110);
        p.strokeWeight(1);
        p.ellipse(x, y, pulse * 0.58, pulse * 0.58);
        p.noStroke();
        p.fill(7, 7, 11, 185);
        p.ellipse(x, y, pulse * 0.28, pulse * 0.28);
        p.pop();
      }

      const traceStartedAt = process.env.NODE_ENV !== "production" ? performance.now() : 0;
      if (transformedDrawingLayer) {
        if (state.clearVersion !== lastClearVersion) {
          lastClearVersion = state.clearVersion;
          clearingStartedAt = now;
          traceHistory.clear();
          traceLayer.clear();
          traceTrailPositions.clear();
          lastMouseTrailSample = null;
          lastTraceTrailStrokeVersion = -1;
        }

        if (clearingStartedAt !== null) {
          const progress = clamp(
            (now - clearingStartedAt) /
              (INTERACTION_CONFIG.gestures.clearFadeMs / 1000),
            0,
            1,
          );
          if (progress >= 1) {
            visibleStrokes = [];
            strokePaths.clear();
            lastStrokeVersion = -1;
            lastDisplayedStrokeVersion = -1;
            clearingStartedAt = null;
          }
        }
        if (clearingStartedAt === null && state.strokeVersion !== lastStrokeVersion) {
          visibleStrokes = [...state.strokes];
          lastStrokeVersion = state.strokeVersion;
        }

        // La capa persistente solo se redibuja si cambia la geometría o la
        // transformación; las estelas se calculan y caducan por separado.
        if (
          lastStrokeVersion !== lastDisplayedStrokeVersion ||
          state.universeScale !== lastDisplayedScale ||
          state.universeRotation !== lastDisplayedRotation
        ) {
          transformedDrawingLayer.clear();
          transformedDrawingLayer.push();
          applyFieldTransform(transformedDrawingLayer, fieldTransform);
          const context = transformedDrawingLayer.drawingContext as CanvasRenderingContext2D;
          for (const stroke of visibleStrokes) {
            const style = {
              ...stroke.style,
              thickness: Math.max(stroke.style.thickness, 0.75 / fieldScale),
            };
            if (stroke.points[0]) {
              drawStroke(context, stroke, style, width, height, strokePaths);
            }
          }
          transformedDrawingLayer.pop();
          lastDisplayedStrokeVersion = lastStrokeVersion;
          lastDisplayedScale = state.universeScale;
          lastDisplayedRotation = state.universeRotation;
        }

        if (
          state.strokeVersion !== lastTraceTrailStrokeVersion ||
          state.universeScale !== lastTraceTrailScale ||
          state.universeRotation !== lastTraceTrailRotation
        ) {
          if (state.strokeVersion !== lastTraceTrailStrokeVersion) {
            const pointCount = state.strokes.reduce((total, stroke) => total + stroke.points.length, 0);
            // Repartir el muestreo entre trazos limita el trabajo en dibujos largos.
            const nextStride = Math.max(
              INTERACTION_CONFIG.trails.traceSampleStride,
              Math.ceil(pointCount / INTERACTION_CONFIG.trails.maximumTrackedTracePoints),
            );
            if (nextStride !== traceTrailStride) {
              traceTrailPositions.clear();
              traceTrailStride = nextStride;
            }
          }
          let pointOffset = 0;
          for (const stroke of state.strokes) {
            let lastPositions = traceTrailPositions.get(stroke.id);
            if (!lastPositions) {
              lastPositions = [];
              traceTrailPositions.set(stroke.id, lastPositions);
            }
            const firstIndex = (traceTrailStride - pointOffset % traceTrailStride) % traceTrailStride;
            for (let pointIndex = firstIndex; pointIndex < stroke.points.length; pointIndex += traceTrailStride) {
              const point = stroke.points[pointIndex];
              transformFieldPoint(
                point.x * width,
                point.y * height,
                fieldTransform,
                transformedPoint,
              );
              const previous = lastPositions[pointIndex];
              if (!previous || now - previous.time >= INTERACTION_CONFIG.trails.lifetimeSeconds) {
                lastPositions[pointIndex] = {
                  position: { ...transformedPoint },
                  time: now,
                };
                continue;
              }
              const dx = transformedPoint.x - previous.position.x;
              const dy = transformedPoint.y - previous.position.y;
              const distanceSquared = dx * dx + dy * dy;
              if (
                distanceSquared < traceTrailDistanceSquared ||
                now - previous.time < traceTrailInterval
              ) {
                continue;
              }

              if (
                distanceSquared <= maximumTrailDistanceSquared &&
                segmentMayBeVisible(
                  previous.position.x, previous.position.y,
                  transformedPoint.x, transformedPoint.y, width, height,
                )
              ) {
                traceHistory.add({
                  x1: previous.position.x, y1: previous.position.y,
                  x2: transformedPoint.x, y2: transformedPoint.y,
                  time: now, intensity: 1,
                });
              }
              lastPositions[pointIndex] = {
                position: { ...transformedPoint },
                time: now,
              };
            }
            lastPositions.length = stroke.points.length;
            pointOffset += stroke.points.length;
          }
          lastTraceTrailStrokeVersion = state.strokeVersion;
          lastTraceTrailScale = state.universeScale;
          lastTraceTrailRotation = state.universeRotation;
        }

        if (activeHands.length === 0 && state.mousePressed) {
          transformedPoint.x = state.mouse.x * width;
          transformedPoint.y = state.mouse.y * height;
          if (lastMouseTrailSample) {
            const dx = transformedPoint.x - lastMouseTrailSample.position.x;
            const dy = transformedPoint.y - lastMouseTrailSample.position.y;
            const distanceSquared = dx * dx + dy * dy;
            if (
              distanceSquared >= traceTrailDistanceSquared &&
              now - lastMouseTrailSample.time >= traceTrailInterval
            ) {
              if (distanceSquared <= maximumTrailDistanceSquared) {
                traceHistory.add({
                  x1: lastMouseTrailSample.position.x, y1: lastMouseTrailSample.position.y,
                  x2: transformedPoint.x, y2: transformedPoint.y,
                  time: now, intensity: 1,
                });
              }
              lastMouseTrailSample = {
                position: { ...transformedPoint },
                time: now,
              };
            }
          } else {
            lastMouseTrailSample = {
              position: { ...transformedPoint },
              time: now,
            };
          }
        } else {
          lastMouseTrailSample = null;
        }

        const hasTraceTrail = traceHistory.render(
          traceLayer, now, traceTrailAlpha, INTERACTION_CONFIG.trails.traceThickness,
        );
        if (hasTraceTrail) {
          p.push();
          p.blendMode(p.ADD);
          p.image(traceLayer, -width / 2, -height / 2, width, height);
          p.blendMode(p.BLEND);
          p.pop();
        }

        p.push();
        if (clearingStartedAt !== null) {
          const opacity = 1 - clamp(
            (now - clearingStartedAt) /
              (INTERACTION_CONFIG.gestures.clearFadeMs / 1000),
            0,
            1,
          );
          p.push();
          p.tint(255, opacity * 255);
          p.image(transformedDrawingLayer, -width / 2, -height / 2, width, height);
          p.noTint();
          p.pop();
        } else {
          p.image(transformedDrawingLayer, -width / 2, -height / 2, width, height);
        }
        p.pop();
      }
      const traceEndedAt = process.env.NODE_ENV !== "production" ? performance.now() : 0;

      for (const cursor of state.cursors) {
        const x = cursor.position.x * width - width / 2;
        const y = cursor.position.y * height - height / 2;
        const brush = cursor.mode === "TRACE";
        const diameter = brush ? 20 : 14;
        p.push();
        p.resetShader();
        p.noFill();
        p.stroke(brush ? 154 : 242, brush ? 217 : 240, brush ? 108 : 245, 220);
        p.strokeWeight(1.2);
        p.ellipse(x, y, diameter, diameter);
        if (brush) {
          p.stroke(154, 217, 108, 130);
          p.strokeWeight(3);
          p.ellipse(x, y, diameter + 5, diameter + 5);
        } else {
          p.stroke(242, 240, 245, 150);
          p.line(x - 3, y, x + 3, y);
          p.line(x, y - 3, x, y + 3);
        }
        p.pop();
      }
      if (process.env.NODE_ENV !== "production") {
        completedFrames += 1;
        const finishedAt = performance.now();
        const interval = frameStartedAt - lastFrameStartedAt;
        if (lastFrameStartedAt && interval > 0 && interval < 1000) {
          frameIntervalMs = frameIntervalMs ? frameIntervalMs * 0.9 + interval * 0.1 : interval;
        }
        const smooth = (previous: number, current: number) =>
          previous ? previous * 0.9 + current * 0.1 : current;
        drawTimeMs = smooth(drawTimeMs, finishedAt - frameStartedAt);
        simulationTimeMs = smooth(simulationTimeMs, simulationEndedAt - simulationStartedAt);
        traceTimeMs = smooth(traceTimeMs, traceEndedAt - traceStartedAt);
        visibleParticleCount = renderedParticles;
        lastFrameStartedAt = frameStartedAt;
        lastCompletedFrameAt = finishedAt;
      }
    };

    p.windowResized = () => {
      if (!instance || destroyed) return;
      const width = Math.max(container.clientWidth, window.innerWidth);
      const height = Math.max(container.clientHeight, window.innerHeight);
      resizeCanvases(width, height);
    };
  };

  const resizeObserver = new ResizeObserver(() => {
    if (!instance || destroyed) return;
    const width = Math.max(container.clientWidth, window.innerWidth);
    const height = Math.max(container.clientHeight, window.innerHeight);
    if (instance.width !== width || instance.height !== height) {
      resizeCanvases(width, height);
    }
  });
  resizeObserver.observe(container);

  // React llama a esta limpieza al desmontar: desconecta observadores y libera
  // el lienzo, las capas y los diagnósticos de desarrollo.
  const cleanup = () => {
    destroyed = true;
    resizeObserver.disconnect();
    gsap.killTweensOf(container);
    if (process.env.NODE_ENV !== "production" && window.__particleDiagnostics === diagnostics) {
      delete window.__particleDiagnostics;
    }
    if (process.env.NODE_ENV !== "production" && window.__particlePerformance === performanceSnapshot) {
      delete window.__particlePerformance;
    }
    instance?.remove();
    instance = null;
    particleTrailLayer = null;
    traceTrailLayer = null;
    transformedDrawingLayer = null;
  };

  try {
    new P5(sketch, container);
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}
