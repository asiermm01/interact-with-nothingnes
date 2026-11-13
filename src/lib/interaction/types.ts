// Contratos compartidos entre cámara, reconocedor, interfaz y motor visual.
// Las uniones restringen los identificadores posibles en tiempo de compilación.
export type GestureName =
  | "IDLE"
  | "CURSOR"
  | "TRACE"
  | "GRAVITY"
  | "STRETCH"
  | "COLLAPSE"
  | "CLEAR ALL";

export type HandPoseName =
  | "IDLE"
  | "CURSOR"
  | "TRACE"
  | "GRAVITY"
  | "COLLAPSE"
  | "OPEN PALM";
export type HandInteraction =
  | "none"
  | "cursor"
  | "trace"
  | "gravity"
  | "collapse"
  | "stretch"
  | "clear-all";
export type FingerName = "thumb" | "index" | "middle" | "ring" | "pinky";
export type Handedness = "Left" | "Right" | "Unknown";
export type HandIdentity = string;
export type HandForceMode = "attract" | "none";
export type HandPresenceStatus = "tracking" | "temporarily-lost";

export type TrackingStatus =
  | "idle"
  | "requesting"
  | "loading-model"
  | "tracking"
  | "searching"
  | "no-hands"
  | "denied"
  | "unavailable"
  | "error";

export type VisualMode = "nebula" | "filament" | "monochrome";

export interface Point2D {
  x: number;
  y: number;
}

export interface HandLandmark extends Point2D {
  z?: number;
  name: string;
  score?: number;
}

/** Resultado de una mano del modelo, con x e y normalizadas entre 0 y 1. */
export interface HandObservation {
  keypoints: HandLandmark[];
  confidence: number;
  handedness?: string;
}

export interface InteractionTuning {
  confidenceThreshold: number;
  smoothing: number;
  pinchEnterRatio: number;
  pinchExitRatio: number;
  fingerExtensionRatio: number;
  fingerReleaseRatio: number;
  gestureHoldMs: number;
  clearHoldMs: number;
  clearCooldownMs: number;
  traceSpacing: number;
  traceThickness: number;
  traceGlow: number;
  traceOpacity: number;
  forceMultiplier: number;
  gravityStrength: number;
  stretchSensitivity: number;
}

export interface TraceStyle {
  color: string;
  thickness: number;
  glow: number;
  opacity: number;
}

/** Geometría persistente en coordenadas normalizadas del espacio del campo. */
export interface PersistentStroke {
  id: string;
  handId: string;
  points: Point2D[];
  style: TraceStyle;
}

export interface HandTrackSnapshot {
  id: string;
  handedness: Handedness;
  status: HandPresenceStatus;
  confidence: number;
  pose: HandPoseName;
  interaction: HandInteraction;
  fingerCount: number;
  stability: number;
  center: Point2D;
  cursorPoint: Point2D;
  velocity: Point2D;
  orientation: number;
  lastSeenAt: number;
}

export interface InteractionEvent {
  id: number;
  type: "clear-all";
  timestamp: number;
}

export interface DetectedHand {
  id: string;
  handedness: Handedness;
  pose: HandPoseName;
  stablePose: HandPoseName;
  interaction: HandInteraction;
  center: Point2D;
  cursorPoint: Point2D;
  pinchPoint: Point2D;
  orientation: number;
  confidence: number;
  openness: number;
  fingerCount: number;
  extendedFingers: FingerName[];
  stability: number;
  forceMode: HandForceMode;
  isPinching: boolean;
  isFist: boolean;
  isThumbOnly: boolean;
  isOpenPalm: boolean;
  velocity: Point2D;
}

export interface HandCursor {
  handId: string;
  position: Point2D;
  mode: "CURSOR" | "TRACE";
}

/**
 * Instantánea publicada por el reconocedor y leída por la interfaz y p5.
 * Las versiones indican cambios en los trazos o un borrado sin copiar toda su geometría.
 */
export interface InteractionFrame {
  hands: DetectedHand[];
  tracking: HandTrackSnapshot[];
  mouse: Point2D;
  mouseActive: boolean;
  mousePressed: boolean;
  gesture: GestureName;
  cursors: HandCursor[];
  strokes: PersistentStroke[];
  strokeVersion: number;
  clearVersion: number;
  clearProgress: number;
  clearActive: boolean;
  clearCooldownRemaining: number;
  events: InteractionEvent[];
  universeScale: number;
  universeRotation: number;
}

export interface UserSettings {
  density: number;
  intensity: number;
  persistence: number;
  mode: VisualMode;
  interaction: InteractionTuning;
}

export interface RenderParameters {
  width: number;
  height: number;
  pixelRatio: number;
  particleCount: number;
}

export interface HandTrackerHandle {
  stop(): void;
}

export interface ParticleCanvasHandle {
  pause(): void;
  resume(): void;
  reset(): void;
  capture(): void;
}
