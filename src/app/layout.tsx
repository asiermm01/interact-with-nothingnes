import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ONE WITH NOTHINGNESS — Field Study 001",
  description:
    "An interactive generative particle universe. Move with the field, or invite your hands to shape it.",
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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
