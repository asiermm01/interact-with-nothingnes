# ONE WITH NOTHINGNESS

An interactive particle installation. The visual experience starts immediately;
camera tracking is optional, and pointer interaction works without a camera.

## Run locally

Requires Node.js 20.15.1 or newer.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) for development.

## Open with VS Code Live Server

Live Server serves static files; it does not compile or run a Next.js project.
Build the static site first:

```bash
npm run build
```

Then open `out/index.html` in VS Code and select **Go Live**. The build creates
the functional HTML entry point and its JavaScript/CSS assets in `out`.
Webcam access requires a secure context: localhost during development or HTTPS
in production.

## Interaction

- Move the pointer to disturb the field; press and drag to trace.
- The live camera preview appears beneath the title while tracking is active;
  frames are processed locally in your browser.
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
If the model does not detect a hand, the status changes to **NO HANDS DETECTED**
with a placement hint. If detections stop arriving, tracking reports an error
instead of searching indefinitely.

## Quality checks

```bash
npm run typecheck
npm run build
```
