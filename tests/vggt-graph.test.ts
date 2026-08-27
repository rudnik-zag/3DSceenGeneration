import assert from "node:assert/strict";
import test from "node:test";

import { validateConnectionByNodeTypes } from "@/lib/graph/connection-rules";
import { parseGraphDocument } from "@/lib/graph/plan";

test("graph parser applies VGGT defaults", () => {
  const parsed = parseGraphDocument({
    nodes: [
      {
        id: "vggt-1",
        type: "geo.vggt",
        position: { x: 0, y: 0 },
        data: { label: "VGGT", params: {} }
      }
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  });

  assert.equal(parsed.nodes[0]?.data.params.device, "auto");
  assert.equal(parsed.nodes[0]?.data.params.videoFps, "1.0");
  assert.equal(parsed.nodes[0]?.data.params.maxFrames, 32);
  assert.equal(parsed.nodes[0]?.data.params.saveNpz, false);
});

test("graph allows input video to feed VGGT", () => {
  const result = validateConnectionByNodeTypes({
    sourceNodeType: "input.video",
    sourceHandleId: "video",
    targetNodeType: "geo.vggt",
    targetHandleId: "video"
  });

  assert.equal(result.valid, true);
  assert.equal(result.sourceHandleId, "video");
  assert.equal(result.targetHandleId, "video");
});

test("graph allows VGGT outputs to feed depth-to-pointcloud", () => {
  const depthResult = validateConnectionByNodeTypes({
    sourceNodeType: "geo.vggt",
    sourceHandleId: "depth",
    targetNodeType: "geo.pointcloud_from_depth",
    targetHandleId: "depth"
  });
  const cameraResult = validateConnectionByNodeTypes({
    sourceNodeType: "geo.vggt",
    sourceHandleId: "camera",
    targetNodeType: "geo.pointcloud_from_depth",
    targetHandleId: "camera"
  });

  assert.equal(depthResult.valid, true);
  assert.equal(cameraResult.valid, true);
});
