import { INTERACTION_CONFIG } from "./config";
import type {
  DetectedHand,
  HandGestureName,
  HandIdentity,
  HandLandmark,
  HandObservation,
  HandPresenceStatus,
  HandTrackSnapshot,
  Handedness,
  InteractionEvent,
  InteractionFrame,
  InteractionTuning,
  PersistentStroke,
  Point2D,
  Shockwave,
} from "./types";

interface HandMemory {
  id: HandIdentity;
  handedness: Handedness;
  center: Point2D;
  indexTip: Point2D;
  velocity: Point2D;
  orientation: number;
  confidence: number;
  isPinching: boolean;
  gesture: HandGestureName;
  candidateGesture: HandGestureName;
  candidateSince: number;
  lastImpulseAt: number;
  lastSeen: number;
}

interface AssignedObservation {
  observation: HandObservation;
  id: HandIdentity;
  handedness: Handedness;
  center: Point2D;
}

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

export class GestureRecognizer {
  private readonly memory = new Map<HandIdentity, HandMemory>();
  private readonly strokes: PersistentStroke[] = [];
  private readonly activeStrokes = new Map<HandIdentity, PersistentStroke>();
  private readonly shockwaves: Shockwave[] = [];
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

  update(
    observations: HandObservation[],
    now: number,
    tuning: InteractionTuning,
  ): InteractionFrame {
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
    const events: InteractionEvent[] = [];
    const bothFists = hands.length === 2 && hands.every((hand) => hand.isFist);

    if (bothFists) {
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

    const clearHoldElapsed =
      this.clearStartedAt === null ? 0 : now - this.clearStartedAt;
    const clearProgress =
      bothFists && !this.clearLatched
        ? clamp01(clearHoldElapsed / tuning.clearHoldMs)
        : this.clearLatched
          ? 1
          : 0;
    const clearActive =
      bothFists &&
      now >= this.clearCooldownUntil &&
      (this.clearLatched || this.clearStartedAt !== null);

    if (
      clearActive &&
      !this.clearLatched &&
      clearHoldElapsed >= tuning.clearHoldMs &&
      now >= this.clearCooldownUntil
    ) {
      this.clearLatched = true;
      this.clearCooldownUntil = now + tuning.clearCooldownMs;
      this.strokes.length = 0;
      this.activeStrokes.clear();
      this.strokeVersion += 1;
      this.clearVersion += 1;
      events.push({ id: this.nextEventId++, type: "clear-all", timestamp: now });
    }

    if (clearActive) {
      this.activeStrokes.clear();
    } else {
      for (const hand of hands) {
        if (hand.gesture === "TRACE") this.updateStroke(hand, tuning);
        else this.activeStrokes.delete(hand.id);
      }
    }

    if (!clearActive) {
      for (const hand of hands) {
        const speed = Math.hypot(hand.velocity.x, hand.velocity.y);
        const track = this.memory.get(hand.id);
        if (
          track &&
          speed >= tuning.impulseSpeed &&
          now - track.lastImpulseAt >= tuning.impulseCooldownMs
        ) {
          const magnitude = Math.max(speed, 0.001);
          const direction = {
            x: hand.velocity.x / magnitude,
            y: hand.velocity.y / magnitude,
          };
          this.shockwaves.push({ center: hand.center, direction, strength: 1, age: 0 });
          track.lastImpulseAt = now;
          events.push({
            id: this.nextEventId++,
            type: "impulse",
            timestamp: now,
            handId: hand.id,
            center: hand.center,
            direction,
          });
        }
      }
    }

    this.recordEvents(events, now);
    this.updateShockwaves(delta);
    if (!clearActive) this.updateFieldTransform(hands, delta);

    const primaryHand = hands.find((hand) => hand.handedness === "Right") ?? hands[0];
    const gesture = clearActive
      ? "CLEAR ALL"
      : hands.some((hand) => hand.isPinching)
        ? "COLLAPSE"
        : hands.length >= 2
          ? "STRETCH"
          : events.some((event) => event.type === "impulse")
            ? "IMPULSE"
            : primaryHand?.gesture ?? "IDLE";

    const tracking = this.getTrackingSnapshots(hands, now);
    return {
      hands,
      tracking,
      mouse: { x: 0.5, y: 0.5 },
      mouseActive: false,
      mousePressed: false,
      gesture,
      tracePoints: [],
      strokes: this.strokes,
      strokeVersion: this.strokeVersion,
      clearVersion: this.clearVersion,
      clearProgress,
      clearActive,
      clearCooldownRemaining: Math.max(0, this.clearCooldownUntil - now),
      events: this.recentEvents,
      shockwaves: this.shockwaves,
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

  private recordEvents(events: InteractionEvent[], now: number) {
    this.recentEvents.push(...events);
    while (
      this.recentEvents.length > 12 ||
      (this.recentEvents[0] && now - this.recentEvents[0].timestamp > 1800)
    ) {
      this.recentEvents.shift();
    }
  }

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
      return {
        observation,
        id,
        handedness:
          getHandedness(observation.handedness) === "Unknown"
            ? existing?.handedness ?? "Unknown"
            : getHandedness(observation.handedness),
        center: centers[index],
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
    const observedIndexTip = findPoint(keypoints, "index_finger_tip");
    const observedThumbTip = findPoint(keypoints, "thumb_tip");
    const indexTip = observedIndexTip ?? wrist;
    const thumbTip = observedThumbTip ?? wrist;
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
    const smoothedTip = previous
      ? {
          x: lerp(previous.indexTip.x, indexTip.x, tuning.smoothing),
          y: lerp(previous.indexTip.y, indexTip.y, tuning.smoothing),
        }
      : indexTip;
    const velocity =
      previous && delta > 0
        ? {
            x: (smoothedCenter.x - previous.center.x) / delta,
            y: (smoothedCenter.y - previous.center.y) / delta,
          }
        : { x: 0, y: 0 };
    const palmWidth = Math.max(distance(indexBase, pinkyBase), 0.04);
    const pinchRatio =
      observedIndexTip && observedThumbTip
        ? distance(thumbTip, indexTip) / palmWidth
        : Number.POSITIVE_INFINITY;
    const isPinching =
      Boolean(observedIndexTip && observedThumbTip) &&
      (previous?.isPinching
        ? pinchRatio < Math.max(tuning.pinchEnterRatio, tuning.pinchExitRatio)
        : pinchRatio < tuning.pinchEnterRatio);
    const extended = new Map<string, boolean>();
    let availableFingerCount = 0;
    let extendedCount = 0;
    for (const finger of ["index_finger", "middle_finger", "ring_finger", "pinky_finger"]) {
      const tip = findPoint(keypoints, `${finger}_tip`);
      const pip = findPoint(keypoints, `${finger}_pip`);
      if (tip && pip) availableFingerCount += 1;
      const isExtended = Boolean(
        tip &&
          pip &&
          distance(tip, wrist) >
            distance(pip, wrist) * tuning.fingerExtensionRatio,
      );
      extended.set(finger, isExtended);
      if (isExtended) extendedCount += 1;
    }
    const isIndexPointing =
      extended.get("index_finger") === true &&
      availableFingerCount >= 3 &&
      extendedCount - 1 <= 1 &&
      !isPinching;
    const isOpenPalm =
      availableFingerCount >= 3 && extendedCount >= 3 && !isPinching;
    const isFist =
      availableFingerCount >= 3 &&
      extendedCount <= 1 &&
      !isPinching &&
      !isIndexPointing;
    const nextGesture: HandGestureName = isPinching
      ? "COLLAPSE"
      : isIndexPointing
        ? "TRACE"
        : isOpenPalm || isFist
          ? "GRAVITY"
          : "IDLE";
    const gesture = this.stabilizeGesture(previous, nextGesture, now, tuning.gestureHoldMs);
    const forceMode = isPinching || isFist
      ? "attract"
      : isOpenPalm
        ? "repel"
        : isIndexPointing
          ? "attract"
          : "none";

    this.memory.set(id, {
      id,
      handedness,
      center: smoothedCenter,
      indexTip: smoothedTip,
      velocity,
      orientation: getOrientation(keypoints),
      confidence: observation.confidence,
      isPinching,
      gesture,
      candidateGesture: previous?.candidateGesture ?? nextGesture,
      candidateSince: previous?.candidateSince ?? now,
      lastImpulseAt: previous?.lastImpulseAt ?? Number.NEGATIVE_INFINITY,
      lastSeen: now,
    });

    return {
      id,
      handedness,
      center: smoothedCenter,
      indexTip: smoothedTip,
      pinchPoint: {
        x: (thumbTip.x + indexTip.x) / 2,
        y: (thumbTip.y + indexTip.y) / 2,
      },
      orientation: getOrientation(keypoints),
      confidence: observation.confidence,
      openness: extendedCount / 4,
      gesture,
      forceMode,
      isPinching,
      isFist,
      isOpenPalm,
      isIndexPointing,
      velocity,
    };
  }

  private stabilizeGesture(
    previous: HandMemory | undefined,
    next: HandGestureName,
    now: number,
    holdMs: number,
  ): HandGestureName {
    if (!previous) return next;
    if (next === previous.gesture) {
      previous.candidateGesture = next;
      previous.candidateSince = now;
      return next;
    }
    if (next !== previous.candidateGesture) {
      previous.candidateGesture = next;
      previous.candidateSince = now;
      return previous.gesture;
    }
    return now - previous.candidateSince >= holdMs ? next : previous.gesture;
  }

  private updateStroke(hand: DetectedHand, tuning: InteractionTuning) {
    let stroke = this.activeStrokes.get(hand.id);
    if (!stroke) {
      stroke = {
        id: `stroke-${this.nextStrokeId++}`,
        handId: hand.id,
        points: [hand.indexTip],
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
    const segmentLength = distance(previous, hand.indexTip);
    if (segmentLength < tuning.traceSpacing) return;
    const steps = Math.min(
      Math.ceil(segmentLength / tuning.traceSpacing),
      INTERACTION_CONFIG.drawing.maxInterpolationSteps,
    );
    for (let step = 1; step <= steps; step += 1) {
      const amount = step / steps;
      stroke.points.push({
        x: lerp(previous.x, hand.indexTip.x, amount),
        y: lerp(previous.y, hand.indexTip.y, amount),
      });
    }
    this.strokeVersion += 1;
  }

  private updateFieldTransform(hands: DetectedHand[], delta: number) {
    if (hands.length >= 2) {
      const orderedHands = [...hands].sort((a, b) => a.id.localeCompare(b.id));
      const first = orderedHands[0];
      const second = orderedHands[1];
      const separation = distance(first.center, second.center);
      const targetScale = Math.min(1.8, Math.max(0.65, 0.72 + separation * 0.95));
      this.universeScale = lerp(this.universeScale, targetScale, 1 - Math.exp(-delta * 5));
      const targetRotation = Math.atan2(
        second.center.y - first.center.y,
        second.center.x - first.center.x,
      );
      this.universeRotation +=
        wrapAngle(targetRotation - this.universeRotation) * (1 - Math.exp(-delta * 4));
      return;
    }
    this.universeScale = lerp(this.universeScale, 1, 1 - Math.exp(-delta * 1.8));
    this.universeRotation += wrapAngle(-this.universeRotation) * (1 - Math.exp(-delta * 1.8));
  }

  private updateShockwaves(delta: number) {
    for (let index = this.shockwaves.length - 1; index >= 0; index -= 1) {
      const wave = this.shockwaves[index];
      wave.age += delta;
      wave.strength *= Math.pow(INTERACTION_CONFIG.shockwave.decayPerFrame, delta * 60);
      if (
        wave.age > INTERACTION_CONFIG.shockwave.lifetimeSeconds ||
        wave.strength < 0.08
      ) {
        this.shockwaves.splice(index, 1);
      }
    }
  }

  private getTrackingSnapshots(hands: DetectedHand[], now: number): HandTrackSnapshot[] {
    const currentIds = new Set(hands.map((hand) => hand.id));
    const snapshots = hands.map((hand) => ({
      id: hand.id,
      handedness: hand.handedness,
      status: "tracking" as HandPresenceStatus,
      confidence: hand.confidence,
      gesture: hand.gesture,
      center: hand.center,
      indexTip: hand.indexTip,
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
        gesture: track.gesture,
        center: track.center,
        indexTip: track.indexTip,
        velocity: track.velocity,
        orientation: track.orientation,
        lastSeenAt: track.lastSeen,
      });
    });
    return snapshots;
  }

  private createFrame(now: number): InteractionFrame {
    const tracking = this.getTrackingSnapshots([], now);
    return {
      hands: [],
      tracking,
      mouse: { x: 0.5, y: 0.5 },
      mouseActive: false,
      mousePressed: false,
      gesture: "IDLE",
      tracePoints: [],
      strokes: this.strokes,
      strokeVersion: this.strokeVersion,
      clearVersion: this.clearVersion,
      clearProgress: 0,
      clearActive: false,
      clearCooldownRemaining: Math.max(0, this.clearCooldownUntil - now),
      events: this.recentEvents,
      shockwaves: this.shockwaves,
      universeScale: this.universeScale,
      universeRotation: this.universeRotation,
    };
  }
}
