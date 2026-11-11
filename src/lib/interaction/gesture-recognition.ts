import type {
  DetectedHand,
  HandLandmark,
  HandObservation,
  InteractionFrame,
  Point2D,
  Shockwave,
} from "./types";

const SMOOTHING = 0.34;
const PINCH_ENTER = 0.34;
const PINCH_EXIT = 0.48;
const IMPULSE_SPEED = 1.15;
const IMPULSE_COOLDOWN = 420;
const GESTURE_HOLD_MS = 140;
const TRAIL_LENGTH = 24;

const fingerNames = [
  "index_finger",
  "middle_finger",
  "ring_finger",
  "pinky_finger",
] as const;

const distance = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;

const findPoint = (landmarks: HandLandmark[], name: string): Point2D | null => {
  const point = landmarks.find((landmark) => landmark.name === name);
  return point ? { x: clamp01(point.x), y: clamp01(point.y) } : null;
};

interface HandMemory {
  center: Point2D;
  indexTip: Point2D;
  velocity: Point2D;
  isPinching: boolean;
  lastSeen: number;
}

export class GestureRecognizer {
  private readonly memory = new Map<number, HandMemory>();
  private readonly tracePoints: Point2D[] = [];
  private readonly shockwaves: Shockwave[] = [];
  private candidateGesture: InteractionFrame["gesture"] = "IDLE";
  private candidateSince = 0;
  private gesture: InteractionFrame["gesture"] = "IDLE";
  private lastImpulse = 0;
  private lastFrame = 0;
  private universeScale = 1;
  private universeRotation = 0;

  update(observations: HandObservation[], now: number): InteractionFrame {
    const delta = this.lastFrame ? Math.min((now - this.lastFrame) / 1000, 0.05) : 1 / 30;
    this.lastFrame = now;
    const hands = observations
      .filter((observation) => observation.confidence >= 0.45)
      .slice(0, 2)
      .map((observation, index) => this.trackHand(observation, index, now, delta));

    this.memory.forEach((value, key) => {
      if (now - value.lastSeen > 450) this.memory.delete(key);
    });

    const impulseTriggered = hands.some(
      (hand) =>
        Math.hypot(hand.velocity.x, hand.velocity.y) >= IMPULSE_SPEED &&
        now - this.lastImpulse > IMPULSE_COOLDOWN,
    );

    if (impulseTriggered) {
      const fastest = hands.reduce((best, hand) =>
        Math.hypot(hand.velocity.x, hand.velocity.y) >
        Math.hypot(best.velocity.x, best.velocity.y)
          ? hand
          : best,
      );
      this.shockwaves.push({ center: fastest.center, strength: 1, age: 0 });
      this.lastImpulse = now;
    }

    this.updateShockwaves(delta);
    const gesture = this.selectGesture(hands, impulseTriggered, now);
    this.updateGesture(gesture, now);

    if (this.gesture === "TRACE" && hands[0]) {
      const tip = hands[0].indexTip;
      this.tracePoints.push({ x: tip.x, y: tip.y });
      if (this.tracePoints.length > TRAIL_LENGTH) this.tracePoints.shift();
    } else if (this.tracePoints.length > 0) {
      this.tracePoints.shift();
    }

    if (hands.length >= 2) {
      const separation = distance(hands[0].center, hands[1].center);
      this.universeScale = lerp(this.universeScale, 0.72 + separation * 0.95, 0.12);
      this.universeRotation = lerp(
        this.universeRotation,
        Math.atan2(
          hands[1].center.y - hands[0].center.y,
          hands[1].center.x - hands[0].center.x,
        ),
        0.1,
      );
    } else {
      this.universeScale = lerp(this.universeScale, 1, 0.035);
      this.universeRotation = lerp(this.universeRotation, 0, 0.035);
    }

    return {
      hands,
      mouse: { x: 0.5, y: 0.5 },
      mouseActive: false,
      mousePressed: false,
      gesture: this.gesture,
      tracePoints: this.tracePoints,
      shockwaves: this.shockwaves,
      universeScale: this.universeScale,
      universeRotation: this.universeRotation,
      intensity: 1,
    };
  }

  private trackHand(
    observation: HandObservation,
    index: number,
    now: number,
    delta: number,
  ): DetectedHand {
    const keypoints = observation.keypoints;
    const wrist = findPoint(keypoints, "wrist") ?? { x: 0.5, y: 0.5 };
    const indexTip = findPoint(keypoints, "index_finger_tip") ?? wrist;
    const thumbTip = findPoint(keypoints, "thumb_tip") ?? wrist;
    const indexBase = findPoint(keypoints, "index_finger_mcp") ?? wrist;
    const middleBase = findPoint(keypoints, "middle_finger_mcp") ?? wrist;
    const ringBase = findPoint(keypoints, "ring_finger_mcp") ?? wrist;
    const pinkyBase = findPoint(keypoints, "pinky_finger_mcp") ?? wrist;
    const center = {
      x: (wrist.x + indexBase.x + middleBase.x + ringBase.x + pinkyBase.x) / 5,
      y: (wrist.y + indexBase.y + middleBase.y + ringBase.y + pinkyBase.y) / 5,
    };
    const palmWidth = Math.max(distance(indexBase, pinkyBase), 0.04);
    const memory = this.memory.get(index);
    const smoothedCenter = memory
      ? {
          x: lerp(memory.center.x, center.x, SMOOTHING),
          y: lerp(memory.center.y, center.y, SMOOTHING),
        }
      : center;
    const smoothedTip = memory
      ? {
          x: lerp(memory.indexTip.x, indexTip.x, SMOOTHING),
          y: lerp(memory.indexTip.y, indexTip.y, SMOOTHING),
        }
      : indexTip;
    const velocity =
      memory && delta > 0
        ? {
            x: (smoothedCenter.x - memory.center.x) / delta,
            y: (smoothedCenter.y - memory.center.y) / delta,
          }
        : { x: 0, y: 0 };
    const pinchRatio = distance(thumbTip, indexTip) / palmWidth;
    const isPinching = memory?.isPinching
      ? pinchRatio < PINCH_EXIT
      : pinchRatio < PINCH_ENTER;
    let extendedFingers = 0;

    fingerNames.forEach((finger) => {
      const tip = findPoint(keypoints, `${finger}_tip`);
      const pip = findPoint(keypoints, `${finger}_pip`);
      if (tip && pip && distance(tip, wrist) > distance(pip, wrist) * 1.14) {
        extendedFingers += 1;
      }
    });

    const isOpenPalm = extendedFingers >= 3 && !isPinching;
    const isFist = extendedFingers <= 1 && !isPinching;

    this.memory.set(index, {
      center: smoothedCenter,
      indexTip: smoothedTip,
      velocity,
      isPinching,
      lastSeen: now,
    });

    return {
      center: smoothedCenter,
      indexTip: smoothedTip,
      pinchPoint: {
        x: (thumbTip.x + indexTip.x) / 2,
        y: (thumbTip.y + indexTip.y) / 2,
      },
      confidence: observation.confidence,
      openness: extendedFingers / 4,
      isPinching,
      isFist,
      isOpenPalm,
      velocity,
    };
  }

  private selectGesture(hands: DetectedHand[], impulse: boolean, now: number) {
    if (hands.some((hand) => hand.isPinching)) return "COLLAPSE" as const;
    if (hands.length >= 2) return "STRETCH" as const;
    if (impulse || (this.gesture === "IMPULSE" && now - this.lastImpulse < 300)) {
      return "IMPULSE" as const;
    }
    if (hands[0]?.isOpenPalm || hands[0]?.isFist) return "GRAVITY" as const;
    if (hands[0] && hands[0].openness > 0 && hands[0].openness < 0.75) {
      return "TRACE" as const;
    }
    return "IDLE" as const;
  }

  private updateGesture(next: InteractionFrame["gesture"], now: number) {
    if (next === this.gesture) {
      this.candidateGesture = next;
      this.candidateSince = now;
      return;
    }

    if (next !== this.candidateGesture) {
      this.candidateGesture = next;
      this.candidateSince = now;
      return;
    }

    if (now - this.candidateSince >= GESTURE_HOLD_MS) {
      if (this.gesture === "COLLAPSE" && next !== "COLLAPSE") {
        const hand = this.memory.values().next().value as HandMemory | undefined;
        if (hand) this.shockwaves.push({ center: hand.center, strength: 1.8, age: 0 });
      }
      this.gesture = next;
    }
  }

  private updateShockwaves(delta: number) {
    for (let index = this.shockwaves.length - 1; index >= 0; index -= 1) {
      const wave = this.shockwaves[index];
      wave.age += delta;
      wave.strength *= 0.988;
      if (wave.age > 1.7 || wave.strength < 0.08) this.shockwaves.splice(index, 1);
    }
  }
}
