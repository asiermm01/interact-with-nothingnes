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
    smoothing: 0.34,
    pinchEnterRatio: 0.34,
    pinchExitRatio: 0.48,
    fingerExtensionRatio: 1.14,
    impulseSpeed: 1.15,
    impulseCooldownMs: 420,
    gestureHoldMs: 140,
    clearHoldMs: 900,
    clearCooldownMs: 2400,
    clearFadeMs: 850,
  },
  drawing: {
    spacing: 0.004,
    maxInterpolationSteps: 384,
    thickness: 3.5,
    glow: 14,
    opacity: 0.88,
    color: "#9ad96c",
  },
  forces: {
    rangeRatio: 0.24,
    strength: 520,
    collapseMultiplier: 2.6,
    traceMultiplier: 0.3,
    maximumSpeed: 80,
  },
  shockwave: {
    lifetimeSeconds: 1.7,
    decayPerFrame: 0.988,
    radialRatio: 0.72,
    directedRatio: 0.28,
    forceStrength: 16,
    bandSharpness: 0.045,
    directionLength: 0.09,
  },
} as const;

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
  impulseSpeed: INTERACTION_CONFIG.gestures.impulseSpeed,
  impulseCooldownMs: INTERACTION_CONFIG.gestures.impulseCooldownMs,
  gestureHoldMs: INTERACTION_CONFIG.gestures.gestureHoldMs,
  clearHoldMs: INTERACTION_CONFIG.gestures.clearHoldMs,
  clearCooldownMs: INTERACTION_CONFIG.gestures.clearCooldownMs,
  traceSpacing: INTERACTION_CONFIG.drawing.spacing,
  traceThickness: INTERACTION_CONFIG.drawing.thickness,
  traceGlow: INTERACTION_CONFIG.drawing.glow,
  traceOpacity: INTERACTION_CONFIG.drawing.opacity,
  forceMultiplier: 1,
};

export const INTERACTION_TUNING_RANGES: Record<keyof InteractionTuning, SettingRange> = {
  confidenceThreshold: { min: 0.2, max: 0.9, step: 0.05 },
  smoothing: { min: 0.1, max: 0.8, step: 0.05 },
  pinchEnterRatio: { min: 0.18, max: 0.65, step: 0.01 },
  pinchExitRatio: { min: 0.28, max: 0.8, step: 0.01 },
  fingerExtensionRatio: { min: 1.02, max: 1.4, step: 0.01 },
  impulseSpeed: { min: 0.2, max: 2.5, step: 0.05 },
  impulseCooldownMs: { min: 250, max: 2000, step: 50 },
  gestureHoldMs: { min: 80, max: 600, step: 20 },
  clearHoldMs: { min: 500, max: 2000, step: 50 },
  clearCooldownMs: { min: 1000, max: 6000, step: 100 },
  traceSpacing: { min: 0.0015, max: 0.012, step: 0.0005 },
  traceThickness: { min: 1, max: 12, step: 0.5 },
  traceGlow: { min: 0, max: 32, step: 1 },
  traceOpacity: { min: 0.2, max: 1, step: 0.05 },
  forceMultiplier: { min: 0.25, max: 2, step: 0.05 },
};

export const DEFAULT_USER_SETTINGS: UserSettings = {
  density: 1050,
  intensity: 54,
  persistence: 72,
  mode: "nebula",
  interaction: { ...INTERACTION_TUNING_DEFAULTS },
};
