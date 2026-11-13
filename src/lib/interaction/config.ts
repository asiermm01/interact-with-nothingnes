import type { InteractionTuning, UserSettings } from "./types";

export const INTERACTION_CONFIG = {
  detection: {
    maxHands: 2,
    inferenceIntervalMs: 1000 / 24,
    confidenceThreshold: 0.45,
    trackingLossMs: 700,
    associationDistance: 0.34,
    maxFrameDeltaSeconds: 0.1,
  },
  gestures: {
    smoothing: 0.55,
    pinchEnterRatio: 0.3,
    pinchExitRatio: 0.42,
    fingerExtensionRatio: 1.14,
    fingerReleaseRatio: 1.06,
    fingerExtensionAngleDeg: 150,
    fingerReleaseAngleDeg: 135,
    gestureHoldMs: 110,
    clearHoldMs: 900,
    clearCooldownMs: 2400,
    clearFadeMs: 850,
  },
  drawing: {
    spacing: 0.006,
    maxInterpolationSteps: 384,
    thickness: 1.1,
    glow: 3,
    opacity: 0.5,
    color: "#9ad96c",
  },
  trails: {
    lifetimeSeconds: 3,
    defaultIntensity: 72,
    particleSampleDistance: 1.5,
    particleSampleStride: 4,
    particleSampleIntervalSeconds: 0.06,
    particleOpacity: 28,
    particleThickness: 0.75,
    traceSampleDistance: 1.5,
    traceSampleStride: 3,
    maximumTrackedTracePoints: 128,
    traceSampleIntervalSeconds: 0.08,
    traceOpacity: 20,
    traceThickness: 0.65,
  },
  forces: {
    rangeRatio: 0.38,
    gravityStrength: 1500,
    collapseMultiplier: 3.2,
    maximumSpeed: 80,
  },
  particles: {
    initialCount: 1050,
    minimumCount: 300,
    maximumCount: 1800,
  },
  stretch: {
    sensitivity: 1.8,
    minimumScale: 0.3,
    maximumScale: 4,
    minimumGestureSeparation: 0.04,
  },
} as const;

export const particleCountForDensity = (density: number) => {
  if (!Number.isFinite(density)) throw new Error("Particle density must be finite.");
  return Math.min(INTERACTION_CONFIG.particles.maximumCount, Math.max(0, Math.round(density)));
};

export interface SettingRange {
  min: number;
  max: number;
  step: number;
}

export const INTERACTION_TUNING_DEFAULTS: InteractionTuning = {
  confidenceThreshold: INTERACTION_CONFIG.detection.confidenceThreshold,
  smoothing: INTERACTION_CONFIG.gestures.smoothing,
  pinchEnterRatio: INTERACTION_CONFIG.gestures.pinchEnterRatio,
  pinchExitRatio: INTERACTION_CONFIG.gestures.pinchExitRatio,
  fingerExtensionRatio: INTERACTION_CONFIG.gestures.fingerExtensionRatio,
  fingerReleaseRatio: INTERACTION_CONFIG.gestures.fingerReleaseRatio,
  gestureHoldMs: INTERACTION_CONFIG.gestures.gestureHoldMs,
  clearHoldMs: INTERACTION_CONFIG.gestures.clearHoldMs,
  clearCooldownMs: INTERACTION_CONFIG.gestures.clearCooldownMs,
  traceSpacing: INTERACTION_CONFIG.drawing.spacing,
  traceThickness: INTERACTION_CONFIG.drawing.thickness,
  traceGlow: INTERACTION_CONFIG.drawing.glow,
  traceOpacity: INTERACTION_CONFIG.drawing.opacity,
  forceMultiplier: 1,
  gravityStrength: INTERACTION_CONFIG.forces.gravityStrength,
  stretchSensitivity: INTERACTION_CONFIG.stretch.sensitivity,
};

export const INTERACTION_TUNING_RANGES: Record<keyof InteractionTuning, SettingRange> = {
  confidenceThreshold: { min: 0.2, max: 0.9, step: 0.05 },
  smoothing: { min: 0.1, max: 0.8, step: 0.05 },
  pinchEnterRatio: { min: 0.18, max: 0.65, step: 0.01 },
  pinchExitRatio: { min: 0.28, max: 0.8, step: 0.01 },
  fingerExtensionRatio: { min: 1.02, max: 1.4, step: 0.01 },
  fingerReleaseRatio: { min: 1, max: 1.3, step: 0.01 },
  gestureHoldMs: { min: 80, max: 600, step: 20 },
  clearHoldMs: { min: 500, max: 2000, step: 50 },
  clearCooldownMs: { min: 1000, max: 6000, step: 100 },
  traceSpacing: { min: 0.0015, max: 0.012, step: 0.0005 },
  traceThickness: { min: 0.5, max: 6, step: 0.1 },
  traceGlow: { min: 0, max: 32, step: 1 },
  traceOpacity: { min: 0.2, max: 1, step: 0.05 },
  forceMultiplier: { min: 0.25, max: 2, step: 0.05 },
  gravityStrength: { min: 300, max: 3000, step: 100 },
  stretchSensitivity: { min: 0.5, max: 2.5, step: 0.1 },
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
  density: INTERACTION_CONFIG.particles.initialCount,
  intensity: 54,
  persistence: INTERACTION_CONFIG.trails.defaultIntensity,
  mode: "nebula",
  interaction: { ...INTERACTION_TUNING_DEFAULTS },
};
