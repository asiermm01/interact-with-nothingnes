import type p5 from "p5";
import type {
  InteractionFrame,
  ParticleCanvasHandle,
  UserSettings,
} from "../interaction/types";

const vertexShader = `
precision highp float;
attribute vec3 aPosition;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
uniform float uPointSize;
uniform float uTime;
varying float vPhase;
varying vec3 vPosition;

void main() {
  vec4 position = uModelViewMatrix * vec4(aPosition, 1.0);
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
  let paused = false;
  let destroyed = false;
  let backgroundProgram: p5.Shader;
  let particleProgram: p5.Shader;
  let instance: p5 | null = null;
  let lastTime = 0;

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
      const activeHands = state.hands;
      const focus = activeHands[0]?.center ?? state.mouse;

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

      const forceRange = Math.min(width, height) * 0.24;
      const forceRangeSquared = forceRange * forceRange;
      const forceStrength = (intensity / 100) * 520;

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

        for (let handIndex = 0; handIndex < activeHands.length; handIndex += 1) {
          const hand = activeHands[handIndex];
          const target =
            state.gesture === "COLLAPSE" && hand.isPinching
              ? hand.pinchPoint
              : hand.center;
          const dx = x - target.x * width;
          const dy = y - target.y * height;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared > forceRangeSquared || distanceSquared < 2) continue;

          const distance = Math.sqrt(distanceSquared);
          const falloff = 1 - distance / forceRange;
          const gravity = hand.isOpenPalm ? -1 : 1;
          const collapse = state.gesture === "COLLAPSE" && hand.isPinching ? 2.6 : 1;
          const force = (forceStrength * falloff * collapse * gravity * delta) / distance;
          vx -= dx * force * 0.001;
          vy -= dy * force * 0.001;
          particles.alpha[index] = state.gesture === "COLLAPSE" ? Math.max(0.12, particles.alpha[index] - 0.012) : 1;
        }

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

        for (let waveIndex = 0; waveIndex < state.shockwaves.length; waveIndex += 1) {
          const wave = state.shockwaves[waveIndex];
          const dx = x - wave.center.x * width;
          const dy = y - wave.center.y * height;
          const distance = Math.hypot(dx, dy);
          const front = wave.age * Math.min(width, height) * 0.72;
          const band = Math.exp(-Math.abs(distance - front) * 0.045);
          if (distance > 1) {
            const push = band * wave.strength * 16 * delta;
            vx += (dx / distance) * push;
            vy += (dy / distance) * push;
          }
        }

        const maxSpeed = 80;
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

        if (state.gesture === "TRACE" && state.tracePoints.length > 1) {
          const trace = state.tracePoints[state.tracePoints.length - 1];
          const dx = x / width - trace.x;
          const dy = y / height - trace.y;
          if (dx * dx + dy * dy < 0.003) {
            trailLayer.stroke(154, 217, 108, 105);
            trailLayer.strokeWeight(particles.size[index] + 0.5);
          }
        }

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

      if (state.tracePoints.length > 1) {
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
    };

    p.windowResized = () => {
      if (!instance || destroyed) return;
      const width = Math.max(container.clientWidth, window.innerWidth);
      const height = Math.max(container.clientHeight, window.innerHeight);
      p.resizeCanvas(width, height, true);
      field?.resizeCanvas(width, height);
      field?.clear();
      particles = makeParticles(particleCount, width, height);
    };
  };

  const resizeObserver = new ResizeObserver(() => {
    if (!instance || destroyed) return;
    const width = Math.max(container.clientWidth, window.innerWidth);
    const height = Math.max(container.clientHeight, window.innerHeight);
    if (instance.width !== width || instance.height !== height) {
      instance.resizeCanvas(width, height, true);
      field?.resizeCanvas(width, height);
      field?.clear();
      particles = makeParticles(particleCount, width, height);
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
  };

  try {
    new P5(sketch, container);
  } catch (error) {
    cleanup();
    throw error;
  }

  return cleanup;
}
