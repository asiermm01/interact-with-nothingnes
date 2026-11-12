# ONE WITH NOTHINGNESS

Instalación interactiva de partículas. La experiencia visual comienza directamente;
el seguimiento con cámara es opcional y también se puede interactuar con el ratón.

## Tecnologías y bibliotecas

- **Next.js 16 (App Router)**: estructura de la aplicación y generación estática
  para publicar la experiencia como archivos web.
- **React 19**: componentes de interfaz y gestión de la experiencia interactiva.
- **TypeScript 5**: desarrollo con tipado estático y comprobación de tipos estricta.
- **p5.js**: motor de dibujo y simulación visual de partículas en el navegador.
- **ml5.js HandPose**: detección de manos y puntos clave mediante la cámara web.
- **TensorFlow.js**: ejecución del modelo HandPose en el navegador.
- **GSAP**: transiciones y animaciones de la interfaz.
- **WebGL**: aceleración gráfica utilizada por el lienzo de la experiencia.
- **CSS**: estilos adaptables e identidad visual de la instalación.
- **Node.js y npm**: entorno de ejecución y gestión de dependencias y scripts.

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

The build creates a formatted `index.html` and its `_next` assets directly in
the project root. Open the project folder in VS Code and select **Go Live**;
the root `index.html` is served automatically.
Webcam access requires a secure context: localhost during development or HTTPS
in production.

## Interaction

- Move the pointer to disturb the field; press and drag to trace.
- The live camera preview appears beneath the title while tracking is active;
  frames are processed locally in your browser.
- Use the tracking control to disconnect or resume ml5 HandPose tracking.
- Point with an index finger to draw persistent TRACE strokes. An open palm
  repels particles; a fist attracts them.
- Move either hand quickly for a directional IMPULSE. Use both hands to
  STRETCH and rotate the particle field; pinch with either hand for a localized
  COLLAPSE.
- Hold both hands in fists to trigger CLEAR ALL after the configured hold time.
  The toolbar reset also clears drawings.
- Open PARAMETERS to tune the field, gesture thresholds, drawing appearance,
  impulse sensitivity, and CLEAR ALL timing.
- Use the toolbar to pause, reset, capture a PNG, toggle fullscreen, or hide
  the interface. Press `H` to show the interface and `Escape` to restore it.
- Enable **DEBUG** beside the tracking control to show camera diagnostics,
  both landmark sets, per-hand identity/gesture/position/velocity, force modes,
  and recent interaction events; disable it with **DEBUG OFF** when finished.

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
