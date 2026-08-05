import assert from "node:assert/strict";
import test from "node:test";

import { runManagedProcess } from "@/lib/execution/process";

test("managed process captures successful output", async () => {
  const result = await runManagedProcess({
    command: "/bin/sh",
    args: ["-c", "printf ok"],
    cwd: process.cwd(),
    label: "test process",
    timeoutMs: 5000
  });
  assert.equal(result.stdout, "ok");
});
