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

export default function ParticleCanvas({
  interactionRef,
  settingsRef,
  onReady,
  onError,
}: ParticleCanvasProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef({ onReady, onError });
  callbacksRef.current = { onReady, onError };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;
    let disposed = false;
    let disposeEngine: (() => void) | null = null;

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
        callbacksRef.current.onError(
          error instanceof Error ? error.message : "The visual engine failed to start.",
        );
      });

    return () => {
      disposed = true;
      disposeEngine?.();
    };
  }, [interactionRef, settingsRef]);

  return <div aria-hidden="true" className="particle-canvas" ref={mountRef} />;
}
