import type p5 from "p5";
import type {
  InteractionFrame,
  ParticleCanvasHandle,
  Point2D,
  TraceStyle,
  UserSettings,
} from "../interaction/types";
import { INTERACTION_CONFIG } from "../interaction/config";

const vertexShader = `
precision highp float;
attribute vec3 aPosition;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
uniform float uPointSize;
uniform float uTime;
uniform vec4 uFieldLinear;
varying float vPhase;
varying vec3 vPosition;

void main() {
  vec2 fieldPosition = vec2(
    uFieldLinear.x * aPosition.x + uFieldLinear.z * aPosition.y,
    uFieldLinear.y * aPosition.x + uFieldLinear.w * aPosition.y
  );
  vec4 position = uModelViewMatrix * vec4(fieldPosition, aPosition.z, 1.0);
  gl_Position = uProjectionMatrix * position;
  gl_PointSize = uPointSize * (0.65 + 0.35 * sin(uTime + aPosition.z * 0.03));
  vPhase = aPosition.z;
  vPosition = aPosition;
}
`;

const fragmentShader = `
precision highp float;
uniform float uTime;
uniform float uIntensity;
uniform int uMode;
uniform vec2 uResolution;
uniform vec2 uFocus;
varying float vPhase;
varying vec3 vPosition;

void main() {
  vec2 point = gl_PointCoord - 0.5;
  float radius = length(point);
  float core = 1.0 - smoothstep(0.05, 0.5, radius);
  float halo = exp(-radius * 10.0) * 0.42;
  float shimmer = 0.78 + 0.22 * sin(uTime * 1.7 + vPhase * 0.07);
  vec3 violet = vec3(0.337, 0.125, 0.914);
  vec3 lavender = vec3(0.627, 0.541, 0.749);
  vec3 green = vec3(0.604, 0.851, 0.424);
  vec3 yellow = vec3(0.851, 0.678, 0.161);
  float blend = 0.5 + 0.5 * sin(vPhase * 0.013 + uTime * 0.24);
  vec3 color = mix(violet, lavender, blend);
  color = mix(color, green, smoothstep(0.72, 0.98, sin(vPhase * 0.006 + uTime * 0.12)));
  color = mix(color, yellow, smoothstep(0.9, 1.0, sin(vPhase * 0.017 + uTime * 0.18)) * 0.5);
  if (uMode == 1) color = mix(green, lavender, blend);
  if (uMode == 2) color = mix(vec3(0.42), vec3(0.95), core);
  float focus = exp(-distance(gl_FragCoord.xy / uResolution, uFocus) * 2.5);
  color += focus * vec3(0.08, 0.05, 0.16);
  gl_FragColor = vec4(color * shimmer * uIntensity, (core + halo) * 0.86);
}
`;

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
  vec2 aspectUv = vec2(uv.x * uResolution.x / uResolution.y, uv.y);
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
  onQuality: (quality: string) => void;
}

declare global {
  interface Window {
    __particleDiagnostics?: () => unknown;
  }
}

interface ParticleBuffers {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  trailX: Float32Array;
  trailY: Float32Array;
  trailTime: Float32Array;
  size: Float32Array;
  phase: Float32Array;
  alpha: Float32Array;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

interface FieldTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

interface TrailSample {
  position: Point2D;
  time: number;
}

const createFieldTransform = (
  width: number,
  height: number,
  scale: number,
  rotation: number,
): FieldTransform => {
  const cosine = Math.cos(rotation) * scale;
  const sine = Math.sin(rotation) * scale;
  return {
    a: cosine,
    b: sine,
    c: -sine,
    d: cosine,
    e: width / 2 - cosine * width / 2 + sine * height / 2,
    f: height / 2 - sine * width / 2 - cosine * height / 2,
  };
};

const transformFieldPoint = (
  x: number,
  y: number,
  transform: FieldTransform,
  point: Point2D,
) => {
  point.x = transform.a * x + transform.c * y + transform.e;
  point.y = transform.b * x + transform.d * y + transform.f;
};

interface TrailSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  time: number;
  intensity: number;
}

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
    const paths = Array.from({ length: 16 }, () => new Path2D());
    for (let index = 0; index < this.length; index += 1) {
      const segment = this.segments[(this.start + index) % this.capacity]!;
      const strength = clamp((1 - (now - segment.time) / lifetime) * segment.intensity, 0, 1);
      if (strength <= 0) continue;
      const path = paths[Math.min(paths.length - 1, Math.floor(strength * paths.length))];
      path.moveTo(segment.x1, segment.y1);
      path.lineTo(segment.x2, segment.y2);
    }

    const context = layer.drawingContext as CanvasRenderingContext2D;
    context.save();
    context.lineWidth = thickness;
    context.lineCap = "round";
    context.strokeStyle = "#f2f0f5";
    for (let index = 0; index < paths.length; index += 1) {
      context.globalAlpha = clamp((opacity / 255) * (index + 0.5) / paths.length, 0, 1);
      context.stroke(paths[index]);
    }
    context.restore();
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
  context.arc(x, y, Math.max(0.8, style.thickness * 0.45), 0, Math.PI * 2);
  context.fill();
  context.restore();
};

const drawStrokeSegment = (
  context: CanvasRenderingContext2D,
  from: Point2D,
  to: Point2D,
  style: TraceStyle,
  width: number,
  height: number,
) => {
  context.save();
  context.globalCompositeOperation = "lighter";
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = style.color;
  context.shadowColor = style.color;
  context.globalAlpha = style.opacity * 0.55;
  context.lineWidth = style.thickness + style.glow * 0.25;
  context.shadowBlur = style.glow;
  context.beginPath();
  context.moveTo(from.x * width, from.y * height);
  context.lineTo(to.x * width, to.y * height);
  context.stroke();
  context.globalAlpha = style.opacity;
  context.lineWidth = style.thickness;
  context.shadowBlur = style.glow * 0.35;
  context.beginPath();
  context.moveTo(from.x * width, from.y * height);
  context.lineTo(to.x * width, to.y * height);
  context.stroke();
  drawStrokePoint(context, to, { ...style, glow: style.glow * 0.5 }, width, height);
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

const particleColors = ["#5620e9", "#a08abf", "#9ad96c", "#d9ad29"];
const filamentColors = ["#9ad96c", "#a08abf", "#9ad96c", "#f2f0f5"];

export async function createParticleEngine({
  container,
  interactionRef,
  settingsRef,
  onReady,
  onQuality,
}: EngineOptions): Promise<() => void> {
  const [p5Module, gsapModule] = await Promise.all([import("p5"), import("gsap")]);
  const P5 = p5Module.default;
  const gsap = gsapModule.gsap;
  let particleCount = settingsRef.current.density;
  let particles: ParticleBuffers;
  let particleTrailLayer: p5.Graphics | null = null;
  let traceTrailLayer: p5.Graphics | null = null;
  let drawingLayer: p5.Graphics | null = null;
  let transformedDrawingLayer: p5.Graphics | null = null;
  let paused = false;
  let destroyed = false;
  let backgroundProgram: p5.Shader;
  let particleProgram: p5.Shader;
  let instance: p5 | null = null;
  let lastTime = 0;
  let lastStrokeVersion = -1;
  let lastClearVersion = 0;
  let lastTraceTrailStrokeVersion = -1;
  let lastTraceTrailScale = Number.NaN;
  let lastTraceTrailRotation = Number.NaN;
  let lastDisplayedStrokeVersion = -1;
  let lastDisplayedScale = Number.NaN;
  let lastDisplayedRotation = Number.NaN;
  let clearingStartedAt: number | null = null;
  let completedFrames = 0;
  let lastCompletedFrameAt = 0;
  let diagnostics: (() => unknown) | undefined;
  const drawnStrokePoints = new Map<string, number>();
  const traceTrailPositions = new Map<string, TrailSample[]>();
  const particleHistory = new TrailHistory(12000);
  const traceHistory = new TrailHistory(12000);
  let lastMouseTrailSample: TrailSample | null = null;

  const makeParticles = (count: number, width: number, height: number) => {
    const buffers: ParticleBuffers = {
      x: new Float32Array(count),
      y: new Float32Array(count),
      z: new Float32Array(count),
      vx: new Float32Array(count),
      vy: new Float32Array(count),
      trailX: new Float32Array(count).fill(Number.NaN),
      trailY: new Float32Array(count).fill(Number.NaN),
      trailTime: new Float32Array(count).fill(Number.NaN),
      size: new Float32Array(count),
      phase: new Float32Array(count),
      alpha: new Float32Array(count).fill(1),
    };

    for (let index = 0; index < count; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.pow(Math.random(), 0.66) * 0.54;
      buffers.x[index] = width * (0.5 + Math.cos(angle) * radius);
      buffers.y[index] = height * (0.5 + Math.sin(angle) * radius);
      buffers.z[index] = Math.random() * 1000;
      buffers.vx[index] = (Math.random() - 0.5) * 0.18;
      buffers.vy[index] = (Math.random() - 0.5) * 0.18;
      buffers.size[index] = Math.random() * 2.1 + 0.7;
      buffers.phase[index] = Math.random() * 1000;
    }

    return buffers;
  };
  particles = makeParticles(particleCount, 1, 1);

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
    drawingLayer?.resizeCanvas(width, height);
    drawingLayer?.clear();
    transformedDrawingLayer?.resizeCanvas(width, height);
    transformedDrawingLayer?.clear();
    drawnStrokePoints.clear();
    lastStrokeVersion = -1;
    lastDisplayedStrokeVersion = -1;
    lastDisplayedScale = Number.NaN;
    lastDisplayedRotation = Number.NaN;
    particles = makeParticles(particleCount, width, height);
  };

  const sketch = (p: p5) => {
    instance = p;

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
      drawingLayer = p.createGraphics(width, height);
      drawingLayer.pixelDensity(1);
      transformedDrawingLayer = p.createGraphics(width, height);
      transformedDrawingLayer.pixelDensity(1);
      particles = makeParticles(particleCount, width, height);
      backgroundProgram = p.createShader(backgroundVertexShader, backgroundFragmentShader);
      particleProgram = p.createShader(vertexShader, fragmentShader);
      if (process.env.NODE_ENV !== "production") {
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
            particles: { count: particleCount, invalid: invalidParticles },
            trace: { strokes: state.strokes.length, points: tracePoints, invalid: invalidTracePoints },
            transformedOutsideViewport: outsideViewport,
            transformedBounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null,
            trails: { particle: particleHistory.diagnostics(now), trace: traceHistory.diagnostics(now) },
            webgl: {
              contextLost: gl.isContextLost(),
              error: gl.getError(),
              backgroundShaderErrors: inspectShader(gl, backgroundVertexShader, backgroundFragmentShader),
              particleShaderErrors: inspectShader(gl, vertexShader, fragmentShader),
            },
          };
        };
        window.__particleDiagnostics = diagnostics;
      }
      onQuality(pixelRatio > 1.25 ? "FULL" : "EFFICIENT");
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

    p.draw = () => {
      if (paused || !particles || !particleTrailLayer || !traceTrailLayer || destroyed) return;
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
      const persistentLayer = drawingLayer;
      const activeHands = state.hands;
      const transformedPoint: Point2D = { x: 0, y: 0 };
      const focus =
        activeHands.find((hand) => hand.handedness === "Right")?.center ??
        activeHands[0]?.center ??
        state.mouse;
      const collapsing =
        !state.clearActive && activeHands.some((hand) => hand.interaction === "collapse");

      if (density !== particleCount) {
        particleCount = density;
        particles = makeParticles(particleCount, width, height);
        trailLayer.clear();
        particleHistory.clear();
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
      p.rect(-width / 2, -height / 2, width, height);
      p.resetShader();

      const forceRange = Math.min(width, height) * INTERACTION_CONFIG.forces.rangeRatio;
      const forceRangeSquared = forceRange * forceRange;
      const forceStrength =
        settingsRef.current.interaction.gravityStrength *
        (intensity / 100) *
        settingsRef.current.interaction.forceMultiplier;
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
      const traceTrailStride = INTERACTION_CONFIG.trails.traceSampleStride;
      const maximumTrailDistanceSquared = (Math.min(width, height) * 0.4) ** 2;
      const particleTrailAlpha =
        INTERACTION_CONFIG.trails.particleOpacity * trailIntensity;
      const traceTrailAlpha = INTERACTION_CONFIG.trails.traceOpacity;

      for (let index = 0; index < particleCount; index += 1) {
        let x = particles.x[index];
        let y = particles.y[index];
        let vx = particles.vx[index];
        let vy = particles.vy[index];
        const phase = particles.phase[index];
        const angle =
          Math.sin(y * 0.004 + now * 0.18 + phase) *
          Math.cos(x * 0.003 - now * 0.15);
        vx += Math.cos(angle) * 0.11 * delta;
        vy += Math.sin(angle) * 0.11 * delta;

        for (let handIndex = 0; !state.clearActive && handIndex < activeHands.length; handIndex += 1) {
          const hand = activeHands[handIndex];
          if (hand.forceMode === "none") continue;
          const target = hand.interaction === "collapse" ? hand.pinchPoint : hand.center;
          const dx = x - target.x * width;
          const dy = y - target.y * height;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared > forceRangeSquared || distanceSquared < 2) continue;

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
          const dx = x - state.mouse.x * width;
          const dy = y - state.mouse.y * height;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < forceRangeSquared && distanceSquared > 2) {
            const distance = Math.sqrt(distanceSquared);
            const force = (forceStrength * (1 - distance / forceRange) * delta) / distance;
            const direction = state.mousePressed ? -1 : 1;
            vx -= dx * force * 0.001 * direction;
            vy -= dy * force * 0.001 * direction;
          }
        }

        const maxSpeed = INTERACTION_CONFIG.forces.maximumSpeed;
        const damping = Math.pow(0.986, delta * 60);
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
            if (distanceSquared <= maximumTrailDistanceSquared) {
              const sampleIntensity =
                particles.alpha[index] *
                (0.75 + 0.25 * Math.sin(now * 0.7 + phase));
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

      particleHistory.render(
        trailLayer, now, particleTrailAlpha, INTERACTION_CONFIG.trails.particleThickness,
      );
      // p5 POINTS uses its point shader rather than the custom fill shader.
      const particleContext = trailLayer.drawingContext as CanvasRenderingContext2D;
      particleContext.save();
      const particleScale = Math.hypot(fieldTransform.a, fieldTransform.b);
      for (let index = 0; index < particleCount; index += 1) {
        transformFieldPoint(particles.x[index], particles.y[index], fieldTransform, transformedPoint);
        const phase = particles.phase[index];
        const colorIndex = Math.floor((phase + now * 7) % 4);
        particleContext.fillStyle = mode === "monochrome"
          ? "#f2f0f5"
          : mode === "filament" ? filamentColors[colorIndex] : particleColors[colorIndex];
        particleContext.globalAlpha = clamp(
          ((80 + Math.sin(now * 0.7 + phase) * 45) * particles.alpha[index]) / 255,
          0,
          1,
        );
        particleContext.beginPath();
        particleContext.arc(
          transformedPoint.x, transformedPoint.y,
          particles.size[index] * particleScale / 2, 0, Math.PI * 2,
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
      p.shader(particleProgram);
      particleProgram.setUniform("uPointSize", Math.min(3.2, 1.8 + intensity * 0.012));
      particleProgram.setUniform("uTime", now);
      particleProgram.setUniform("uFieldLinear", [
        fieldTransform.a,
        fieldTransform.b,
        fieldTransform.c,
        fieldTransform.d,
      ]);
      particleProgram.setUniform("uIntensity", intensity / 100);
      particleProgram.setUniform("uMode", mode === "monochrome" ? 2 : mode === "filament" ? 1 : 0);
      particleProgram.setUniform("uResolution", [
        width * p.pixelDensity(),
        height * p.pixelDensity(),
      ]);
      particleProgram.setUniform("uFocus", [focus.x, 1 - focus.y]);
      p.beginShape(p.POINTS);
      for (let index = 0; index < particleCount; index += 1) {
        p.vertex(
          particles.x[index] - width / 2,
          particles.y[index] - height / 2,
          particles.z[index] * 0.01,
        );
      }
      p.endShape();
      p.resetShader();
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

      const fieldScale = Math.hypot(fieldTransform.a, fieldTransform.b);
      for (const hand of activeHands) {
        if (hand.interaction !== "collapse") continue;
        transformFieldPoint(
          hand.pinchPoint.x * width,
          hand.pinchPoint.y * height,
          fieldTransform,
          transformedPoint,
        );
        const x = transformedPoint.x - width / 2;
        const y = transformedPoint.y - height / 2;
        const pulse = (25 + Math.sin(now * 5) * 3) * fieldScale;
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

      if (persistentLayer && transformedDrawingLayer) {
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
            persistentLayer.clear();
            drawnStrokePoints.clear();
            lastStrokeVersion = -1;
            lastDisplayedStrokeVersion = -1;
            clearingStartedAt = null;
          }
        } else if (state.strokeVersion !== lastStrokeVersion) {
          const context = persistentLayer.drawingContext as CanvasRenderingContext2D;
          for (const stroke of state.strokes) {
            const drawnCount = drawnStrokePoints.get(stroke.id) ?? 0;
            if (drawnCount === 0 && stroke.points[0]) {
              drawStrokePoint(context, stroke.points[0], stroke.style, width, height);
            }
            for (let pointIndex = Math.max(1, drawnCount); pointIndex < stroke.points.length; pointIndex += 1) {
              drawStrokeSegment(
                context,
                stroke.points[pointIndex - 1],
                stroke.points[pointIndex],
                stroke.style,
                width,
                height,
              );
            }
            drawnStrokePoints.set(stroke.id, stroke.points.length);
          }
          lastStrokeVersion = state.strokeVersion;
        }

        if (
          state.strokeVersion !== lastDisplayedStrokeVersion ||
          state.universeScale !== lastDisplayedScale ||
          state.universeRotation !== lastDisplayedRotation
        ) {
          transformedDrawingLayer.clear();
          transformedDrawingLayer.push();
          applyFieldTransform(transformedDrawingLayer, fieldTransform);
          transformedDrawingLayer.image(persistentLayer, 0, 0, width, height);
          transformedDrawingLayer.pop();
          lastDisplayedStrokeVersion = state.strokeVersion;
          lastDisplayedScale = state.universeScale;
          lastDisplayedRotation = state.universeRotation;
        }

        if (
          state.strokeVersion !== lastTraceTrailStrokeVersion ||
          state.universeScale !== lastTraceTrailScale ||
          state.universeRotation !== lastTraceTrailRotation
        ) {
          for (const stroke of state.strokes) {
            let lastPositions = traceTrailPositions.get(stroke.id);
            if (!lastPositions) {
              lastPositions = [];
              traceTrailPositions.set(stroke.id, lastPositions);
            }
            for (let pointIndex = 0; pointIndex < stroke.points.length; pointIndex += 1) {
              if (pointIndex % traceTrailStride !== 0) continue;
              const point = stroke.points[pointIndex];
              transformFieldPoint(
                point.x * width,
                point.y * height,
                fieldTransform,
                transformedPoint,
              );
              const previous = lastPositions[pointIndex];
              if (!previous) {
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

              if (distanceSquared <= maximumTrailDistanceSquared) {
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
          }
          lastTraceTrailStrokeVersion = state.strokeVersion;
          lastTraceTrailScale = state.universeScale;
          lastTraceTrailRotation = state.universeRotation;
        }

        if (activeHands.length === 0 && state.mousePressed) {
          transformFieldPoint(
            state.mouse.x * width,
            state.mouse.y * height,
            fieldTransform,
            transformedPoint,
          );
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

        traceHistory.render(
          traceLayer, now, traceTrailAlpha, INTERACTION_CONFIG.trails.traceThickness,
        );
        p.push();
        p.blendMode(p.ADD);
        p.image(traceLayer, -width / 2, -height / 2, width, height);
        p.blendMode(p.BLEND);
        p.pop();

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
        lastCompletedFrameAt = performance.now();
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

  const cleanup = () => {
    destroyed = true;
    resizeObserver.disconnect();
    gsap.killTweensOf(container);
    if (process.env.NODE_ENV !== "production" && window.__particleDiagnostics === diagnostics) {
      delete window.__particleDiagnostics;
    }
    instance?.remove();
    instance = null;
    particleTrailLayer = null;
    traceTrailLayer = null;
    drawingLayer = null;
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
