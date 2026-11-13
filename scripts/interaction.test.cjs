const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  const source = fs.readFileSync(filename, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  module._compile(result.outputText, filename);
};

const { GestureRecognizer } = require("../src/lib/interaction/gesture-recognition.ts");
const { INTERACTION_CONFIG, INTERACTION_TUNING_DEFAULTS, particleCountForDensity } = require("../src/lib/interaction/config.ts");
const { createFieldTransform, transformFieldPoint } = require("../src/lib/interaction/field-transform.ts");

const viewport = { width: 1000, height: 500 };
const tuning = { ...INTERACTION_TUNING_DEFAULTS, smoothing: 1 };

function hand(x, y, handedness, extended = ["thumb", "index", "middle", "ring", "pinky"]) {
  const keypoints = [];
  const add = (name, px, py) => keypoints.push({ name, x: px, y: py });
  add("wrist", x, y + 0.05);
  const fingers = [
    ["index", "index_finger", -0.03],
    ["middle", "middle_finger", -0.01],
    ["ring", "ring_finger", 0.01],
    ["pinky", "pinky_finger", 0.03],
  ];
  for (const [finger, prefix, offset] of fingers) {
    add(`${prefix}_mcp`, x + offset, y);
    add(`${prefix}_pip`, x + offset, y - 0.04);
    add(`${prefix}_tip`, x + offset, y + (extended.includes(finger) ? -0.09 : -0.01));
  }
  add("thumb_mcp", x - 0.04, y + 0.01);
  add("thumb_ip", x - 0.06, y);
  add("thumb_tip", x - (extended.includes("thumb") ? 0.08 : 0.04), y + (extended.includes("thumb") ? -0.01 : 0.01));
  return { keypoints, confidence: 1, handedness };
}

function harness() {
  const recognizer = new GestureRecognizer();
  let now = 1000;
  const tick = (hands, count = 1) => {
    let frame;
    for (let index = 0; index < count; index += 1) {
      now += 33;
      frame = recognizer.update(hands, now, tuning, viewport);
    }
    return frame;
  };
  const pair = (leftX, rightX) => [hand(leftX, 0.5, "Left"), hand(rightX, 0.5, "Right")];
  return { recognizer, tick, pair };
}

test("stretch starts from the committed state, accumulates, and does not drift on release", () => {
  const { tick, pair } = harness();
  const start = tick(pair(0.35, 0.65), 8);
  assert.equal(start.gesture, "STRETCH");
  assert.equal(start.universeScale, 1);
  const expanded = tick(pair(0.25, 0.75), 80);
  assert.ok(expanded.universeScale > 2);
  const released = tick([], 80);
  assert.equal(released.universeScale, expanded.universeScale);
  assert.equal(released.universeRotation, expanded.universeRotation);
  const resumed = tick(pair(0.3, 0.7), 1);
  assert.equal(resumed.universeScale, released.universeScale);
  const further = tick(pair(0.2, 0.8), 80);
  assert.ok(further.universeScale > expanded.universeScale);
  const stopped = tick([], 80);
  assert.equal(stopped.universeScale, further.universeScale);
  tick(pair(0.2, 0.8), 1);
  const smaller = tick(pair(0.35, 0.65), 80);
  assert.ok(smaller.universeScale < stopped.universeScale);
  assert.equal(tick([], 60).universeScale, smaller.universeScale);
});

test("stretch rotation passes full turns and stays continuous across gestures", () => {
  const { tick } = harness();
  const pairAt = (angle) => {
    const dx = Math.cos(angle) * 100 / viewport.width;
    const dy = Math.sin(angle) * 100 / viewport.height;
    return [hand(0.5 - dx, 0.5 - dy, "Left"), hand(0.5 + dx, 0.5 + dy, "Right")];
  };
  tick(pairAt(0), 8);
  for (let index = 1; index <= 60; index += 1) tick(pairAt(index * Math.PI / 24));
  const rotated = tick(pairAt(2.5 * Math.PI), 80);
  assert.ok(rotated.universeRotation > 2 * Math.PI);
  assert.equal(tick([], 40).universeRotation, rotated.universeRotation);
  const restarted = tick(pairAt(0), 1);
  assert.equal(restarted.universeRotation, rotated.universeRotation);
  tick(pairAt(Math.PI / 4), 80);
  const continued = tick([], 20);
  assert.ok(continued.universeRotation > rotated.universeRotation + 0.7);
});

test("zoom limits are bounded and new trace points map back to their screen position", () => {
  const { tick, pair } = harness();
  tick(pair(0.46, 0.54), 8);
  const maximum = tick(pair(0.1, 0.9), 120);
  assert.equal(maximum.universeScale, INTERACTION_CONFIG.stretch.maximumScale);
  tick([], 1);
  tick(pair(0.1, 0.9), 1);
  const minimum = tick(pair(0.47, 0.53), 120);
  assert.equal(minimum.universeScale, INTERACTION_CONFIG.stretch.minimumScale);
  tick([], 1);
  const frame = tick([hand(0.18, 0.5, "Left", ["index", "middle"])], 1);
  assert.equal(frame.gesture, "TRACE");
  const vertex = frame.strokes[0].points[0];
  assert.ok(vertex.x < 0);
  const screen = { x: 0, y: 0 };
  transformFieldPoint(
    vertex.x * viewport.width, vertex.y * viewport.height,
    createFieldTransform(viewport.width, viewport.height, frame.universeScale, frame.universeRotation),
    screen,
  );
  assert.ok(Math.abs(screen.x / viewport.width - frame.hands[0].cursorPoint.x) < 1e-10);
  assert.ok(Math.abs(screen.y / viewport.height - frame.hands[0].cursorPoint.y) < 1e-10);
});

test("particle density is bounded and rejects invalid values", () => {
  const maximum = INTERACTION_CONFIG.particles.maximumCount;
  assert.equal(particleCountForDensity(maximum + 1000), maximum);
  assert.equal(particleCountForDensity(-10), 0);
  assert.throws(() => particleCountForDensity(Number.NaN), /finite/);
  assert.throws(() => particleCountForDensity(Infinity), /finite/);
});
