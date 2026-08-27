import type { Metadata } from "next";

import "@/app/globals.css";
import { InteractiveDotGrid } from "@/components/layout/interactive-dot-grid";
import { Toaster } from "@/components/ui/toaster";

export const metadata: Metadata = {
  title: "TribalAI Workflow Studio",
  description: "GraphEditor ML workflows with integrated 3D viewer"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="font-sans" suppressHydrationWarning>
        <InteractiveDotGrid />
        <div className="relative z-10 min-h-screen">
          {children}
          <Toaster />
        </div>
      </body>
    </html>
  );
}
