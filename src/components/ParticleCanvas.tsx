"use client";

import { useEffect, useRef } from "react";
import { createParticleEngine } from "@/lib/rendering/particle-engine";
import type {
  InteractionFrame,
  ParticleCanvasHandle,
  UserSettings,
} from "@/lib/interaction/types";

interface ParticleCanvasProps {
  interactionRef: { current: InteractionFrame };
  settingsRef: { current: UserSettings };
  onReady: (handle: ParticleCanvasHandle) => void;
  onError: (message: string) => void;
}

// Este puente monta p5 fuera del render de React y entrega sus controles al padre.
export default function ParticleCanvas({
  interactionRef,
  settingsRef,
  onReady,
  onError,
}: ParticleCanvasProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  // La instancia del motor conserva un callback estable, pero llama siempre a
  // las versiones más recientes de las funciones recibidas como props.
  const callbacksRef = useRef({ onReady, onError });
  callbacksRef.current = { onReady, onError };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;
    let disposed = false;
    let disposeEngine: (() => void) | null = null;

    // La carga es asíncrona: si el componente se desmonta antes de terminar,
    // hay que liberar igualmente el motor que acaba de crearse.
    void createParticleEngine({
      container,
      interactionRef,
      settingsRef,
      onReady: (handle) => callbacksRef.current.onReady(handle),
    })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        disposeEngine = cleanup;
      })
      .catch((error: unknown) => {
        console.error("The visual engine failed to start.", error);
        callbacksRef.current.onError("No se pudo iniciar el entorno visual.");
      });

    return () => {
      disposed = true;
      disposeEngine?.();
    };
  }, [interactionRef, settingsRef]);

  return <div aria-hidden="true" className="particle-canvas" ref={mountRef} />;
}
