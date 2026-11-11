import type { HandObservation, HandTrackerHandle, TrackingStatus } from "./types";

interface Ml5Keypoint {
  x: number;
  y: number;
  z?: number;
  name: string;
  score?: number;
}

interface Ml5HandResult {
  keypoints?: Ml5Keypoint[];
  confidence?: number;
  score?: number;
  handedness?: string;
  label?: string;
}

interface HandPoseModel {
  ready: Promise<unknown>;
  detectStart(
    video: HTMLVideoElement,
    callback: (results: Ml5HandResult[]) => void,
  ): void;
  detectStop?(): void;
}

interface Ml5Api {
  handPose(
    options: { maxHands: number; flipped: boolean },
  ): Promise<HandPoseModel> | HandPoseModel;
}

interface Ml5Module {
  handPose?: Ml5Api["handPose"];
  default?: Ml5Api;
}

export class HandTracker implements HandTrackerHandle {
  private stream: MediaStream | null = null;
  private model: HandPoseModel | null = null;
  private active = false;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onHands: (hands: HandObservation[]) => void,
    private readonly onStatus: (status: TrackingStatus, message?: string) => void,
  ) {}

  async start(): Promise<boolean> {
    if (this.active) return true;
    this.active = true;
    this.onStatus("requesting");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.active = false;
        this.onStatus("unavailable", "This browser does not support webcam access.");
        return false;
      }

      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 24, max: 30 },
        },
      });

      if (!this.active) {
        this.stop();
        return false;
      }

      this.video.srcObject = this.stream;
      await this.video.play();
      this.onStatus("loading-model");

      const imported = (await import("ml5")) as Ml5Module;
      const ml5 = imported.handPose ? imported : imported.default;
      if (!ml5?.handPose) throw new Error("The ml5 HandPose model could not be loaded.");

      const model = await ml5.handPose({ maxHands: 2, flipped: true });
      this.model = model;
      await model.ready;
      if (!this.active) {
        model.detectStop?.();
        return false;
      }

      this.onStatus("searching");
      model.detectStart(this.video, (results) => {
        if (!this.active) return;
        const hands = results
          .filter((result) => Array.isArray(result.keypoints))
          .map((result) => ({
            confidence: result.confidence ?? result.score ?? 0,
            handedness: result.handedness ?? result.label,
            keypoints: (result.keypoints ?? []).map((point) => ({
              x: point.x / this.video.videoWidth,
              y: point.y / this.video.videoHeight,
              z: point.z,
              name: point.name,
              score: point.score,
            })),
          }));
        this.onHands(hands);
        this.onStatus(hands.length > 0 ? "tracking" : "searching");
      });
      return true;
    } catch (error) {
      this.stop();
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.onStatus("denied", "Camera permission was denied. Mouse interaction remains available.");
        return false;
      }
      if (error instanceof DOMException && error.name === "NotFoundError") {
        this.onStatus("unavailable", "No camera was found. Mouse interaction remains available.");
        return false;
      }

      this.onStatus(
        "error",
        error instanceof Error ? error.message : "Hand tracking could not start.",
      );
      return false;
    }
  }

  stop() {
    this.active = false;
    const model = this.model;
    this.model = null;
    const stream = this.stream;
    this.stream = null;
    try {
      model?.detectStop?.();
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      this.video.pause();
      this.video.srcObject = null;
    }
  }
}
