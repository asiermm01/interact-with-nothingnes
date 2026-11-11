"use client";

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
