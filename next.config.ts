import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// La exportación genera archivos estáticos; en desarrollo Next sirve los
// recursos desde la raíz y en producción se usan rutas relativas.
const nextConfig = (phase: string): NextConfig => ({
  output: "export",
  assetPrefix: phase === PHASE_DEVELOPMENT_SERVER ? undefined : ".",
  reactStrictMode: true,
});

export default nextConfig;
