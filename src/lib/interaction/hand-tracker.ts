import type {
  HandObservation,
  HandTrackerHandle,
  HandTrackingDiagnostics,
  TrackingStatus,
} from "./types";
import { INTERACTION_CONFIG } from "./config";

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

interface TensorFlowRuntime {
  ready(): Promise<void>;
  getBackend(): string;
}

interface HandPoseModel {
  ready: Promise<unknown>;
  detect(image: HTMLVideoElement | HTMLCanvasElement): Promise<Ml5HandResult[]>;
  detectStop?(): void;
}

interface Ml5Api {
  tf: TensorFlowRuntime;
  handPose(
    options: {
      maxHands: 2;
      flipped: boolean;
      modelType: "full";
      runtime: "tfjs";
    },
  ): Promise<HandPoseModel> | HandPoseModel;
}

interface Ml5Module {
  handPose?: Ml5Api["handPose"];
  tf?: TensorFlowRuntime;
  default?: Ml5Api;
}

const MODEL_LOAD_TIMEOUT_MS = 30_000;
const DETECTION_TIMEOUT_MS = 12_000;
const SEARCH_HINT_DELAY_MS = 7_000;
const VIDEO_READY_TIMEOUT_MS = 10_000;
const VIDEO_FRAME_TIMEOUT_MS = 5_000;
const TARGET_INFERENCE_INTERVAL_MS = INTERACTION_CONFIG.detection.inferenceIntervalMs;

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
  private lastLoggedHandCount: number | null = null;
  private lastVideoTime = -1;
  private staticTestActive = false;
  private inferenceInProgress = false;
  private inferenceCanvas: HTMLCanvasElement | null = null;
  private diagnostics: HandTrackingDiagnostics = {
    cameraPermission: "unknown",
    videoReady: false,
    videoWidth: 0,
    videoHeight: 0,
    videoCurrentTime: 0,
    videoPaused: true,
    videoFrameCount: 0,
    modelLoaded: false,
    detectionActive: false,
    inferenceBackend: "not initialized",
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

  private async waitForVideoFrame() {
    const firstTime = this.video.currentTime;
    const startedAt = performance.now();

    await new Promise<void>((resolve, reject) => {
      const checkFrame = () => {
        if (
          this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
          !this.video.paused &&
          this.video.currentTime > firstTime
        ) {
          resolve();
          return;
        }
        if (performance.now() - startedAt >= VIDEO_FRAME_TIMEOUT_MS) {
          reject(new Error("The camera video is ready but its frames are not advancing."));
          return;
        }
        window.requestAnimationFrame(checkFrame);
      };

      checkFrame();
    });

    this.lastVideoTime = this.video.currentTime;
    this.updateDiagnostics({
      videoCurrentTime: this.video.currentTime,
      videoPaused: this.video.paused,
      videoFrameCount: this.diagnostics.videoFrameCount + 1,
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
      videoCurrentTime: this.video.currentTime,
      videoPaused: this.video.paused,
      videoFrameCount:
        this.video.currentTime > this.lastVideoTime
          ? this.diagnostics.videoFrameCount + 1
          : this.diagnostics.videoFrameCount,
      detectionFrames: this.diagnostics.detectionFrames + 1,
      lastDetectionAt: Date.now(),
      hands,
      error: "",
    });
    if (this.video.currentTime > this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
    }
    this.onHands(hands);
    if (hands.length > 0) {
      this.setStatus("tracking");
    } else {
      const waitingTooLong = performance.now() - this.searchStartedAt >= SEARCH_HINT_DELAY_MS;
      this.setStatus(waitingTooLong ? "no-hands" : "searching");
    }
  }

  private async detectNextFrame(model: HandPoseModel) {
    if (!this.active || this.staticTestActive) return;
    const startedAt = performance.now();
    this.inferenceInProgress = true;
    try {
      const results = await model.detect(this.captureInferenceFrame());
      if (!this.active) return;
      if (!Array.isArray(results)) {
        throw new Error("HandPose returned a non-array detection response.");
      }
      if (this.lastLoggedHandCount === null || results.length !== this.lastLoggedHandCount) {
        console.info("[HANDPOSE DETECTION] Complete raw response:", results);
        console.info("[HANDPOSE DETECTION] Response structure:", {
          length: results.length,
          hands: results.map((hand) => ({
            keys: Object.keys(hand),
            confidence: hand.confidence ?? hand.score ?? null,
            keypointCount: hand.keypoints?.length ?? 0,
            keypoints: hand.keypoints?.map((point) => ({
              name: point.name,
              confidence: point.confidence ?? point.score ?? null,
            })),
          })),
        });
        this.lastLoggedHandCount = results.length;
      }
      this.processResults(results);
    } catch (error) {
      if (!this.active) return;
      const message =
        error instanceof Error ? `HandPose inference failed: ${error.message}` : "HandPose inference failed.";
      console.error("[HANDPOSE DETECTION] Inference failed:", error);
      this.updateDiagnostics({ error: message });
      this.stop();
      this.setStatus("error", message);
    } finally {
      this.inferenceInProgress = false;
      if (this.active && !this.staticTestActive) {
        const delay = Math.max(
          0,
          TARGET_INFERENCE_INTERVAL_MS - (performance.now() - startedAt),
        );
        this.inferenceTimer = window.setTimeout(() => {
          void this.detectNextFrame(model);
        }, delay);
      }
    }
  }

  private captureInferenceFrame() {
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (width <= 0 || height <= 0) {
      throw new Error("The camera video has no frame dimensions for inference.");
    }

    if (!this.inferenceCanvas) {
      this.inferenceCanvas = document.createElement("canvas");
    }
    if (this.inferenceCanvas.width !== width || this.inferenceCanvas.height !== height) {
      this.inferenceCanvas.width = width;
      this.inferenceCanvas.height = height;
    }

    const context = this.inferenceCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Could not create a canvas for the live camera frame.");
    context.drawImage(this.video, 0, 0, width, height);
    return this.inferenceCanvas;
  }

  async testCurrentFrame(canvas: HTMLCanvasElement) {
    const model = this.model;
    if (!this.active || !model) throw new Error("HandPose must be active before testing a captured frame.");
    if (this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || this.video.videoWidth === 0) {
      throw new Error("The camera has no current frame to capture.");
    }

    this.staticTestActive = true;
    if (this.inferenceTimer !== null) {
      window.clearTimeout(this.inferenceTimer);
      this.inferenceTimer = null;
    }

    while (this.inferenceInProgress && this.active) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
    }
    if (!this.active || !this.model) {
      this.staticTestActive = false;
      throw new Error("Hand tracking stopped before the captured-frame test could run.");
    }

    try {
      canvas.width = this.video.videoWidth;
      canvas.height = this.video.videoHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("Could not create a canvas context for the captured frame.");
      context.drawImage(this.video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonBlackPixels = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] + pixels[index + 1] + pixels[index + 2] > 30) nonBlackPixels += 1;
      }

      const results = await this.model.detect(canvas);
      console.info("[HANDPOSE STATIC TEST] Captured video frame:", {
        currentTime: this.video.currentTime,
        paused: this.video.paused,
        readyState: this.video.readyState,
        width: canvas.width,
        height: canvas.height,
        nonBlackPixelRatio: nonBlackPixels / (canvas.width * canvas.height),
      });
      console.info("[HANDPOSE STATIC TEST] Complete raw response:", results);
      console.info("[HANDPOSE STATIC TEST] Response structure:", {
        length: results.length,
        hands: results.map((hand) => ({
          keys: Object.keys(hand),
          confidence: hand.confidence ?? hand.score ?? null,
          keypointCount: hand.keypoints?.length ?? 0,
          keypoints: hand.keypoints?.map((point) => ({
            name: point.name,
            confidence: point.confidence ?? point.score ?? null,
          })),
        })),
      });
      return results.length;
    } finally {
      this.staticTestActive = false;
      if (this.active && this.model) void this.detectNextFrame(this.model);
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
    console.info("[WEBCAM] HandTracker.start() entered");
    this.setStatus("requesting");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.active = false;
        const message = "This browser does not support webcam access.";
        console.error("[WEBCAM] getUserMedia is unavailable in this browser.");
        this.updateDiagnostics({ cameraPermission: "unavailable", error: message });
        this.setStatus("unavailable", message);
        return false;
      }

      console.info("[WEBCAM] Requesting camera with getUserMedia");
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
        console.info("[WEBCAM] Tracker was stopped while camera permission was pending.");
        this.stop();
        return false;
      }

      console.info("[WEBCAM] Camera stream acquired", {
        tracks: this.stream.getVideoTracks().map((track) => ({
          label: track.label,
          state: track.readyState,
          settings: track.getSettings(),
        })),
      });
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
      console.info("[WEBCAM] Waiting for video metadata and frames");
      await this.waitForVideoReady();
      await this.video.play();
      await this.waitForVideoFrame();
      console.info("[WEBCAM] Video is ready", {
        readyState: this.video.readyState,
        width: this.video.videoWidth,
        height: this.video.videoHeight,
      });
      if (this.video.videoWidth <= 0 || this.video.videoHeight <= 0) {
        throw new Error("The camera is active but has no usable video dimensions.");
      }
      this.updateDiagnostics({
        videoReady: true,
        videoWidth: this.video.videoWidth,
        videoHeight: this.video.videoHeight,
      });
      this.setStatus("loading-model");

      console.info("[HANDPOSE IMPORT] Importing the ml5 ES module");
      const imported = (await import("ml5")) as Ml5Module;
      const ml5 = imported.handPose ? imported : imported.default;
      console.info("[HANDPOSE IMPORT] ml5 module import completed", {
        hasNamedHandPose: Boolean(imported.handPose),
        hasDefaultHandPose: Boolean(imported.default?.handPose),
      });
      if (!ml5?.handPose || !ml5.tf) {
        throw new Error("The ml5 module did not expose the HandPose and TensorFlow APIs.");
      }

      await ml5.tf.ready();
      const inferenceBackend = ml5.tf.getBackend();
      console.info("[HANDPOSE INIT] TensorFlow.js backend ready:", inferenceBackend);
      this.updateDiagnostics({ inferenceBackend });

      console.info("[HANDPOSE INIT] Initializing full model for up to two hands");
      const handPose = await ml5.handPose({
        maxHands: INTERACTION_CONFIG.detection.maxHands,
        flipped: true,
        modelType: "full",
        runtime: "tfjs",
      });
      this.model = handPose;
      console.info("[HANDPOSE INIT] handPose() returned a model; waiting for model.ready");
      await this.waitForModel(handPose);
      console.info("[HANDPOSE INIT] Model initialized:", handPose);
      this.updateDiagnostics({ modelLoaded: true });
      if (!this.active) {
        console.info("[HANDPOSE INIT] Tracker stopped during model loading; skipping detection.");
        handPose.detectStop?.();
        return false;
      }

      this.searchStartedAt = performance.now();
      this.setStatus("searching");
      this.receivedDetection = false;
      this.lastLoggedHandCount = null;
      this.updateDiagnostics({ detectionActive: true, hands: [], error: "" });
      this.watchForDetections();
      console.info("[HANDPOSE DETECTION] Starting sequential detect(canvas) inference from the live video", {
        readyState: this.video.readyState,
        width: this.video.videoWidth,
        height: this.video.videoHeight,
        currentTime: this.video.currentTime,
      });
      void this.detectNextFrame(handPose);
      return true;
    } catch (error) {
      this.stop();
      console.error("[WEBCAM] Hand tracking startup failed:", error);
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
      if (error instanceof DOMException && error.name === "NotReadableError") {
        const message =
          "The camera is already in use or unavailable. Close other apps or tabs using it, then enable hands again.";
        this.updateDiagnostics({ cameraPermission: "unavailable", error: message });
        this.setStatus("error", message);
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
      videoCurrentTime: this.video.currentTime,
      videoPaused: this.video.paused,
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
