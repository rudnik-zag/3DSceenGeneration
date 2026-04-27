import { mkdir, readFile, readdir, unlink, writeFile } from "fs/promises";
import { constants as fsConstants } from "fs";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

type ComfyMode = "on_demand" | "always_on";
type ManagedComfyProcessRef = {
  pid: number;
  pgid: number | null;
};

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

function resolveBaseUrlPort() {
  try {
    const parsed = new URL(resolveBaseUrl());
    if (parsed.port) {
      const explicit = Number(parsed.port);
      if (Number.isInteger(explicit) && explicit > 0) return explicit;
    }
    if (parsed.protocol === "https:") return 443;
    if (parsed.protocol === "http:") return 80;
  } catch {
    // ignore and use default
  }
  return 8188;
}

function resolveAdoptExistingProcess() {
  const raw = (process.env.COMFYUI_ON_DEMAND_ADOPT_EXISTING ?? "true").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
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

function processGroupExists(pgid: number) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function resolveProcessGroupId(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0 || closeParen + 2 >= stat.length) return null;
    const suffix = stat.slice(closeParen + 2).trim();
    const parts = suffix.split(/\s+/);
    const pgrp = Number(parts[2] ?? "");
    if (!Number.isInteger(pgrp) || pgrp <= 0) return null;
    return pgrp;
  } catch {
    return null;
  }
}

function normalizeManagedRef(candidate: { pid: number; pgid?: number | null }): ManagedComfyProcessRef | null {
  const pid = Number(candidate.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const pgidRaw = candidate.pgid;
  const pgid = Number.isInteger(pgidRaw) && pgidRaw && pgidRaw > 0 ? pgidRaw : null;
  return { pid, pgid };
}

async function readPidFile(pidFile: string): Promise<ManagedComfyProcessRef | null> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    if (!raw) return null;
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as { pid?: number; pgid?: number | null };
      return normalizeManagedRef({
        pid: Number(parsed.pid),
        pgid: parsed.pgid ?? null
      });
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return {
      pid: parsed,
      pgid: parsed
    };
  } catch {
    return null;
  }
}

async function writePidFile(pidFile: string, ref: ManagedComfyProcessRef) {
  await mkdir(path.dirname(pidFile), { recursive: true });
  await writeFile(pidFile, `${JSON.stringify(ref)}\n`, "utf8");
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

async function findComfyProcessPidByPort(port: number): Promise<number | null> {
  let procEntries: string[] = [];
  try {
    procEntries = await readdir("/proc");
  } catch {
    return null;
  }

  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;

    let cmdline = "";
    try {
      cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!cmdline) continue;
    const args = cmdline.split("\u0000").filter(Boolean);
    if (args.length === 0) continue;
    if (!args.some((arg) => arg.endsWith("python") || arg.endsWith("python3") || arg.includes("/python"))) continue;
    if (!args.some((arg) => arg.includes("main.py"))) continue;

    const portIdx = args.findIndex((arg) => arg === "--port");
    if (portIdx < 0) continue;
    const portArg = args[portIdx + 1] ?? "";
    if (Number(portArg) !== port) continue;
    return pid;
  }

  return null;
}

async function adoptReachableComfyProcessIfNeeded() {
  if (!resolveAdoptExistingProcess()) return;
  const pidFile = resolveManagedPidFile();
  const existingRef = await readPidFile(pidFile);
  if (existingRef && (processExists(existingRef.pid) || (existingRef.pgid && processGroupExists(existingRef.pgid)))) {
    return;
  }
  if (!(await isComfyReachable())) return;

  const adoptedPid = await findComfyProcessPidByPort(resolveBaseUrlPort());
  if (!adoptedPid) return;
  const adoptedPgid = await resolveProcessGroupId(adoptedPid);
  await writePidFile(pidFile, {
    pid: adoptedPid,
    pgid: adoptedPgid
  });
}

async function startManagedComfyProcess() {
  const pidFile = resolveManagedPidFile();
  const existingRef = await readPidFile(pidFile);
  if (existingRef && (processExists(existingRef.pid) || (existingRef.pgid && processGroupExists(existingRef.pgid)))) return;
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

  await writePidFile(pidFile, {
    pid: child.pid,
    pgid: child.pid
  });

  const startedAt = Date.now();
  const timeoutMs = resolveStartTimeoutMs();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isComfyReachable()) return;
    await sleep(1000);
  }

  await stopManagedComfyProcess();
  throw new Error(`ComfyUI did not become reachable within ${Math.round(timeoutMs / 1000)}s.`);
}

async function terminateManagedRef(ref: ManagedComfyProcessRef, signal: NodeJS.Signals) {
  let sent = false;
  if (ref.pgid && ref.pgid > 0) {
    try {
      process.kill(-ref.pgid, signal);
      sent = true;
    } catch {
      // ignore and fallback to pid
    }
  }
  if (!sent) {
    try {
      process.kill(ref.pid, signal);
      sent = true;
    } catch {
      // ignore
    }
  }
  return sent;
}

function managedRefAlive(ref: ManagedComfyProcessRef) {
  if (ref.pgid && processGroupExists(ref.pgid)) return true;
  return processExists(ref.pid);
}

export async function stopManagedComfyProcess() {
  const pidFile = resolveManagedPidFile();
  let ref = await readPidFile(pidFile);
  if (!ref) {
    const adoptedPid = await findComfyProcessPidByPort(resolveBaseUrlPort());
    if (!adoptedPid) {
      await removePidFile(pidFile);
      return;
    }
    ref = {
      pid: adoptedPid,
      pgid: await resolveProcessGroupId(adoptedPid)
    };
  }

  await terminateManagedRef(ref, "SIGTERM");

  for (let i = 0; i < 20; i += 1) {
    if (!managedRefAlive(ref)) {
      await removePidFile(pidFile);
      return;
    }
    await sleep(250);
  }

  await terminateManagedRef(ref, "SIGKILL");
  await removePidFile(pidFile);
}

async function ensureComfyReadyOnDemand() {
  if (await isComfyReachable()) {
    await adoptReachableComfyProcessIfNeeded();
    return;
  }
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
