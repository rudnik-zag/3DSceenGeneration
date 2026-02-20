import type { Metadata } from "next";
import { Inter } from "next/font/google";

import "@/app/globals.css";
import { Toaster } from "@/components/ui/toaster";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-sans"
});

export const metadata: Metadata = {
  title: "Flora Workflow Studio",
  description: "Infinite-canvas ML workflows with integrated 3D viewer"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} font-[var(--font-sans)]`}>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
