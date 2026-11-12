export type GestureName =
  | "IDLE"
  | "TRACE"
  | "GRAVITY"
  | "IMPULSE"
  | "STRETCH"
  | "COLLAPSE"
  | "CLEAR ALL";

export type HandGestureName = "IDLE" | "TRACE" | "GRAVITY" | "COLLAPSE";
export type Handedness = "Left" | "Right" | "Unknown";
export type HandIdentity = string;
export type HandForceMode = "attract" | "repel" | "none";
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
  impulseSpeed: number;
  impulseCooldownMs: number;
  gestureHoldMs: number;
  clearHoldMs: number;
  clearCooldownMs: number;
  traceSpacing: number;
  traceThickness: number;
  traceGlow: number;
  traceOpacity: number;
  forceMultiplier: number;
}

export interface TraceStyle {
  color: string;
  thickness: number;
  glow: number;
  opacity: number;
}

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
  gesture: HandGestureName;
  center: Point2D;
  indexTip: Point2D;
  velocity: Point2D;
  orientation: number;
  lastSeenAt: number;
}

export interface InteractionEvent {
  id: number;
  type: "impulse" | "clear-all";
  timestamp: number;
  handId?: string;
  center?: Point2D;
  direction?: Point2D;
}

export interface HandTrackingDiagnostics {
  cameraPermission: "unknown" | "granted" | "denied" | "unavailable";
  videoReady: boolean;
  videoWidth: number;
  videoHeight: number;
  videoCurrentTime: number;
  videoPaused: boolean;
  videoFrameCount: number;
  modelLoaded: boolean;
  detectionActive: boolean;
  inferenceBackend: string;
  detectionFrames: number;
  lastDetectionAt: number | null;
  hands: HandObservation[];
  error: string;
}

export interface DetectedHand {
  id: string;
  handedness: Handedness;
  center: Point2D;
  indexTip: Point2D;
  pinchPoint: Point2D;
  orientation: number;
  confidence: number;
  openness: number;
  gesture: HandGestureName;
  forceMode: HandForceMode;
  isPinching: boolean;
  isFist: boolean;
  isOpenPalm: boolean;
  isIndexPointing: boolean;
  velocity: Point2D;
}

export interface Shockwave {
  center: Point2D;
  direction: Point2D;
  strength: number;
  age: number;
}

export interface InteractionFrame {
  hands: DetectedHand[];
  tracking: HandTrackSnapshot[];
  mouse: Point2D;
  mouseActive: boolean;
  mousePressed: boolean;
  gesture: GestureName;
  tracePoints: Point2D[];
  strokes: PersistentStroke[];
  strokeVersion: number;
  clearVersion: number;
  clearProgress: number;
  clearActive: boolean;
  clearCooldownRemaining: number;
  events: InteractionEvent[];
  shockwaves: Shockwave[];
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
