import type { Point2D } from "./types";

// Matriz afín 2D compatible con canvas: transforma píxeles del campo en
// píxeles de pantalla mediante escala y giro alrededor del centro.
export interface FieldTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const createFieldTransform = (
  width: number,
  height: number,
  scale: number,
  rotation: number,
): FieldTransform => {
  const cosine = Math.cos(rotation) * scale;
  const sine = Math.sin(rotation) * scale;
  return {
    a: cosine,
    b: sine,
    c: -sine,
    d: cosine,
    e: width / 2 - cosine * width / 2 + sine * height / 2,
    f: height / 2 - sine * width / 2 - cosine * height / 2,
  };
};

export const transformFieldPoint = (
  x: number,
  y: number,
  transform: FieldTransform,
  point: Point2D,
) => {
  point.x = transform.a * x + transform.c * y + transform.e;
  point.y = transform.b * x + transform.d * y + transform.f;
};

// La inversa lleva una posición de pantalla al campo para que manos, ratón y
// nuevos trazos coincidan con el entorno aun con zoom o rotación.
export const inverseTransformFieldPoint = (
  x: number,
  y: number,
  transform: FieldTransform,
  point: Point2D,
) => {
  const determinant = transform.a * transform.d - transform.b * transform.c;
  const dx = x - transform.e;
  const dy = y - transform.f;
  point.x = (transform.d * dx - transform.c * dy) / determinant;
  point.y = (-transform.b * dx + transform.a * dy) / determinant;
};
