export type GestureName =
  | "IDLE"
  | "TRACE"
  | "GRAVITY"
  | "IMPULSE"
  | "STRETCH"
  | "COLLAPSE";

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

export interface HandTrackingDiagnostics {
  cameraPermission: "unknown" | "granted" | "denied" | "unavailable";
  videoReady: boolean;
  videoWidth: number;
  videoHeight: number;
  modelLoaded: boolean;
  detectionActive: boolean;
  detectionFrames: number;
  lastDetectionAt: number | null;
  hands: HandObservation[];
  error: string;
}

export interface DetectedHand {
  center: Point2D;
  indexTip: Point2D;
  pinchPoint: Point2D;
  confidence: number;
  openness: number;
  isPinching: boolean;
  isFist: boolean;
  isOpenPalm: boolean;
  velocity: Point2D;
}

export interface Shockwave {
  center: Point2D;
  strength: number;
  age: number;
}

export interface InteractionFrame {
  hands: DetectedHand[];
  mouse: Point2D;
  mouseActive: boolean;
  mousePressed: boolean;
  gesture: GestureName;
  tracePoints: Point2D[];
  shockwaves: Shockwave[];
  universeScale: number;
  universeRotation: number;
  intensity: number;
}

export interface UserSettings {
  density: number;
  intensity: number;
  persistence: number;
  mode: VisualMode;
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
