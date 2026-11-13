import type {
  HandObservation,
  HandTrackerHandle,
  TrackingStatus,
} from "./types";
import { INTERACTION_CONFIG } from "./config";

// Adapta la salida de ml5 a los contratos del proyecto; ni React ni p5
// necesitan conocer los detalles de la cámara o del modelo.
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
const startupErrorMessages = new Map([
  ["The camera stream could not provide video frames.", "La cámara no ha podido enviar imágenes."],
  ["The camera did not become ready. Check that it is not being used by another app.", "La cámara no está lista. Comprueba que no la esté usando otra aplicación."],
  ["The camera video is ready but its frames are not advancing.", "La cámara está lista, pero la imagen no avanza."],
  ["The camera is active but has no usable video dimensions.", "La cámara está activa, pero no envía imágenes válidas."],
  ["The ml5 module did not expose the HandPose and TensorFlow APIs.", "No se pudo cargar la detección de manos."],
  ["HandPose is taking too long to load. Check your internet connection and try again.", "La detección de manos tarda demasiado en cargar. Comprueba la conexión a internet e inténtalo de nuevo."],
]);

/**
 * Controla la cámara y HandPose. Publica observaciones y estados mediante
 * callbacks, y libera el flujo, los temporizadores y el modelo al detenerse.
 */
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
  private inferenceCanvas: HTMLCanvasElement | null = null;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onHands: (hands: HandObservation[]) => void,
    private readonly onStatus: (status: TrackingStatus, message?: string) => void,
  ) {}

  private setStatus(status: TrackingStatus, message?: string) {
    if (this.trackingStatus === status && !message) return;
    this.trackingStatus = status;
    this.onStatus(status, message);
  }

  // Los metadatos no garantizan por sí solos que haya imágenes disponibles.
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

  }

  // requestAnimationFrame espera al siguiente repintado del navegador y
  // comprueba que el tiempo del vídeo avance antes de ejecutar el modelo.
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

  }

  // El watchdog hace visible un modelo que deja de responder en vez de dejar
  // la interfaz esperando indefinidamente.
  private watchForDetections() {
    if (this.detectionWatchdog !== null) {
      window.clearTimeout(this.detectionWatchdog);
    }
    const timeout = this.receivedDetection ? DETECTION_TIMEOUT_MS : MODEL_LOAD_TIMEOUT_MS;
    this.detectionWatchdog = window.setTimeout(() => {
      if (!this.active) return;
      console.error("HandPose did not return inference results before the watchdog expired.");
      this.stop();
      const message = "La detección ha dejado de responder. Comprueba la cámara y la conexión a internet e inténtalo de nuevo.";
      this.setStatus("error", message);
    }, timeout);
  }

  /** Filtra puntos inválidos, normaliza píxeles a 0–1 y entrega las manos al reconocedor. */
  private processResults(results: Ml5HandResult[]) {
    if (!this.active) return;
    if (!Array.isArray(results)) {
      const message = "La detección ha devuelto un resultado no válido.";
      console.error(message, results);
      this.stop();
      this.setStatus("error", message);
      return;
    }

    this.receivedDetection = true;
    this.watchForDetections();
    const width = this.video.videoWidth;
    const height = this.video.videoHeight;
    if (width <= 0 || height <= 0) {
      const message = "La cámara ha dejado de enviar imágenes válidas.";
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
    this.onHands(hands);
    if (hands.length > 0) {
      this.setStatus("tracking");
    } else {
      const waitingTooLong = performance.now() - this.searchStartedAt >= SEARCH_HINT_DELAY_MS;
      this.setStatus(waitingTooLong ? "no-hands" : "searching");
    }
  }

  // Cada promesa de inferencia termina antes de programar la siguiente; así
  // no se acumulan llamadas concurrentes si el modelo tarda en responder.
  private async detectNextFrame(model: HandPoseModel) {
    if (!this.active) return;
    const startedAt = performance.now();
    try {
      const results = await model.detect(this.captureInferenceFrame());
      if (!this.active) return;
      if (!Array.isArray(results)) {
        throw new Error("HandPose returned a non-array detection response.");
      }
      this.processResults(results);
    } catch (error) {
      if (!this.active) return;
      const message = "No se pudieron detectar las manos. Comprueba la cámara e inténtalo de nuevo.";
      console.error("[HANDPOSE DETECTION] Inference failed:", error);
      this.stop();
      this.setStatus("error", message);
    } finally {
      if (this.active) {
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

  // Se reutiliza un canvas auxiliar para capturar la imagen actual del vídeo.
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

  // Promise.race limita la espera del modelo y el temporizador se limpia tanto
  // si la carga termina como si falla.
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

  /** Solicita permiso, espera al vídeo y al modelo, y arranca la inferencia local. */
  async start(): Promise<boolean> {
    if (this.active) return true;
    this.active = true;
    console.info("[WEBCAM] HandTracker.start() entered");
    this.setStatus("requesting");

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        this.active = false;
        const message = "Este navegador no permite acceder a la cámara.";
        console.error("[WEBCAM] getUserMedia is unavailable in this browser.");
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

      // El usuario puede desconectar mientras la petición de permiso sigue pendiente.
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
      this.streamEndedHandler = () => {
        if (!this.active) return;
        const message = "La cámara se ha desconectado. Vuelve a conectarla e inténtalo de nuevo.";
        console.error(message);
        this.stop();
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
      if (!this.active) {
        console.info("[HANDPOSE INIT] Tracker stopped during model loading; skipping detection.");
        handPose.detectStop?.();
        return false;
      }

      this.searchStartedAt = performance.now();
      this.setStatus("searching");
      this.receivedDetection = false;
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
        this.setStatus("denied", "Se ha denegado el acceso a la cámara. Puedes seguir usando el ratón.");
        return false;
      }
      if (error instanceof DOMException && error.name === "NotFoundError") {
        this.setStatus("unavailable", "No se ha encontrado ninguna cámara. Puedes seguir usando el ratón.");
        return false;
      }
      if (error instanceof DOMException && error.name === "NotReadableError") {
        const message =
          "La cámara no está disponible o ya está en uso. Cierra las aplicaciones o pestañas que la usen y vuelve a activar las manos.";
        this.setStatus("error", message);
        return false;
      }

      const message = (error instanceof Error && startupErrorMessages.get(error.message)) ||
        "No se pudo iniciar la detección de manos. Comprueba la cámara y la conexión a internet e inténtalo de nuevo.";
      console.error("Hand tracking could not start.", error);
      this.setStatus(
        "error",
        message,
      );
      return false;
    }
  }

  /** Detiene el seguimiento y libera cámara, escucha de eventos y temporizadores. */
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
