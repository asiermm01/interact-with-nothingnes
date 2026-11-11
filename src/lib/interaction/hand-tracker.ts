import type {
  HandObservation,
  HandTrackerHandle,
  HandTrackingDiagnostics,
  TrackingStatus,
} from "./types";

interface Ml5Keypoint {
  x: number;
  y: number;
  z?: number;
  name: string;
  score?: number;
  confidence?: number;
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
  detect(video: HTMLVideoElement): Promise<Ml5HandResult[]>;
  detectStart?(video: HTMLVideoElement, callback: (results: Ml5HandResult[]) => void): void;
  detectStop?(): void;
}

interface Ml5Api {
  handPose(
    options: {
      maxHands: number;
      flipped: boolean;
      modelType: "lite";
      runtime: "tfjs";
    },
  ): Promise<HandPoseModel> | HandPoseModel;
}

interface Ml5Module {
  handPose?: Ml5Api["handPose"];
  default?: Ml5Api;
}

const MODEL_LOAD_TIMEOUT_MS = 30_000;
const DETECTION_TIMEOUT_MS = 12_000;
const SEARCH_HINT_DELAY_MS = 7_000;
const VIDEO_READY_TIMEOUT_MS = 10_000;
const TARGET_INFERENCE_INTERVAL_MS = 1000 / 24;

export class HandTracker implements HandTrackerHandle {
  private stream: MediaStream | null = null;
  private model: HandPoseModel | null = null;
  private active = false;
  private detectionWatchdog: number | null = null;
  private inferenceTimer: number | null = null;
  private trackingStatus: TrackingStatus = "idle";
  private searchStartedAt = 0;
  private receivedDetection = false;
  private streamEndedHandler: (() => void) | null = null;
  private diagnostics: HandTrackingDiagnostics = {
    cameraPermission: "unknown",
    videoReady: false,
    videoWidth: 0,
    videoHeight: 0,
    modelLoaded: false,
    detectionActive: false,
    detectionFrames: 0,
    lastDetectionAt: null,
    hands: [],
    error: "",
  };

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onHands: (hands: HandObservation[]) => void,
    private readonly onStatus: (status: TrackingStatus, message?: string) => void,
    private readonly onDiagnostics?: (diagnostics: HandTrackingDiagnostics) => void,
  ) {}

  private updateDiagnostics(updates: Partial<HandTrackingDiagnostics>) {
    this.diagnostics = { ...this.diagnostics, ...updates };
    this.onDiagnostics?.(this.diagnostics);
  }

  private setStatus(status: TrackingStatus, message?: string) {
    if (this.trackingStatus === status && !message) return;
    this.trackingStatus = status;
    this.onStatus(status, message);
  }

  private async waitForVideoReady() {
    if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.video.videoWidth > 0) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let timeout: number;
      const cleanup = () => {
        window.clearTimeout(timeout);
        this.video.removeEventListener("loadedmetadata", checkReady);
        this.video.removeEventListener("loadeddata", checkReady);
        this.video.removeEventListener("error", onError);
      };
      const checkReady = () => {
        if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || this.video.videoWidth <= 0) {
          return;
        }
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("The camera stream could not provide video frames."));
      };

      this.video.addEventListener("loadedmetadata", checkReady);
      this.video.addEventListener("loadeddata", checkReady);
      this.video.addEventListener("error", onError, { once: true });
      timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("The camera did not become ready. Check that it is not being used by another app."));
      }, VIDEO_READY_TIMEOUT_MS);
      checkReady();
    });

    this.updateDiagnostics({
      videoReady: true,
      videoWidth: this.video.videoWidth,
      videoHeight: this.video.videoHeight,
    });
  }

  private watchForDetections() {
    if (this.detectionWatchdog !== null) {
      window.clearTimeout(this.detectionWatchdog);
    }
    const timeout = this.receivedDetection ? DETECTION_TIMEOUT_MS : MODEL_LOAD_TIMEOUT_MS;
    this.detectionWatchdog = window.setTimeout(() => {
      if (!this.active) return;
      console.error("HandPose did not return inference results before the watchdog expired.");
      this.stop();
      const message = "HandPose stopped responding. Check the camera and internet connection, then try again.";
      this.updateDiagnostics({ error: message });
      this.setStatus("error", message);
    }, timeout);
  }

  private processResults(results: Ml5HandResult[]) {
    if (!this.active) return;
    if (!Array.isArray(results)) {
      const message = "HandPose returned an invalid detection result.";
      console.error(message, results);
      this.updateDiagnostics({ error: message });
      this.stop();
      this.setStatus("error", message);
      return;
    }

    this.receivedDetection = true;
    this.watchForDetections();
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (width <= 0 || height <= 0) {
      const message = "The camera stopped providing valid video dimensions.";
      this.updateDiagnostics({ videoReady: false, error: message });
      this.stop();
      this.setStatus("error", message);
      return;
    }
    const hands = results.flatMap((result) => {
      if (!Array.isArray(result.keypoints)) return [];
      const keypoints = result.keypoints
        .filter(
          (point) =>
            Number.isFinite(point.x) &&
            Number.isFinite(point.y) &&
            typeof point.name === "string",
        )
        .map((point) => ({
          x: Math.min(1, Math.max(0, point.x / width)),
          y: Math.min(1, Math.max(0, point.y / height)),
          z: point.z,
          name: point.name,
          score: point.score ?? point.confidence,
        }));
      if (keypoints.length === 0) return [];
      return [
        {
          confidence: result.confidence ?? result.score ?? 0,
          handedness: result.handedness ?? result.label,
          keypoints,
        },
      ];
    });
    this.updateDiagnostics({
      videoReady: true,
      videoWidth: width,
      videoHeight: height,
      detectionFrames: this.diagnostics.detectionFrames + 1,
      lastDetectionAt: Date.now(),
      hands,
      error: "",
    });
    this.onHands(hands);
    if (hands.length > 0) {
      this.setStatus("tracking");
    } else {
      const waitingTooLong = performance.now() - this.searchStartedAt >= SEARCH_HINT_DELAY_MS;
      this.setStatus(waitingTooLong ? "no-hands" : "searching");
    }
  }

  private async detectNextFrame(model: HandPoseModel) {
    if (!this.active) return;
    const startedAt = performance.now();
    try {
      const results = await model.detect(this.video);
      if (!this.active) return;
      console.log("[HandPose] Detection results:", results);
      console.log("[HandPose] Hands detected:", results.length);
      this.processResults(results);
      if (!this.active) return;
      const delay = Math.max(
        0,
        TARGET_INFERENCE_INTERVAL_MS - (performance.now() - startedAt),
      );
      this.inferenceTimer = window.setTimeout(() => {
        void this.detectNextFrame(model);
      }, delay);
    } catch (error) {
      if (!this.active) return;
      const message =
        error instanceof Error ? `HandPose inference failed: ${error.message}` : "HandPose inference failed.";
      console.error(message, error);
      this.updateDiagnostics({ error: message });
      this.stop();
      this.setStatus("error", message);
    }
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
        const message = "This browser does not support webcam access.";
        this.updateDiagnostics({ cameraPermission: "unavailable", error: message });
        this.setStatus("unavailable", message);
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

      this.updateDiagnostics({ cameraPermission: "granted", error: "" });
      this.streamEndedHandler = () => {
        if (!this.active) return;
        const message = "The camera stream ended. Reconnect the camera and try again.";
        console.error(message);
        this.stop();
        this.updateDiagnostics({ cameraPermission: "unavailable", error: message });
        this.setStatus("error", message);
      };
      this.stream.addEventListener("inactive", this.streamEndedHandler, { once: true });
      this.video.srcObject = this.stream;
      await this.waitForVideoReady();
      await this.video.play();
      if (this.video.videoWidth <= 0 || this.video.videoHeight <= 0) {
        throw new Error("The camera is active but has no usable video dimensions.");
      }
      this.updateDiagnostics({
        videoReady: true,
        videoWidth: this.video.videoWidth,
        videoHeight: this.video.videoHeight,
      });
      this.setStatus("loading-model");

      const imported = (await import("ml5")) as Ml5Module;
      const ml5 = imported.handPose ? imported : imported.default;
      if (!ml5?.handPose) throw new Error("The ml5 HandPose model could not be loaded.");

      console.log("[HandPose] Initializing model...");
      const handPose = await ml5.handPose({
        maxHands: 2,
        flipped: true,
        modelType: "lite",
        runtime: "tfjs",
      });
      this.model = handPose;
      await this.waitForModel(handPose);
      console.log("[HandPose] Model initialized:", handPose);
      this.updateDiagnostics({ modelLoaded: true });
      if (!this.active) {
        handPose.detectStop?.();
        return false;
      }

      this.searchStartedAt = performance.now();
      this.setStatus("searching");
      this.receivedDetection = false;
      this.updateDiagnostics({ detectionActive: true, hands: [], error: "" });
      this.watchForDetections();
      void this.detectNextFrame(handPose);
      return true;
    } catch (error) {
      this.stop();
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.updateDiagnostics({ cameraPermission: "denied", error: error.message });
        this.setStatus("denied", "Camera permission was denied. Mouse interaction remains available.");
        return false;
      }
      if (error instanceof DOMException && error.name === "NotFoundError") {
        this.updateDiagnostics({ cameraPermission: "unavailable", error: error.message });
        this.setStatus("unavailable", "No camera was found. Mouse interaction remains available.");
        return false;
      }

      const message = error instanceof Error ? error.message : "Hand tracking could not start.";
      console.error("Hand tracking could not start.", error);
      this.updateDiagnostics({ error: message, detectionActive: false });
      this.setStatus(
        "error",
        message,
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
    if (this.streamEndedHandler) {
      stream?.removeEventListener("inactive", this.streamEndedHandler);
      this.streamEndedHandler = null;
    }
    this.updateDiagnostics({
      detectionActive: false,
      videoReady: false,
      videoWidth: 0,
      videoHeight: 0,
    });
    if (this.detectionWatchdog !== null) {
      window.clearTimeout(this.detectionWatchdog);
      this.detectionWatchdog = null;
    }
    if (this.inferenceTimer !== null) {
      window.clearTimeout(this.inferenceTimer);
      this.inferenceTimer = null;
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
