import assert from "node:assert/strict";
import test from "node:test";

import { buildExecutionPlan, parseGraphDocument } from "@/lib/graph/plan";

function buildSceneGraph() {
  return parseGraphDocument({
    nodes: [
      {
        id: "input1",
        type: "input.image",
        position: { x: 0, y: 0 },
        data: { label: "Input", params: { filename: "image.png", storageKey: "projects/demo/uploads/image.png" } }
      },
      {
        id: "segment1",
        type: "model.sam2",
        position: { x: 240, y: 0 },
        data: { label: "Segment", params: {} }
      },
      {
        id: "scene1",
        type: "model.sam3d_objects",
        position: { x: 480, y: 0 },
        data: { label: "Scene", params: {} }
      }
    ],
    edges: [
      { id: "e1", source: "input1", target: "segment1", sourceHandle: "image", targetHandle: "image" },
      { id: "e2", source: "segment1", target: "scene1", sourceHandle: "config", targetHandle: "config" }
    ],
    viewport: { x: 0, y: 0, zoom: 1 }
  });
}

test("execution plan includes ancestors for start node by default", () => {
  const graph = buildSceneGraph();
  const plan = buildExecutionPlan(graph, "scene1");

  assert.deepEqual(
    plan.tasks.map((task) => task.nodeId),
    ["input1", "segment1", "scene1"]
  );
});

test("execution plan can target only the requested node", () => {
  const graph = buildSceneGraph();
  const plan = buildExecutionPlan(graph, "scene1", { includeAncestors: false });

  assert.deepEqual(
    plan.tasks.map((task) => task.nodeId),
    ["scene1"]
  );
  assert.equal(plan.tasks[0]?.dependsOn.length, 0);
  assert.equal(plan.tasks[0]?.inputBindings.length, 1);
  assert.equal(plan.tasks[0]?.inputBindings[0]?.sourceNodeId, "segment1");
  assert.equal(plan.tasks[0]?.inputBindings[0]?.sourceOutputId, "config");
});
