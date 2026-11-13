import type { VisualMode } from "../interaction/types";

type Color = readonly [number, number, number];

const palettes: Record<Exclude<VisualMode, "monochrome">, readonly Color[]> = {
  nebula: [[86, 32, 233], [160, 138, 191], [154, 217, 108], [217, 173, 41]],
  filament: [[154, 217, 108], [160, 138, 191], [154, 217, 108], [242, 240, 245]],
};
const blendSteps = 64;

const makeColorTable = (palette: readonly Color[]) =>
  palette.map((from) => palette.map((to) =>
    Array.from({ length: blendSteps + 1 }, (_, step) => {
      const amount = step / blendSteps;
      const channels = from.map((channel, index) =>
        Math.round(channel + (to[index] - channel) * amount),
      );
      return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
    }),
  ));

const colorTables = {
  nebula: makeColorTable(palettes.nebula),
  filament: makeColorTable(palettes.filament),
};

export interface ParticleColorState {
  from: number;
  to: number;
  transitionAt: number;
  duration: number;
}

const nextColor = (from: number, random: () => number) =>
  (from + 1 + Math.floor(random() * 3)) % 4;

export const createParticleColor = (now: number, random = Math.random): ParticleColorState => {
  const from = Math.floor(random() * 4);
  return {
    from,
    to: nextColor(from, random),
    transitionAt: now + 8 + random() * 24,
    duration: 3 + random() * 6,
  };
};

export const particleColorAt = (
  state: ParticleColorState,
  now: number,
  mode: VisualMode,
  random = Math.random,
) => {
  if (mode === "monochrome") return "#f2f0f5";
  if (now >= state.transitionAt + state.duration) {
    state.from = state.to;
    state.to = nextColor(state.from, random);
    state.transitionAt = now + 8 + random() * 24;
    state.duration = 3 + random() * 6;
  }
  const progress = Math.max(0, Math.min(1, (now - state.transitionAt) / state.duration));
  const smoothProgress = progress * progress * (3 - 2 * progress);
  return colorTables[mode][state.from][state.to][Math.round(smoothProgress * blendSteps)];
};
