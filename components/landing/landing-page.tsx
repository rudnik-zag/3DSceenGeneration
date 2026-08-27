"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface LandingUserProject {
  id: string;
  name: string;
  updatedAt: string;
  runs: number;
  previewStorageKey: string | null;
}

const featureCards = [
  {
    title: "GraphEditor-first workflow graph",
    text: "Compose model chains on an infinite node graph editor with smooth pan, zoom, and port-safe connections."
  },
  {
    title: "Model orchestration",
    text: "Chain GroundingDINO, SAM2, scene generation, texturing, and export in one interaction surface."
  },
  {
    title: "Viewer-native results",
    text: "Open generated meshes, point clouds, and splats instantly with transforms and environment controls."
  }
];

const workflowSteps = [
  "Place input, model, geometry, and output nodes",
  "Run graph asynchronously with live status",
  "Inspect per-node logs and produced artifacts",
  "Open the result in the integrated 3D viewer"
];

const galleryItems = [
  { src: "/demo-assets/gallery-1.svg", title: "Cinematic interior", category: "Interior" },
  { src: "/demo-assets/gallery-2.svg", title: "Stylized terrain", category: "Landscape" },
  { src: "/demo-assets/gallery-3.svg", title: "Urban composition", category: "Architecture" }
];

const fadeUp = {
  initial: { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-10%" },
  transition: { duration: 0.55, ease: [0.2, 0.8, 0.2, 1] }
};

export function LandingPage({
  isAuthenticated = false,
  userLabel = null,
  userProjects = []
}: {
  isAuthenticated?: boolean;
  userLabel?: string | null;
  userProjects?: LandingUserProject[];
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState("All");
  const [loadedCards, setLoadedCards] = useState<Record<string, true>>({});
  const [loadedProjectPreviews, setLoadedProjectPreviews] = useState<Record<string, true>>({});
  const [brokenProjectPreviews, setBrokenProjectPreviews] = useState<Record<string, true>>({});

  const categories = useMemo(() => ["All", ...Array.from(new Set(galleryItems.map((item) => item.category)))], []);
  const filteredGallery = useMemo(
    () => (activeCategory === "All" ? galleryItems : galleryItems.filter((item) => item.category === activeCategory)),
    [activeCategory]
  );

  return (
    <main className="relative min-h-screen overflow-x-hidden studio-dot-bg">
      <header className="sticky top-0 z-50 border-b border-white/[0.06] bg-[#18181a]/92 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center justify-between px-4 md:px-6">
          <Link href="/" className="inline-flex items-center gap-3 text-sm font-medium tracking-wide text-white">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-white text-[#18181a]">
              <Sparkles className="h-4 w-4" />
            </span>
            3D AI Studio
          </Link>

          <nav className="hidden items-center gap-8 text-xs text-zinc-400 md:flex">
            <a href="#features" className="motion-fast hover:text-white">Features</a>
            <a href="#workflow" className="motion-fast hover:text-white">Workflow</a>
            <a href="#gallery" className="motion-fast hover:text-white">Gallery</a>
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            {isAuthenticated ? (
              <>
                {userLabel ? (
                  <span className="max-w-[220px] truncate px-2 text-xs text-zinc-500">{userLabel}</span>
                ) : null}
                <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-white" asChild>
                  <Link href="/pricing">Pricing</Link>
                </Button>
                <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-white" asChild>
                  <Link href="/settings">Account</Link>
                </Button>
                <Button size="sm" className="rounded-lg bg-white text-[#18181a] hover:bg-zinc-200" asChild>
                  <Link href="/app">Open app</Link>
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-white" asChild>
                  <Link href="/pricing">Pricing</Link>
                </Button>
                <Button variant="ghost" size="sm" className="text-zinc-400 hover:text-white" asChild>
                  <Link href="/login">Login</Link>
                </Button>
                <Button size="sm" className="rounded-lg bg-white text-[#18181a] hover:bg-zinc-200" asChild>
                  <Link href="/register">Get started</Link>
                </Button>
              </>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="rounded-lg text-white hover:bg-white/5 md:hidden"
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
        </div>

        {menuOpen ? (
          <div className="border-t border-white/[0.06] bg-[#18181a]/95 p-4 md:hidden">
            <div className="flex flex-col gap-2">
              <a href="#features" className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-white/5 hover:text-white" onClick={() => setMenuOpen(false)}>Features</a>
              <a href="#workflow" className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-white/5 hover:text-white" onClick={() => setMenuOpen(false)}>Workflow</a>
              <a href="#gallery" className="rounded-lg px-3 py-2 text-sm text-zinc-400 hover:bg-white/5 hover:text-white" onClick={() => setMenuOpen(false)}>Gallery</a>
              {isAuthenticated ? (
                <>
                  {userLabel ? <p className="px-1 pt-1 text-xs text-zinc-500">{userLabel}</p> : null}
                  <Button asChild className="mt-2 bg-white text-[#18181a] hover:bg-zinc-200"><Link href="/app">Open app</Link></Button>
                  <Button variant="outline" asChild><Link href="/settings">Account</Link></Button>
                  <Button variant="outline" asChild><Link href="/pricing">Pricing</Link></Button>
                </>
              ) : (
                <>
                  <Button asChild className="mt-2 bg-white text-[#18181a] hover:bg-zinc-200"><Link href="/register">Get started</Link></Button>
                  <Button variant="outline" asChild><Link href="/pricing">Pricing</Link></Button>
                  <Button variant="outline" asChild><Link href="/login">Login</Link></Button>
                </>
              )}
            </div>
          </div>
        ) : null}
      </header>

      <section className="mx-auto w-full max-w-[1160px] px-4 pb-24 pt-24 md:px-6 md:pt-28">
        <div className="grid gap-12 md:grid-cols-[1.02fr_0.98fr] md:items-center">
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
              <p className="studio-kicker mb-6 text-[11px]">
                AI 3D WORKFLOW STUDIO
              </p>
              <h1 className="studio-hero-title max-w-3xl text-5xl font-medium leading-[0.95] text-white sm:text-6xl md:text-7xl">
                Intelligent 3D Environment Maker
              </h1>
              <p className="mt-7 max-w-2xl text-base leading-8 text-zinc-400 md:text-lg">
                Design, run, and inspect AI-native 3D workflows in one continuous cinematic workspace.
              </p>

              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Button size="lg" className="rounded-lg bg-white px-7 text-sm font-semibold text-[#18181a] hover:bg-zinc-200" asChild>
                  <Link href={isAuthenticated ? "/app" : "/register"}>{isAuthenticated ? "Open app" : "Get started"}</Link>
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="rounded-lg border-white/15 bg-transparent px-7 text-zinc-200 hover:bg-white/5"
                  asChild
                >
                  <Link href={isAuthenticated ? "/settings" : "/pricing"}>
                    {isAuthenticated ? "Account settings" : "View pricing"}
                  </Link>
                </Button>
              </div>

              <p className="mt-5 text-sm text-zinc-500">
                {isAuthenticated
                  ? "Your latest projects are shown on the right panel."
                  : "Sign in to see your real project gallery directly on this landing page."}
              </p>
              <div className="mt-10 flex flex-wrap gap-x-9 gap-y-3 font-mono text-[11px] uppercase tracking-[0.12em] text-zinc-600">
                <span>Graph based</span>
                <span>3D viewer</span>
                <span>Depth + segmentation</span>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.08 }}
              className="relative"
            >
              <div className="relative">
                {isAuthenticated ? (
                  <div className="relative h-[340px] overflow-hidden rounded-xl border border-white/[0.08] bg-[#111113] p-3 shadow-[0_28px_80px_rgba(0,0,0,0.34)] md:h-[420px]">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="font-mono text-xs uppercase tracking-[0.16em] text-zinc-500">Your Project Gallery</p>
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-zinc-400 hover:text-white" asChild>
                        <Link href="/app">View all</Link>
                      </Button>
                    </div>

                    {userProjects.length > 0 ? (
                      <div className="grid h-[calc(100%-2rem)] grid-cols-2 gap-2 overflow-y-auto pr-1">
                        {userProjects.slice(0, 6).map((project) => (
                          <button
                            key={`landing-project-${project.id}`}
                            type="button"
                            onClick={() => router.push(`/app/p/${project.id}/graph-editor`)}
                            className="group overflow-hidden rounded-lg border border-white/[0.08] bg-white/[0.035] text-left motion-fast hover:border-white/20 hover:bg-white/[0.06]"
                          >
                            <div className="relative h-24 border-b border-white/[0.08] bg-black/30">
                              {project.previewStorageKey && !brokenProjectPreviews[project.id] ? (
                                <>
                                  {!loadedProjectPreviews[project.id] ? <div className="skeleton-shimmer absolute inset-0 bg-white/[0.04]" /> : null}
                                  <img
                                    src={`/api/storage/object?key=${encodeURIComponent(project.previewStorageKey)}`}
                                    alt={`${project.name} preview`}
                                    loading="lazy"
                                    className="relative z-[1] h-full w-full object-cover motion-panel group-hover:scale-[1.03]"
                                    onLoad={() =>
                                      setLoadedProjectPreviews((current) => ({
                                        ...current,
                                        [project.id]: true
                                      }))
                                    }
                                    onError={() =>
                                      setBrokenProjectPreviews((current) => ({
                                        ...current,
                                        [project.id]: true
                                      }))
                                    }
                                  />
                                </>
                              ) : (
                                <div className="h-full w-full bg-[linear-gradient(135deg,rgba(255,255,255,0.12),rgba(255,255,255,0.035),rgba(37,240,178,0.12))]" />
                              )}
                            </div>
                            <div className="px-2.5 py-2">
                              <p className="line-clamp-1 text-sm font-semibold text-white">{project.name}</p>
                              <p className="mt-1 text-[11px] text-zinc-500">{project.runs} runs</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="grid h-[calc(100%-2rem)] place-items-center rounded-xl border border-dashed border-white/15 bg-black/20 p-6 text-center">
                        <div>
                          <p className="text-sm text-zinc-300">No projects yet.</p>
                          <p className="mt-1 text-xs text-zinc-500">Create your first workflow project to populate this gallery.</p>
                          <Button className="mt-3 h-8 rounded-lg bg-white px-3 text-xs text-[#18181a] hover:bg-zinc-200" asChild>
                            <Link href="/app">Create project</Link>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="relative h-[300px] overflow-hidden bg-black md:h-[300px]">
                    <img
                      src="/demo-assets/landing-concept-intelligent-3d.svg"
                      alt="Concept illustration for Intelligent 3D Environment Maker"
                      className="h-full w-full object-cover"
                    />
                  </div>
                )}
              </div>
            </motion.div>
          </div>
          <div className="mt-24 grid gap-6 text-center sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["2-3 min", "Generation time"],
              ["4K", "Texture resolution"],
              ["1.5M", "Max polygons"],
              ["8", "View angles"]
            ].map(([value, label]) => (
              <div key={label}>
                <p className="text-3xl font-semibold text-white">{value}</p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-600">{label}</p>
              </div>
            ))}
          </div>
      </section>

      <section id="features" className="mx-auto w-full max-w-[1160px] px-4 pb-20 md:px-6">
        <motion.div {...fadeUp} className="mb-10">
          <h2 className="studio-hero-title text-3xl font-medium text-white md:text-4xl">Build faster, keep control</h2>
        </motion.div>
        <div className="grid gap-4 md:grid-cols-3">
          {featureCards.map((feature, idx) => (
            <motion.div key={feature.title} {...fadeUp} transition={{ ...fadeUp.transition, delay: idx * 0.06 }} whileHover={{ y: -4 }}>
              <Card className="h-full rounded-xl border-white/[0.08] bg-[#1a1a1d]/82">
                <CardHeader>
                  <CardTitle className="text-xl font-medium text-white">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm leading-relaxed text-zinc-400">{feature.text}</CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      <section id="workflow" className="mx-auto w-full max-w-[1160px] px-4 pb-20 md:px-6">
        <motion.div {...fadeUp} className="rounded-xl border border-white/[0.08] bg-[#1a1a1d]/82 p-6 md:p-10">
          <h3 className="studio-hero-title text-2xl font-medium text-white md:text-3xl">From idea to scene in minutes</h3>
          <div className="mt-7 grid gap-3 md:grid-cols-2">
            {workflowSteps.map((step, i) => (
              <div key={step} className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-4 text-sm text-zinc-400">
                <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-white text-xs font-semibold text-[#18181a]">
                  {i + 1}
                </span>
                {step}
              </div>
            ))}
          </div>
        </motion.div>
      </section>

      <section id="gallery" className="mx-auto w-full max-w-[1160px] px-4 pb-24 md:px-6">
        <motion.h3 {...fadeUp} className="studio-hero-title mb-4 text-2xl font-medium text-white md:text-3xl">
          {isAuthenticated ? "Project gallery" : "Demo gallery"}
        </motion.h3>

        {isAuthenticated ? (
          userProjects.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {userProjects.map((project) => (
                <button
                  key={`landing-gallery-${project.id}`}
                  type="button"
                  onClick={() => router.push(`/app/p/${project.id}/graph-editor`)}
                  className="group overflow-hidden rounded-xl border border-white/[0.08] bg-[#1a1a1d]/82 text-left motion-fast hover:border-white/20 hover:bg-white/[0.05]"
                >
                  <div className="relative aspect-[4/3] overflow-hidden border-b border-white/[0.08] bg-black/30">
                    {project.previewStorageKey && !brokenProjectPreviews[project.id] ? (
                      <img
                        src={`/api/storage/object?key=${encodeURIComponent(project.previewStorageKey)}`}
                        alt={`${project.name} preview`}
                        loading="lazy"
                        className="h-full w-full object-cover motion-panel group-hover:scale-[1.035]"
                        onError={() =>
                          setBrokenProjectPreviews((current) => ({
                            ...current,
                            [project.id]: true
                          }))
                        }
                      />
                    ) : (
                      <div className="h-full w-full bg-[linear-gradient(135deg,rgba(255,255,255,0.12),rgba(255,255,255,0.035),rgba(37,240,178,0.12))]" />
                    )}
                  </div>
                  <div className="px-3 py-2.5">
                    <p className="line-clamp-1 text-sm font-semibold text-white">{project.name}</p>
                    <p className="mt-1 text-[11px] text-zinc-500">{project.runs} runs</p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.025] p-8 text-center text-zinc-500">
              Your project gallery is empty. Open app and create your first project.
            </div>
          )
        ) : (
          <>
            <div className="mb-5 flex flex-wrap gap-2">
              {categories.map((category) => {
                const active = activeCategory === category;
                return (
                  <motion.button
                    key={`category-${category}`}
                    type="button"
                    onClick={() => setActiveCategory(category)}
                    className={`rounded-full border px-3 py-1.5 text-xs font-medium motion-fast ${
                      active
                        ? "border-white bg-white text-[#18181a]"
                        : "border-white/10 bg-white/[0.025] text-zinc-400 hover:border-white/20 hover:bg-white/[0.05]"
                    }`}
                    whileTap={{ scale: 0.97 }}
                  >
                    {category}
                  </motion.button>
                );
              })}
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <AnimatePresence mode="popLayout">
                {filteredGallery.map((item, idx) => (
                  <motion.div
                    key={`${item.src}-${activeCategory}`}
                    initial={{ opacity: 0, scale: 0.98, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.98, y: 4 }}
                    transition={{ duration: 0.26, delay: idx * 0.04, ease: [0.2, 0.8, 0.2, 1] }}
                    className="group overflow-hidden rounded-xl border border-white/[0.08] bg-[#1a1a1d]/82"
                  >
                    <div className="relative aspect-[4/3] overflow-hidden">
                      {!loadedCards[item.src] ? <div className="skeleton-shimmer absolute inset-0 bg-white/[0.04]" /> : null}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.src}
                        alt={item.title}
                        loading="lazy"
                        onLoad={() =>
                          setLoadedCards((current) => ({
                            ...current,
                            [item.src]: true
                          }))
                        }
                        className="relative z-[1] h-full w-full object-cover transition duration-300 ease-out group-hover:scale-[1.035]"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2 border-t border-white/[0.08] px-3 py-2.5">
                      <p className="truncate text-sm text-zinc-200">{item.title}</p>
                      <span className="rounded-full border border-white/10 bg-white/[0.035] px-2 py-0.5 text-[10px] text-zinc-500">
                        {item.category}
                      </span>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
