"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Menu, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/hooks/use-toast";

const featureCards = [
  {
    title: "Infinite canvas workflows",
    text: "Build graph pipelines with fluid pan/zoom, strict typed ports, and cache-aware execution."
  },
  {
    title: "Connect best-in-class models",
    text: "GroundingDINO, SAM2, SAM3D, Qwen-VL, Image Edit, and Texturing nodes are ready to chain."
  },
  {
    title: "Open 3D outputs instantly",
    text: "Export GLB/PLY/splats and inspect scene hierarchy, transforms, and stats in one click."
  }
];

const workflowSteps = [
  "Drop input/model/geometry/output nodes on the canvas",
  "Run in background with BullMQ + Redis",
  "Track status and logs per run",
  "Open generated artifacts in the 3D viewer"
];

const gallery = ["/demo-assets/gallery-1.svg", "/demo-assets/gallery-2.svg", "/demo-assets/gallery-3.svg"];

const fadeUp = {
  initial: { opacity: 0, y: 22 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-10%" },
  transition: { duration: 0.55, ease: [0.16, 1, 0.3, 1] }
};

export function LandingPage() {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  const openDemo = async () => {
    const res = await fetch("/api/demo/open", { method: "POST" });
    if (!res.ok) {
      toast({ title: "Could not open demo", description: "Try seeding the database first." });
      return;
    }

    const data = await res.json();
    router.push(`/app/p/${data.projectId}/canvas`);
  };

  return (
    <main className="relative min-h-screen overflow-x-hidden">
      <header className="sticky top-0 z-50 border-b border-border/70 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 md:px-6">
          <Link href="/" className="text-sm font-semibold tracking-[0.18em] text-foreground/90">
            3D-AI CANVAS
          </Link>

          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <a href="#features" className="hover:text-foreground">Features</a>
            <a href="#workflow" className="hover:text-foreground">Workflow</a>
            <a href="#gallery" className="hover:text-foreground">Gallery</a>
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/app">Get started</Link>
            </Button>
            <Button size="sm" onClick={openDemo}>Open demo</Button>
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="rounded-xl md:hidden"
            onClick={() => setMenuOpen((v) => !v)}
          >
            {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
        </div>

        {menuOpen ? (
          <div className="border-t border-border/70 bg-card/95 p-4 md:hidden">
            <div className="flex flex-col gap-2">
              <a href="#features" className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent" onClick={() => setMenuOpen(false)}>Features</a>
              <a href="#workflow" className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent" onClick={() => setMenuOpen(false)}>Workflow</a>
              <a href="#gallery" className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent" onClick={() => setMenuOpen(false)}>Gallery</a>
              <Button asChild className="mt-2"><Link href="/app">Get started</Link></Button>
              <Button variant="secondary" onClick={openDemo}>Open demo</Button>
            </div>
          </div>
        ) : null}
      </header>

      <section className="mx-auto grid w-full max-w-7xl gap-12 px-4 pb-20 pt-12 md:grid-cols-[1.1fr_0.9fr] md:px-6 md:pt-20">
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <p className="mb-5 inline-flex rounded-full border border-primary/35 bg-primary/10 px-4 py-1 text-xs tracking-[0.2em] text-primary">
            PRODUCTION-READY WORKFLOW STUDIO
          </p>
          <h1 className="max-w-3xl text-5xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl md:text-7xl">
            Your Intelligent 3D-AI Canvas
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
            Connect models into workflows. Generate 3D scenes. Open instantly in the viewer.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" className="rounded-xl px-7 text-sm font-medium" asChild>
              <Link href="/app">Get started</Link>
            </Button>
            <Button size="lg" variant="outline" className="rounded-xl px-7" onClick={openDemo}>
              Open demo
            </Button>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.08 }}
          className="relative"
        >
          <div className="relative rounded-3xl border border-white/10 bg-black/35 p-4 shadow-[0_32px_80px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            <div className="canvas-dot-bg relative h-[340px] overflow-hidden rounded-2xl border border-white/10 bg-[#090b13] md:h-[420px]">
              <motion.div
                className="absolute left-5 top-6 rounded-2xl border border-white/10 bg-card/95 p-3"
                animate={{ y: [0, -6, 0] }}
                transition={{ duration: 4.2, repeat: Infinity, ease: "easeInOut" }}
              >
                <p className="text-xs text-muted-foreground">input.image</p>
                <div className="mt-2 h-20 w-28 rounded-lg border border-white/10 bg-gradient-to-br from-zinc-700 to-zinc-900" />
              </motion.div>

              <motion.div
                className="absolute left-[35%] top-[34%] rounded-2xl border border-white/10 bg-card/95 p-3"
                animate={{ y: [0, 8, 0] }}
                transition={{ duration: 5.4, repeat: Infinity, ease: "easeInOut" }}
              >
                <p className="text-xs text-muted-foreground">geo.mesh_reconstruction</p>
                <div className="mt-2 h-16 w-32 rounded-lg border border-white/10 bg-gradient-to-tr from-emerald-600/30 to-cyan-400/10" />
              </motion.div>

              <motion.div
                className="absolute right-6 top-10 rounded-2xl border border-white/10 bg-card/95 p-3"
                animate={{ y: [0, -7, 0] }}
                transition={{ duration: 4.7, repeat: Infinity, ease: "easeInOut" }}
              >
                <p className="text-xs text-muted-foreground">out.export_scene</p>
                <div className="mt-2 h-20 w-24 rounded-lg border border-white/10 bg-gradient-to-tr from-primary/40 to-sky-500/25" />
              </motion.div>

              <svg className="absolute inset-0 h-full w-full" viewBox="0 0 800 480" preserveAspectRatio="none">
                <path d="M130 130 C 250 140, 270 210, 395 220" stroke="rgba(255,255,255,0.3)" strokeWidth="2" fill="none" />
                <path d="M470 220 C 540 220, 590 170, 700 160" stroke="rgba(255,255,255,0.3)" strokeWidth="2" fill="none" />
              </svg>
            </div>
          </div>
        </motion.div>
      </section>

      <section id="features" className="mx-auto w-full max-w-7xl px-4 pb-20 md:px-6">
        <motion.div {...fadeUp} className="mb-10">
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">Everything in one tactile surface</h2>
        </motion.div>
        <div className="grid gap-4 md:grid-cols-3">
          {featureCards.map((feature, idx) => (
            <motion.div key={feature.title} {...fadeUp} transition={{ ...fadeUp.transition, delay: idx * 0.06 }} whileHover={{ y: -4 }}>
              <Card className="h-full rounded-2xl border-white/10 bg-card/65 shadow-[0_16px_40px_rgba(0,0,0,0.35)]">
                <CardHeader>
                  <CardTitle className="text-xl font-semibold text-white">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm leading-relaxed text-muted-foreground">{feature.text}</CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      <section id="workflow" className="mx-auto w-full max-w-7xl px-4 pb-20 md:px-6">
        <motion.div {...fadeUp} className="rounded-3xl border border-white/10 bg-card/55 p-6 md:p-10">
          <h3 className="text-2xl font-semibold text-white md:text-3xl">From graph to 3D in minutes</h3>
          <div className="mt-7 grid gap-3 md:grid-cols-2">
            {workflowSteps.map((step, i) => (
              <div key={step} className="rounded-xl border border-white/10 bg-background/50 p-4 text-sm text-muted-foreground">
                <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                  {i + 1}
                </span>
                {step}
              </div>
            ))}
          </div>
        </motion.div>
      </section>

      <section id="gallery" className="mx-auto w-full max-w-7xl px-4 pb-24 md:px-6">
        <motion.h3 {...fadeUp} className="mb-6 text-2xl font-semibold text-white md:text-3xl">
          Demo gallery
        </motion.h3>
        <div className="grid gap-4 md:grid-cols-3">
          {gallery.map((src, i) => (
            <motion.img
              key={src}
              src={src}
              alt={`Gallery item ${i + 1}`}
              className="h-56 w-full rounded-2xl border border-white/10 object-cover shadow-[0_18px_40px_rgba(0,0,0,0.35)]"
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.07, duration: 0.45 }}
              whileHover={{ y: -4 }}
            />
          ))}
        </div>
      </section>

      <section className="mx-auto w-full max-w-7xl px-4 pb-24 md:px-6">
        <motion.div {...fadeUp} className="rounded-3xl border border-primary/30 bg-gradient-to-br from-primary/15 to-sky-500/10 p-8 md:p-12">
          <h3 className="max-w-2xl text-3xl font-semibold leading-tight text-white md:text-4xl">
            Build workflows, run them in background, and inspect 3D output without leaving the app.
          </h3>
          <div className="mt-7 flex flex-wrap gap-3">
            <Button size="lg" asChild>
              <Link href="/app">Get started</Link>
            </Button>
            <Button size="lg" variant="outline" onClick={openDemo}>
              Open demo
            </Button>
          </div>
        </motion.div>
      </section>
    </main>
  );
}
