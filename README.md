# ONE WITH NOTHINGNESS

An interactive particle installation. The visual experience starts immediately;
camera tracking is optional, and pointer interaction works without a camera.

## Run locally

Requires Node.js 20.15.1 or newer.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Webcam access requires a
secure context: localhost during development or HTTPS in production.

## Interaction

- Move the pointer to disturb the field; press and drag to trace.
- Use the tracking control to disconnect or resume ml5 HandPose tracking.
- TRACE with an index finger, use an open palm to repel, and a fist to attract.
- Move quickly for an IMPULSE; use two hands to STRETCH the field.
- Pinch to COLLAPSE the field, then release for a burst.
- Open PARAMETERS to tune density, force, trails, and visual mode.
- Use the toolbar to pause, reset, capture a PNG, toggle fullscreen, or hide
  the interface. Press `H` to show the interface and `Escape` to restore it.

When the experience opens, the browser requests webcam permission. If permission
is denied or a camera is unavailable, pointer interaction remains available.
Hand landmarks and video frames are processed in the browser. The first model
load requires an internet connection to retrieve its runtime/model assets.

## Quality checks

```bash
npm run typecheck
npm run build
```
