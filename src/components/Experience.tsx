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
import type { ParticlePerformanceSnapshot } from "@/lib/rendering/particle-engine";
import {
  DEFAULT_USER_SETTINGS,
  INTERACTION_CONFIG,
  INTERACTION_TUNING_RANGES,
} from "@/lib/interaction/config";
import type {
  GestureName,
  HandObservation,
  HandTrackingDiagnostics,
  InteractionFrame,
  InteractionTuning,
  ParticleCanvasHandle,
  TrackingStatus,
  UserSettings,
  VisualMode,
} from "@/lib/interaction/types";

const ParticleCanvas = dynamic(() => import("./ParticleCanvas"), {
  ssr: false,
  loading: () => <div aria-hidden="true" className="canvas-loading" />,
});

const initialInteraction: InteractionFrame = {
  hands: [],
  tracking: [],
  mouse: { x: 0.5, y: 0.5 },
  mouseActive: false,
  mousePressed: false,
  gesture: "IDLE",
  cursors: [],
  strokes: [],
  strokeVersion: 0,
  clearVersion: 0,
  clearProgress: 0,
  clearActive: false,
  clearCooldownRemaining: 0,
  events: [],
  universeScale: 1,
  universeRotation: 0,
};

const gestureLabels: Record<GestureName, string> = {
  IDLE: "Move to disturb the field",
  CURSOR: "CURSOR · Extend one finger to position without disturbing the field",
  TRACE: "TRACE · Extend two fingers to draw persistent strokes",
  GRAVITY: "GRAVITY · Close one hand into a fist to attract particles",
  STRETCH: "STRETCH · Open both palms and move them apart or together",
  COLLAPSE: "COLLAPSE · Pinch thumb and index while extending the other three fingers",
  "CLEAR ALL": "CLEAR ALL · Hold both thumbs extended",
};

const gestureLegend = [
  { name: "CURSOR", cue: "1 FINGER", symbol: "1", description: "Move the cursor without affecting particles or drawings." },
  { name: "TRACE", cue: "2 FINGERS", symbol: "2", description: "Draw persistent strokes with the two-finger brush." },
  { name: "GRAVITY", cue: "CLOSED FIST", symbol: "F", description: "Attract nearby particles toward the center of that hand." },
  { name: "STRETCH", cue: "2 OPEN PALMS", symbol: "OPEN ×2", description: "Move both open palms to scale and rotate the particle field." },
  { name: "COLLAPSE", cue: "OK SIGN", symbol: "OK", description: "Pinch thumb to index while extending the middle, ring, and pinky fingers." },
  { name: "CLEAR ALL", cue: "THUMBS ONLY · HOLD", symbol: "T ×2", description: "Extend only the thumb on each hand and hold to erase all persistent TRACE strokes." },
] as const;

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
  const settingsRef = useRef<UserSettings>({ ...DEFAULT_USER_SETTINGS });
  const engineRef = useRef<ParticleCanvasHandle | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const recognizerRef = useRef(new GestureRecognizer());
  const videoRef = useRef<HTMLVideoElement>(null);
  const staticFrameCanvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const gestureLegendTriggerRef = useRef<HTMLButtonElement>(null);
  const gestureLegendCloseRef = useRef<HTMLButtonElement>(null);
  const lastGestureRef = useRef<GestureName>("IDLE");
  const lastDiagnosticsUpdateRef = useRef(0);
  const lastDebugInteractionUpdateRef = useRef(0);
  const diagnosticsRef = useRef(initialDiagnostics);
  const debugEnabledRef = useRef(false);
  const [settings, setSettings] = useState(DEFAULT_USER_SETTINGS);
  const [trackingStatus, setTrackingStatus] = useState<TrackingStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [activeGesture, setActiveGesture] = useState<GestureName>("IDLE");
  const [quality, setQuality] = useState("AUTO");
  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isGestureLegendOpen, setIsGestureLegendOpen] = useState(false);
  const [isInterfaceVisible, setIsInterfaceVisible] = useState(true);
  const [hint, setHint] = useState("");
  const [debugEnabled, setDebugEnabled] = useState(false);
  const [diagnostics, setDiagnostics] = useState(initialDiagnostics);
  const [staticTestResult, setStaticTestResult] = useState("");
  const [staticFrameCaptured, setStaticFrameCaptured] = useState(false);
  const [handSummary, setHandSummary] = useState("NO HANDS DETECTED");
  const [clearProgress, setClearProgress] = useState(0);
  const [debugInteraction, setDebugInteraction] = useState<InteractionFrame | null>(null);
  const [renderPerformance, setRenderPerformance] = useState<ParticlePerformanceSnapshot | null>(null);
  debugEnabledRef.current = debugEnabled;
  const handSummaryRef = useRef("");
  const lastClearVersionRef = useRef(0);
  const lastClearProgressUpdateRef = useRef(0);
  const clearProgressRef = useRef(0);

  const resetTrackingFrame = () => {
    recognizerRef.current.releaseStretch();
    const current = interactionRef.current;
    interactionRef.current = {
      ...initialInteraction,
      strokes: current.strokes,
      strokeVersion: current.strokeVersion,
      clearVersion: current.clearVersion,
      universeScale: current.universeScale,
      universeRotation: current.universeRotation,
    };
  };

  const hasCameraImage =
    trackingStatus === "loading-model" ||
    trackingStatus === "searching" ||
    trackingStatus === "no-hands" ||
    trackingStatus === "tracking";

  settingsRef.current = settings;

  useEffect(() => {
    if (process.env.NODE_ENV === "production" || !debugEnabled) return;
    const update = () => setRenderPerformance(window.__particlePerformance?.() ?? null);
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [debugEnabled]);

  const updateHands = useCallback((observations: HandObservation[]) => {
    const frame = recognizerRef.current.update(
      observations,
      performance.now(),
      settingsRef.current.interaction,
      { width: window.innerWidth, height: window.innerHeight },
    );
    frame.mouse = interactionRef.current.mouse;
    frame.mouseActive = interactionRef.current.mouseActive;
    frame.mousePressed = interactionRef.current.mousePressed;
    interactionRef.current = frame;
    if (frame.gesture !== lastGestureRef.current && frame.gesture !== "IDLE") {
      setHint(gestureLabels[frame.gesture]);
    }
    if (frame.clearVersion !== lastClearVersionRef.current) {
      lastClearVersionRef.current = frame.clearVersion;
      setHint("TRACE FIELD CLEARED");
    }
    if (frame.clearActive) {
      const now = performance.now();
      if (now - lastClearProgressUpdateRef.current >= 100) {
        lastClearProgressUpdateRef.current = now;
        clearProgressRef.current = frame.clearProgress;
        setClearProgress(frame.clearProgress);
      }
    } else if (clearProgressRef.current !== 0) {
      clearProgressRef.current = 0;
      setClearProgress(0);
    }
    if (frame.gesture !== lastGestureRef.current) {
      lastGestureRef.current = frame.gesture;
      setActiveGesture(frame.gesture);
    }
    const nextSummary =
      frame.hands.length === 0
        ? "NO HANDS DETECTED"
        : frame.hands
            .map((hand) =>
              hand.handedness === "Unknown"
                ? `HAND ${hand.id.replace("hand-", "")}`
                : `${hand.handedness.toUpperCase()} HAND`,
            )
            .sort()
            .join(" + ");
    if (nextSummary !== handSummaryRef.current) {
      handSummaryRef.current = nextSummary;
      setHandSummary(nextSummary);
    }
    if (debugEnabledRef.current) {
      const now = performance.now();
      if (now - lastDebugInteractionUpdateRef.current >= 180) {
        lastDebugInteractionUpdateRef.current = now;
        setDebugInteraction(frame);
      }
    }
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
      resetTrackingFrame();
      lastGestureRef.current = "IDLE";
      handSummaryRef.current = "NO HANDS DETECTED";
      setHandSummary("NO HANDS DETECTED");
      clearProgressRef.current = 0;
      setClearProgress(0);
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
    handSummaryRef.current = "NO HANDS DETECTED";
    setDiagnostics(initialDiagnostics);
    setDebugInteraction(null);
    setHandSummary("NO HANDS DETECTED");
    const tracker = new HandTracker(
      video,
      updateHands,
      updateTrackingStatus,
      (nextDiagnostics) => {
        diagnosticsRef.current = nextDiagnostics;
        if (!debugEnabledRef.current) return;
        const now = performance.now();
        if (
          nextDiagnostics.detectionActive &&
          now - lastDiagnosticsUpdateRef.current < 180
        ) {
          return;
        }
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
    resetTrackingFrame();
    lastGestureRef.current = "IDLE";
    handSummaryRef.current = "NO HANDS DETECTED";
    setIsTracking(false);
    setTrackingStatus("idle");
    setStatusMessage("");
    setActiveGesture("IDLE");
    setHandSummary("NO HANDS DETECTED");
    setDebugInteraction(null);
    clearProgressRef.current = 0;
    setClearProgress(0);
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

  const changeInteractionSetting = <Key extends keyof InteractionTuning>(
    key: Key,
    value: InteractionTuning[Key],
  ) => {
    setSettings((current) => ({
      ...current,
      interaction: { ...current.interaction, [key]: value },
    }));
  };

  const clearTraceDrawings = () => {
    const cleared = recognizerRef.current.clearDrawings();
    interactionRef.current = {
      ...interactionRef.current,
      strokes: cleared.strokes,
      strokeVersion: cleared.strokeVersion,
      clearVersion: cleared.clearVersion,
      clearCooldownRemaining: cleared.clearCooldownRemaining,
      events: cleared.events,
    };
    lastClearVersionRef.current = cleared.clearVersion;
    clearProgressRef.current = 0;
    setClearProgress(0);
    setHint("TRACE FIELD CLEARED");
  };

  const renderTuningSlider = (
    key: keyof InteractionTuning,
    label: string,
    format: (value: number) => string = (value) => value.toFixed(2),
  ) => {
    const range = INTERACTION_TUNING_RANGES[key];
    const value = settings.interaction[key];
    return (
      <label className="slider-control tuning-slider" key={key}>
        <span>
          {label} <output>{format(value)}</output>
        </span>
        <input
          aria-label={label}
          max={range.max}
          min={range.min}
          onChange={(event) => changeInteractionSetting(key, Number(event.target.value))}
          step={range.step}
          type="range"
          value={value}
        />
      </label>
    );
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch" && event.buttons === 0) return;
    if (event.target instanceof Element && event.target.closest("[data-ui]")) return;
    const point = {
      x: event.clientX / window.innerWidth,
      y: event.clientY / window.innerHeight,
    };
    const current = interactionRef.current;
    if (current.hands.length > 0) return;
    interactionRef.current = {
      ...current,
      mouse: point,
      mouseActive: true,
      mousePressed: event.buttons > 0,
      gesture: event.buttons > 0 ? "TRACE" : "IDLE",
    };
    const nextGesture = event.buttons > 0 ? "TRACE" : "IDLE";
    if (nextGesture !== lastGestureRef.current) {
      lastGestureRef.current = nextGesture;
      setActiveGesture(nextGesture);
    }
  };

  const onPointerLeave = () => {
    interactionRef.current = {
      ...interactionRef.current,
      mouseActive: false,
      mousePressed: false,
      gesture: interactionRef.current.hands.length ? interactionRef.current.gesture : "IDLE",
    };
    if (!interactionRef.current.hands.length) {
      lastGestureRef.current = "IDLE";
      setActiveGesture("IDLE");
    }
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
    if (isGestureLegendOpen) gestureLegendCloseRef.current?.focus();
  }, [isGestureLegendOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "h" && !event.repeat) {
        setIsInterfaceVisible((visible) => !visible);
      }
      if (event.key === "Escape") {
        setIsInterfaceVisible(true);
        setIsGestureLegendOpen(false);
        gestureLegendTriggerRef.current?.focus();
      }
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
            {diagnostics.hands.map((hand, handIndex) => {
              const label = hand.handedness?.toLowerCase();
              const track = debugInteraction?.tracking.find(
                (candidate) =>
                  candidate.status === "tracking" &&
                  candidate.handedness.toLowerCase() === label,
              );
              return (
                <g
                  className={track?.handedness === "Left" ? "left-hand-landmarks" : "right-hand-landmarks"}
                  key={`${track?.id ?? hand.handedness ?? "hand"}-${handIndex}`}
                >
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
                  {track && (
                    <text
                      className="hand-track-label"
                      x={track.center.x + 0.018}
                      y={track.center.y}
                    >
                      {track.handedness.toUpperCase()} · {track.pose} · {track.interaction}
                    </text>
                  )}
                </g>
              );
            })}
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
            {process.env.NODE_ENV !== "production" && renderPerformance && (
              <>
                <span>
                  Render: {renderPerformance.fps?.toFixed(1) ?? "—"} FPS ·{" "}
                  {renderPerformance.frameIntervalMs.toFixed(1)} ms/frame ·{" "}
                  {renderPerformance.drawTimeMs.toFixed(1)} ms CPU draw
                </span>
                <span>
                  Particles: {renderPerformance.count}/{renderPerformance.maximum} ·{" "}
                  {renderPerformance.visible} visible · scale {renderPerformance.scale.toFixed(2)}× ·{" "}
                  {renderPerformance.quality} quality
                </span>
                <span>
                  Simulation: {renderPerformance.simulationTimeMs.toFixed(1)} ms ·{" "}
                  TRACE: {renderPerformance.traceTimeMs.toFixed(1)} ms
                </span>
              </>
            )}
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
              HandPose model: {diagnostics.modelLoaded ? "ready" : "loading"} · full · max two hands
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
                Detection {index + 1}
                {hand.handedness ? ` (${hand.handedness})` : ""}:{" "}
                {Number.isFinite(hand.confidence)
                  ? `${(hand.confidence * 100).toFixed(0)}% confidence`
                  : "confidence unavailable"}{" "}
                · {hand.keypoints.length} landmarks
              </span>
            ))}
            <span>Gesture engine: {activeGesture}</span>
            {debugInteraction?.tracking.map((track) => {
              const hand = debugInteraction.hands.find((candidate) => candidate.id === track.id);
              return (
                <span key={`track-${track.id}`}>
                  {track.handedness === "Unknown" ? track.id : track.handedness} · {track.status} ·{" "}
                  {track.pose} · {track.interaction} · {track.fingerCount} fingers ·{" "}
                  confidence {(track.confidence * 100).toFixed(0)}% · stability{" "}
                  {(track.stability * 100).toFixed(0)}% · center{" "}
                  {track.center.x.toFixed(2)}, {track.center.y.toFixed(2)} ·{" "}
                  cursor {track.cursorPoint.x.toFixed(2)}, {track.cursorPoint.y.toFixed(2)} ·{" "}
                  velocity {track.velocity.x.toFixed(2)}, {track.velocity.y.toFixed(2)} ·{" "}
                  angle {track.orientation.toFixed(2)} rad ·{" "}
                  fingers {hand?.extendedFingers.join(", ") || "none"} · force{" "}
                  {hand?.forceMode ?? "none"}
                </span>
              );
            })}
            {debugInteraction?.events.map((event) => (
              <span key={`event-${event.id}`}>
                EVENT {event.type.toUpperCase()}
              </span>
            ))}
            {debugInteraction && (
              <span>
                Stroke points: {debugInteraction.strokes.reduce(
                  (total, stroke) => total + stroke.points.length,
                  0,
                )}{" "}
                · clear hold {(debugInteraction.clearProgress * 100).toFixed(0)}% · clear cooldown{" "}
                {(debugInteraction.clearCooldownRemaining / 1000).toFixed(1)}s
              </span>
            )}
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
                {trackingStatus === "tracking"
                  ? handSummary
                  : isTracking
                    ? "LOCAL PROCESSING"
                  : trackingStatus === "no-hands"
                    ? "FULL HAND IN FRAME · PALM TO CAMERA"
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
            <button
              aria-controls="gesture-legend-panel"
              aria-expanded={isGestureLegendOpen}
              className="tracking-toggle gesture-legend-toggle"
              onClick={() => setIsGestureLegendOpen((open) => !open)}
              ref={gestureLegendTriggerRef}
              title={isGestureLegendOpen ? "Close gesture legend" : "Open gesture legend"}
              type="button"
            >
              GESTURES
            </button>
            <section
              aria-labelledby="gesture-legend-title"
              className="gesture-legend"
              hidden={!isGestureLegendOpen}
              id="gesture-legend-panel"
              role="dialog"
            >
              <div className="gesture-legend-heading">
                <div>
                  <span>INTERACTION KEY</span>
                  <h2 id="gesture-legend-title">Ways of touching the field</h2>
                </div>
                <button
                  aria-label="Close gesture legend"
                  className="icon-button"
                  ref={gestureLegendCloseRef}
                  onClick={() => {
                    setIsGestureLegendOpen(false);
                    gestureLegendTriggerRef.current?.focus();
                  }}
                  type="button"
                >
                  ×
                </button>
              </div>
              <ul>
                {gestureLegend.map((entry) => (
                  <li key={entry.name}>
                    <span aria-hidden="true" className="gesture-legend-cue">
                      {entry.symbol}
                    </span>
                    <div>
                      <h3>
                        {entry.name} <span>{entry.cue}</span>
                      </h3>
                      <p>{entry.description}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </section>

          <div aria-live="polite" className="gesture-readout">
            <span className="readout-line" />
            <p>
              {activeGesture === "CLEAR ALL" && clearProgress > 0
                ? `CLEAR ALL · HOLD ${Math.round(clearProgress * 100)}%`
                : gestureLabels[activeGesture]}
            </p>
            {activeGesture === "CLEAR ALL" && (
              <span
                aria-label={`Clear all progress ${Math.round(clearProgress * 100)} percent`}
                className="clear-progress-track"
              >
                <span style={{ width: `${clearProgress * 100}%` }} />
              </span>
            )}
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
                max={INTERACTION_CONFIG.particles.maximumCount}
                min={INTERACTION_CONFIG.particles.minimumCount}
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
              <span>TRAIL INTENSITY <output>{settings.persistence}%</output></span>
              <input
                max="96"
                min="20"
                onChange={(event) => changeSetting("persistence", Number(event.target.value))}
                type="range"
                value={settings.persistence}
              />
            </label>

            <p className="panel-section-label">HAND INTERACTION</p>
            {renderTuningSlider("confidenceThreshold", "HAND CONFIDENCE", (value) =>
              `${Math.round(value * 100)}%`,
            )}
            {renderTuningSlider("smoothing", "POSITION SMOOTHING")}
            {renderTuningSlider("pinchEnterRatio", "PINCH SENSITIVITY")}
            {renderTuningSlider("pinchExitRatio", "PINCH RELEASE")}
            {renderTuningSlider("fingerExtensionRatio", "FINGER EXTENSION")}
            {renderTuningSlider("gestureHoldMs", "GESTURE HOLD", (value) =>
              `${Math.round(value)} ms`,
            )}
            {renderTuningSlider("forceMultiplier", "HAND FORCE")}
            {renderTuningSlider("gravityStrength", "GRAVITY STRENGTH", (value) =>
              `${Math.round(value)} px/s²`,
            )}
            {renderTuningSlider("stretchSensitivity", "STRETCH SENSITIVITY")}
            {renderTuningSlider("traceSpacing", "TRACE DENSITY", (value) =>
              `${(1 / value).toFixed(0)} pts/unit`,
            )}
            {renderTuningSlider("traceThickness", "TRACE THICKNESS", (value) =>
              `${value.toFixed(1)} px`,
            )}
            {renderTuningSlider("traceGlow", "TRACE GLOW", (value) =>
              `${Math.round(value)} px`,
            )}
            {renderTuningSlider("traceOpacity", "TRACE OPACITY", (value) =>
              `${Math.round(value * 100)}%`,
            )}
            {renderTuningSlider("clearHoldMs", "CLEAR ALL HOLD", (value) =>
              `${Math.round(value)} ms`,
            )}
            {renderTuningSlider("clearCooldownMs", "CLEAR ALL COOLDOWN", (value) =>
              `${(value / 1000).toFixed(1)} s`,
            )}

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
                recognizerRef.current.resetTransform();
                interactionRef.current = {
                  ...interactionRef.current,
                  universeScale: 1,
                  universeRotation: 0,
                };
                clearTraceDrawings();
                setHint("The field and drawings return to their first state.");
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
