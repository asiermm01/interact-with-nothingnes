"use client";

// App Router usa este archivo como la ruta inicial. La experiencia necesita
// un componente de cliente por sus efectos y su acceso a las API del navegador.
import { useEffect } from "react";
import Experience from "@/components/Experience";

export default function Home() {
  console.info("[APP] Home page rendered");

  useEffect(() => {
    console.info("[APP] Home page mounted in the browser");
    return () => console.info("[APP] Home page unmounted");
  }, []);

  return <Experience />;
}
