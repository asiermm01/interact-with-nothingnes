import type { DetectedHand, HandInteraction } from "./types";

// Traduce la interacción ya priorizada por el reconocedor; no clasifica poses.
type HandStatus = "NO DETECTADA" | "SIN IDENTIFICAR" | "EN REPOSO" | "CURSOR" | "TRACE" |
  "GRAVITY" | "STRETCH" | "COLLAPSE" | "CLEAR ALL";

const interactionLabels: Record<HandInteraction, HandStatus> = {
  none: "EN REPOSO",
  cursor: "CURSOR",
  trace: "TRACE",
  gravity: "GRAVITY",
  stretch: "STRETCH",
  collapse: "COLLAPSE",
  "clear-all": "CLEAR ALL",
};

export const getHandStatuses = (hands: Pick<DetectedHand, "handedness" | "interaction">[]) => {
  const unidentified = hands.some((hand) => hand.handedness === "Unknown");
  const fallback: HandStatus = unidentified ? "SIN IDENTIFICAR" : "NO DETECTADA";
  const left = hands.find((hand) => hand.handedness === "Left");
  const right = hands.find((hand) => hand.handedness === "Right");
  return {
    left: left ? interactionLabels[left.interaction] : fallback,
    right: right ? interactionLabels[right.interaction] : fallback,
  };
};
