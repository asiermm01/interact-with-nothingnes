import { INTERACTION_CONFIG } from "./config";
import {
  createFieldTransform,
  inverseTransformFieldPoint,
  transformFieldPoint,
} from "./field-transform";
import type {
  DetectedHand,
  FingerName,
  HandCursor,
  HandForceMode,
  HandIdentity,
  HandInteraction,
  HandLandmark,
  HandObservation,
  HandPoseName,
  HandPresenceStatus,
  HandTrackSnapshot,
  Handedness,
  InteractionEvent,
  InteractionFrame,
  InteractionTuning,
  PersistentStroke,
  Point2D,
} from "./types";

// Convierte observaciones de manos en poses, acciones y un InteractionFrame.
// Conserva memoria entre detecciones para estabilizar identidades y gestos.
interface FingerDefinition {
  name: FingerName;
  tip: string;
  joint: string;
  base: string;
}

interface HandMemory {
  id: HandIdentity;
  handedness: Handedness;
  center: Point2D;
  cursorPoint: Point2D;
  velocity: Point2D;
  orientation: number;
  confidence: number;
  isPinching: boolean;
  pose: HandPoseName;
  candidatePose: HandPoseName;
  candidateSince: number;
  extendedFingers: Record<FingerName, boolean>;
  fingerCount: number;
  lastSeen: number;
}

interface AssignedObservation {
  observation: HandObservation;
  id: HandIdentity;
  handedness: Handedness;
}

interface PoseStability {
  pose: HandPoseName;
  candidatePose: HandPoseName;
  candidateSince: number;
  stability: number;
}

// Referencia tomada al comenzar el gesto; evita acumular la misma variación
// de escala en cada fotograma y permite continuar desde la vista actual.
interface StretchReference {
  handIds: string;
  width: number;
  height: number;
  separation: number;
  previousAngle: number;
  rotationDelta: number;
  scale: number;
  rotation: number;
}

const fingerDefinitions: FingerDefinition[] = [
  { name: "thumb", tip: "thumb_tip", joint: "thumb_ip", base: "thumb_mcp" },
  { name: "index", tip: "index_finger_tip", joint: "index_finger_pip", base: "index_finger_mcp" },
  { name: "middle", tip: "middle_finger_tip", joint: "middle_finger_pip", base: "middle_finger_mcp" },
  { name: "ring", tip: "ring_finger_tip", joint: "ring_finger_pip", base: "ring_finger_mcp" },
  { name: "pinky", tip: "pinky_finger_tip", joint: "pinky_finger_pip", base: "pinky_finger_mcp" },
];

const fingerNames = fingerDefinitions.map((finger) => finger.name);
const extendedFingersForCollapse: FingerName[] = ["middle", "ring", "pinky"];
const nonThumbFingers: FingerName[] = ["index", "middle", "ring", "pinky"];

const distance = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;
const wrapAngle = (angle: number) => Math.atan2(Math.sin(angle), Math.cos(angle));

const findPoint = (landmarks: HandLandmark[], name: string): Point2D | null => {
  const point = landmarks.find((landmark) => landmark.name === name);
  return point ? { x: clamp01(point.x), y: clamp01(point.y) } : null;
};

const getCenter = (landmarks: HandLandmark[]): Point2D => {
  const wrist = findPoint(landmarks, "wrist") ?? { x: 0.5, y: 0.5 };
  const bases = [
    findPoint(landmarks, "index_finger_mcp"),
    findPoint(landmarks, "middle_finger_mcp"),
    findPoint(landmarks, "ring_finger_mcp"),
    findPoint(landmarks, "pinky_finger_mcp"),
  ].filter((point): point is Point2D => point !== null);
  const count = bases.length + 1;
  return {
    x: (wrist.x + bases.reduce((sum, point) => sum + point.x, 0)) / count,
    y: (wrist.y + bases.reduce((sum, point) => sum + point.y, 0)) / count,
  };
};

const angleAt = (a: Point2D, vertex: Point2D, c: Point2D) => {
  const first = { x: a.x - vertex.x, y: a.y - vertex.y };
  const second = { x: c.x - vertex.x, y: c.y - vertex.y };
  const firstLength = Math.hypot(first.x, first.y);
  const secondLength = Math.hypot(second.x, second.y);
  if (firstLength < 0.001 || secondLength < 0.001) return 0;
  const cosine = Math.min(
    1,
    Math.max(-1, (first.x * second.x + first.y * second.y) / (firstLength * secondLength)),
  );
  return (Math.acos(cosine) * 180) / Math.PI;
};

const getHandedness = (label?: string): Handedness => {
  const normalized = label?.trim().toLowerCase();
  if (normalized === "left" || normalized?.includes("left")) return "Left";
  if (normalized === "right" || normalized?.includes("right")) return "Right";
  return "Unknown";
};

const getOrientation = (landmarks: HandLandmark[]) => {
  const indexBase = findPoint(landmarks, "index_finger_mcp");
  const pinkyBase = findPoint(landmarks, "pinky_finger_mcp");
  if (!indexBase || !pinkyBase) return 0;
  return Math.atan2(pinkyBase.y - indexBase.y, pinkyBase.x - indexBase.x);
};

const getInteractionForPose = (pose: HandPoseName): HandInteraction => {
  if (pose === "CURSOR") return "cursor";
  if (pose === "TRACE") return "trace";
  if (pose === "GRAVITY") return "gravity";
  if (pose === "COLLAPSE") return "collapse";
  return "none";
};

const getForceMode = (interaction: HandInteraction): HandForceMode =>
  interaction === "gravity" || interaction === "collapse" ? "attract" : "none";

export class GestureRecognizer {
  private readonly memory = new Map<HandIdentity, HandMemory>();
  private readonly strokes: PersistentStroke[] = [];
  private readonly activeStrokes = new Map<HandIdentity, PersistentStroke>();
  private readonly recentEvents: InteractionEvent[] = [];
  private nextAnonymousId = 1;
  private nextStrokeId = 1;
  private nextEventId = 1;
  private strokeVersion = 0;
  private clearVersion = 0;
  private clearStartedAt: number | null = null;
  private clearCooldownUntil = 0;
  private clearLatched = false;
  private lastFrame = 0;
  private universeScale = 1;
  private universeRotation = 0;
  private stretchReference: StretchReference | null = null;
  private invalidStretchReported = false;

  /**
   * Procesa las observaciones de una inferencia con su instante, ajustes y
   * tamaño de pantalla; devuelve el estado consumido por React y el motor.
   */
  update(
    observations: HandObservation[],
    now: number,
    tuning: InteractionTuning,
    viewport: { width: number; height: number },
  ): InteractionFrame {
    if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
        viewport.width <= 0 || viewport.height <= 0) {
      throw new Error("Gesture recognition requires finite, positive viewport dimensions.");
    }
    const delta = this.lastFrame
      ? Math.min(
          Math.max((now - this.lastFrame) / 1000, 0.001),
          INTERACTION_CONFIG.detection.maxFrameDeltaSeconds,
        )
      : 1 / 30;
    this.lastFrame = now;

    this.memory.forEach((track, id) => {
      if (now - track.lastSeen > INTERACTION_CONFIG.detection.trackingLossMs) {
        this.activeStrokes.delete(id);
      }
      if (now - track.lastSeen > INTERACTION_CONFIG.detection.trackingLossMs * 2) {
        this.memory.delete(id);
      }
    });

    const accepted = observations
      .filter((observation) => observation.confidence >= tuning.confidenceThreshold)
      .slice(0, INTERACTION_CONFIG.detection.maxHands);
    const assigned = this.assignIdentities(accepted, now);
    const hands = assigned.map(({ observation, id, handedness }) =>
      this.trackHand(observation, id, handedness, now, delta, tuning),
    );
    const visibleIds = new Set(hands.map((hand) => hand.id));
    this.activeStrokes.forEach((_stroke, id) => {
      if (!visibleIds.has(id)) this.activeStrokes.delete(id);
    });

    // CLEAR ALL tiene prioridad: requiere ambas manos, una duración mínima y
    // soltar el gesto antes de poder activarlo de nuevo.
    const bothClearPoses =
      hands.length === 2 && hands.every((hand) => hand.isThumbOnly);
    if (bothClearPoses) {
      if (
        !this.clearLatched &&
        this.clearStartedAt === null &&
        now >= this.clearCooldownUntil
      ) {
        this.clearStartedAt = now;
      }
    } else {
      this.clearStartedAt = null;
      this.clearLatched = false;
    }

    const clearHoldElapsed = this.clearStartedAt === null ? 0 : now - this.clearStartedAt;
    const clearProgress =
      bothClearPoses && !this.clearLatched
        ? clamp01(clearHoldElapsed / tuning.clearHoldMs)
        : this.clearLatched
          ? 1
          : 0;
    const clearActive =
      bothClearPoses &&
      now >= this.clearCooldownUntil &&
      (this.clearLatched || this.clearStartedAt !== null);

    const clearEvent: InteractionEvent[] = [];
    if (
      clearActive &&
      !this.clearLatched &&
      clearHoldElapsed >= tuning.clearHoldMs
    ) {
      this.clearLatched = true;
      this.clearCooldownUntil = now + tuning.clearCooldownMs;
      this.strokes.length = 0;
      this.activeStrokes.clear();
      this.strokeVersion += 1;
      this.clearVersion += 1;
      clearEvent.push({ id: this.nextEventId++, type: "clear-all", timestamp: now });
    }

    // Después de CLEAR ALL, STRETCH ocupa ambas manos; las demás acciones
    // se deciden individualmente según la pose estable de cada mano.
    const stretchActive =
      !clearActive &&
      hands.length === 2 &&
      hands.every((hand) => hand.isOpenPalm && hand.stablePose === "OPEN PALM");
    for (const hand of hands) {
      hand.interaction = clearActive
        ? "clear-all"
        : stretchActive
          ? "stretch"
          : getInteractionForPose(hand.stablePose);
      hand.forceMode = clearActive || stretchActive ? "none" : getForceMode(hand.interaction);
    }

    if (clearActive) {
      this.activeStrokes.clear();
    } else {
      for (const hand of hands) {
        if (hand.interaction === "trace") this.updateStroke(hand, tuning, viewport);
        else this.activeStrokes.delete(hand.id);
      }
    }

    this.recordEvents(clearEvent, now);
    if (clearActive) {
      this.updateFieldTransform([], delta, tuning.stretchSensitivity, viewport);
    } else {
      this.updateFieldTransform(hands, delta, tuning.stretchSensitivity, viewport, stretchActive);
    }

    const cursors: HandCursor[] = clearActive
      ? []
      : hands.flatMap((hand) =>
          hand.interaction === "cursor" || hand.interaction === "trace"
            ? [
                {
                  handId: hand.id,
                  position: hand.cursorPoint,
                  mode: hand.interaction === "trace" ? "TRACE" : "CURSOR",
                },
              ]
            : [],
        );
    const primaryHand = hands.find((hand) => hand.handedness === "Right") ?? hands[0];
    const gesture = clearActive
      ? "CLEAR ALL"
      : stretchActive
        ? "STRETCH"
        : hands.some((hand) => hand.interaction === "collapse")
          ? "COLLAPSE"
          : hands.some((hand) => hand.interaction === "trace")
            ? "TRACE"
            : hands.some((hand) => hand.interaction === "cursor")
              ? "CURSOR"
              : hands.some((hand) => hand.interaction === "gravity")
                ? "GRAVITY"
                : primaryHand?.stablePose === "OPEN PALM"
                  ? "IDLE"
                  : "IDLE";

    const tracking = this.getTrackingSnapshots(hands, now);
    return {
      hands,
      tracking,
      mouse: { x: 0.5, y: 0.5 },
      mouseActive: false,
      mousePressed: false,
      gesture,
      cursors,
      strokes: this.strokes,
      strokeVersion: this.strokeVersion,
      clearVersion: this.clearVersion,
      clearProgress,
      clearActive,
      clearCooldownRemaining: Math.max(0, this.clearCooldownUntil - now),
      events: this.recentEvents,
      universeScale: this.universeScale,
      universeRotation: this.universeRotation,
    };
  }

  clearDrawings(now = performance.now()): InteractionFrame {
    this.strokes.length = 0;
    this.activeStrokes.clear();
    this.strokeVersion += 1;
    this.clearVersion += 1;
    this.recordEvents([{ id: this.nextEventId++, type: "clear-all", timestamp: now }], now);
    return this.createFrame(now);
  }

  releaseStretch() {
    this.stretchReference = null;
  }

  resetTransform() {
    this.releaseStretch();
    this.universeScale = 1;
    this.universeRotation = 0;
  }

  private recordEvents(events: InteractionEvent[], now: number) {
    this.recentEvents.push(...events);
    while (
      this.recentEvents.length > 12 ||
      (this.recentEvents[0] && now - this.recentEvents[0].timestamp > 1800)
    ) {
      this.recentEvents.shift();
    }
  }

  /**
   * Conserva la identidad entre inferencias: usa la lateralidad disponible y,
   * si falta, compara la posición predicha con las trayectorias recientes.
   */
  private assignIdentities(
    observations: HandObservation[],
    now: number,
  ): AssignedObservation[] {
    const assigned = new Map<number, HandIdentity>();
    const claimed = new Set<HandIdentity>();
    const centers = observations.map((observation) => getCenter(observation.keypoints));

    observations.forEach((observation, index) => {
      const handedness = getHandedness(observation.handedness);
      if (handedness === "Unknown") return;
      const id = handedness.toLowerCase() as HandIdentity;
      if (!claimed.has(id)) {
        assigned.set(index, id);
        claimed.add(id);
      }
    });

    const unresolvedIndices = observations
      .map((_observation, index) => index)
      .filter((index) => !assigned.has(index));
    const availableTracks = [...this.memory.values()].filter(
      (track) =>
        !claimed.has(track.id) &&
        now - track.lastSeen <= INTERACTION_CONFIG.detection.trackingLossMs,
    );
    if (unresolvedIndices.length >= 2 && availableTracks.length >= 2) {
      const [first, second] = unresolvedIndices;
      const [trackA, trackB] = availableTracks;
      const direct =
        this.predictedDistance(trackA, centers[first], now) +
        this.predictedDistance(trackB, centers[second], now);
      const swapped =
        this.predictedDistance(trackB, centers[first], now) +
        this.predictedDistance(trackA, centers[second], now);
      const matches =
        direct <= swapped
          ? [
              [first, trackA],
              [second, trackB],
            ] as const
          : [
              [first, trackB],
              [second, trackA],
            ] as const;
      for (const [index, track] of matches) {
        if (
          this.predictedDistance(track, centers[index], now) <=
          INTERACTION_CONFIG.detection.associationDistance
        ) {
          assigned.set(index, track.id);
          claimed.add(track.id);
        }
      }
    }

    observations.forEach((observation, index) => {
      if (assigned.has(index)) return;
      const remainingTracks = [...this.memory.values()]
        .filter(
          (track) =>
            !claimed.has(track.id) &&
            now - track.lastSeen <= INTERACTION_CONFIG.detection.trackingLossMs,
        )
        .sort(
          (a, b) =>
            this.predictedDistance(a, centers[index], now) -
            this.predictedDistance(b, centers[index], now),
        );
      const closest = remainingTracks[0];
      if (
        closest &&
        this.predictedDistance(closest, centers[index], now) <=
          INTERACTION_CONFIG.detection.associationDistance
      ) {
        assigned.set(index, closest.id);
        claimed.add(closest.id);
        return;
      }

      const handedness = getHandedness(observation.handedness);
      const preferredId =
        handedness === "Unknown"
          ? `hand-${this.nextAnonymousId++}`
          : handedness.toLowerCase();
      const id = claimed.has(preferredId)
        ? `hand-${this.nextAnonymousId++}`
        : preferredId;
      assigned.set(index, id);
      claimed.add(id);
    });

    return observations.map((observation, index) => {
      const id = assigned.get(index) ?? `hand-${this.nextAnonymousId++}`;
      const existing = this.memory.get(id);
      const reportedHandedness = getHandedness(observation.handedness);
      return {
        observation,
        id,
        handedness:
          reportedHandedness === "Unknown"
            ? existing?.handedness ?? "Unknown"
            : reportedHandedness,
      };
    });
  }

  private predictedDistance(track: HandMemory, center: Point2D, now: number) {
    const elapsed = Math.min((now - track.lastSeen) / 1000, 0.15);
    const predicted = {
      x: clamp01(track.center.x + track.velocity.x * elapsed),
      y: clamp01(track.center.y + track.velocity.y * elapsed),
    };
    return distance(predicted, center);
  }

  private trackHand(
    observation: HandObservation,
    id: HandIdentity,
    handedness: Handedness,
    now: number,
    delta: number,
    tuning: InteractionTuning,
  ): DetectedHand {
    const keypoints = observation.keypoints;
    const wrist = findPoint(keypoints, "wrist") ?? { x: 0.5, y: 0.5 };
    const indexBase = findPoint(keypoints, "index_finger_mcp") ?? wrist;
    const pinkyBase = findPoint(keypoints, "pinky_finger_mcp") ?? wrist;
    const center = getCenter(keypoints);
    const previous = this.memory.get(id);
    const smoothedCenter = previous
      ? {
          x: lerp(previous.center.x, center.x, tuning.smoothing),
          y: lerp(previous.center.y, center.y, tuning.smoothing),
        }
      : center;
    const velocity =
      previous && delta > 0
        ? {
            x: (smoothedCenter.x - previous.center.x) / delta,
            y: (smoothedCenter.y - previous.center.y) / delta,
          }
        : { x: 0, y: 0 };

    const extendedFingers: Record<FingerName, boolean> = {
      thumb: false,
      index: false,
      middle: false,
      ring: false,
      pinky: false,
    };
    const fingerTips: Point2D[] = [];
    let availableFingerCount = 0;
    for (const finger of fingerDefinitions) {
      const tip = findPoint(keypoints, finger.tip);
      const joint = findPoint(keypoints, finger.joint);
      const base = findPoint(keypoints, finger.base);
      if (!tip || !joint || !base) continue;

      const distanceFromJoint = finger.name === "thumb"
        ? distance(joint, indexBase)
        : distance(joint, wrist);
      const distanceFromTip = finger.name === "thumb"
        ? distance(tip, indexBase)
        : distance(tip, wrist);
      // La histéresis usa umbrales distintos al extender y al recoger el dedo
      // para evitar cambios rápidos cuando la medición oscila cerca del límite.
      const referencePoint = previous?.extendedFingers[finger.name] ?? false;
      const extensionRatio = referencePoint
        ? tuning.fingerReleaseRatio
        : tuning.fingerExtensionRatio;
      const angleThreshold = referencePoint
        ? INTERACTION_CONFIG.gestures.fingerReleaseAngleDeg
        : INTERACTION_CONFIG.gestures.fingerExtensionAngleDeg;
      const angle = angleAt(base, joint, tip);
      const isExtended =
        angle >= angleThreshold &&
        distanceFromTip > distanceFromJoint * extensionRatio;
      extendedFingers[finger.name] = isExtended;
      availableFingerCount += 1;
      if (isExtended) fingerTips.push(tip);
    }

    const extendedNames = fingerNames.filter((name) => extendedFingers[name]);
    const fingerCount = extendedNames.length;
    const palmWidth = Math.max(distance(indexBase, pinkyBase), 0.04);
    const indexTip = findPoint(keypoints, "index_finger_tip");
    const thumbTip = findPoint(keypoints, "thumb_tip");
    const thumbIp = findPoint(keypoints, "thumb_ip");
    const pinchRatio =
      indexTip && thumbTip
        ? distance(thumbTip, indexTip) / palmWidth
        : Number.POSITIVE_INFINITY;
    const isPinching =
      Boolean(indexTip && thumbTip && thumbIp) &&
      (previous?.isPinching
        ? pinchRatio < Math.max(tuning.pinchEnterRatio, tuning.pinchExitRatio)
        : pinchRatio < tuning.pinchEnterRatio);
    const isFist = availableFingerCount >= 4 && fingerCount === 0;
    const isThumbOnly =
      availableFingerCount === fingerDefinitions.length &&
      extendedFingers.thumb &&
      nonThumbFingers.every((finger) => !extendedFingers[finger]);
    const isOpenPalm =
      availableFingerCount >= 4 && fingerCount >= Math.min(4, availableFingerCount);
    const isCollapse =
      isPinching &&
      availableFingerCount === fingerDefinitions.length &&
      !isOpenPalm &&
      extendedFingersForCollapse.every((finger) => extendedFingers[finger]);

    const rawPose: HandPoseName = isCollapse
      ? "COLLAPSE"
      : fingerCount === 1 && availableFingerCount >= 4
        ? "CURSOR"
        : fingerCount === 2 && availableFingerCount >= 4
          ? "TRACE"
          : isFist
            ? "GRAVITY"
            : isOpenPalm
              ? "OPEN PALM"
              : "IDLE";
    // CURSOR y TRACE responden de inmediato; las demás poses esperan una
    // duración configurable antes de sustituir la pose estable anterior.
    const poseStability =
      rawPose === "CURSOR" || rawPose === "TRACE"
        ? {
            pose: rawPose,
            candidatePose: rawPose,
            candidateSince: now,
            stability: 1,
          }
        : this.stabilizePose(previous, rawPose, now, tuning.gestureHoldMs);
    const rawCursorPoint =
      fingerTips.length > 0
        ? fingerTips.reduce(
            (point, tip) => ({ x: point.x + tip.x / fingerTips.length, y: point.y + tip.y / fingerTips.length }),
            { x: 0, y: 0 },
          )
        : indexTip ?? wrist;
    const cursorPoint = previous
      ? {
          x: lerp(previous.cursorPoint.x, rawCursorPoint.x, tuning.smoothing),
          y: lerp(previous.cursorPoint.y, rawCursorPoint.y, tuning.smoothing),
        }
      : rawCursorPoint;
    const interaction = getInteractionForPose(poseStability.pose);

    this.memory.set(id, {
      id,
      handedness,
      center: smoothedCenter,
      cursorPoint,
      velocity,
      orientation: getOrientation(keypoints),
      confidence: observation.confidence,
      isPinching,
      pose: poseStability.pose,
      candidatePose: poseStability.candidatePose,
      candidateSince: poseStability.candidateSince,
      extendedFingers,
      fingerCount,
      lastSeen: now,
    });

    return {
      id,
      handedness,
      pose: rawPose,
      stablePose: poseStability.pose,
      interaction,
      center: smoothedCenter,
      cursorPoint,
      pinchPoint:
        indexTip && thumbTip
          ? { x: (thumbTip.x + indexTip.x) / 2, y: (thumbTip.y + indexTip.y) / 2 }
          : wrist,
      orientation: getOrientation(keypoints),
      confidence: observation.confidence,
      openness: fingerCount / Math.max(availableFingerCount, 1),
      fingerCount,
      extendedFingers: extendedNames,
      stability: poseStability.stability,
      forceMode: getForceMode(interaction),
      isPinching,
      isFist,
      isThumbOnly,
      isOpenPalm,
      velocity,
    };
  }

  private stabilizePose(
    previous: HandMemory | undefined,
    next: HandPoseName,
    now: number,
    holdMs: number,
  ): PoseStability {
    if (!previous || next === previous.pose) {
      return {
        pose: next,
        candidatePose: next,
        candidateSince: now,
        stability: 1,
      };
    }
    if (next !== previous.candidatePose) {
      return {
        pose: previous.pose,
        candidatePose: next,
        candidateSince: now,
        stability: 0,
      };
    }
    const stability = clamp01((now - previous.candidateSince) / Math.max(holdMs, 1));
    return stability >= 1
      ? { pose: next, candidatePose: next, candidateSince: now, stability: 1 }
      : {
          pose: previous.pose,
          candidatePose: next,
          candidateSince: previous.candidateSince,
          stability,
        };
  }

  /**
   * Convierte el cursor de pantalla a espacio del campo y añade puntos solo
   * al dibujar, interpolando segmentos largos para conservar la continuidad.
   */
  private updateStroke(
    hand: DetectedHand,
    tuning: InteractionTuning,
    viewport: { width: number; height: number },
  ) {
    const transform = createFieldTransform(
      viewport.width, viewport.height, this.universeScale, this.universeRotation,
    );
    const worldPoint: Point2D = { x: 0, y: 0 };
    inverseTransformFieldPoint(
      hand.cursorPoint.x * viewport.width,
      hand.cursorPoint.y * viewport.height,
      transform,
      worldPoint,
    );
    worldPoint.x /= viewport.width;
    worldPoint.y /= viewport.height;
    let stroke = this.activeStrokes.get(hand.id);
    if (!stroke) {
      stroke = {
        id: `stroke-${this.nextStrokeId++}`,
        handId: hand.id,
        points: [worldPoint],
        style: {
          color: INTERACTION_CONFIG.drawing.color,
          thickness: tuning.traceThickness,
          glow: tuning.traceGlow,
          opacity: tuning.traceOpacity,
        },
      };
      this.strokes.push(stroke);
      this.activeStrokes.set(hand.id, stroke);
      this.strokeVersion += 1;
      return;
    }

    const previous = stroke.points[stroke.points.length - 1];
    const previousScreen: Point2D = { x: 0, y: 0 };
    transformFieldPoint(
      previous.x * viewport.width, previous.y * viewport.height, transform, previousScreen,
    );
    const segmentLength = distance(
      { x: previousScreen.x / viewport.width, y: previousScreen.y / viewport.height },
      hand.cursorPoint,
    );
    if (segmentLength < tuning.traceSpacing) return;
    const steps = Math.min(
      Math.ceil(segmentLength / tuning.traceSpacing),
      INTERACTION_CONFIG.drawing.maxInterpolationSteps,
    );
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps;
      stroke.points.push({
        x: lerp(previous.x, worldPoint.x, amount),
        y: lerp(previous.y, worldPoint.y, amount),
      });
    }
    this.strokeVersion += 1;
  }

  /**
   * Calcula escala y giro relativos al inicio de STRETCH y suaviza la vista.
   * Al soltar solo se descarta la referencia: la transformación actual persiste.
   */
  private updateFieldTransform(
    hands: DetectedHand[],
    delta: number,
    sensitivity: number,
    viewport: { width: number; height: number },
    stretchActive = false,
  ) {
    if (stretchActive && hands.length === 2) {
      const orderedHands = [...hands].sort((a, b) => a.id.localeCompare(b.id));
      const first = orderedHands[0];
      const second = orderedHands[1];
      const dx = (second.center.x - first.center.x) * viewport.width;
      const dy = (second.center.y - first.center.y) * viewport.height;
      const separation = Math.hypot(dx, dy) / Math.min(viewport.width, viewport.height);
      const angle = Math.atan2(dy, dx);
      if (!Number.isFinite(separation) || !Number.isFinite(angle) || !Number.isFinite(sensitivity)) {
        if (!this.invalidStretchReported) {
          console.error("[STRETCH] Invalid hand positions or sensitivity; transformation unchanged.");
          this.invalidStretchReported = true;
        }
        this.releaseStretch();
        return;
      }
      this.invalidStretchReported = false;
      if (separation < INTERACTION_CONFIG.stretch.minimumGestureSeparation) {
        this.releaseStretch();
        return;
      }
      const handIds = `${first.id}:${second.id}`;
      if (
        !this.stretchReference ||
        this.stretchReference.handIds !== handIds ||
        this.stretchReference.width !== viewport.width ||
        this.stretchReference.height !== viewport.height
      ) {
        this.stretchReference = {
          handIds, width: viewport.width, height: viewport.height,
          separation, previousAngle: angle, rotationDelta: 0,
          scale: this.universeScale, rotation: this.universeRotation,
        };
        return;
      }
      // El delta angular envuelto permite cruzar ±π y acumular varias vueltas.
      const reference = this.stretchReference;
      reference.rotationDelta += wrapAngle(angle - reference.previousAngle);
      reference.previousAngle = angle;
      const targetScale = Math.min(
        INTERACTION_CONFIG.stretch.maximumScale,
        Math.max(
          INTERACTION_CONFIG.stretch.minimumScale,
          reference.scale * Math.pow(separation / reference.separation, sensitivity),
        ),
      );
      this.universeScale = lerp(this.universeScale, targetScale, 1 - Math.exp(-delta * 5));
      if (Math.abs(this.universeScale - targetScale) < 0.00001) {
        this.universeScale = targetScale;
      }
      const targetRotation = reference.rotation + reference.rotationDelta;
      this.universeRotation = lerp(
        this.universeRotation, targetRotation, 1 - Math.exp(-delta * 4),
      );
      return;
    }
    this.releaseStretch();
  }

  private getTrackingSnapshots(hands: DetectedHand[], now: number): HandTrackSnapshot[] {
    const currentIds = new Set(hands.map((hand) => hand.id));
    const snapshots = hands.map((hand) => ({
      id: hand.id,
      handedness: hand.handedness,
      status: "tracking" as HandPresenceStatus,
      confidence: hand.confidence,
      pose: hand.pose,
      interaction: hand.interaction,
      fingerCount: hand.fingerCount,
      stability: hand.stability,
      center: hand.center,
      cursorPoint: hand.cursorPoint,
      velocity: hand.velocity,
      orientation: hand.orientation,
      lastSeenAt: now,
    }));

    this.memory.forEach((track) => {
      if (
        currentIds.has(track.id) ||
        now - track.lastSeen > INTERACTION_CONFIG.detection.trackingLossMs
      ) {
        return;
      }
      snapshots.push({
        id: track.id,
        handedness: track.handedness,
        status: "temporarily-lost",
        confidence: track.confidence,
        pose: track.pose,
        interaction: "none",
        fingerCount: track.fingerCount,
        stability: 0,
        center: track.center,
        cursorPoint: track.cursorPoint,
        velocity: track.velocity,
        orientation: track.orientation,
        lastSeenAt: track.lastSeen,
      });
    });
    return snapshots;
  }

  private createFrame(now: number): InteractionFrame {
    return {
      hands: [],
      tracking: this.getTrackingSnapshots([], now),
      mouse: { x: 0.5, y: 0.5 },
      mouseActive: false,
      mousePressed: false,
      gesture: "IDLE",
      cursors: [],
      strokes: this.strokes,
      strokeVersion: this.strokeVersion,
      clearVersion: this.clearVersion,
      clearProgress: 0,
      clearActive: false,
      clearCooldownRemaining: Math.max(0, this.clearCooldownUntil - now),
      events: this.recentEvents,
      universeScale: this.universeScale,
      universeRotation: this.universeRotation,
    };
  }
}
