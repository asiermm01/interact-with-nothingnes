import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Genera una versión estática de la web
  output: "export",

  // Ruta del repositorio en GitHub Pages
  basePath: "/onewithnothingness.ai",

  // Facilita la resolución de rutas
  trailingSlash: true,

  // Desactiva la optimización de imágenes del servidor
  images: {
    unoptimized: true,
  },

  reactStrictMode: true,
};

export default nextConfig;
