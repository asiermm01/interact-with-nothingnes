import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",

  // Nombre exacto del repositorio de GitHub
  basePath: "/onewithnothingness",

  trailingSlash: true,

  images: {
    unoptimized: true,
  },

  reactStrictMode: true,
};

export default nextConfig;
