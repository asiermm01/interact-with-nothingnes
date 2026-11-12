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
uniform float uFieldScale;
uniform float uFieldRotation;
varying float vPhase;
varying vec3 vPosition;

void main() {
  float cosine = cos(uFieldRotation);
  float sine = sin(uFieldRotation);
  mat2 rotation = mat2(cosine, sine, -sine, cosine);
  vec2 fieldPosition = rotation * aPosition.xy * uFieldScale;
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

interface ParticleBuffers {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  size: Float32Array;
  phase: Float32Array;
  alpha: Float32Array;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

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

const modeColors = [
  [86, 32, 233],
  [160, 138, 191],
  [154, 217, 108],
  [217, 173, 41],
];
const filamentColors = [
  [154, 217, 108],
  [160, 138, 191],
  [154, 217, 108],
  [242, 240, 245],
];
const monochromeColor = [242, 240, 245];

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
  let field: p5.Graphics | null = null;
  let drawingLayer: p5.Graphics | null = null;
  let paused = false;
  let destroyed = false;
  let backgroundProgram: p5.Shader;
  let particleProgram: p5.Shader;
  let instance: p5 | null = null;
  let lastTime = 0;
  let lastStrokeVersion = -1;
  let lastClearVersion = 0;
  let clearingStartedAt: number | null = null;
  const drawnStrokePoints = new Map<string, number>();

  const makeParticles = (count: number, width: number, height: number) => {
    const buffers: ParticleBuffers = {
      x: new Float32Array(count),
      y: new Float32Array(count),
      z: new Float32Array(count),
      vx: new Float32Array(count),
      vy: new Float32Array(count),
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
    field?.resizeCanvas(width, height);
    field?.clear();
    drawingLayer?.resizeCanvas(width, height);
    drawingLayer?.clear();
    drawnStrokePoints.clear();
    lastStrokeVersion = -1;
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
      field = p.createGraphics(width, height);
      field.pixelDensity(1);
      drawingLayer = p.createGraphics(width, height);
      drawingLayer.pixelDensity(1);
      particles = makeParticles(particleCount, width, height);
      backgroundProgram = p.createShader(backgroundVertexShader, backgroundFragmentShader);
      particleProgram = p.createShader(vertexShader, fragmentShader);
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
          field?.clear();
          lastTime = 0;
        },
        capture: () => {
          p.saveCanvas("one-with-nothingness", "png");
        },
      });
    };

    p.draw = () => {
      if (paused || !particles || !field || destroyed) return;
      const now = p.millis() * 0.001;
      const delta = lastTime ? clamp(now - lastTime, 0.001, 0.04) : 1 / 60;
      lastTime = now;
      const width = p.width;
      const height = p.height;
      const state = interactionRef.current;
      const { intensity, persistence, density, mode } = settingsRef.current;
      const trailLayer = field;
      const persistentLayer = drawingLayer;
      const activeHands = state.hands;
      const focus =
        activeHands.find((hand) => hand.handedness === "Right")?.center ??
        activeHands[0]?.center ??
        state.mouse;
      const collapsing =
        !state.clearActive && activeHands.some((hand) => hand.interaction === "collapse");

      if (density !== particleCount) {
        particleCount = density;
        particles = makeParticles(particleCount, width, height);
        field.clear();
      }

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

      trailLayer.noStroke();
      trailLayer.fill(5, 6, 10, clamp(42 - persistence * 0.34, 3, 38));
      trailLayer.rect(0, 0, width, height);
      trailLayer.push();
      trailLayer.translate(width / 2, height / 2);
      trailLayer.rotate(state.universeRotation);
      trailLayer.scale(state.universeScale, state.universeScale);
      trailLayer.translate(-width / 2, -height / 2);

      const forceRange = Math.min(width, height) * INTERACTION_CONFIG.forces.rangeRatio;
      const forceRangeSquared = forceRange * forceRange;
      const forceStrength =
        settingsRef.current.interaction.gravityStrength *
        (intensity / 100) *
        settingsRef.current.interaction.forceMultiplier;

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

        const hue = mode === "monochrome" ? 0 : (phase + now * 7) % 4;
        const color =
          mode === "monochrome"
            ? monochromeColor
            : mode === "filament"
              ? filamentColors[Math.floor(hue)]
              : modeColors[Math.floor(hue)] ?? modeColors[0];
        const alpha = clamp((80 + Math.sin(now * 0.7 + phase) * 45) * particles.alpha[index], 8, 150);
        trailLayer.stroke(color[0], color[1], color[2], alpha);
        trailLayer.strokeWeight(particles.size[index]);

        trailLayer.point(x, y);

        if (index % 8 === 0 && index + 29 < particleCount) {
          const neighbor = index + 29;
          const linkX = particles.x[neighbor];
          const linkY = particles.y[neighbor];
          const dx = linkX - x;
          const dy = linkY - y;
          if (dx * dx + dy * dy < 4100) {
            trailLayer.stroke(160, 138, 191, 17);
            trailLayer.strokeWeight(0.55);
            trailLayer.line(x, y, linkX, linkY);
          }
        }
      }

      for (const hand of activeHands) {
        if (hand.interaction !== "collapse") continue;
        const x = hand.pinchPoint.x * width;
        const y = hand.pinchPoint.y * height;
        const pulse = 25 + Math.sin(now * 5) * 3;
        trailLayer.noFill();
        trailLayer.stroke(154, 217, 108, 155);
        trailLayer.strokeWeight(1.5);
        trailLayer.ellipse(x, y, pulse, pulse);
        trailLayer.stroke(160, 138, 191, 110);
        trailLayer.strokeWeight(1);
        trailLayer.ellipse(x, y, pulse * 0.58, pulse * 0.58);
        trailLayer.noStroke();
        trailLayer.fill(7, 7, 11, 185);
        trailLayer.ellipse(x, y, pulse * 0.28, pulse * 0.28);
      }
      if (activeHands.length === 0 && state.tracePoints.length > 1) {
        trailLayer.noFill();
        trailLayer.stroke(154, 217, 108, 105);
        trailLayer.strokeWeight(1.1);
        trailLayer.beginShape();
        state.tracePoints.forEach((point) =>
          trailLayer.curveVertex(point.x * width, point.y * height),
        );
        trailLayer.endShape();
      }
      trailLayer.pop();

      p.push();
      p.blendMode(p.ADD);
      p.image(trailLayer, -width / 2, -height / 2, width, height);
      p.blendMode(p.BLEND);
      p.pop();

      p.push();
      p.shader(particleProgram);
      particleProgram.setUniform("uPointSize", Math.min(3.2, 1.8 + intensity * 0.012));
      particleProgram.setUniform("uTime", now);
      particleProgram.setUniform("uFieldScale", state.universeScale);
      particleProgram.setUniform("uFieldRotation", state.universeRotation);
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

      if (persistentLayer) {
        if (state.clearVersion !== lastClearVersion) {
          lastClearVersion = state.clearVersion;
          clearingStartedAt = now;
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

        if (clearingStartedAt !== null) {
          const opacity = 1 - clamp(
            (now - clearingStartedAt) /
              (INTERACTION_CONFIG.gestures.clearFadeMs / 1000),
            0,
            1,
          );
          p.push();
          p.tint(255, opacity * 255);
          p.image(persistentLayer, -width / 2, -height / 2, width, height);
          p.noTint();
          p.pop();
        } else {
          p.push();
          p.image(persistentLayer, -width / 2, -height / 2, width, height);
          p.pop();
        }
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
    instance?.remove();
    instance = null;
    field = null;
    drawingLayer = null;
  };

  try {
    new P5(sketch, container);
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}
