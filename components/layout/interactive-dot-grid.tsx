"use client";

import { useEffect, useRef } from "react";

type Dot = {
  baseX: number;
  baseY: number;
  x: number;
  y: number;
  phase: number;
};

const GRID_SIZE = 24;
const INTERACTION_RADIUS = 150;
const MAX_DISPLACEMENT = 9;
const BASE_ALPHA = 0.055;
const ACTIVE_ALPHA = 0.2;

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function InteractiveDotGrid() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || prefersReducedMotion()) return;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    let animationFrame = 0;
    let width = 0;
    let height = 0;
    let devicePixelRatio = 1;
    let dots: Dot[] = [];
    const pointer = {
      x: -10_000,
      y: -10_000,
      targetX: -10_000,
      targetY: -10_000,
      active: false
    };

    const buildDots = () => {
      dots = [];
      const columns = Math.ceil(width / GRID_SIZE) + 2;
      const rows = Math.ceil(height / GRID_SIZE) + 2;

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const baseX = column * GRID_SIZE - GRID_SIZE / 2;
          const baseY = row * GRID_SIZE - GRID_SIZE / 2;
          dots.push({
            baseX,
            baseY,
            x: baseX,
            y: baseY,
            phase: (row * 0.31 + column * 0.17) % Math.PI
          });
        }
      }
    };

    const resize = () => {
      devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * devicePixelRatio);
      canvas.height = Math.floor(height * devicePixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      buildDots();
    };

    const draw = (time: number) => {
      pointer.x += (pointer.targetX - pointer.x) * 0.16;
      pointer.y += (pointer.targetY - pointer.y) * 0.16;

      context.clearRect(0, 0, width, height);

      for (const dot of dots) {
        const dx = dot.baseX - pointer.x;
        const dy = dot.baseY - pointer.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const influence = pointer.active ? Math.max(0, 1 - distance / INTERACTION_RADIUS) : 0;
        const wave = Math.sin(distance * 0.055 - time * 0.006 + dot.phase);
        const angle = Math.atan2(dy, dx);
        const displacement = influence * MAX_DISPLACEMENT * (0.45 + wave * 0.55);
        const targetX = dot.baseX + Math.cos(angle) * displacement;
        const targetY = dot.baseY + Math.sin(angle) * displacement;

        dot.x += (targetX - dot.x) * 0.2;
        dot.y += (targetY - dot.y) * 0.2;

        const alpha = BASE_ALPHA + influence * ACTIVE_ALPHA;
        const radius = 1 + influence * 0.85;
        context.beginPath();
        context.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
        context.arc(dot.x, dot.y, radius, 0, Math.PI * 2);
        context.fill();
      }

      animationFrame = window.requestAnimationFrame(draw);
    };

    const handlePointerMove = (event: PointerEvent) => {
      pointer.targetX = event.clientX;
      pointer.targetY = event.clientY;
      pointer.active = true;
    };

    const handlePointerLeave = () => {
      pointer.active = false;
      pointer.targetX = -10_000;
      pointer.targetY = -10_000;
    };

    resize();
    animationFrame = window.requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("blur", handlePointerLeave);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("blur", handlePointerLeave);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 opacity-100"
    />
  );
}
