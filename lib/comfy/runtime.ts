import { mkdir, readFile, unlink, writeFile } from "fs/promises";
import { constants as fsConstants } from "fs";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

type ComfyMode = "on_demand" | "always_on";

let activeComfyJobs = 0;
let idleStopTimer: NodeJS.Timeout | null = null;
let startingPromise: Promise<void> | null = null;

function resolveMode(): ComfyMode {
  const raw = (process.env.COMFYUI_MODE ?? "on_demand").trim().toLowerCase();
  return raw === "always_on" ? "always_on" : "on_demand";
}

function isComfyEnabled() {
  const raw = (process.env.COMFYUI_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveBaseUrl() {
  return (process.env.COMFYUI_BASE_URL ?? "http://127.0.0.1:8188").trim().replace(/\/+$/, "");
}

function resolveIdleMs() {
  const raw = Number(process.env.COMFYUI_ON_DEMAND_IDLE_MS ?? 15_000);
  if (!Number.isFinite(raw)) return 15_000;
  return Math.max(0, Math.min(30 * 60 * 1000, Math.round(raw)));
}

function resolveStartTimeoutMs() {
  const raw = Number(process.env.COMFYUI_START_TIMEOUT_MS ?? 120_000);
  if (!Number.isFinite(raw)) return 120_000;
  return Math.max(10_000, Math.min(10 * 60 * 1000, Math.round(raw)));
}

function resolveRootDir() {
  return process.cwd();
}

function resolveRunDir() {
  return path.join(resolveRootDir(), ".run");
}

function resolvePidDir() {
  return path.join(resolveRunDir(), "pids");
}

function resolveLogDir() {
  return path.join(resolveRunDir(), "logs");
}

function resolveManagedPidFile() {
  return path.join(resolvePidDir(), "comfyui-ondemand.pid");
}

function resolveManagedLogFile() {
  return path.join(resolveLogDir(), "comfyui.log");
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPidFile(pidFile: string): Promise<number | null> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    if (!raw) return null;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writePidFile(pidFile: string, pid: number) {
  await mkdir(path.dirname(pidFile), { recursive: true });
  await writeFile(pidFile, `${pid}\n`, "utf8");
}

async function removePidFile(pidFile: string) {
  try {
    await unlink(pidFile);
  } catch {
    // ignore
  }
}

async function isComfyReachable(timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${resolveBaseUrl()}/system_stats`, {
      method: "GET",
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function startManagedComfyProcess() {
  const pidFile = resolveManagedPidFile();
  const existingPid = await readPidFile(pidFile);
  if (existingPid && processExists(existingPid)) return;
  if (await isComfyReachable()) return;

  await mkdir(resolvePidDir(), { recursive: true });
  await mkdir(resolveLogDir(), { recursive: true });

  const logFile = resolveManagedLogFile();
  const outFd = fs.openSync(logFile, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o644);
  const errFd = fs.openSync(logFile, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o644);

  const child = spawn("bash", ["scripts/comfyui-start.sh"], {
    cwd: resolveRootDir(),
    env: process.env,
    detached: true,
    stdio: ["ignore", outFd, errFd]
  });
  if (!child.pid) {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    throw new Error("Failed to start ComfyUI process.");
  }
  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  await writePidFile(pidFile, child.pid);

  const startedAt = Date.now();
  const timeoutMs = resolveStartTimeoutMs();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isComfyReachable()) return;
    await sleep(1000);
  }

  await stopManagedComfyProcess();
  throw new Error(`ComfyUI did not become reachable within ${Math.round(timeoutMs / 1000)}s.`);
}

export async function stopManagedComfyProcess() {
  const pidFile = resolveManagedPidFile();
  const pid = await readPidFile(pidFile);
  if (!pid) {
    await removePidFile(pidFile);
    return;
  }
  if (!processExists(pid)) {
    await removePidFile(pidFile);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    await removePidFile(pidFile);
    return;
  }

  for (let i = 0; i < 20; i += 1) {
    if (!processExists(pid)) {
      await removePidFile(pidFile);
      return;
    }
    await sleep(250);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // ignore
  }
  await removePidFile(pidFile);
}

async function ensureComfyReadyOnDemand() {
  if (await isComfyReachable()) return;
  if (startingPromise) {
    await startingPromise;
    return;
  }
  startingPromise = (async () => {
    if (await isComfyReachable()) return;
    await startManagedComfyProcess();
  })();
  try {
    await startingPromise;
  } finally {
    startingPromise = null;
  }
}

function scheduleIdleStop() {
  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
  }
  if (activeComfyJobs > 0) return;
  const idleMs = resolveIdleMs();
  if (idleMs <= 0) {
    void stopManagedComfyProcess();
    return;
  }
  idleStopTimer = setTimeout(() => {
    idleStopTimer = null;
    if (activeComfyJobs === 0) {
      void stopManagedComfyProcess();
    }
  }, idleMs);
  idleStopTimer.unref();
}

export async function withComfyRuntime<T>(fn: () => Promise<T>): Promise<T> {
  if (!isComfyEnabled()) return fn();

  if (resolveMode() === "always_on") {
    return fn();
  }

  if (idleStopTimer) {
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
  }
  activeComfyJobs += 1;
  try {
    await ensureComfyReadyOnDemand();
    return await fn();
  } finally {
    activeComfyJobs = Math.max(0, activeComfyJobs - 1);
    scheduleIdleStop();
  }
}
