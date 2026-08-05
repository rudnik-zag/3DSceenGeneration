import { spawn } from "node:child_process";

interface ManagedProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  isCancellationRequested?: () => Promise<boolean>;
}

function appendBounded(current: string, chunk: Buffer | string, maxBytes: number) {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next) <= maxBytes) return next;
  return Buffer.from(next).subarray(-maxBytes).toString();
}

function signalProcess(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
    } else {
      process.kill(pid, signal);
    }
  } catch {
    // Process already exited.
  }
}

export async function runManagedProcess(options: ManagedProcessOptions) {
  const maxOutputBytes = Math.max(64 * 1024, options.maxOutputBytes ?? 1024 * 1024);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : 300_000;
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    let terminationReason: string | null = null;
    let finished = false;

    const terminate = (reason: string) => {
      if (finished || terminationReason) return;
      terminationReason = reason;
      signalProcess(child.pid, "SIGTERM");
      setTimeout(() => signalProcess(child.pid, "SIGKILL"), 5000).unref();
    };

    const timeout = setTimeout(
      () => terminate(`${options.label} timed out after ${Math.round(timeoutMs / 1000)}s`),
      Math.max(1000, timeoutMs)
    );
    timeout.unref();

    const cancellationPoll = options.isCancellationRequested
      ? setInterval(() => {
          void options.isCancellationRequested?.().then((canceled) => {
            if (canceled) terminate(`${options.label} canceled by user`);
          }).catch(() => undefined);
        }, 1000)
      : null;
    cancellationPoll?.unref();

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes);
    });
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (cancellationPoll) clearInterval(cancellationPoll);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (cancellationPoll) clearInterval(cancellationPoll);
      if (terminationReason) {
        reject(new Error(terminationReason));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${options.label} failed (exit=${code}, signal=${signal ?? "none"})\nstderr: ${stderr}`));
      }
    });
  });
}
