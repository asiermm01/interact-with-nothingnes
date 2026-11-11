"use client";

import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { GestureRecognizer } from "@/lib/interaction/gesture-recognition";
import { HandTracker } from "@/lib/interaction/hand-tracker";
import type {
  GestureName,
  HandObservation,
  HandTrackingDiagnostics,
  InteractionFrame,
  ParticleCanvasHandle,
  TrackingStatus,
  UserSettings,
  VisualMode,
} from "@/lib/interaction/types";

const ParticleCanvas = dynamic(() => import("./ParticleCanvas"), {
  ssr: false,
  loading: () => <div aria-hidden="true" className="canvas-loading" />,
});

const initialSettings: UserSettings = {
  density: 1050,
  intensity: 54,
  persistence: 72,
  mode: "nebula",
};

const initialInteraction: InteractionFrame = {
  hands: [],
  mouse: { x: 0.5, y: 0.5 },
  mouseActive: false,
  mousePressed: false,
  gesture: "IDLE",
  tracePoints: [],
  shockwaves: [],
  universeScale: 1,
  universeRotation: 0,
  intensity: 1,
};

const gestureLabels: Record<GestureName, string> = {
  IDLE: "Move to disturb the field",
  TRACE: "TRACE · Index finger",
  GRAVITY: "GRAVITY · Open / close your hand",
  IMPULSE: "IMPULSE · Move quickly",
  STRETCH: "STRETCH · Move hands apart",
  COLLAPSE: "COLLAPSE · Pinch to gather",
};

const statusLabels: Record<TrackingStatus, string> = {
  idle: "MOUSE FIELD",
  requesting: "REQUESTING CAMERA",
  "loading-model": "LOADING HANDPOSE",
  tracking: "HANDS PRESENT",
  searching: "SEARCHING FOR HANDS",
  "no-hands": "NO HANDS DETECTED",
  denied: "CAMERA DECLINED",
  unavailable: "CAMERA UNAVAILABLE",
  error: "TRACKING ERROR",
};

const initialDiagnostics: HandTrackingDiagnostics = {
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

export default function Experience() {
  const loggedRenderRef = useRef(false);
  if (!loggedRenderRef.current) {
    console.info("[WEBCAM] Experience component rendered");
    loggedRenderRef.current = true;
  }

  const interactionRef = useRef<InteractionFrame>({ ...initialInteraction });
  const settingsRef = useRef<UserSettings>({ ...initialSettings });
  const engineRef = useRef<ParticleCanvasHandle | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const recognizerRef = useRef(new GestureRecognizer());
  const videoRef = useRef<HTMLVideoElement>(null);
  const staticFrameCanvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const lastGestureRef = useRef<GestureName>("IDLE");
  const lastDiagnosticsUpdateRef = useRef(0);
  const diagnosticsRef = useRef(initialDiagnostics);
  const debugEnabledRef = useRef(false);
  const [settings, setSettings] = useState(initialSettings);
  const [trackingStatus, setTrackingStatus] = useState<TrackingStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [activeGesture, setActiveGesture] = useState<GestureName>("IDLE");
  const [quality, setQuality] = useState("AUTO");
  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isInterfaceVisible, setIsInterfaceVisible] = useState(true);
  const [hint, setHint] = useState("");
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [diagnostics, setDiagnostics] = useState(initialDiagnostics);
  const [staticTestResult, setStaticTestResult] = useState("");
  const [staticFrameCaptured, setStaticFrameCaptured] = useState(false);
  debugEnabledRef.current = debugEnabled;

  const hasCameraImage =
    trackingStatus === "loading-model" ||
    trackingStatus === "searching" ||
    trackingStatus === "no-hands" ||
    trackingStatus === "tracking";

  settingsRef.current = settings;

  const updateHands = useCallback((observations: HandObservation[]) => {
    const frame = recognizerRef.current.update(observations, performance.now());
    frame.mouse = interactionRef.current.mouse;
    frame.mouseActive = interactionRef.current.mouseActive;
    frame.mousePressed = interactionRef.current.mousePressed;
    interactionRef.current = frame;
    if (frame.gesture !== lastGestureRef.current && frame.gesture !== "IDLE") {
      setHint(gestureLabels[frame.gesture]);
    }
    lastGestureRef.current = frame.gesture;
    setActiveGesture(frame.gesture);
  }, []);

  const updateTrackingStatus = useCallback((status: TrackingStatus, message?: string) => {
    setTrackingStatus(status);
    setStatusMessage(message ?? "");
    setIsTracking(
      status === "requesting" ||
        status === "tracking" ||
        status === "searching" ||
        status === "no-hands" ||
        status === "loading-model",
    );
    if (status === "denied" || status === "unavailable" || status === "error") {
      trackerRef.current = null;
      recognizerRef.current = new GestureRecognizer();
      interactionRef.current = { ...initialInteraction };
      lastGestureRef.current = "IDLE";
      setActiveGesture("IDLE");
    }
  }, []);

  const startTracking = useCallback(async () => {
    const video = videoRef.current;
    console.info("[WEBCAM] startTracking called", {
      videoElementAvailable: Boolean(video),
      trackerAlreadyCreated: Boolean(trackerRef.current),
    });
    if (!video) {
      console.error("[WEBCAM] Cannot start tracking: the video element is not mounted.");
      return;
    }
    if (trackerRef.current) {
      console.info("[WEBCAM] Tracking is already starting or active.");
      return;
    }
    diagnosticsRef.current = initialDiagnostics;
    lastDiagnosticsUpdateRef.current = 0;
    setDiagnostics(initialDiagnostics);
    const tracker = new HandTracker(
      video,
      updateHands,
      updateTrackingStatus,
      (nextDiagnostics) => {
        diagnosticsRef.current = nextDiagnostics;
        if (!debugEnabledRef.current) return;
        const now = performance.now();
        if (now - lastDiagnosticsUpdateRef.current < 180) return;
        lastDiagnosticsUpdateRef.current = now;
        setDiagnostics(nextDiagnostics);
      },
    );
    trackerRef.current = tracker;
    const started = await tracker.start();
    if (!started) trackerRef.current = null;
  }, [updateHands, updateTrackingStatus]);

  const stopTracking = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    recognizerRef.current = new GestureRecognizer();
    interactionRef.current = { ...initialInteraction };
    lastGestureRef.current = "IDLE";
    setIsTracking(false);
    setTrackingStatus("idle");
    setStatusMessage("");
    setActiveGesture("IDLE");
  }, []);

  const testCapturedFrame = async () => {
    const canvas = staticFrameCanvasRef.current;
    const tracker = trackerRef.current;
    if (!canvas || !tracker) {
      setStaticTestResult("Start camera tracking before testing a captured frame.");
      return;
    }

    setStaticTestResult("Capturing the current camera frame and testing it…");
    setStaticFrameCaptured(false);
    try {
      const count = await tracker.testCurrentFrame(canvas);
      setStaticFrameCaptured(true);
      setStaticTestResult(`Captured-frame inference found ${count} hand${count === 1 ? "" : "s"}.`);
    } catch (error) {
      console.error("[HANDPOSE STATIC TEST] Captured-frame inference failed:", error);
      setStaticTestResult(
        error instanceof Error ? `Static test failed: ${error.message}` : "Static test failed.",
      );
    }
  };

  const changeSetting = <Key extends keyof UserSettings>(
    key: Key,
    value: UserSettings[Key],
  ) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch" && event.buttons === 0) return;
    if (event.target instanceof Element && event.target.closest("[data-ui]")) return;
    const point = {
      x: event.clientX / window.innerWidth,
      y: event.clientY / window.innerHeight,
    };
    const current = interactionRef.current;
    const tracePoints =
      event.buttons > 0
        ? [...current.tracePoints, point].slice(-28)
        : current.tracePoints.length
          ? current.tracePoints.slice(1)
          : current.tracePoints;
    interactionRef.current = {
      ...current,
      mouse: point,
      mouseActive: true,
      mousePressed: event.buttons > 0,
      gesture: event.buttons > 0 ? "TRACE" : current.hands.length ? current.gesture : "GRAVITY",
      tracePoints,
    };
    if (current.hands.length === 0) {
      setActiveGesture(event.buttons > 0 ? "TRACE" : "GRAVITY");
    }
  };

  const onPointerLeave = () => {
    interactionRef.current = {
      ...interactionRef.current,
      mouseActive: false,
      mousePressed: false,
      gesture: interactionRef.current.hands.length ? interactionRef.current.gesture : "IDLE",
      tracePoints: interactionRef.current.hands.length ? interactionRef.current.tracePoints : [],
    };
    if (!interactionRef.current.hands.length) setActiveGesture("IDLE");
  };

  const togglePanel = async () => {
    const next = !isPanelOpen;
    setIsPanelOpen(next);
    const { gsap } = await import("gsap");
    if (panelRef.current) {
      gsap.to(panelRef.current, {
        autoAlpha: next ? 1 : 0,
        y: next ? 0 : 10,
        duration: 0.28,
        ease: "power2.out",
        pointerEvents: next ? "auto" : "none",
      });
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await rootRef.current?.requestFullscreen();
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Fullscreen is unavailable.");
    }
  };

  useEffect(() => {
    if (!hint) return;
    const timeout = window.setTimeout(() => setHint(""), 3800);
    return () => window.clearTimeout(timeout);
  }, [hint]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "h" && !event.repeat) {
        setIsInterfaceVisible((visible) => !visible);
      }
      if (event.key === "Escape") setIsInterfaceVisible(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    console.info("[WEBCAM] Startup effect mounted");
    const startup = window.setTimeout(() => {
      if (cancelled) {
        console.info("[WEBCAM] Startup was cancelled before camera initialization.");
        return;
      }
      console.info("[WEBCAM] Startup effect invoking startTracking");
      void startTracking().catch((error: unknown) => {
        console.error("[WEBCAM] Unexpected startup failure:", error);
      });
    }, 0);

    return () => {
      console.info("[WEBCAM] Startup effect cleanup");
      cancelled = true;
      window.clearTimeout(startup);
      const tracker = trackerRef.current;
      trackerRef.current = null;
      tracker?.stop();
    };
  }, [startTracking]);

  const togglePause = () => {
    if (isPaused) engineRef.current?.resume();
    else engineRef.current?.pause();
    setIsPaused((paused) => !paused);
    setHint(isPaused ? "The field resumes." : "The field is still.");
  };

  const setMode = (mode: VisualMode) => changeSetting("mode", mode);

  return (
    <main
      className="experience"
      onPointerLeave={onPointerLeave}
      onPointerMove={onPointerMove}
      ref={rootRef}
    >
      <ParticleCanvas
        interactionRef={interactionRef}
        onError={setStatusMessage}
        onQuality={setQuality}
        onReady={(handle) => {
          engineRef.current = handle;
        }}
        settingsRef={settingsRef}
      />

      <figure
        aria-label="Live camera preview for local hand tracking"
        className="camera-preview"
        data-active={hasCameraImage}
        data-debug={debugEnabled}
        data-visible={isInterfaceVisible}
      >
        <video
          aria-label="Mirrored live camera image used for hand tracking"
          autoPlay
          className="camera-feed"
          muted
          playsInline
          ref={videoRef}
        />
        {debugEnabled && diagnostics.hands.length > 0 && (
          <svg
            aria-hidden="true"
            className="hand-landmark-overlay"
            preserveAspectRatio="none"
            viewBox="0 0 1 1"
          >
            {diagnostics.hands.map((hand, handIndex) => (
              <g key={`${hand.handedness ?? "hand"}-${handIndex}`}>
                {hand.keypoints.map((point) => {
                  const isAnchor =
                    point.name === "wrist" ||
                    point.name.endsWith("_finger_tip") ||
                    point.name === "thumb_tip";
                  return (
                    <g key={point.name}>
                      <circle
                        className={isAnchor ? "landmark-anchor" : "landmark-point"}
                        cx={point.x}
                        cy={point.y}
                        r={isAnchor ? 0.012 : 0.006}
                      />
                      {isAnchor && (
                        <text x={point.x + 0.012} y={point.y - 0.012}>
                          {point.name.replace("_finger", "")}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ))}
          </svg>
        )}
        {!hasCameraImage && (
          <span className="camera-placeholder">
            {trackingStatus === "requesting" ? "CONNECTING" : "CAMERA OFF"}
          </span>
        )}
        <figcaption>{hasCameraImage ? "LIVE INPUT · LOCAL ONLY" : "CAMERA PREVIEW"}</figcaption>
        {debugEnabled && (
          <div className="tracking-diagnostics" aria-live="polite">
            <p>TRACKING DIAGNOSTICS</p>
            <span>Camera permission: {diagnostics.cameraPermission}</span>
            <span>
              Video: {diagnostics.videoReady ? "ready" : "waiting"} ·{" "}
              {diagnostics.videoWidth} × {diagnostics.videoHeight} · readyState{" "}
              {videoRef.current?.readyState ?? 0} · t=
              {diagnostics.videoCurrentTime.toFixed(2)}s ·{" "}
              {diagnostics.videoPaused ? "paused" : "playing"} ·{" "}
              {diagnostics.videoFrameCount} advancing frames
            </span>
            <span>
              HandPose model: {diagnostics.modelLoaded ? "ready" : "loading"} · full · one hand
            </span>
            <span>TensorFlow.js backend: {diagnostics.inferenceBackend}</span>
            <span>
              Inference: {diagnostics.detectionActive ? "active" : "stopped"} ·{" "}
              {diagnostics.detectionFrames} frames
              {diagnostics.lastDetectionAt
                ? ` · ${Math.max(0, Math.round((Date.now() - diagnostics.lastDetectionAt) / 1000))}s ago`
                : ""}
            </span>
            <span>Detected hands: {diagnostics.hands.length}</span>
            {diagnostics.hands.map((hand, index) => (
              <span key={`${hand.handedness ?? "hand"}-confidence-${index}`}>
                Hand {index + 1}
                {hand.handedness ? ` (${hand.handedness})` : ""}:{" "}
                {Number.isFinite(hand.confidence)
                  ? `${(hand.confidence * 100).toFixed(0)}% confidence`
                  : "confidence unavailable"}{" "}
                · {hand.keypoints.length} landmarks
              </span>
            ))}
            <span>Gesture engine: {activeGesture}</span>
            {diagnostics.error && <span className="diagnostic-error">{diagnostics.error}</span>}
            <button
              className="tracking-toggle diagnostic-test-button"
              disabled={!diagnostics.detectionActive}
              onClick={() => void testCapturedFrame()}
              type="button"
            >
              CAPTURE FRAME + TEST
            </button>
            <canvas
              aria-label="Captured camera frame sent to static HandPose inference"
              className="static-frame-preview"
              data-captured={staticFrameCaptured}
              ref={staticFrameCanvasRef}
            />
            {staticTestResult && <span>{staticTestResult}</span>}
          </div>
        )}
      </figure>

      {!isInterfaceVisible && (
        <button
          aria-label="Show interface"
          className="interface-reveal"
          data-ui
          onClick={() => setIsInterfaceVisible(true)}
          type="button"
        >
          + UI
        </button>
      )}

      {isInterfaceVisible && (
        <div className="interface-layer" data-ui>
          <header className="identity">
            <span className="identity-mark" aria-hidden="true">
              ∅
            </span>
            <div>
              <p>ONE WITH NOTHINGNESS</p>
              <span>FIELD STUDY &nbsp; / &nbsp; 001</span>
            </div>
          </header>

          <section aria-label="Tracking status" className="tracking">
            <span className={`tracking-light is-${trackingStatus}`} />
            <div>
              <p>{statusLabels[trackingStatus]}</p>
              <span>
                {trackingStatus === "no-hands"
                  ? "FULL HAND IN FRAME · PALM TO CAMERA"
                  : isTracking
                    ? "LOCAL PROCESSING"
                    : "MOVE TO INTERACT"}
              </span>
            </div>
            <button
              className="tracking-toggle"
              onClick={isTracking ? stopTracking : startTracking}
              type="button"
            >
              {isTracking ? "DISCONNECT" : "ENABLE HANDS"}
            </button>
            <button
              aria-pressed={debugEnabled}
              className="tracking-toggle debug-toggle"
              onClick={() => {
                const next = !debugEnabled;
                if (next) setDiagnostics(diagnosticsRef.current);
                setDebugEnabled(next);
              }}
              type="button"
            >
              DEBUG {debugEnabled ? "ON" : "OFF"}
            </button>
          </section>

          <div aria-live="polite" className="gesture-readout">
            <span className="readout-line" />
            <p>{gestureLabels[activeGesture]}</p>
            <span>{quality} QUALITY</span>
          </div>

          {(statusMessage || hint) && (
            <p aria-live="polite" className="toast">
              {statusMessage || hint}
            </p>
          )}

          <aside
            aria-label="Experience controls"
            className={`control-panel ${isPanelOpen ? "is-open" : ""}`}
            ref={panelRef}
          >
            <div className="panel-heading">
              <div>
                <span>FIELD PARAMETERS</span>
                <h2>Adjust the medium</h2>
              </div>
              <button
                aria-label="Close controls"
                className="icon-button panel-close"
                onClick={togglePanel}
                type="button"
              >
                ×
              </button>
            </div>

            <label className="slider-control">
              <span>PARTICLE DENSITY <output>{settings.density}</output></span>
              <input
                max="1800"
                min="300"
                onChange={(event) => changeSetting("density", Number(event.target.value))}
                step="50"
                type="range"
                value={settings.density}
              />
            </label>

            <label className="slider-control">
              <span>FORCE INTENSITY <output>{settings.intensity}%</output></span>
              <input
                max="100"
                min="10"
                onChange={(event) => changeSetting("intensity", Number(event.target.value))}
                type="range"
                value={settings.intensity}
              />
            </label>

            <label className="slider-control">
              <span>TRAIL PERSISTENCE <output>{settings.persistence}%</output></span>
              <input
                max="96"
                min="20"
                onChange={(event) => changeSetting("persistence", Number(event.target.value))}
                type="range"
                value={settings.persistence}
              />
            </label>

            <fieldset className="mode-control">
              <legend>VISUAL MODE</legend>
              {(["nebula", "filament", "monochrome"] as const).map((mode) => (
                <button
                  aria-pressed={settings.mode === mode}
                  className={settings.mode === mode ? "is-selected" : ""}
                  key={mode}
                  onClick={() => setMode(mode)}
                  type="button"
                >
                  {mode}
                </button>
              ))}
            </fieldset>

            <p className="panel-note">Camera inference stays on this device.</p>
          </aside>

          <nav aria-label="Experience actions" className="toolbar">
            <button
              aria-expanded={isPanelOpen}
              className="toolbar-button settings-button"
              onClick={togglePanel}
              type="button"
            >
              <span aria-hidden="true">⌘</span> PARAMETERS
            </button>
            <span className="toolbar-divider" />
            <button
              aria-label={isPaused ? "Resume" : "Pause"}
              className="icon-button"
              onClick={togglePause}
              type="button"
            >
              {isPaused ? "▶" : "Ⅱ"}
            </button>
            <button
              className="icon-button"
              aria-label="Reset universe"
              onClick={() => {
                engineRef.current?.reset();
                setHint("The field returns to its first state.");
              }}
              title="Reset universe"
              type="button"
            >
              ↺
            </button>
            <button
              className="icon-button"
              aria-label="Capture image"
              onClick={() => engineRef.current?.capture()}
              type="button"
            >
              ↓
            </button>
            <button
              aria-label="Toggle fullscreen"
              className="icon-button"
              onClick={toggleFullscreen}
              type="button"
            >
              ⛶
            </button>
            <button
              className="icon-button hide-button"
              aria-label="Hide interface"
              onClick={() => setIsInterfaceVisible(false)}
              type="button"
            >
              − UI
            </button>
          </nav>

          <footer className="interface-footer">
            <span>MOVE · SHAPE · RELEASE</span>
            <span>ESCAPE TO RETURN</span>
          </footer>
        </div>
      )}
    </main>
  );
}
