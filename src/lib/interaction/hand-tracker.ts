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

const MODEL_LOAD_TIMEOUT_MS = 30_000;
const DETECTION_TIMEOUT_MS = 12_000;
const SEARCH_HINT_DELAY_MS = 7_000;

export class HandTracker implements HandTrackerHandle {
  private stream: MediaStream | null = null;
  private model: HandPoseModel | null = null;
  private active = false;
  private detectionWatchdog: number | null = null;
  private trackingStatus: TrackingStatus = "idle";
  private searchStartedAt = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onHands: (hands: HandObservation[]) => void,
    private readonly onStatus: (status: TrackingStatus, message?: string) => void,
  ) {}

  private setStatus(status: TrackingStatus, message?: string) {
    if (this.trackingStatus === status) return;
    this.trackingStatus = status;
    this.onStatus(status, message);
  }

  private watchForDetections() {
    if (this.detectionWatchdog !== null) {
      window.clearTimeout(this.detectionWatchdog);
    }
    this.detectionWatchdog = window.setTimeout(() => {
      if (!this.active) return;
      this.stop();
      this.setStatus(
        "error",
        "HandPose stopped responding. Check the camera and internet connection, then try again.",
      );
    }, DETECTION_TIMEOUT_MS);
  }

  private async waitForModel(model: HandPoseModel) {
    let timeout: number | undefined;
    try {
      await Promise.race([
        model.ready,
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(
            () => reject(new Error("HandPose is taking too long to load. Check your internet connection and try again.")),
            MODEL_LOAD_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
    }
  }

  async start(): Promise<boolean> {
    if (this.active) return true;
    this.active = true;
    this.setStatus("requesting");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.active = false;
        this.setStatus("unavailable", "This browser does not support webcam access.");
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
      this.setStatus("loading-model");

      const imported = (await import("ml5")) as Ml5Module;
      const ml5 = imported.handPose ? imported : imported.default;
      if (!ml5?.handPose) throw new Error("The ml5 HandPose model could not be loaded.");

      const model = await ml5.handPose({ maxHands: 2, flipped: true });
      this.model = model;
      await this.waitForModel(model);
      if (!this.active) {
        model.detectStop?.();
        return false;
      }

      this.searchStartedAt = performance.now();
      this.setStatus("searching");
      this.watchForDetections();
      model.detectStart(this.video, (results) => {
        if (!this.active) return;
        this.watchForDetections();
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
        if (hands.length > 0) {
          this.setStatus("tracking");
        } else {
          const waitingTooLong = performance.now() - this.searchStartedAt >= SEARCH_HINT_DELAY_MS;
          this.setStatus(waitingTooLong ? "no-hands" : "searching");
        }
      });
      return true;
    } catch (error) {
      this.stop();
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.setStatus("denied", "Camera permission was denied. Mouse interaction remains available.");
        return false;
      }
      if (error instanceof DOMException && error.name === "NotFoundError") {
        this.setStatus("unavailable", "No camera was found. Mouse interaction remains available.");
        return false;
      }

      this.setStatus(
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
    if (this.detectionWatchdog !== null) {
      window.clearTimeout(this.detectionWatchdog);
      this.detectionWatchdog = null;
    }
    try {
      model?.detectStop?.();
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      this.video.pause();
      this.video.srcObject = null;
    }
  }
}
