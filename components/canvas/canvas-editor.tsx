"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  Edge,
  MiniMap,
  Node,
  OnConnect,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useEdgesState,
  useNodesState
} from "reactflow";
import "reactflow/dist/style.css";
import {
  Boxes,
  Camera,
  ExternalLink,
  Image as ImageIcon,
  LocateFixed,
  Map,
  Minus,
  PanelLeft,
  Play,
  Plus,
  Save,
  Scan,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Type,
  WandSparkles,
  Zap,
  ZoomIn
} from "lucide-react";

import { WorkflowNode } from "@/components/canvas/workflow-node";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { nodeGroups, nodeSpecRegistry } from "@/lib/graph/node-specs";
import { GraphDocument, GraphNodeData, NodeUiScale, WorkflowNodeType } from "@/types/workflow";

interface GraphVersion {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  graphJson: GraphDocument;
}

interface NodeArtifact {
  id: string;
  nodeId: string;
  kind: string;
}

interface CanvasEditorProps {
  projectId: string;
  projectName: string;
  initialGraph: GraphDocument;
  versions: GraphVersion[];
  nodeArtifacts: NodeArtifact[];
}

interface PaneContextMenuState {
  x: number;
  y: number;
  flowX: number;
  flowY: number;
}

type ContextMenuCategory = "Inputs" | "Models" | "Geometry" | "Outputs";

const nodeTypes = {
  "input.image": WorkflowNode,
  "input.text": WorkflowNode,
  "input.cameraPath": WorkflowNode,
  "model.groundingdino": WorkflowNode,
  "model.sam2": WorkflowNode,
  "model.sam3d_objects": WorkflowNode,
  "model.qwen_vl": WorkflowNode,
  "model.qwen_image_edit": WorkflowNode,
  "model.texturing": WorkflowNode,
  "geo.depth_estimation": WorkflowNode,
  "geo.pointcloud_from_depth": WorkflowNode,
  "geo.mesh_reconstruction": WorkflowNode,
  "geo.uv_unwrap": WorkflowNode,
  "geo.bake_textures": WorkflowNode,
  "out.export_scene": WorkflowNode,
  "out.open_in_viewer": WorkflowNode
};

const shortcutByNodeType: Partial<Record<WorkflowNodeType, string>> = {
  "input.text": "T",
  "input.image": "I",
  "input.cameraPath": "C",
  "model.groundingdino": "G",
  "model.sam2": "S",
  "model.sam3d_objects": "3",
  "model.qwen_vl": "Q",
  "model.qwen_image_edit": "E",
  "model.texturing": "X",
  "geo.depth_estimation": "D",
  "geo.pointcloud_from_depth": "P",
  "geo.mesh_reconstruction": "M",
  "geo.uv_unwrap": "U",
  "geo.bake_textures": "B",
  "out.export_scene": "O",
  "out.open_in_viewer": "V"
};

const categoryLabelMap: Record<ContextMenuCategory, string> = {
  Inputs: "Add Source",
  Models: "Add Model",
  Geometry: "Add Geometry",
  Outputs: "Add Output"
};

function getContextRowIcon(type: WorkflowNodeType) {
  if (type.startsWith("input.text")) return Type;
  if (type.startsWith("input.image")) return ImageIcon;
  if (type.startsWith("input.cameraPath")) return Camera;
  if (type.startsWith("model.groundingdino")) return Scan;
  if (type.startsWith("model.sam")) return Boxes;
  if (type.startsWith("model.")) return WandSparkles;
  if (type.startsWith("out.")) return ExternalLink;
  if (type.startsWith("geo.")) return Sparkles;
  return Sparkles;
}

function buildNodeData(base: Node<GraphNodeData>, artifacts: NodeArtifact[]) {
  const artifact = artifacts.find((a) => a.nodeId === base.id);
  return {
    ...base,
    data: {
      ...base.data,
      status: base.data.status ?? "idle",
      latestArtifactId: artifact?.id,
      latestArtifactKind: artifact?.kind,
      uiScale: base.data.uiScale ?? "balanced"
    }
  };
}

function withStyledEdge(edge: Edge): Edge {
  return {
    ...edge,
    type: edge.type ?? "smoothstep",
    animated: edge.animated ?? true,
    style: {
      stroke: "rgba(176, 191, 221, 0.42)",
      strokeWidth: 1.45,
      ...(edge.style ?? {})
    }
  };
}

function GraphCanvasInner({ projectId, projectName, initialGraph, versions: initialVersions, nodeArtifacts }: CanvasEditorProps) {
  const reactFlow = useReactFlow();
  const wrappedNodes = initialGraph.nodes.map((n) => buildNodeData(n as Node<GraphNodeData>, nodeArtifacts));
  const wrappedEdges = initialGraph.edges.map((edge) => withStyledEdge(edge as Edge));

  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNodeData>(wrappedNodes as Node<GraphNodeData>[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(wrappedEdges);
  const [versions, setVersions] = useState(initialVersions);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [nodeScalePreset, setNodeScalePreset] = useState<NodeUiScale>("balanced");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState(versions[0]?.id ?? "");
  const [runLogs, setRunLogs] = useState("");
  const [selectedArtifactPreview, setSelectedArtifactPreview] = useState<{ previewUrl: string | null; jsonSnippet: string | null }>({
    previewUrl: null,
    jsonSnippet: null
  });
  const [paneMenu, setPaneMenu] = useState<PaneContextMenuState | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const runPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasPanelRef = useRef<HTMLDivElement>(null);
  const paneMenuRef = useRef<HTMLDivElement>(null);

  const selectedNode = useMemo(() => nodes.find((n) => n.selected), [nodes]);
  const orderedCategories = useMemo<ContextMenuCategory[]>(() => ["Inputs", "Models", "Geometry", "Outputs"], []);
  const contextMenuGroups = useMemo(
    () =>
      orderedCategories
        .map((category) => ({
          category,
          specs: [...(nodeGroups[category] ?? [])].sort((a, b) => a.title.localeCompare(b.title))
        }))
        .filter((group) => group.specs.length > 0),
    [orderedCategories]
  );

  useEffect(() => {
    return () => {
      if (runPollRef.current) {
        clearInterval(runPollRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!paneMenu) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null;
      if (target && paneMenuRef.current?.contains(target)) {
        return;
      }
      setPaneMenu(null);
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPaneMenu(null);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [paneMenu]);

  useEffect(() => {
    const artifactId = selectedNode?.data.latestArtifactId;
    if (!artifactId) {
      setSelectedArtifactPreview({ previewUrl: null, jsonSnippet: null });
      return;
    }

    let mounted = true;

    const load = async () => {
      const metaRes = await fetch(`/api/artifacts/${artifactId}`, { cache: "no-store" });
      if (!metaRes.ok || !mounted) return;
      const meta = await metaRes.json();

      let jsonSnippet: string | null = null;
      const previewUrl = meta.previewUrl ?? (["image", "mask"].includes(meta.artifact.kind) ? meta.url : null);

      if (meta.artifact.kind === "json") {
        const jsonRes = await fetch(meta.url);
        if (jsonRes.ok && mounted) {
          const text = await jsonRes.text();
          jsonSnippet = text.slice(0, 900);
        }
      }

      if (mounted) {
        setSelectedArtifactPreview({ previewUrl, jsonSnippet });
      }
    };

    load().catch(() => {
      if (mounted) {
        setSelectedArtifactPreview({ previewUrl: null, jsonSnippet: null });
      }
    });

    return () => {
      mounted = false;
    };
  }, [selectedNode?.data.latestArtifactId]);

  const onConnect = useCallback<OnConnect>(
    (params) =>
      setEdges((eds) =>
        addEdge(
          withStyledEdge({
            ...params,
            id: `${params.source}-${params.target}-${Date.now()}`
          } as Edge),
          eds
        )
      ),
    [setEdges]
  );

  const addNode = useCallback(
    (nodeType: WorkflowNodeType, x = 80, y = 80) => {
      const spec = nodeSpecRegistry[nodeType];
      const id = `${nodeType}-${Date.now().toString(36)}`;
      const newNode: Node<GraphNodeData> = {
        id,
        type: nodeType,
        position: { x, y },
        data: {
          label: spec.title,
          params: { ...spec.defaultParams },
          status: "idle",
          uiScale: nodeScalePreset
        }
      };
      setNodes((prev) => [...prev, newNode]);
    },
    [nodeScalePreset, setNodes]
  );

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const nodeType = event.dataTransfer.getData("application/reactflow") as WorkflowNodeType;
    if (!nodeType) return;
    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addNode(nodeType, position.x, position.y);
  };

  const onDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const openPaneMenuAtScreenPoint = useCallback(
    (clientX: number, clientY: number, flowOverride?: { x: number; y: number }) => {
      const rect = canvasPanelRef.current?.getBoundingClientRect();
      const flow = flowOverride ?? reactFlow.screenToFlowPosition({ x: clientX, y: clientY });

      if (!rect) {
        setPaneMenu({ x: clientX, y: clientY, flowX: flow.x, flowY: flow.y });
        return;
      }

      const menuWidth = 318;
      const menuHeight = 540;
      const rawX = clientX - rect.left;
      const rawY = clientY - rect.top;
      const x = Math.max(10, Math.min(rawX, rect.width - menuWidth - 10));
      const y = Math.max(10, Math.min(rawY, rect.height - menuHeight - 10));

      setPaneMenu({ x, y, flowX: flow.x, flowY: flow.y });
    },
    [reactFlow]
  );

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      openPaneMenuAtScreenPoint(event.clientX, event.clientY);
    },
    [openPaneMenuAtScreenPoint]
  );

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.detail === 2) {
        openPaneMenuAtScreenPoint(event.clientX, event.clientY);
        return;
      }
      setPaneMenu(null);
    },
    [openPaneMenuAtScreenPoint]
  );

  const addNodeFromContextMenu = useCallback(
    (nodeType: WorkflowNodeType) => {
      if (!paneMenu) return;
      addNode(nodeType, paneMenu.flowX, paneMenu.flowY);
      setPaneMenu(null);
    },
    [addNode, paneMenu]
  );

  useEffect(() => {
    if (!paneMenu) return;

    const onShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isTyping) return;

      const pressed = event.key.toUpperCase();
      const match = (Object.entries(shortcutByNodeType) as Array<[WorkflowNodeType, string]>).find(
        ([, shortcut]) => shortcut.toUpperCase() === pressed
      );

      if (!match) return;
      event.preventDefault();
      addNodeFromContextMenu(match[0]);
    };

    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [paneMenu, addNodeFromContextMenu]);

  const addNodeAtViewportCenter = (nodeType: WorkflowNodeType) => {
    const rect = canvasPanelRef.current?.getBoundingClientRect();
    if (!rect) {
      addNode(nodeType);
      return;
    }

    const flow = reactFlow.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    });
    addNode(nodeType, flow.x, flow.y);
  };

  const applyNodeScalePreset = (preset: NodeUiScale) => {
    setNodeScalePreset(preset);
    setNodes((prev) =>
      prev.map((node) => ({
        ...node,
        data: {
          ...node.data,
          uiScale: preset
        }
      }))
    );
  };

  const openNodeMenuAtViewportCenter = useCallback(() => {
    const rect = canvasPanelRef.current?.getBoundingClientRect();
    if (!rect) {
      openPaneMenuAtScreenPoint(92, 72, { x: 80, y: 80 });
      return;
    }

    const flow = reactFlow.screenToFlowPosition({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2
    });
    openPaneMenuAtScreenPoint(rect.left + 92, rect.top + 72, { x: flow.x, y: flow.y });
  }, [openPaneMenuAtScreenPoint, reactFlow]);

  const insertImagePromptTemplate = useCallback(() => {
    const rect = canvasPanelRef.current?.getBoundingClientRect();
    const anchor = rect
      ? reactFlow.screenToFlowPosition({
          x: rect.left + rect.width * 0.42,
          y: rect.top + rect.height * 0.5
        })
      : { x: 120, y: 120 };

    const imageId = `input.image-${Date.now().toString(36)}`;
    const textId = `input.text-${(Date.now() + 1).toString(36)}`;
    const modelId = `model.qwen_image_edit-${(Date.now() + 2).toString(36)}`;

    const imageSpec = nodeSpecRegistry["input.image"];
    const textSpec = nodeSpecRegistry["input.text"];
    const modelSpec = nodeSpecRegistry["model.qwen_image_edit"];

    const templateNodes: Node<GraphNodeData>[] = [
      {
        id: imageId,
        type: "input.image",
        position: { x: anchor.x - 360, y: anchor.y - 130 },
        data: {
          label: imageSpec.title,
          params: { ...imageSpec.defaultParams },
          status: "idle",
          uiScale: nodeScalePreset
        }
      },
      {
        id: textId,
        type: "input.text",
        position: { x: anchor.x - 360, y: anchor.y + 80 },
        data: {
          label: textSpec.title,
          params: {
            ...textSpec.defaultParams,
            value:
              "Create a cinematic environment image from this prompt.\nStyle: high detail, soft global illumination, dramatic sky."
          },
          status: "idle",
          uiScale: nodeScalePreset
        }
      },
      {
        id: modelId,
        type: "model.qwen_image_edit",
        position: { x: anchor.x, y: anchor.y - 20 },
        data: {
          label: modelSpec.title,
          params: {
            ...modelSpec.defaultParams,
            prompt: "Transform to a stylized scene with richer color contrast and cleaner composition."
          },
          status: "idle",
          uiScale: nodeScalePreset
        }
      }
    ];

    const templateEdges: Edge[] = [
      withStyledEdge({
        id: `e-${imageId}-${modelId}`,
        source: imageId,
        target: modelId,
        sourceHandle: "image",
        targetHandle: "image"
      } as Edge),
      withStyledEdge({
        id: `e-${textId}-${modelId}`,
        source: textId,
        target: modelId,
        sourceHandle: "text",
        targetHandle: "text"
      } as Edge)
    ];

    setNodes((prev) => [...prev, ...templateNodes]);
    setEdges((prev) => [...prev, ...templateEdges]);
    toast({ title: "Template inserted", description: "Added text + image + Qwen Image Edit starter nodes." });
  }, [nodeScalePreset, reactFlow, setEdges, setNodes]);

  const updateSelectedNodeParam = (key: string, value: string | number | boolean) => {
    if (!selectedNode) return;
    setNodes((prev) =>
      prev.map((node) => {
        if (node.id !== selectedNode.id) return node;
        return {
          ...node,
          data: {
            ...node.data,
            params: {
              ...node.data.params,
              [key]: value
            }
          }
        };
      })
    );
  };

  const currentGraph = (): GraphDocument => ({
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as WorkflowNodeType,
      position: n.position,
      data: {
        label: n.data.label,
        params: n.data.params,
        status: n.data.status,
        uiScale: n.data.uiScale ?? nodeScalePreset
      }
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined
    })),
    viewport: { x: 0, y: 0, zoom: 1 }
  });

  const saveGraph = async ({ silent }: { silent?: boolean } = {}) => {
    setIsSaving(true);
    try {
      const payload = currentGraph();
      const res = await fetch(`/api/projects/${projectId}/graph`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Main Graph",
          graphJson: payload
        })
      });

      if (!res.ok) {
        throw new Error("Failed to save graph");
      }

      const data = await res.json();
      setVersions((prev) => [{ ...data.graph, createdAt: data.graph.createdAt, graphJson: payload }, ...prev]);
      setSelectedVersionId(data.graph.id);
      if (!silent) {
        toast({ title: "Graph saved", description: `Version ${data.graph.version} created` });
      }
      return data.graph.id as string;
    } catch (error) {
      if (!silent) {
        toast({ title: "Save failed", description: error instanceof Error ? error.message : "Unknown error" });
      }
      throw error;
    } finally {
      setIsSaving(false);
    }
  };

  const applyRunNodeState = (logs: string, status: string, artifactPairs: Array<{ nodeId: string; id: string; kind: string }>) => {
    const lines = logs.split("\n");
    const executed = new Set<string>();
    const cached = new Set<string>();
    const errored = new Set<string>();

    lines.forEach((line) => {
      const executedMatch = line.match(/\] (.+) executed/);
      const cacheMatch = line.match(/\] (.+) cache-hit/);
      if (executedMatch?.[1]) executed.add(executedMatch[1]);
      if (cacheMatch?.[1]) cached.add(cacheMatch[1]);
      if (line.includes("ERROR")) {
        const maybeNode = nodes.find((n) => line.includes(n.id));
        if (maybeNode) errored.add(maybeNode.id);
      }
    });

    setNodes((prev) =>
      prev.map((node) => {
        const pair = artifactPairs.find((a) => a.nodeId === node.id);
        let runtimeStatus = node.data.status ?? "idle";

        if (errored.has(node.id)) runtimeStatus = "error";
        else if (cached.has(node.id)) runtimeStatus = "cache-hit";
        else if (executed.has(node.id)) runtimeStatus = "success";
        else if (status === "running") runtimeStatus = "running";

        return {
          ...node,
          data: {
            ...node.data,
            status: runtimeStatus,
            latestArtifactId: pair?.id ?? node.data.latestArtifactId,
            latestArtifactKind: pair?.kind ?? node.data.latestArtifactKind
          }
        };
      })
    );
  };

  const pollRun = (runId: string) => {
    if (runPollRef.current) {
      clearInterval(runPollRef.current);
    }

    runPollRef.current = setInterval(async () => {
      const res = await fetch(`/api/runs/${runId}`, { cache: "no-store" });
      if (!res.ok) return;

      const data = await res.json();
      setRunLogs(data.run.logs ?? "");
      applyRunNodeState(
        data.run.logs ?? "",
        data.run.status,
        (data.run.artifacts ?? []).map((a: { nodeId: string; id: string; kind: string }) => ({
          nodeId: a.nodeId,
          id: a.id,
          kind: a.kind
        }))
      );

      if (["success", "error", "canceled"].includes(data.run.status)) {
        setActiveRunId(null);
        clearInterval(runPollRef.current!);
        runPollRef.current = null;
        const title = data.run.status === "success" ? "Run finished" : data.run.status === "canceled" ? "Run canceled" : "Run failed";
        toast({ title, description: `Run ${runId.slice(0, 8)}` });
      }
    }, 1600);
  };

  const startRun = async (startNodeId?: string) => {
    try {
      const latestGraphId = await saveGraph({ silent: true });
      const res = await fetch(`/api/projects/${projectId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graphId: latestGraphId, startNodeId })
      });
      if (!res.ok) throw new Error("Failed to queue run");

      const data = await res.json();
      setActiveRunId(data.run.id);
      toast({ title: "Run started", description: `Run ${data.run.id.slice(0, 8)} queued` });
      pollRun(data.run.id);
    } catch (error) {
      toast({ title: "Run start failed", description: error instanceof Error ? error.message : "Unknown error" });
    }
  };

  const cancelRun = async () => {
    if (!activeRunId) return;
    await fetch(`/api/runs/${activeRunId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" })
    });
    toast({ title: "Cancel requested", description: `Run ${activeRunId.slice(0, 8)}` });
  };

  const shareProject = async () => {
    const url = `${window.location.origin}/app/p/${projectId}/canvas`;
    await navigator.clipboard.writeText(url);
    toast({ title: "Share link copied", description: url });
  };

  const spec = selectedNode ? nodeSpecRegistry[selectedNode.type as WorkflowNodeType] : null;
  const viewerArtifactId =
    selectedNode?.data.latestArtifactId ?? nodes.find((node) => Boolean(node.data.latestArtifactId))?.data.latestArtifactId ?? null;
  const viewerHref = viewerArtifactId
    ? `/app/p/${projectId}/viewer?artifactId=${viewerArtifactId}`
    : `/app/p/${projectId}/viewer`;

  return (
    <div className="h-full">
      <div className="flex h-full flex-col overflow-hidden rounded-none border border-border/70 panel-blur md:rounded-2xl" onDrop={onDrop} onDragOver={onDragOver}>
        <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-black/30 p-2.5">
          <Badge className="rounded-full border border-white/10 bg-black/30 text-[11px] text-zinc-300" variant="secondary">
            {projectName}
          </Badge>
          <Button size="sm" className="rounded-xl" onClick={() => startRun()}>
            <Play className="mr-1 h-4 w-4" /> Run workflow
          </Button>
          <Button size="sm" variant="secondary" className="rounded-xl" onClick={() => startRun(selectedNode?.id)} disabled={!selectedNode}>
            <Zap className="mr-1 h-4 w-4" /> Run from selection
          </Button>
          <Button size="sm" variant="outline" className="rounded-xl" onClick={cancelRun} disabled={!activeRunId}>
            <Square className="mr-1 h-4 w-4" /> Stop
          </Button>
          <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void saveGraph()} disabled={isSaving}>
            <Save className="mr-1 h-4 w-4" /> {isSaving ? "Saving..." : "Save"}
          </Button>
          <Button size="sm" variant="outline" className="rounded-xl" onClick={shareProject}>
            <Share2 className="mr-1 h-4 w-4" /> Share
          </Button>
          <Button size="sm" variant="outline" className="rounded-xl" onClick={insertImagePromptTemplate}>
            <WandSparkles className="mr-1 h-4 w-4" /> Image Prompt Flow
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="rounded-xl">
                <PanelLeft className="mr-1 h-4 w-4" /> Nodes
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[360px] rounded-xl border-border/70 bg-[#090d18]/95 p-2 text-zinc-100">
              <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-zinc-400">Node Palette</p>
              <p className="mb-2 text-xs text-zinc-500">Right-click on canvas to add at cursor, or add at viewport center below.</p>
              <ScrollArea className="h-[62vh] pr-2">
                <div className="space-y-3">
                  {contextMenuGroups.map((group) => (
                    <div key={`dropdown-${group.category}`} className="rounded-xl border border-border/70 bg-background/35 p-2">
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-300">
                        {group.category}
                      </p>
                      <div className="space-y-1.5">
                        {group.specs.map((item) => (
                          <button
                            key={`dropdown-node-${item.type}`}
                            type="button"
                            onClick={() => addNodeAtViewportCenter(item.type)}
                            className="w-full rounded-lg border border-border/70 bg-background/45 px-2.5 py-1.5 text-left text-xs transition hover:-translate-y-0.5 hover:border-primary/40 hover:bg-accent"
                          >
                            <p className="font-medium text-zinc-100">{item.title}</p>
                            <p className="text-[10px] text-zinc-400">{item.type}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="rounded-xl">
                <SlidersHorizontal className="mr-1 h-4 w-4" /> Inspector
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[430px] rounded-xl border-border/70 bg-[#090d18]/95 p-2 text-zinc-100">
              <Tabs defaultValue="params" className="w-full">
                <TabsList className="grid w-full grid-cols-3 rounded-xl bg-background/70">
                  <TabsTrigger value="params" className="rounded-lg">Params</TabsTrigger>
                  <TabsTrigger value="outputs" className="rounded-lg">Outputs</TabsTrigger>
                  <TabsTrigger value="logs" className="rounded-lg">Logs</TabsTrigger>
                </TabsList>

                <TabsContent value="params" className="mt-3">
                  {!selectedNode || !spec ? (
                    <p className="text-sm text-muted-foreground">Select a node to edit parameters.</p>
                  ) : (
                    <>
                      <div className="mb-3 space-y-1">
                        <h3 className="font-semibold text-white">{spec.title}</h3>
                        <p className="text-xs text-muted-foreground">{selectedNode.id}</p>
                      </div>
                      <Separator className="mb-3" />
                      <ScrollArea className="h-[44vh] pr-2">
                        <div className="space-y-3">
                          {spec.paramFields.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No editable parameters.</p>
                          ) : (
                            spec.paramFields.map((field) => {
                              const value = selectedNode.data.params[field.key];
                              const key = `${selectedNode.id}-${field.key}`;
                              return (
                                <div key={key} className="space-y-1.5">
                                  <Label>{field.label}</Label>
                                  {field.input === "textarea" || field.input === "json" ? (
                                    <Textarea
                                      value={String(value ?? "")}
                                      onChange={(e) => updateSelectedNodeParam(field.key, e.target.value)}
                                      rows={field.input === "json" ? 5 : 3}
                                      className="rounded-xl"
                                    />
                                  ) : field.input === "select" ? (
                                    <Select value={String(value ?? field.options?.[0] ?? "")} onValueChange={(v) => updateSelectedNodeParam(field.key, v)}>
                                      <SelectTrigger className="rounded-xl">
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        {(field.options ?? []).map((option) => (
                                          <SelectItem key={option} value={option}>
                                            {option}
                                          </SelectItem>
                                        ))}
                                      </SelectContent>
                                    </Select>
                                  ) : (
                                    <Input
                                      type={field.input === "number" ? "number" : "text"}
                                      value={String(value ?? "")}
                                      onChange={(e) =>
                                        updateSelectedNodeParam(field.key, field.input === "number" ? Number(e.target.value || 0) : e.target.value)
                                      }
                                      placeholder={field.placeholder}
                                      className="rounded-xl"
                                    />
                                  )}
                                </div>
                              );
                            })
                          )}
                        </div>
                      </ScrollArea>
                      <Button className="mt-3 w-full rounded-xl" onClick={() => startRun(selectedNode.id)}>
                        <Play className="mr-1 h-4 w-4" /> Run from this node
                      </Button>
                    </>
                  )}
                </TabsContent>

                <TabsContent value="outputs" className="mt-3 space-y-3">
                  {!selectedNode?.data.latestArtifactId ? (
                    <p className="text-sm text-muted-foreground">No output for selected node yet.</p>
                  ) : (
                    <Card className="rounded-xl border-primary/35 bg-primary/5">
                      <CardContent className="space-y-2 p-3 text-sm">
                        <p className="font-medium text-white">Latest output</p>
                        <p className="text-xs text-muted-foreground">Kind: {selectedNode.data.latestArtifactKind}</p>
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            className="rounded-lg"
                            onClick={() => window.open(`/app/p/${projectId}/viewer?artifactId=${selectedNode.data.latestArtifactId}`, "_blank")}
                          >
                            Open viewer
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-lg"
                            onClick={() => window.open(`/api/artifacts/${selectedNode.data.latestArtifactId}`, "_blank")}
                          >
                            Meta
                          </Button>
                        </div>
                        {selectedArtifactPreview.previewUrl ? (
                          <img src={selectedArtifactPreview.previewUrl} alt="Artifact preview" className="h-32 w-full rounded-lg border object-contain bg-black/40" />
                        ) : null}
                        {selectedArtifactPreview.jsonSnippet ? (
                          <pre className="max-h-44 overflow-auto rounded-lg border bg-background/70 p-2 text-xs">
                            {selectedArtifactPreview.jsonSnippet}
                          </pre>
                        ) : null}
                      </CardContent>
                    </Card>
                  )}
                </TabsContent>

                <TabsContent value="logs" className="mt-3">
                  <ScrollArea className="h-[50vh] rounded-xl border border-border/70 bg-black/30 p-3">
                    <pre className="whitespace-pre-wrap text-xs text-zinc-300">{runLogs || "No logs yet. Run workflow to stream logs."}</pre>
                  </ScrollArea>
                </TabsContent>
              </Tabs>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button size="sm" variant="outline" className="rounded-xl" asChild>
            <Link href={viewerHref}>
              <ExternalLink className="mr-1 h-4 w-4" /> Viewer
            </Link>
          </Button>

          <div className="ml-auto flex items-center gap-2">
            <Badge variant={activeRunId ? "default" : "secondary"} className="rounded-full border border-white/10 bg-black/30">
              {activeRunId ? "Running" : "Idle"}
            </Badge>
            <Button variant={snapToGrid ? "default" : "outline"} size="sm" className="rounded-xl" onClick={() => setSnapToGrid((v) => !v)}>
              Snap {snapToGrid ? "On" : "Off"}
            </Button>
            <Select value={nodeScalePreset} onValueChange={(value) => applyNodeScalePreset(value as NodeUiScale)}>
              <SelectTrigger className="h-9 w-[170px] rounded-xl">
                <SelectValue placeholder="Node size" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="compact">Nodes: Compact</SelectItem>
                <SelectItem value="balanced">Nodes: Balanced</SelectItem>
                <SelectItem value="cinematic">Nodes: Cinematic</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={selectedVersionId}
              onValueChange={(value) => {
                setSelectedVersionId(value);
                const version = versions.find((v) => v.id === value);
                if (!version) return;
                const loadedNodes = version.graphJson.nodes.map((n) => buildNodeData(n as Node<GraphNodeData>, nodeArtifacts)) as Node<GraphNodeData>[];
                setNodes(loadedNodes);
                setEdges(version.graphJson.edges.map((edge) => withStyledEdge(edge as Edge)));
                const loadedPreset = loadedNodes[0]?.data.uiScale;
                if (loadedPreset === "compact" || loadedPreset === "balanced" || loadedPreset === "cinematic") {
                  setNodeScalePreset(loadedPreset);
                }
                toast({ title: "Version loaded", description: `v${version.version}` });
              }}
            >
              <SelectTrigger className="h-9 w-[180px] rounded-xl">
                <SelectValue placeholder="Graph version" />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    v{v.version} - {new Date(v.createdAt).toLocaleDateString()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="canvas-dot-bg relative min-h-0 flex-1 bg-[#06080f]" ref={canvasPanelRef}>
          <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-xl border border-white/10 bg-black/45 px-3 py-2 backdrop-blur-sm">
            <p className="text-[11px] font-medium text-zinc-200">{projectName}</p>
            <p className="text-[10px] text-zinc-500">Workspace canvas</p>
          </div>

          <div className="absolute left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-1 rounded-[18px] border border-white/10 bg-black/50 p-2 backdrop-blur-sm">
            <Button size="icon" variant="outline" className="h-10 w-10 rounded-full" onClick={openNodeMenuAtViewportCenter}>
              <Plus className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8 rounded-lg" onClick={() => reactFlow.zoomIn({ duration: 180 })}>
              <ZoomIn className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8 rounded-lg" onClick={() => reactFlow.zoomOut({ duration: 180 })}>
              <Minus className="h-4 w-4" />
            </Button>
            <Button size="icon" variant="ghost" className="h-8 w-8 rounded-lg" onClick={() => reactFlow.fitView({ padding: 0.2, duration: 220 })}>
              <LocateFixed className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant={showMiniMap ? "default" : "ghost"}
              className="h-8 w-8 rounded-lg"
              onClick={() => setShowMiniMap((value) => !value)}
            >
              <Map className="h-4 w-4" />
            </Button>
          </div>

          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onPaneContextMenu={onPaneContextMenu}
            onPaneClick={onPaneClick}
            fitView
            panOnScroll
            panOnDrag
            selectionOnDrag
            minZoom={0.2}
            maxZoom={1.8}
            snapToGrid={snapToGrid}
            snapGrid={[20, 20]}
            className="h-full"
            defaultEdgeOptions={{
              type: "smoothstep",
              animated: true,
              style: { stroke: "rgba(176, 191, 221, 0.42)", strokeWidth: 1.45 }
            }}
            connectionLineStyle={{ stroke: "rgba(188, 203, 228, 0.45)", strokeWidth: 1.35 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="rgba(255,255,255,0.12)" gap={18} />
            {showMiniMap ? <MiniMap pannable zoomable style={{ background: "rgba(8,10,18,0.95)" }} /> : null}
          </ReactFlow>

          {paneMenu ? (
            <div
              ref={paneMenuRef}
              className="absolute z-30 w-80 rounded-2xl border border-white/10 bg-[#151515]/95 p-3 shadow-[0_30px_80px_rgba(0,0,0,0.65)] backdrop-blur-md"
              style={{ left: paneMenu.x, top: paneMenu.y }}
            >
              <div className="mb-2">
                <p className="text-xs text-zinc-500">Add Node</p>
              </div>

              <ScrollArea className="max-h-[24rem] pr-2">
                <div className="space-y-3">
                  {contextMenuGroups.map((group) => (
                    <div key={`ctx-${group.category}`} className="rounded-xl border border-white/10 bg-white/[0.015] p-2">
                      <p className="mb-1.5 text-xs text-zinc-500">{categoryLabelMap[group.category]}</p>
                      <div className="space-y-1">
                        {group.specs.map((spec) => {
                          const RowIcon = getContextRowIcon(spec.type);
                          const shortcut = shortcutByNodeType[spec.type];
                          return (
                            <button
                              key={`ctx-node-${spec.type}`}
                              type="button"
                              onClick={() => addNodeFromContextMenu(spec.type)}
                              className="group flex w-full items-center gap-2 rounded-lg border border-transparent px-2 py-2 text-left text-sm text-zinc-200 transition hover:border-white/10 hover:bg-white/5"
                            >
                              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-white/5 text-zinc-200">
                                <RowIcon className="h-4 w-4" />
                              </span>
                              <span className="flex-1 leading-none">{spec.title}</span>
                              {shortcut ? <span className="text-xs text-zinc-500">{shortcut}</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>

              <div className="mt-3 flex items-center justify-between border-t border-white/10 px-1 pt-2 text-xs text-zinc-500">
                <span>↕ Navigate</span>
                <span>↵ Select</span>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function CanvasEditor(props: CanvasEditorProps) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
