import type { DetectedHand, HandInteraction } from "./types";

type HandStatus = "NOT DETECTED" | "NOT IDENTIFIED" | "IDLE" | "CURSOR" | "TRACE" |
  "GRAVITY" | "STRETCH" | "COLLAPSE" | "CLEAR ALL";

const interactionLabels: Record<HandInteraction, HandStatus> = {
  none: "IDLE",
  cursor: "CURSOR",
  trace: "TRACE",
  gravity: "GRAVITY",
  stretch: "STRETCH",
  collapse: "COLLAPSE",
  "clear-all": "CLEAR ALL",
};

export const getHandStatuses = (hands: Pick<DetectedHand, "handedness" | "interaction">[]) => {
  const unidentified = hands.some((hand) => hand.handedness === "Unknown");
  const fallback: HandStatus = unidentified ? "NOT IDENTIFIED" : "NOT DETECTED";
  const left = hands.find((hand) => hand.handedness === "Left");
  const right = hands.find((hand) => hand.handedness === "Right");
  return {
    left: left ? interactionLabels[left.interaction] : fallback,
    right: right ? interactionLabels[right.interaction] : fallback,
  };
};
