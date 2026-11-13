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
import { getHandStatuses } from "@/lib/interaction/hand-status";
import { HandTracker } from "@/lib/interaction/hand-tracker";
import {
  DEFAULT_USER_SETTINGS,
  INTERACTION_CONFIG,
  INTERACTION_TUNING_RANGES,
} from "@/lib/interaction/config";
import type {
  GestureName,
  HandObservation,
  InteractionFrame,
  InteractionTuning,
  ParticleCanvasHandle,
  TrackingStatus,
  UserSettings,
  VisualMode,
} from "@/lib/interaction/types";

// p5 necesita DOM y WebGL: se carga solo en el navegador, no al prerenderizar.
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
  IDLE: "Muévete para agitar el campo",
  CURSOR: "CURSOR · Extiende un dedo para mover el cursor sin alterar el campo",
  TRACE: "TRACE · Extiende dos dedos para dibujar trazos persistentes",
  GRAVITY: "GRAVITY · Cierra el puño para atraer partículas",
  STRETCH: "STRETCH · Abre las palmas y acércalas o aléjalas",
  COLLAPSE: "COLLAPSE · Une pulgar e índice y extiende los otros tres dedos",
  "CLEAR ALL": "CLEAR ALL · Mantén ambos pulgares extendidos",
};

const gestureLegend = [
  { name: "CURSOR", cue: "1 DEDO", symbol: "☝️", description: "Mueve el cursor sin afectar a las partículas ni a los dibujos." },
  { name: "TRACE", cue: "2 DEDOS", symbol: "✌️", description: "Dibuja trazos persistentes con dos dedos." },
  { name: "GRAVITY", cue: "PUÑO CERRADO", symbol: "✊", description: "Atrae las partículas cercanas hacia el centro de la mano." },
  { name: "STRETCH", cue: "2 PALMAS ABIERTAS", symbol: "🙌", description: "Mueve las dos palmas abiertas para ampliar y girar el campo." },
  { name: "COLLAPSE", cue: "PINZA ÍNDICE-PULGAR", symbol: "👌", description: "Une pulgar e índice y extiende los dedos medio, anular y meñique." },
  { name: "CLEAR ALL", cue: "SOLO PULGARES · MANTÉN", symbol: "👍👍", description: "Extiende solo los pulgares y mantén el gesto para borrar todos los trazos de TRACE." },
] as const;

const statusLabels: Record<TrackingStatus, string> = {
  idle: "MODO RATÓN",
  requesting: "SOLICITANDO CÁMARA",
  "loading-model": "CARGANDO DETECCIÓN",
  tracking: "MANOS DETECTADAS",
  searching: "BUSCANDO MANOS",
  "no-hands": "SIN MANOS DETECTADAS",
  denied: "CÁMARA DENEGADA",
  unavailable: "CÁMARA NO DISPONIBLE",
  error: "ERROR DE DETECCIÓN",
};

export default function Experience() {
  const loggedRenderRef = useRef(false);
  if (!loggedRenderRef.current) {
    console.info("[WEBCAM] Experience component rendered");
    loggedRenderRef.current = true;
  }

  // Las refs permiten que detección y animación intercambien datos frecuentes
  // sin forzar un render de React por cada imagen de cámara o fotograma.
  const interactionRef = useRef<InteractionFrame>({ ...initialInteraction });
  const settingsRef = useRef<UserSettings>({ ...DEFAULT_USER_SETTINGS });
  const engineRef = useRef<ParticleCanvasHandle | null>(null);
  const trackerRef = useRef<HandTracker | null>(null);
  const recognizerRef = useRef(new GestureRecognizer());
  const videoRef = useRef<HTMLVideoElement>(null);
  const rootRef = useRef<HTMLElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const gestureLegendTriggerRef = useRef<HTMLButtonElement>(null);
  const gestureLegendCloseRef = useRef<HTMLButtonElement>(null);
  const lastGestureRef = useRef<GestureName>("IDLE");
  // El estado de React se reserva para los valores que sí cambian la interfaz.
  const [settings, setSettings] = useState(DEFAULT_USER_SETTINGS);
  const [trackingStatus, setTrackingStatus] = useState<TrackingStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("");
  const [activeGesture, setActiveGesture] = useState<GestureName>("IDLE");
  const [isTracking, setIsTracking] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isGestureLegendOpen, setIsGestureLegendOpen] = useState(false);
  const [isInterfaceVisible, setIsInterfaceVisible] = useState(true);
  const [hint, setHint] = useState("");
  const [handStatuses, setHandStatuses] = useState(() => getHandStatuses([]));
  const [handSummary, setHandSummary] = useState("SIN MANOS DETECTADAS");
  const [clearProgress, setClearProgress] = useState(0);
  const handStatusesRef = useRef(handStatuses);
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

  /**
   * Recibe observaciones normalizadas del tracker y publica el fotograma
   * interpretado para p5; solo actualiza la interfaz cuando sus textos cambian.
   */
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
    const nextStatuses = getHandStatuses(frame.hands);
    if (
      nextStatuses.left !== handStatusesRef.current.left ||
      nextStatuses.right !== handStatusesRef.current.right
    ) {
      handStatusesRef.current = nextStatuses;
      setHandStatuses(nextStatuses);
    }
    if (frame.gesture !== lastGestureRef.current && frame.gesture !== "IDLE") {
      setHint(gestureLabels[frame.gesture]);
    }
    if (frame.clearVersion !== lastClearVersionRef.current) {
      lastClearVersionRef.current = frame.clearVersion;
      setHint("TRAZOS DE TRACE BORRADOS");
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
        ? "SIN MANOS DETECTADAS"
        : frame.hands
            .map((hand) =>
              hand.handedness === "Unknown"
                ? `MANO ${hand.id.replace("hand-", "")}`
                : hand.handedness === "Left" ? "MANO IZQUIERDA" : "MANO DERECHA",
            )
            .sort()
            .join(" + ");
    if (nextSummary !== handSummaryRef.current) {
      handSummaryRef.current = nextSummary;
      setHandSummary(nextSummary);
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
      handSummaryRef.current = "SIN MANOS DETECTADAS";
      setHandSummary("SIN MANOS DETECTADAS");
      handStatusesRef.current = getHandStatuses([]);
      setHandStatuses(handStatusesRef.current);
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
    handSummaryRef.current = "SIN MANOS DETECTADAS";
    setHandSummary("SIN MANOS DETECTADAS");
    const tracker = new HandTracker(video, updateHands, updateTrackingStatus);
    trackerRef.current = tracker;
    const started = await tracker.start();
    if (!started) trackerRef.current = null;
  }, [updateHands, updateTrackingStatus]);

  const stopTracking = useCallback(() => {
    trackerRef.current?.stop();
    trackerRef.current = null;
    resetTrackingFrame();
    lastGestureRef.current = "IDLE";
    handSummaryRef.current = "SIN MANOS DETECTADAS";
    setIsTracking(false);
    setTrackingStatus("idle");
    setStatusMessage("");
    setActiveGesture("IDLE");
    setHandSummary("SIN MANOS DETECTADAS");
    handStatusesRef.current = getHandStatuses([]);
    setHandStatuses(handStatusesRef.current);
    clearProgressRef.current = 0;
    setClearProgress(0);
  }, []);

  // El genérico relaciona cada clave con su tipo de valor: no permite, por
  // ejemplo, asignar un texto a un ajuste numérico.
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
    setHint("TRAZOS DE TRACE BORRADOS");
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
      console.error("Fullscreen is unavailable.", error);
      setStatusMessage("No se pudo activar la pantalla completa.");
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

    // El efecto puede desmontarse mientras se solicita permiso o carga el
    // modelo; stop() libera la cámara y evita mantener el seguimiento activo.
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
    setHint(isPaused ? "El campo vuelve a moverse." : "El campo está en pausa.");
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
        onReady={(handle) => {
          engineRef.current = handle;
        }}
        settingsRef={settingsRef}
      />

      <figure
        aria-label="Vista de la cámara para detectar las manos en este dispositivo"
        className="camera-preview"
        data-active={hasCameraImage}
        data-visible={isInterfaceVisible}
      >
        <div className="camera-window">
          <video
            aria-label="Imagen reflejada de la cámara para detectar las manos"
            autoPlay
            className="camera-feed"
            muted
            playsInline
            ref={videoRef}
          />
          {!hasCameraImage && (
            <span className="camera-placeholder">
              {trackingStatus === "requesting" ? "CONECTANDO" : "CÁMARA APAGADA"}
            </span>
          )}
          <span className="camera-caption">{hasCameraImage ? "EN DIRECTO · SOLO EN ESTE DISPOSITIVO" : "VISTA DE CÁMARA"}</span>
        </div>
        <figcaption aria-live="polite" className="hand-status">
          <span>MANO IZQUIERDA — {handStatuses.left}</span>
          <span>MANO DERECHA — {handStatuses.right}</span>
        </figcaption>
      </figure>

      {!isInterfaceVisible && (
        <button
          aria-label="Mostrar interfaz"
          className="interface-reveal"
          data-ui
          onClick={() => setIsInterfaceVisible(true)}
          type="button"
        >
          + INTERFAZ
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
              <span>PROYECTO ARTÍSTICO &nbsp; / &nbsp; 001</span>
            </div>
          </header>

          <section aria-label="Estado de detección" className="tracking">
            <span className={`tracking-light is-${trackingStatus}`} />
            <div>
              <p>{statusLabels[trackingStatus]}</p>
              <span>
                {trackingStatus === "tracking"
                  ? handSummary
                  : isTracking
                    ? "PROCESAMIENTO LOCAL"
                  : trackingStatus === "no-hands"
                    ? "MANO COMPLETA · PALMA HACIA LA CÁMARA"
                    : "MUÉVETE PARA INTERACTUAR"}
              </span>
            </div>
            <button
              className="tracking-toggle"
              onClick={isTracking ? stopTracking : startTracking}
              type="button"
            >
              {isTracking ? "DESCONECTAR" : "ACTIVAR MANOS"}
            </button>
            <button
              aria-controls="gesture-legend-panel"
              aria-expanded={isGestureLegendOpen}
              className="tracking-toggle gesture-legend-toggle"
              onClick={() => setIsGestureLegendOpen((open) => !open)}
              ref={gestureLegendTriggerRef}
              title={isGestureLegendOpen ? "Cerrar guía de gestos" : "Abrir guía de gestos"}
              type="button"
            >
              GESTOS
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
                  <span>GUÍA DE INTERACCIÓN</span>
                  <h2 id="gesture-legend-title">Formas de tocar el campo</h2>
                </div>
                <button
                  aria-label="Cerrar guía de gestos"
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
                    <span
                      aria-hidden="true"
                      className={`gesture-legend-cue${entry.name === "CLEAR ALL" ? " gesture-legend-cue-pair" : ""}`}
                    >
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
                ? `CLEAR ALL · MANTÉN ${Math.round(clearProgress * 100)}%`
                : gestureLabels[activeGesture]}
            </p>
            {activeGesture === "CLEAR ALL" && (
              <span
                aria-label={`Progreso de CLEAR ALL: ${Math.round(clearProgress * 100)} por ciento`}
                className="clear-progress-track"
              >
                <span style={{ width: `${clearProgress * 100}%` }} />
              </span>
            )}
          </div>

          {(statusMessage || hint) && (
            <p aria-live="polite" className="toast">
              {statusMessage || hint}
            </p>
          )}

          <aside
            aria-label="Controles de la experiencia"
            className={`control-panel ${isPanelOpen ? "is-open" : ""}`}
            ref={panelRef}
          >
            <div className="panel-heading">
              <div>
                <span>PARÁMETROS DEL CAMPO</span>
                <h2>Ajusta el entorno</h2>
              </div>
              <button
                aria-label="Cerrar controles"
                className="icon-button panel-close"
                onClick={togglePanel}
                type="button"
              >
                ×
              </button>
            </div>

            <label className="slider-control">
              <span>DENSIDAD DE PARTÍCULAS <output>{settings.density}</output></span>
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
              <span>INTENSIDAD DE LA FUERZA <output>{settings.intensity}%</output></span>
              <input
                max="100"
                min="10"
                onChange={(event) => changeSetting("intensity", Number(event.target.value))}
                type="range"
                value={settings.intensity}
              />
            </label>

            <label className="slider-control">
              <span>INTENSIDAD DE LA ESTELA <output>{settings.persistence}%</output></span>
              <input
                max="96"
                min="20"
                onChange={(event) => changeSetting("persistence", Number(event.target.value))}
                type="range"
                value={settings.persistence}
              />
            </label>

            <p className="panel-section-label">INTERACCIÓN CON LAS MANOS</p>
            {renderTuningSlider("confidenceThreshold", "CONFIANZA DE DETECCIÓN", (value) =>
              `${Math.round(value * 100)}%`,
            )}
            {renderTuningSlider("smoothing", "SUAVIZADO DE POSICIÓN")}
            {renderTuningSlider("pinchEnterRatio", "SENSIBILIDAD DE PINZA")}
            {renderTuningSlider("pinchExitRatio", "LIBERACIÓN DE PINZA")}
            {renderTuningSlider("fingerExtensionRatio", "EXTENSIÓN DE LOS DEDOS")}
            {renderTuningSlider("gestureHoldMs", "DURACIÓN DEL GESTO", (value) =>
              `${Math.round(value)} ms`,
            )}
            {renderTuningSlider("forceMultiplier", "FUERZA DE LA MANO")}
            {renderTuningSlider("gravityStrength", "FUERZA DE GRAVITY", (value) =>
              `${Math.round(value)} px/s²`,
            )}
            {renderTuningSlider("stretchSensitivity", "SENSIBILIDAD DE STRETCH")}
            {renderTuningSlider("traceSpacing", "DENSIDAD DE TRACE", (value) =>
              `${(1 / value).toFixed(0)} pts/unidad`,
            )}
            {renderTuningSlider("traceThickness", "GROSOR DE TRACE", (value) =>
              `${value.toFixed(1)} px`,
            )}
            {renderTuningSlider("traceGlow", "RESPLANDOR DE TRACE", (value) =>
              `${Math.round(value)} px`,
            )}
            {renderTuningSlider("traceOpacity", "OPACIDAD DE TRACE", (value) =>
              `${Math.round(value * 100)}%`,
            )}
            {renderTuningSlider("clearHoldMs", "DURACIÓN DE CLEAR ALL", (value) =>
              `${Math.round(value)} ms`,
            )}
            {renderTuningSlider("clearCooldownMs", "ESPERA DE CLEAR ALL", (value) =>
              `${(value / 1000).toFixed(1)} s`,
            )}

            <fieldset className="mode-control">
              <legend>MODO VISUAL</legend>
              {(["nebula", "filament", "monochrome"] as const).map((mode) => (
                <button
                  aria-pressed={settings.mode === mode}
                  className={settings.mode === mode ? "is-selected" : ""}
                  key={mode}
                  onClick={() => setMode(mode)}
                  type="button"
                >
                  {{ nebula: "NEBULOSA", filament: "FILAMENTO", monochrome: "MONOCROMO" }[mode]}
                </button>
              ))}
            </fieldset>

            <p className="panel-note">La imagen de la cámara se procesa en este dispositivo.</p>
          </aside>

          <nav aria-label="Acciones de la experiencia" className="toolbar">
            <button
              aria-expanded={isPanelOpen}
              className="toolbar-button settings-button"
              onClick={togglePanel}
              type="button"
            >
              <span aria-hidden="true">⌘</span> PARÁMETROS
            </button>
            <span className="toolbar-divider" />
            <button
              aria-label={isPaused ? "Reanudar" : "Pausar"}
              className="icon-button"
              onClick={togglePause}
              type="button"
            >
              {isPaused ? "▶" : "Ⅱ"}
            </button>
            <button
              className="icon-button"
              aria-label="Restablecer universo"
              onClick={() => {
                engineRef.current?.reset();
                recognizerRef.current.resetTransform();
                interactionRef.current = {
                  ...interactionRef.current,
                  universeScale: 1,
                  universeRotation: 0,
                };
                clearTraceDrawings();
                setHint("El campo y los dibujos vuelven a su estado inicial.");
              }}
              title="Restablecer universo"
              type="button"
            >
              ↺
            </button>
            <button
              className="icon-button"
              aria-label="Capturar imagen"
              onClick={() => engineRef.current?.capture()}
              type="button"
            >
              ↓
            </button>
            <button
              aria-label="Alternar pantalla completa"
              className="icon-button"
              onClick={toggleFullscreen}
              type="button"
            >
              ⛶
            </button>
            <button
              className="icon-button hide-button"
              aria-label="Ocultar interfaz"
              onClick={() => setIsInterfaceVisible(false)}
              type="button"
            >
              − INTERFAZ
            </button>
          </nav>

          <footer className="interface-footer">
            <span>MUÉVETE · DA FORMA · SUELTA</span>
            <span>ESC PARA VOLVER</span>
          </footer>
        </div>
      )}
    </main>
  );
}
