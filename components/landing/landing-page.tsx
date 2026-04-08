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
    title: "Canvas-first workflow graph",
    text: "Compose model chains on an infinite node canvas with smooth pan, zoom, and port-safe connections."
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

  const categories = useMemo(() => ["All", ...Array.from(new Set(galleryItems.map((item) => item.category)))], []);
  const filteredGallery = useMemo(
    () => (activeCategory === "All" ? galleryItems : galleryItems.filter((item) => item.category === activeCategory)),
    [activeCategory]
  );

  return (
    <main className="relative min-h-screen overflow-x-hidden bg-[#030915]">
      <header className="sticky top-0 z-50 border-b border-[#263254] bg-[#0b1226]/90 backdrop-blur-xl">
        <div className="mx-auto flex h-14 w-full max-w-[1280px] items-center justify-between px-4 md:px-6">
          <Link href="/" className="inline-flex items-center gap-2 text-sm font-semibold tracking-[0.12em] text-[#e5ecff]">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#5d57f4] text-white shadow-[0_6px_18px_rgba(93,87,244,0.45)]">
              <Sparkles className="h-4 w-4" />
            </span>
            TRIBALAI
            <span className="rounded-full border border-[#41528a] bg-[#1a2550]/75 px-2 py-0.5 text-[10px] text-[#a8b7f2]">
              Studio
            </span>
          </Link>

          <nav className="hidden items-center gap-6 text-sm text-[#9cb0de] md:flex">
            <a href="#features" className="motion-fast hover:text-[#e5ecff]">Features</a>
            <a href="#workflow" className="motion-fast hover:text-[#e5ecff]">Workflow</a>
            <a href="#gallery" className="motion-fast hover:text-[#e5ecff]">Gallery</a>
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            {isAuthenticated ? (
              <>
                {userLabel ? (
                  <span className="max-w-[220px] truncate px-2 text-xs text-[#8ea3d6]">{userLabel}</span>
                ) : null}
                <Button variant="ghost" size="sm" className="text-[#c8d5fb] hover:bg-[#1a2950] hover:text-white" asChild>
                  <Link href="/pricing">Pricing</Link>
                </Button>
                <Button variant="ghost" size="sm" className="text-[#c8d5fb] hover:bg-[#1a2950] hover:text-white" asChild>
                  <Link href="/settings">Account</Link>
                </Button>
                <Button size="sm" className="bg-[#5b58f3] text-white hover:bg-[#6a67ff]" asChild>
                  <Link href="/app">Open app</Link>
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" size="sm" className="text-[#c8d5fb] hover:bg-[#1a2950] hover:text-white" asChild>
                  <Link href="/pricing">Pricing</Link>
                </Button>
                <Button variant="ghost" size="sm" className="text-[#c8d5fb] hover:bg-[#1a2950] hover:text-white" asChild>
                  <Link href="/login">Login</Link>
                </Button>
                <Button size="sm" className="bg-[#5b58f3] text-white hover:bg-[#6a67ff]" asChild>
                  <Link href="/register">Get started</Link>
                </Button>
              </>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon"
            className="rounded-xl text-[#d5e0ff] hover:bg-[#1a2950] md:hidden"
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </Button>
        </div>

        {menuOpen ? (
          <div className="border-t border-[#263254] bg-[#0c152b]/95 p-4 md:hidden">
            <div className="flex flex-col gap-2">
              <a href="#features" className="rounded-lg px-3 py-2 text-sm text-[#a4b6e2] hover:bg-[#1a2950]" onClick={() => setMenuOpen(false)}>Features</a>
              <a href="#workflow" className="rounded-lg px-3 py-2 text-sm text-[#a4b6e2] hover:bg-[#1a2950]" onClick={() => setMenuOpen(false)}>Workflow</a>
              <a href="#gallery" className="rounded-lg px-3 py-2 text-sm text-[#a4b6e2] hover:bg-[#1a2950]" onClick={() => setMenuOpen(false)}>Gallery</a>
              {isAuthenticated ? (
                <>
                  {userLabel ? <p className="px-1 pt-1 text-xs text-[#8ea3d6]">{userLabel}</p> : null}
                  <Button asChild className="mt-2 bg-[#5b58f3] text-white hover:bg-[#6a67ff]"><Link href="/app">Open app</Link></Button>
                  <Button variant="outline" className="border-[#3d4f80] bg-[#152347] text-[#d0dcff] hover:bg-[#1e315f]" asChild><Link href="/settings">Account</Link></Button>
                  <Button variant="outline" className="border-[#3d4f80] bg-[#152347] text-[#d0dcff] hover:bg-[#1e315f]" asChild><Link href="/pricing">Pricing</Link></Button>
                </>
              ) : (
                <>
                  <Button asChild className="mt-2 bg-[#5b58f3] text-white hover:bg-[#6a67ff]"><Link href="/register">Get started</Link></Button>
                  <Button variant="outline" className="border-[#3d4f80] bg-[#152347] text-[#d0dcff] hover:bg-[#1e315f]" asChild><Link href="/pricing">Pricing</Link></Button>
                  <Button variant="outline" className="border-[#3d4f80] bg-[#152347] text-[#d0dcff] hover:bg-[#1e315f]" asChild><Link href="/login">Login</Link></Button>
                </>
              )}
            </div>
          </div>
        ) : null}
      </header>

      <section className="mx-auto w-full max-w-[1280px] px-4 pb-20 pt-10 md:px-6 md:pt-14">
        <div className="rounded-2xl border border-[#2a3559] bg-[#0b1226]/90 p-4 shadow-[0_20px_65px_rgba(1,8,25,0.48)] backdrop-blur md:p-6">
          <div className="grid gap-10 md:grid-cols-[1.08fr_0.92fr] md:items-center">
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
              <p className="mb-5 inline-flex rounded-full border border-[#2f6e63] bg-[#0f3a35]/60 px-4 py-1 text-xs tracking-[0.2em] text-[#58d8ad]">
                TRIBALAI STUDIO
              </p>
              <h1 className="max-w-3xl text-5xl font-semibold leading-[1.02] tracking-tight text-white sm:text-6xl md:text-7xl">
                Intelligent 3D Environment Maker
              </h1>
              <p className="mt-6 max-w-2xl text-base leading-relaxed text-[#b3c0e4] md:text-lg">
                Design, run, and inspect AI-native 3D workflows in one continuous cinematic workspace.
              </p>

              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Button size="lg" className="rounded-xl bg-[#44d6a5] px-7 text-sm font-semibold text-[#072217] hover:bg-[#5ce0b5]" asChild>
                  <Link href={isAuthenticated ? "/app" : "/register"}>{isAuthenticated ? "Open app" : "Get started"}</Link>
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="rounded-xl border-[#3d4f80] bg-[#152347] px-7 text-[#d0dcff] hover:bg-[#1f315f]"
                  asChild
                >
                  <Link href={isAuthenticated ? "/settings" : "/pricing"}>
                    {isAuthenticated ? "Account settings" : "View pricing"}
                  </Link>
                </Button>
              </div>

              <p className="mt-4 text-sm text-[#8fa2d2]">
                {isAuthenticated
                  ? "Your latest projects are shown on the right panel."
                  : "Sign in to see your real project gallery directly on this landing page."}
              </p>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.08 }}
              className="relative"
            >
              <div className="relative rounded-3xl border border-[#2a3c6b] bg-[#0f1936]/85 p-4 shadow-[0_28px_75px_rgba(2,8,23,0.52)] backdrop-blur-xl">
                {isAuthenticated ? (
                  <div className="relative h-[340px] overflow-hidden rounded-2xl border border-[#2f3f68] bg-[#070f24] p-3 md:h-[420px]">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="text-xs uppercase tracking-[0.16em] text-[#8fa2d2]">Your Project Gallery</p>
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-[#a8b7df] hover:bg-[#1a2950] hover:text-white" asChild>
                        <Link href="/app">View all</Link>
                      </Button>
                    </div>

                    {userProjects.length > 0 ? (
                      <div className="grid h-[calc(100%-2rem)] grid-cols-2 gap-2 overflow-y-auto pr-1">
                        {userProjects.slice(0, 6).map((project) => (
                          <button
                            key={`landing-project-${project.id}`}
                            type="button"
                            onClick={() => router.push(`/app/p/${project.id}/canvas`)}
                            className="group overflow-hidden rounded-xl border border-[#324371] bg-[#111d3f]/90 text-left motion-fast hover:border-[#4a63a5] hover:bg-[#162650]"
                          >
                            <div className="relative h-24 border-b border-[#2e406c] bg-[#0c1631]">
                              {project.previewStorageKey ? (
                                <>
                                  {!loadedProjectPreviews[project.id] ? <div className="skeleton-shimmer absolute inset-0 bg-white/[0.04]" /> : null}
                                  <img
                                    src={`/api/storage/object?key=${encodeURIComponent(project.previewStorageKey)}`}
                                    alt={`${project.name} preview`}
                                    loading="lazy"
                                    className={`h-full w-full object-cover motion-panel group-hover:scale-[1.03] ${
                                      loadedProjectPreviews[project.id] ? "opacity-100" : "opacity-0"
                                    }`}
                                    onLoad={() =>
                                      setLoadedProjectPreviews((current) => ({
                                        ...current,
                                        [project.id]: true
                                      }))
                                    }
                                  />
                                </>
                              ) : (
                                <div className="h-full w-full bg-[linear-gradient(135deg,rgba(43,86,123,0.55),rgba(36,47,88,0.5),rgba(23,89,77,0.45))]" />
                              )}
                            </div>
                            <div className="px-2.5 py-2">
                              <p className="line-clamp-1 text-sm font-semibold text-white">{project.name}</p>
                              <p className="mt-1 text-[11px] text-[#9db2e0]">{project.runs} runs</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="grid h-[calc(100%-2rem)] place-items-center rounded-xl border border-dashed border-[#3c507f] bg-[#0c1631]/70 p-6 text-center">
                        <div>
                          <p className="text-sm text-[#b6c4e9]">No projects yet.</p>
                          <p className="mt-1 text-xs text-[#8ea3d6]">Create your first workflow project to populate this gallery.</p>
                          <Button className="mt-3 h-8 rounded-lg bg-[#5b58f3] px-3 text-xs text-white hover:bg-[#6a67ff]" asChild>
                            <Link href="/app">Create project</Link>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="relative h-[340px] overflow-hidden rounded-2xl border border-[#2f3f68] bg-[#070f24] md:h-[420px]">
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
        </div>
      </section>

      <section id="features" className="mx-auto w-full max-w-[1280px] px-4 pb-20 md:px-6">
        <motion.div {...fadeUp} className="mb-10">
          <h2 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">Build faster, keep control</h2>
        </motion.div>
        <div className="grid gap-4 md:grid-cols-3">
          {featureCards.map((feature, idx) => (
            <motion.div key={feature.title} {...fadeUp} transition={{ ...fadeUp.transition, delay: idx * 0.06 }} whileHover={{ y: -4 }}>
              <Card className="h-full rounded-2xl border border-[#2c3b67] bg-[#101a34]/85">
                <CardHeader>
                  <CardTitle className="text-xl font-semibold text-white">{feature.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-sm leading-relaxed text-[#a8b7df]">{feature.text}</CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      <section id="workflow" className="mx-auto w-full max-w-[1280px] px-4 pb-20 md:px-6">
        <motion.div {...fadeUp} className="rounded-3xl border border-[#2c3b67] bg-[#0f1934]/90 p-6 md:p-10">
          <h3 className="text-2xl font-semibold text-white md:text-3xl">From idea to scene in minutes</h3>
          <div className="mt-7 grid gap-3 md:grid-cols-2">
            {workflowSteps.map((step, i) => (
              <div key={step} className="rounded-xl border border-[#2f3f68] bg-[#121f42]/80 p-4 text-sm text-[#a8b7df]">
                <span className="mr-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#243f3a] text-xs font-semibold text-[#58d8ad]">
                  {i + 1}
                </span>
                {step}
              </div>
            ))}
          </div>
        </motion.div>
      </section>

      <section id="gallery" className="mx-auto w-full max-w-[1280px] px-4 pb-24 md:px-6">
        <motion.h3 {...fadeUp} className="mb-4 text-2xl font-semibold text-white md:text-3xl">
          {isAuthenticated ? "Project gallery" : "Demo gallery"}
        </motion.h3>

        {isAuthenticated ? (
          userProjects.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {userProjects.map((project) => (
                <button
                  key={`landing-gallery-${project.id}`}
                  type="button"
                  onClick={() => router.push(`/app/p/${project.id}/canvas`)}
                  className="group overflow-hidden rounded-2xl border border-[#2c3b67] bg-[#101a34]/85 text-left motion-fast hover:border-[#4a63a5] hover:bg-[#152347]"
                >
                  <div className="relative aspect-[4/3] overflow-hidden border-b border-[#2f3f68] bg-[#0d1733]">
                    {project.previewStorageKey ? (
                      <img
                        src={`/api/storage/object?key=${encodeURIComponent(project.previewStorageKey)}`}
                        alt={`${project.name} preview`}
                        loading="lazy"
                        className="h-full w-full object-cover motion-panel group-hover:scale-[1.035]"
                      />
                    ) : (
                      <div className="h-full w-full bg-[linear-gradient(135deg,rgba(43,86,123,0.55),rgba(36,47,88,0.5),rgba(23,89,77,0.45))]" />
                    )}
                  </div>
                  <div className="px-3 py-2.5">
                    <p className="line-clamp-1 text-sm font-semibold text-[#d4def8]">{project.name}</p>
                    <p className="mt-1 text-[11px] text-[#9ab0e0]">{project.runs} runs</p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-[#3c507f] bg-[#0c1631]/70 p-8 text-center text-[#9ab0e0]">
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
                        ? "border-[#58d8ad]/70 bg-[#164139]/70 text-[#58d8ad]"
                        : "border-[#34456f] bg-[#111c38]/80 text-[#a8b7df] hover:border-[#43588b] hover:bg-[#17254a]"
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
                    className="group overflow-hidden rounded-2xl border border-[#2c3b67] bg-[#101a34]/85"
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
                        className={`h-full w-full object-cover transition duration-300 ease-out group-hover:scale-[1.035] ${
                          loadedCards[item.src] ? "opacity-100" : "opacity-0"
                        }`}
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2 border-t border-[#2f3f68] px-3 py-2.5">
                      <p className="truncate text-sm text-[#d4def8]">{item.title}</p>
                      <span className="rounded-full border border-[#3f5282] bg-[#16274f]/70 px-2 py-0.5 text-[10px] text-[#9ab0e0]">
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
