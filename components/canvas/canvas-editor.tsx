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
  ChevronRight,
  ExternalLink,
  Image as ImageIcon,
  LocateFixed,
  Map as MapIcon,
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
  Trash2,
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
  outputKey?: string;
  hidden?: boolean;
  url?: string | null;
  previewUrl?: string | null;
  meta?: Record<string, unknown> | null;
  createdAt?: string;
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
  const nodeType = base.type as WorkflowNodeType;
  const spec = nodeSpecRegistry[nodeType];
  const matched = artifacts
    .filter((a) => a.nodeId === base.id)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());

  const outputArtifacts = matched.reduce<Record<string, NonNullable<GraphNodeData["outputArtifacts"]>[string]>>((acc, artifact) => {
    const outputKey = artifact.outputKey ?? "default";
    if (!acc[outputKey]) {
      acc[outputKey] = {
        id: artifact.id,
        kind: artifact.kind,
        hidden: Boolean(artifact.hidden),
        url: artifact.url ?? null,
        previewUrl: artifact.previewUrl ?? null,
        createdAt: artifact.createdAt
      };
    }
    return acc;
  }, {});

  const previewOutputIds = spec.ui?.previewOutputIds ?? [];
  const hiddenOutputIds = new Set(spec.ui?.hiddenOutputIds ?? []);
  const previewArtifact =
    previewOutputIds
      .map((key) => outputArtifacts[key])
      .find((artifact) => Boolean(artifact?.id)) ??
    Object.entries(outputArtifacts)
      .filter(([key, artifact]) => !artifact.hidden && !hiddenOutputIds.has(key))
      .sort((a, b) => new Date(b[1].createdAt ?? 0).getTime() - new Date(a[1].createdAt ?? 0).getTime())[0]?.[1] ??
    Object.values(outputArtifacts)[0];

  const runtimeMetaCandidate = matched.find((artifact) => artifact.outputKey === "meta")?.meta ?? matched[0]?.meta ?? null;
  const runtimeMode = runtimeMetaCandidate && typeof runtimeMetaCandidate.mode === "string" ? runtimeMetaCandidate.mode : undefined;
  const runtimeWarning =
    runtimeMetaCandidate && Array.isArray(runtimeMetaCandidate.warnings) && runtimeMetaCandidate.warnings.length > 0
      ? String(runtimeMetaCandidate.warnings[0])
      : runtimeMetaCandidate && typeof runtimeMetaCandidate.warning === "string"
        ? runtimeMetaCandidate.warning
        : null;

  return {
    ...base,
    data: {
      ...base.data,
      status: base.data.status ?? "idle",
      latestArtifactId: previewArtifact?.id,
      latestArtifactKind: previewArtifact?.kind,
      previewUrl: previewArtifact?.previewUrl ?? previewArtifact?.url ?? null,
      outputArtifacts,
      runtimeMode: typeof base.data.runtimeMode === "string" ? base.data.runtimeMode : runtimeMode,
      runtimeWarning: base.data.runtimeWarning ?? runtimeWarning,
      uiScale: base.data.uiScale ?? "balanced",
      isCacheHit: base.data.isCacheHit ?? false
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
  const [showAdvancedInspector, setShowAdvancedInspector] = useState(false);
  const [selectedArtifactPreview, setSelectedArtifactPreview] = useState<{ previewUrl: string | null; jsonSnippet: string | null }>({
    previewUrl: null,
    jsonSnippet: null
  });
  const [paneMenu, setPaneMenu] = useState<PaneContextMenuState | null>(null);
  const [activeMenuCategory, setActiveMenuCategory] = useState<ContextMenuCategory | null>(null);
  const [menuSearch, setMenuSearch] = useState("");
  const [showMiniMap, setShowMiniMap] = useState(true);
  const runPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runNodeRef = useRef<(nodeId: string) => void>(() => {});
  const uploadNodeRef = useRef<(nodeId: string, file: File) => void>(() => {});
  const updateNodeParamRef = useRef<(nodeId: string, key: string, value: string | number | boolean) => void>(() => {});
  const canvasPanelRef = useRef<HTMLDivElement>(null);
  const paneMenuRef = useRef<HTMLDivElement>(null);
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didHydrateDraftRef = useRef(false);
  const draftStorageKey = useMemo(() => `tribalai.canvas.draft.${projectId}`, [projectId]);

  const selectedNode = useMemo(() => nodes.find((n) => n.selected), [nodes]);
  const hasSelection = useMemo(() => nodes.some((n) => n.selected), [nodes]);
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
  const canNodeRun = useCallback((node: Node<GraphNodeData> | undefined) => {
    if (!node) return false;
    const nodeType = node.type as WorkflowNodeType;
    const spec = nodeSpecRegistry[nodeType];
    if (!spec.ui?.nodeRunEnabled) return false;
    if (nodeType !== "input.image") return true;
    const sourceMode = node.data.params?.sourceMode === "generate" ? "generate" : "upload";
    const model = typeof node.data.params?.generatorModel === "string" ? node.data.params.generatorModel : "";
    return sourceMode === "generate" && model.trim().length > 0;
  }, []);
  const activeMenuGroup = useMemo(
    () => contextMenuGroups.find((group) => group.category === activeMenuCategory) ?? null,
    [activeMenuCategory, contextMenuGroups]
  );
  const filteredActiveMenuSpecs = useMemo(() => {
    if (!activeMenuGroup) return [];
    const query = menuSearch.trim().toLowerCase();
    if (!query) return activeMenuGroup.specs;
    return activeMenuGroup.specs.filter((spec) => {
      return spec.title.toLowerCase().includes(query) || spec.type.toLowerCase().includes(query);
    });
  }, [activeMenuGroup, menuSearch]);

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
    if (!paneMenu) {
      setActiveMenuCategory(null);
      setMenuSearch("");
      return;
    }
    if (!activeMenuCategory) {
      const firstCategory = contextMenuGroups[0]?.category;
      if (firstCategory) {
        setActiveMenuCategory(firstCategory);
      }
    }
  }, [activeMenuCategory, contextMenuGroups, paneMenu]);

  useEffect(() => {
    if (didHydrateDraftRef.current) return;
    didHydrateDraftRef.current = true;

    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(draftStorageKey);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as {
        graph?: GraphDocument;
      };
      const graph = parsed?.graph;
      if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return;

      const restoredNodes = graph.nodes.map((node) => {
        const hydrated = buildNodeData(node as Node<GraphNodeData>, nodeArtifacts) as Node<GraphNodeData>;
        const previewUrl =
          node.data && typeof node.data.previewUrl === "string" && node.data.previewUrl.length > 0
            ? node.data.previewUrl
            : hydrated.data.previewUrl ?? null;
        return {
          ...hydrated,
          data: {
            ...hydrated.data,
            previewUrl
          }
        };
      }) as Node<GraphNodeData>[];

      setNodes(restoredNodes);
      setEdges(graph.edges.map((edge) => withStyledEdge(edge as Edge)));
      const restoredPreset = restoredNodes[0]?.data.uiScale;
      if (restoredPreset === "compact" || restoredPreset === "balanced" || restoredPreset === "cinematic") {
        setNodeScalePreset(restoredPreset);
      }
      toast({ title: "Draft restored", description: "Recovered your latest unsaved canvas state." });
    } catch {
      window.localStorage.removeItem(draftStorageKey);
    }
  }, [draftStorageKey, nodeArtifacts, setEdges, setNodes]);

  useEffect(() => {
    const onDeleteShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isTyping) return;

      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const selectedIds = nodes.filter((node) => node.selected).map((node) => node.id);
      if (selectedIds.length === 0) return;
      event.preventDefault();
      const nodeSet = new Set(selectedIds);
      setNodes((prev) => prev.filter((node) => !nodeSet.has(node.id)));
      setEdges((prev) => prev.filter((edge) => !nodeSet.has(edge.source) && !nodeSet.has(edge.target)));
      toast({
        title: "Node deleted",
        description: selectedIds.length > 1 ? `${selectedIds.length} nodes removed` : `${selectedIds[0]} removed`
      });
    };

    window.addEventListener("keydown", onDeleteShortcut);
    return () => window.removeEventListener("keydown", onDeleteShortcut);
  }, [nodes, setEdges, setNodes]);

  useEffect(() => {
    setShowAdvancedInspector(false);
  }, [selectedNode?.id]);

  useEffect(() => {
    const artifactId = selectedNode?.data.latestArtifactId;
    if (!artifactId) {
      setSelectedArtifactPreview({ previewUrl: null, jsonSnippet: null });
      return;
    }

    if (selectedNode?.data.previewUrl && selectedNode.data.latestArtifactKind !== "json") {
      setSelectedArtifactPreview({ previewUrl: selectedNode.data.previewUrl, jsonSnippet: null });
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
  }, [selectedNode?.data.latestArtifactId, selectedNode?.data.previewUrl, selectedNode?.data.latestArtifactKind]);

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
          uiScale: nodeScalePreset,
          onRunNode: (currentNodeId: string) => runNodeRef.current(currentNodeId),
          onUploadImage: (currentNodeId: string, file: File) => uploadNodeRef.current(currentNodeId, file),
          onUpdateParam: (currentNodeId: string, key: string, value: string | number | boolean) =>
            updateNodeParamRef.current(currentNodeId, key, value)
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

  const deleteNodesByIds = useCallback(
    (nodeIds: string[]) => {
      if (nodeIds.length === 0) return;
      const nodeSet = new Set(nodeIds);
      setNodes((prev) => prev.filter((node) => !nodeSet.has(node.id)));
      setEdges((prev) => prev.filter((edge) => !nodeSet.has(edge.source) && !nodeSet.has(edge.target)));
      toast({
        title: "Node deleted",
        description: nodeIds.length > 1 ? `${nodeIds.length} nodes removed` : `${nodeIds[0]} removed`
      });
    },
    [setEdges, setNodes]
  );

  const deleteSelectedNodes = useCallback(() => {
    const selectedIds = nodes.filter((node) => node.selected).map((node) => node.id);
    deleteNodesByIds(selectedIds);
  }, [deleteNodesByIds, nodes]);

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
    (_event: React.MouseEvent) => {
      setPaneMenu(null);
    },
    []
  );

  const onCanvasDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest(".react-flow__node")) return;
      openPaneMenuAtScreenPoint(event.clientX, event.clientY);
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

  const updateNodeParamById = useCallback(
    (nodeId: string, key: string, value: string | number | boolean) => {
      if (!nodeId) return;
      setNodes((prev) =>
        prev.map((node) => {
          if (node.id !== nodeId) return node;
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
    },
    [setNodes]
  );

  const updateSelectedNodeParam = (key: string, value: string | number | boolean) => {
    if (!selectedNode) return;
    updateNodeParamById(selectedNode.id, key, value);
  };

  const createNodePreviewUrl = useCallback(async (file: File) => {
    const objectUrl = URL.createObjectURL(file);
    const asDataUrl = () =>
      new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : objectUrl);
        reader.onerror = () => resolve(objectUrl);
        reader.readAsDataURL(file);
      });
    let shouldRevoke = true;
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load image preview"));
        img.src = objectUrl;
      });

      const maxSide = 420;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        shouldRevoke = false;
        return asDataUrl();
      }
      ctx.drawImage(image, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", 0.86);
    } catch {
      shouldRevoke = false;
      return asDataUrl();
    } finally {
      if (shouldRevoke) {
        URL.revokeObjectURL(objectUrl);
      }
    }
  }, []);

  const uploadImageForNode = useCallback(
    async (nodeId: string, file: File) => {
      if (!nodeId) return;
      const localPreviewUrl = await createNodePreviewUrl(file);
      setNodes((prev) =>
        prev.map((node) => {
          if (node.id !== nodeId || node.type !== "input.image") return node;
          return {
            ...node,
            data: {
              ...node.data,
              previewUrl: localPreviewUrl,
              params: {
                ...node.data.params,
                filename: file.name
              }
            }
          };
        })
      );

      try {
        const uploadInit = await fetch("/api/uploads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId,
            nodeId,
            filename: file.name,
            contentType: file.type || "application/octet-stream",
            byteSize: file.size
          })
        });
        if (!uploadInit.ok) {
          const payload = await uploadInit.json().catch(() => ({}));
          throw new Error(typeof payload.message === "string" ? payload.message : "Failed to prepare upload");
        }
        const uploadData = await uploadInit.json();
        const uploadTarget = uploadData.uploadUrl ?? uploadData.directUploadUrl;
        if (typeof uploadTarget !== "string" || uploadTarget.length === 0) {
          throw new Error("Upload target is missing");
        }
        const uploadRes = await fetch(uploadTarget, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file
        });
        if (!uploadRes.ok) {
          throw new Error(`Upload failed (${uploadRes.status})`);
        }
        setNodes((prev) =>
          prev.map((node) => {
            if (node.id !== nodeId || node.type !== "input.image") return node;
            return {
              ...node,
              data: {
                ...node.data,
                params: {
                  ...node.data.params,
                  storageKey: uploadData.key,
                  filename: file.name,
                  uploadAssetId: uploadData.uploadAssetId ?? ""
                }
              }
            };
          })
        );
        toast({ title: "Image uploaded", description: file.name });
      } catch (error) {
        toast({ title: "Upload failed", description: error instanceof Error ? error.message : "Unknown error" });
      }
    },
    [createNodePreviewUrl, projectId, setNodes]
  );

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

  const currentDraftGraph = (): GraphDocument => ({
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type as WorkflowNodeType,
      position: n.position,
      data: {
        label: n.data.label,
        params: n.data.params,
        status: n.data.status,
        uiScale: n.data.uiScale ?? nodeScalePreset,
        previewUrl: n.data.previewUrl ?? null
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

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!didHydrateDraftRef.current) return;

    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current);
    }

    draftSaveTimeoutRef.current = setTimeout(() => {
      try {
        const payload = {
          updatedAt: new Date().toISOString(),
          graph: currentDraftGraph()
        };
        window.localStorage.setItem(draftStorageKey, JSON.stringify(payload));
      } catch {
        // Ignore quota and serialization errors.
      }
    }, 450);

    return () => {
      if (draftSaveTimeoutRef.current) {
        clearTimeout(draftSaveTimeoutRef.current);
      }
    };
  }, [draftStorageKey, edges, nodeScalePreset, nodes]);

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

  const applyRunNodeState = (
    logs: string,
    status: string,
    runProgress: number,
    artifactPairs: Array<{
      nodeId: string;
      id: string;
      kind: string;
      outputKey?: string;
      hidden?: boolean;
      previewUrl?: string | null;
      url?: string | null;
      createdAt?: string;
      meta?: Record<string, unknown> | null;
    }>
  ) => {
    const lines = logs.split("\n");
    const executed = new Set<string>();
    const cached = new Set<string>();
    const errored = new Set<string>();
    const groupedArtifacts = artifactPairs.reduce<Record<string, typeof artifactPairs>>((acc, artifact) => {
      if (!acc[artifact.nodeId]) acc[artifact.nodeId] = [];
      acc[artifact.nodeId].push(artifact);
      return acc;
    }, {});

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

    setNodes((prev) => {
      const hasRunningOrQueued = status === "running" || status === "queued";
      return prev.map((node) => {
        const nodeType = node.type as WorkflowNodeType;
        const spec = nodeSpecRegistry[nodeType];
        const nodeArtifacts = [...(groupedArtifacts[node.id] ?? [])].sort(
          (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
        );
        const artifactByOutput = nodeArtifacts.reduce<Record<string, NonNullable<GraphNodeData["outputArtifacts"]>[string]>>(
          (acc, artifact) => {
            const outputKey = artifact.outputKey ?? "default";
            if (!acc[outputKey]) {
              acc[outputKey] = {
                id: artifact.id,
                kind: artifact.kind,
                hidden: Boolean(artifact.hidden),
                url: artifact.url ?? null,
                previewUrl: artifact.previewUrl ?? null,
                createdAt: artifact.createdAt
              };
            }
            return acc;
          },
          {}
        );

        const previewArtifact =
          (spec.ui?.previewOutputIds ?? [])
            .map((outputId) => artifactByOutput[outputId])
            .find((artifact) => Boolean(artifact?.id)) ??
          Object.values(artifactByOutput).find((artifact) => !artifact.hidden) ??
          Object.values(artifactByOutput)[0];

        const metaArtifact = nodeArtifacts.find((artifact) => artifact.outputKey === "meta");
        const runtimeMode =
          metaArtifact?.meta && typeof metaArtifact.meta.mode === "string"
            ? metaArtifact.meta.mode
            : node.data.runtimeMode;
        const runtimeWarning =
          metaArtifact?.meta && Array.isArray(metaArtifact.meta.warnings) && metaArtifact.meta.warnings.length > 0
            ? String(metaArtifact.meta.warnings[0])
            : nodeArtifacts.find((artifact) => artifact.meta && typeof artifact.meta.warning === "string")?.meta?.warning
              ? String(nodeArtifacts.find((artifact) => artifact.meta && typeof artifact.meta.warning === "string")?.meta?.warning)
              : node.data.runtimeWarning;

        let runtimeStatus = node.data.status ?? "idle";

        if (errored.has(node.id)) runtimeStatus = "error";
        else if (cached.has(node.id)) runtimeStatus = "cache-hit";
        else if (executed.has(node.id)) runtimeStatus = "success";
        else if (hasRunningOrQueued) runtimeStatus = "running";

        return {
          ...node,
          data: {
            ...node.data,
            status: runtimeStatus,
            runProgress: runtimeStatus === "running" ? runProgress : runtimeStatus === "success" || runtimeStatus === "cache-hit" ? 100 : 0,
            latestArtifactId: previewArtifact?.id ?? node.data.latestArtifactId,
            latestArtifactKind: previewArtifact?.kind ?? node.data.latestArtifactKind,
            previewUrl: previewArtifact?.previewUrl ?? previewArtifact?.url ?? node.data.previewUrl ?? null,
            outputArtifacts: Object.keys(artifactByOutput).length > 0 ? artifactByOutput : node.data.outputArtifacts,
            isCacheHit: runtimeStatus === "cache-hit",
            lastRunAt:
              runtimeStatus === "success" || runtimeStatus === "cache-hit" || runtimeStatus === "error"
                ? new Date().toISOString()
                : node.data.lastRunAt,
            runtimeMode,
            runtimeWarning: runtimeWarning ?? null
          }
        };
      });
    });
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
        Number(data.run.progress ?? 0),
        (data.run.artifacts ?? []).map(
          (a: {
            nodeId: string;
            id: string;
            kind: string;
            outputKey?: string;
            hidden?: boolean;
            previewUrl?: string | null;
            url?: string | null;
            createdAt?: string;
            meta?: Record<string, unknown> | null;
          }) => ({
            nodeId: a.nodeId,
            id: a.id,
            kind: a.kind,
            outputKey: a.outputKey,
            hidden: a.hidden,
            previewUrl: a.previewUrl ?? null,
            url: a.url ?? null,
            createdAt: a.createdAt,
            meta: a.meta ?? null
          })
        )
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

  const markNodesPreparingRun = useCallback(
    (startNodeId?: string) => {
      if (!startNodeId) {
        setNodes((prev) =>
          prev.map((node) => ({
            ...node,
            data: {
              ...node.data,
              status: "running",
              runProgress: 0,
              runtimeWarning: null
            }
          }))
        );
        return;
      }

      const incoming = new Map<string, string[]>();
      edges.forEach((edge) => {
        const list = incoming.get(edge.target) ?? [];
        list.push(edge.source);
        incoming.set(edge.target, list);
      });

      const targets = new Set<string>();
      const stack = [startNodeId];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (targets.has(current)) continue;
        targets.add(current);
        (incoming.get(current) ?? []).forEach((source) => stack.push(source));
      }

      setNodes((prev) =>
        prev.map((node) => ({
          ...node,
          data: {
            ...node.data,
            status: targets.has(node.id) ? "running" : node.data.status,
            runProgress: targets.has(node.id) ? 0 : node.data.runProgress ?? 0,
            runtimeWarning: targets.has(node.id) ? null : node.data.runtimeWarning
          }
        }))
      );
    },
    [edges, setNodes]
  );

  const startRun = async (startNodeId?: string) => {
    try {
      const latestGraphId = await saveGraph({ silent: true });
      markNodesPreparingRun(startNodeId);
      const endpoint = startNodeId
        ? `/api/projects/${projectId}/nodes/${startNodeId}/run`
        : `/api/projects/${projectId}/runs`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(startNodeId ? { graphId: latestGraphId } : { graphId: latestGraphId, startNodeId })
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

  runNodeRef.current = (nodeId: string) => {
    if (!nodeId) return;
    void startRun(nodeId);
  };
  uploadNodeRef.current = (nodeId: string, file: File) => {
    void uploadImageForNode(nodeId, file);
  };
  updateNodeParamRef.current = (nodeId: string, key: string, value: string | number | boolean) => {
    updateNodeParamById(nodeId, key, value);
  };

  const stableNodeRunHandler = useCallback((nodeId: string) => {
    runNodeRef.current(nodeId);
  }, []);
  const stableImageUploadHandler = useCallback((nodeId: string, file: File) => {
    uploadNodeRef.current(nodeId, file);
  }, []);
  const stableParamUpdateHandler = useCallback((nodeId: string, key: string, value: string | number | boolean) => {
    updateNodeParamRef.current(nodeId, key, value);
  }, []);

  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        if (
          node.data.onRunNode === stableNodeRunHandler &&
          node.data.onUploadImage === stableImageUploadHandler &&
          node.data.onUpdateParam === stableParamUpdateHandler
        ) {
          return node;
        }
        return {
          ...node,
          data: {
            ...node.data,
            onRunNode: stableNodeRunHandler,
            onUploadImage: stableImageUploadHandler,
            onUpdateParam: stableParamUpdateHandler
          }
        };
      })
    );
  }, [stableImageUploadHandler, stableNodeRunHandler, stableParamUpdateHandler, setNodes]);

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
  const selectedNodeArtifacts = useMemo(() => {
    if (!selectedNode?.data.outputArtifacts) return [];
    return Object.entries(selectedNode.data.outputArtifacts)
      .map(([outputId, artifact]) => ({ outputId, ...artifact }))
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  }, [selectedNode?.data.outputArtifacts]);
  const visibleNodeArtifacts = useMemo(
    () => selectedNodeArtifacts.filter((artifact) => !artifact.hidden),
    [selectedNodeArtifacts]
  );
  const advancedNodeArtifacts = useMemo(
    () => selectedNodeArtifacts.filter((artifact) => artifact.hidden),
    [selectedNodeArtifacts]
  );
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
          <Button
            size="sm"
            variant="secondary"
            className="rounded-xl"
            onClick={() => startRun(selectedNode?.id)}
            disabled={!selectedNode || !canNodeRun(selectedNode)}
          >
            <Zap className="mr-1 h-4 w-4" /> Run from selection
          </Button>
          <Button size="sm" variant="outline" className="rounded-xl" onClick={cancelRun} disabled={!activeRunId}>
            <Square className="mr-1 h-4 w-4" /> Stop
          </Button>
          <Button size="sm" variant="outline" className="rounded-xl" onClick={() => void saveGraph()} disabled={isSaving}>
            <Save className="mr-1 h-4 w-4" /> {isSaving ? "Saving..." : "Save"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="rounded-xl"
            onClick={deleteSelectedNodes}
            disabled={!hasSelection}
          >
            <Trash2 className="mr-1 h-4 w-4" /> Delete node
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
              <div className="mb-2 grid grid-cols-3 gap-1">
                <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => addNodeAtViewportCenter("input.image")}>
                  Input Image
                </Button>
                <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => addNodeAtViewportCenter("model.groundingdino")}>
                  GroundingDINO
                </Button>
                <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => addNodeAtViewportCenter("model.sam2")}>
                  SAM2
                </Button>
              </div>
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
                        {selectedNode.type === "model.sam2" ? (
                          <p className="text-xs text-cyan-300">
                            Mode:{" "}
                            {selectedNode.data.runtimeMode === "guided"
                              ? "Guided segmentation (from GroundingDINO)"
                              : "Full segmentation"}
                          </p>
                        ) : null}
                        {selectedNode.data.runtimeWarning ? (
                          <p className="text-xs text-amber-300">{selectedNode.data.runtimeWarning}</p>
                        ) : null}
                      </div>
                      <Separator className="mb-3" />
                      {canNodeRun(selectedNode) ? (
                        <Button className="mb-3 w-full rounded-xl" onClick={() => startRun(selectedNode.id)}>
                          <Play className="mr-1 h-4 w-4" /> Run this node (+ dependencies)
                        </Button>
                      ) : selectedNode.type === "input.image" ? (
                        <div className="mb-3 rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-xs text-zinc-400">
                          Run is available only when source mode is <span className="text-zinc-200">generate</span>.
                        </div>
                      ) : null}
                      <Button
                        className="mb-3 w-full rounded-xl"
                        variant="outline"
                        onClick={() => deleteNodesByIds([selectedNode.id])}
                      >
                        <Trash2 className="mr-1 h-4 w-4" /> Delete this node
                      </Button>
                      <ScrollArea className="h-[44vh] pr-2">
                        <div className="space-y-3">
                          {spec.paramFields.length === 0 ? (
                            <p className="text-sm text-muted-foreground">No editable parameters.</p>
                          ) : (
                            spec.paramFields.map((field) => {
                              const inputSourceMode =
                                selectedNode.type === "input.image" && selectedNode.data.params?.sourceMode === "generate"
                                  ? "generate"
                                  : "upload";
                              if (
                                selectedNode.type === "input.image" &&
                                inputSourceMode === "upload" &&
                                (field.key === "generatorModel" || field.key === "prompt")
                              ) {
                                return null;
                              }
                              if (
                                selectedNode.type === "input.image" &&
                                inputSourceMode === "generate" &&
                                field.key === "storageKey"
                              ) {
                                return null;
                              }
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
                          {(selectedNode.type === "model.groundingdino" || selectedNode.type === "model.sam2") && selectedNodeArtifacts.length > 0 ? (
                            <div className="rounded-xl border border-border/70 bg-background/40 p-2.5">
                              <p className="mb-1.5 text-xs font-medium text-zinc-300">Latest artifacts</p>
                              <div className="space-y-1">
                                {selectedNodeArtifacts.slice(0, 4).map((artifact) => (
                                  <button
                                    key={`param-artifact-${artifact.id}`}
                                    type="button"
                                    onClick={() => window.open(`/api/artifacts/${artifact.id}`, "_blank")}
                                    className="block w-full rounded-lg border border-border/70 bg-background/45 px-2 py-1 text-left text-xs text-zinc-300 transition hover:bg-accent"
                                  >
                                    {artifact.outputId} • {artifact.kind}
                                  </button>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </ScrollArea>
                    </>
                  )}
                </TabsContent>

                <TabsContent value="outputs" className="mt-3 space-y-3">
                  {!selectedNode || selectedNodeArtifacts.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No output for selected node yet.</p>
                  ) : (
                    <>
                      <Card className="rounded-xl border-primary/35 bg-primary/5">
                        <CardContent className="space-y-2 p-3 text-sm">
                          <p className="font-medium text-white">Visible outputs</p>
                          <div className="space-y-2">
                            {visibleNodeArtifacts.map((artifact) => (
                              <div key={`artifact-visible-${artifact.id}`} className="rounded-lg border border-border/70 bg-background/45 p-2">
                                <p className="text-xs text-zinc-200">
                                  {artifact.outputId} • {artifact.kind}
                                </p>
                                <div className="mt-1 flex gap-2">
                                  {artifact.kind === "mesh_glb" || artifact.kind === "point_ply" || artifact.kind === "splat_ksplat" ? (
                                    <Button
                                      size="sm"
                                      className="rounded-lg"
                                      onClick={() => window.open(`/app/p/${projectId}/viewer?artifactId=${artifact.id}`, "_blank")}
                                    >
                                      Open viewer
                                    </Button>
                                  ) : null}
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="rounded-lg"
                                    onClick={() => window.open(`/api/artifacts/${artifact.id}`, "_blank")}
                                  >
                                    Meta
                                  </Button>
                                </div>
                              </div>
                            ))}
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

                      {advancedNodeArtifacts.length > 0 ? (
                        <div className="space-y-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="rounded-lg"
                            onClick={() => setShowAdvancedInspector((value) => !value)}
                          >
                            {showAdvancedInspector ? "Hide Advanced Outputs" : "Show Advanced Outputs"}
                          </Button>
                          {showAdvancedInspector ? (
                            <Card className="rounded-xl border-border/70 bg-background/45">
                              <CardContent className="space-y-2 p-3">
                                {advancedNodeArtifacts.map((artifact) => (
                                  <div key={`artifact-hidden-${artifact.id}`} className="rounded-lg border border-border/70 bg-background/60 p-2">
                                    <p className="text-xs text-zinc-300">
                                      {artifact.outputId} • {artifact.kind} (hidden)
                                    </p>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="mt-1 rounded-lg"
                                      onClick={() => window.open(`/api/artifacts/${artifact.id}`, "_blank")}
                                    >
                                      Open JSON/meta
                                    </Button>
                                  </div>
                                ))}
                              </CardContent>
                            </Card>
                          ) : null}
                        </div>
                      ) : null}
                    </>
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

        <div className="canvas-dot-bg relative min-h-0 flex-1 bg-[#06080f]" ref={canvasPanelRef} onDoubleClick={onCanvasDoubleClick}>
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
              <MapIcon className="h-4 w-4" />
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
              <div className="mb-2 rounded-xl border border-white/10 bg-white/[0.015] p-2">
                <p className="mb-1 text-xs text-zinc-500">Quick Add</p>
                <div className="grid grid-cols-3 gap-1">
                  <button
                    type="button"
                    onClick={() => addNodeFromContextMenu("input.image")}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-200 transition hover:bg-white/10"
                  >
                    Input
                  </button>
                  <button
                    type="button"
                    onClick={() => addNodeFromContextMenu("model.groundingdino")}
                    className="rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-200 transition hover:bg-white/10"
                  >
                    DINO
                  </button>
                  <button
                    type="button"
                    onClick={() => addNodeFromContextMenu("model.sam2")}
                    className="rounded-lg border border-emerald-400/35 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-200 transition hover:bg-emerald-400/20"
                  >
                    SAM2
                  </button>
                </div>
              </div>

              <ScrollArea className="max-h-[24rem] pr-2">
                <div className="space-y-2">
                  {contextMenuGroups.map((group) => (
                    <button
                      key={`ctx-${group.category}`}
                      type="button"
                      onClick={() => {
                        setActiveMenuCategory(group.category);
                        setMenuSearch("");
                      }}
                      className={`flex w-full items-center justify-between rounded-xl border px-2.5 py-2 text-left transition ${
                        activeMenuCategory === group.category
                          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                          : "border-white/10 bg-white/[0.015] text-zinc-300 hover:bg-white/[0.05]"
                      }`}
                    >
                      <span className="text-sm">{categoryLabelMap[group.category]}</span>
                      <span className="inline-flex items-center gap-1">
                        <span className="text-[10px] text-zinc-500">{group.specs.length}</span>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </button>
                  ))}
                </div>
              </ScrollArea>

              <div className="mt-3 flex items-center justify-between border-t border-white/10 px-1 pt-2 text-xs text-zinc-500">
                <span>↕ Navigate</span>
                <span>↵ Select</span>
              </div>

              {activeMenuGroup ? (
                <div className="absolute left-full top-0 ml-2 w-80 rounded-2xl border border-white/10 bg-[#151515]/95 p-3 shadow-[0_30px_80px_rgba(0,0,0,0.65)] backdrop-blur-md">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs text-zinc-400">{categoryLabelMap[activeMenuGroup.category]}</p>
                    <button
                      type="button"
                      onClick={() => setActiveMenuCategory(null)}
                      className="rounded-md border border-white/10 px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-white/[0.06]"
                    >
                      Close
                    </button>
                  </div>
                  <Input
                    value={menuSearch}
                    onChange={(event) => setMenuSearch(event.target.value)}
                    className="mb-2 h-8 rounded-lg border-white/10 bg-black/35 text-xs"
                    placeholder={`Search ${activeMenuGroup.category.toLowerCase()}...`}
                  />
                  <ScrollArea className="max-h-[25rem] pr-2">
                    <div className="space-y-1">
                      {filteredActiveMenuSpecs.map((spec) => {
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
                      {filteredActiveMenuSpecs.length === 0 ? (
                        <p className="px-2 py-6 text-center text-xs text-zinc-500">No nodes found.</p>
                      ) : null}
                    </div>
                  </ScrollArea>
                </div>
              ) : null}
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
