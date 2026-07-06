import assert from "node:assert/strict";
import test from "node:test";

import { ComfyClient } from "@/lib/comfy/client";

test("Comfy polling removes a queued prompt when canceled", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: typeof init?.body === "string" ? init.body : null
    });
    return new Response(null, { status: 200 });
  };

  try {
    const client = new ComfyClient({ baseUrl: "http://comfy.test", timeoutMs: 1000 });
    await assert.rejects(
      client.waitForPromptCompletion({
        promptId: "prompt-1",
        isCancellationRequested: async () => true
      }),
      /canceled by user/
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, "http://comfy.test/queue");
    assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), { delete: ["prompt-1"] });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
