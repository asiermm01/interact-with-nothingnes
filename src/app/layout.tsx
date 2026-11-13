import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

// Este layout de Next.js se prerenderiza; la interacción se inicia en los
// componentes de cliente que contiene. También fija el idioma y los metadatos.
export const metadata: Metadata = {
  title: "ONE WITH NOTHINGNESS",
  description:
    "Un universo interactivo de partículas. Muévete con el campo o dale forma con las manos.",
  applicationName: "ONE WITH NOTHINGNESS",
  appleWebApp: {
    capable: true,
    title: "ONE WITH NOTHINGNESS",
    statusBarStyle: "black-translucent",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
