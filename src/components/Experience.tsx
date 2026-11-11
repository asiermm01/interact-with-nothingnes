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
  denied: "CAMERA DECLINED",
  unavailable: "CAMERA UNAVAILABLE",
  error: "TRACKING ERROR",
};

export default function Experience() {
  const interactionRef = useRef<InteractionFrame>({ ...initialInteraction });
  const settingsRef = useRef<UserSettings>({ ...initialSettings });
  const engineRef = useRef<ParticleCanvasHandle | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const recognizerRef = useRef(new GestureRecognizer());
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const lastGestureRef = useRef<GestureName>("IDLE");
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
        status === "loading-model",
    );
  }, []);

  const startTracking = useCallback(async () => {
    const video = videoRef.current;
    if (!video || trackerRef.current) return;
    const tracker = new HandTracker(video, updateHands, updateTrackingStatus);
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
    const startup = window.setTimeout(() => {
      if (!cancelled) void startTracking();
    }, 0);

    return () => {
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

      <video
        aria-hidden="true"
        autoPlay
        className="camera-source"
        muted
        playsInline
        ref={videoRef}
      />

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
              <span>{isTracking ? "LOCAL PROCESSING" : "MOVE TO INTERACT"}</span>
            </div>
            <button
              className="tracking-toggle"
              onClick={isTracking ? stopTracking : startTracking}
              type="button"
            >
              {isTracking ? "DISCONNECT" : "ENABLE HANDS"}
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
