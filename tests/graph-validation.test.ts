import assert from "node:assert/strict";
import test from "node:test";

import { parseGraphDocument } from "@/lib/graph/plan";

function graphWithNode(params: Record<string, unknown> = {}) {
  return {
    nodes: [
      {
        id: "image-1",
        type: "input.image",
        position: { x: 0, y: 0 },
        data: { label: "Image", params }
      }
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  };
}

test("graph parser applies validated defaults", () => {
  const parsed = parseGraphDocument(graphWithNode());
  assert.equal(parsed.nodes[0]?.data.params.sourceMode, "upload");
});

test("graph parser rejects invalid model parameters", () => {
  assert.throws(
    () => parseGraphDocument(graphWithNode({ width: 99999 })),
    /Invalid parameters/
  );
});

test("graph parser rejects duplicate node ids", () => {
  const graph = graphWithNode();
  graph.nodes.push({ ...graph.nodes[0] });
  assert.throws(() => parseGraphDocument(graph), /duplicate graph node id/i);
});

test("graph parser preserves legacy Comfy seeds within the safe integer range", () => {
  const seed = 865_377_458_751_032;
  const parsed = parseGraphDocument({
    nodes: [
      {
        id: "qwen-edit-1",
        type: "model.qwen_image_edit",
        position: { x: 0, y: 0 },
        data: { label: "Qwen Image Edit", params: { seed } }
      }
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  });
  assert.equal(parsed.nodes[0]?.data.params.seed, seed);
});
