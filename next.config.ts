import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const nextConfig = (phase: string): NextConfig => ({
  output: "export",
  assetPrefix: phase === PHASE_DEVELOPMENT_SERVER ? undefined : ".",
  reactStrictMode: true,
});

export default nextConfig;
