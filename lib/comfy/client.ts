import { randomUUID } from "crypto";

export interface ComfyClientOptions {
  baseUrl: string;
  authToken?: string | null;
  timeoutMs?: number;
}

export interface ComfyPromptResult {
  promptId: string;
}

export interface ComfyImageRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

export interface ComfyHistoryOutputNode {
  images?: ComfyImageRef[];
}

export interface ComfyHistoryEntry {
  outputs?: Record<string, ComfyHistoryOutputNode>;
  status?: {
    status_str?: string;
    messages?: unknown[];
  };
}

type JsonObject = Record<string, unknown>;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return fallback;
  const maybeError = payload as Record<string, unknown>;
  const errorValue = maybeError.error;
  if (typeof errorValue === "string" && errorValue.trim().length > 0) return errorValue.trim();
  const messageValue = maybeError.message;
  if (typeof messageValue === "string" && messageValue.trim().length > 0) return messageValue.trim();
  return fallback;
}

export class ComfyClient {
  private readonly baseUrl: string;
  private readonly authToken: string | null;
  private readonly timeoutMs: number;

  constructor(options: ComfyClientOptions) {
    this.baseUrl = trimTrailingSlash(options.baseUrl);
    this.authToken = options.authToken?.trim() ? options.authToken.trim() : null;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1000, Number(options.timeoutMs)) : 180_000;
  }

  private buildUrl(path: string) {
    if (!path.startsWith("/")) return `${this.baseUrl}/${path}`;
    return `${this.baseUrl}${path}`;
  }

  private buildHeaders(extra?: Record<string, string>) {
    const headers: Record<string, string> = { ...(extra ?? {}) };
    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  private async fetchWithTimeout(url: string, init: RequestInit) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async uploadImage(params: {
    buffer: Buffer;
    filename: string;
    type?: "input" | "output" | "temp";
    overwrite?: boolean;
    subfolder?: string;
  }): Promise<ComfyImageRef> {
    const form = new FormData();
    const contentType = params.filename.toLowerCase().endsWith(".png")
      ? "image/png"
      : params.filename.toLowerCase().endsWith(".webp")
        ? "image/webp"
        : "image/jpeg";
    const binary = Uint8Array.from(params.buffer);
    const blob = new Blob([binary.buffer], { type: contentType });
    form.append("image", blob, params.filename);
    form.append("type", params.type ?? "input");
    if (params.overwrite) form.append("overwrite", "1");
    if (params.subfolder && params.subfolder.trim().length > 0) form.append("subfolder", params.subfolder.trim());

    const response = await this.fetchWithTimeout(this.buildUrl("/upload/image"), {
      method: "POST",
      body: form,
      headers: this.buildHeaders()
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(toErrorMessage(payload, `Comfy upload failed (${response.status})`));
    }
    const payload = (await response.json()) as { name?: string; subfolder?: string; type?: string };
    if (!payload?.name || typeof payload.name !== "string") {
      throw new Error("Comfy upload response is missing uploaded filename.");
    }
    return {
      filename: payload.name,
      subfolder: typeof payload.subfolder === "string" ? payload.subfolder : "",
      type: typeof payload.type === "string" ? payload.type : params.type ?? "input"
    };
  }

  async queuePrompt(prompt: JsonObject, extraData?: JsonObject): Promise<ComfyPromptResult> {
    const promptId = randomUUID();
    const payload: Record<string, unknown> = {
      prompt,
      prompt_id: promptId,
      client_id: randomUUID()
    };
    if (extraData && Object.keys(extraData).length > 0) {
      payload.extra_data = extraData;
    }
    const response = await this.fetchWithTimeout(this.buildUrl("/prompt"), {
      method: "POST",
      headers: this.buildHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const responsePayload = await response.json().catch(() => null);
      throw new Error(toErrorMessage(responsePayload, `Comfy queue failed (${response.status})`));
    }
    const responsePayload = (await response.json()) as { prompt_id?: string };
    return { promptId: responsePayload.prompt_id ?? promptId };
  }

  async getHistory(promptId: string): Promise<ComfyHistoryEntry | null> {
    const response = await this.fetchWithTimeout(this.buildUrl(`/history/${encodeURIComponent(promptId)}`), {
      method: "GET",
      headers: this.buildHeaders()
    });
    if (!response.ok) {
      throw new Error(`Comfy history fetch failed (${response.status})`);
    }
    const payload = (await response.json()) as Record<string, ComfyHistoryEntry> | ComfyHistoryEntry | null;
    if (!payload) return null;
    if (payload && typeof payload === "object" && !Array.isArray(payload) && promptId in payload) {
      return (payload as Record<string, ComfyHistoryEntry>)[promptId] ?? null;
    }
    return payload as ComfyHistoryEntry;
  }

  async waitForPromptCompletion(params: {
    promptId: string;
    pollIntervalMs?: number;
    maxWaitMs?: number;
  }): Promise<ComfyHistoryEntry> {
    const pollIntervalMs = Number.isFinite(params.pollIntervalMs) ? Math.max(200, Number(params.pollIntervalMs)) : 1200;
    const maxWaitMs = Number.isFinite(params.maxWaitMs) ? Math.max(1000, Number(params.maxWaitMs)) : 600_000;
    const startedAt = Date.now();

    while (Date.now() - startedAt < maxWaitMs) {
      const entry = await this.getHistory(params.promptId);
      if (entry) {
        const status = entry.status?.status_str?.toLowerCase() ?? "";
        if (status.includes("error") || status.includes("failed")) {
          throw new Error(`Comfy prompt failed (prompt_id=${params.promptId}, status=${entry.status?.status_str ?? "unknown"})`);
        }
        if (entry.outputs && Object.keys(entry.outputs).length > 0) {
          return entry;
        }
      }
      await sleep(pollIntervalMs);
    }

    throw new Error(`Comfy prompt timed out after ${Math.round(maxWaitMs / 1000)}s (prompt_id=${params.promptId}).`);
  }

  async downloadImage(image: ComfyImageRef): Promise<{ buffer: Buffer; contentType: string }> {
    const params = new URLSearchParams();
    params.set("filename", image.filename);
    if (image.subfolder && image.subfolder.length > 0) params.set("subfolder", image.subfolder);
    if (image.type && image.type.length > 0) params.set("type", image.type);
    const response = await this.fetchWithTimeout(this.buildUrl(`/view?${params.toString()}`), {
      method: "GET",
      headers: this.buildHeaders()
    });
    if (!response.ok) {
      throw new Error(`Comfy image download failed (${response.status}) for ${image.filename}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "image/png";
    return { buffer: bytes, contentType };
  }

  static pickFirstImageFromHistory(entry: ComfyHistoryEntry, preferredNodeId?: string | null): ComfyImageRef | null {
    if (!entry.outputs || Object.keys(entry.outputs).length === 0) return null;
    if (preferredNodeId && entry.outputs[preferredNodeId]?.images?.length) {
      return entry.outputs[preferredNodeId].images?.[0] ?? null;
    }

    for (const outputNode of Object.values(entry.outputs)) {
      if (!outputNode?.images || outputNode.images.length === 0) continue;
      return outputNode.images[0] ?? null;
    }
    return null;
  }
}
