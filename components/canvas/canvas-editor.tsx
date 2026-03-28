"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  Background,
  Connection,
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
  Type,
  WandSparkles,
  Zap,
  ZoomIn
} from "lucide-react";

import { WorkflowNode } from "@/components/canvas/workflow-node";
import { FlowingEdge } from "@/components/canvas/flowing-edge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { findFirstCompatibleHandles, validateConnectionByNodeTypes } from "@/lib/graph/connection-rules";
import { migrateGraphDocument } from "@/lib/graph/migrations";
import {
  mergeNodeParamsWithDefaults,
  nodeGroups,
  nodeSpecRegistry
} from "@/lib/graph/node-specs";
import { applySceneGenerationPreset } from "@/lib/graph/scene-generation-presets";
import { workflowPresets } from "@/lib/graph/workflow-presets";
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

interface PendingConnectState {
  nodeId: string;
  handleId: string | null;
  handleType: "source" | "target";
}

interface NodeContextMenuState {
  nodeId: string;
  x: number;
  y: number;
}

type ContextMenuCategory = "Inputs" | "Models" | "Geometry" | "Outputs";

const nodeTypes = {
  "input.image": WorkflowNode,
  "input.text": WorkflowNode,
  "input.cameraPath": WorkflowNode,
  "viewer.environment": WorkflowNode,
  "model.groundingdino": WorkflowNode,
  "model.sam2": WorkflowNode,
  "model.sam3d_objects": WorkflowNode,
  "pipeline.scene_generation": WorkflowNode,
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

const edgeTypes = {
  flowing: FlowingEdge
};

const defaultEdgeOptions = {
  type: "flowing",
  animated: false,
  style: { stroke: "rgba(145, 145, 145, 0.65)", strokeWidth: 1.4 }
};

const connectionLineStyle = { stroke: "rgba(169, 169, 169, 0.75)", strokeWidth: 1.35 };
const proOptions = { hideAttribution: true };
const miniMapStyle = { background: "rgba(26,26,26,0.96)" };

const shortcutByNodeType: Partial<Record<WorkflowNodeType, string>> = {
  "input.text": "T",
  "input.image": "I",
  "input.cameraPath": "C",
  "viewer.environment": "H",
  "model.groundingdino": "G",
  "model.sam2": "S",
  "model.sam3d_objects": "3",
  "pipeline.scene_generation": "W",
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
  if (type.startsWith("viewer.environment")) return Sparkles;
  if (type.startsWith("model.groundingdino")) return Scan;
  if (type.startsWith("model.sam")) return Boxes;
  if (type.startsWith("pipeline.scene_generation")) return Boxes;
  if (type.startsWith("model.")) return WandSparkles;
  if (type.startsWith("out.")) return ExternalLink;
  if (type.startsWith("geo.")) return Sparkles;
  return Sparkles;
}

type OutputArtifactView = NonNullable<GraphNodeData["outputArtifacts"]>[string];
type OutputArtifactHistoryView = NonNullable<GraphNodeData["outputArtifactHistory"]>;
type ScenePreviewStageView = NonNullable<GraphNodeData["scenePreviewStages"]>[string];
const LATEST_ARTIFACT_SENTINEL = "__latest__";

function parseTemplateHostNodeId(artifact: NodeArtifact) {
  const meta = artifact.meta;
  if (meta && typeof meta.templateHostNodeId === "string" && meta.templateHostNodeId.trim().length > 0) {
    return meta.templateHostNodeId.trim();
  }
  const marker = "::template.";
  const markerIndex = artifact.nodeId.indexOf(marker);
  if (markerIndex > 0) {
    return artifact.nodeId.slice(0, markerIndex);
  }
  return null;
}

function parseTemplateNodeId(artifact: NodeArtifact) {
  const meta = artifact.meta;
  if (!meta || typeof meta.templateNodeId !== "string") return "";
  return meta.templateNodeId.trim();
}

function mapArtifactView(artifact: NodeArtifact): OutputArtifactView {
  return {
    id: artifact.id,
    kind: artifact.kind,
    hidden: Boolean(artifact.hidden),
    url: artifact.url ?? null,
    previewUrl: artifact.previewUrl ?? null,
    createdAt: artifact.createdAt
  };
}

function buildOutputArtifactHistory(artifacts: NodeArtifact[]): OutputArtifactHistoryView {
  const grouped = artifacts.reduce<OutputArtifactHistoryView>((acc, artifact) => {
    const outputKey = artifact.outputKey ?? "default";
    if (!acc[outputKey]) acc[outputKey] = [];
    if (!acc[outputKey].some((entry) => entry.id === artifact.id)) {
      acc[outputKey].push(mapArtifactView(artifact));
    }
    return acc;
  }, {});

  for (const outputKey of Object.keys(grouped)) {
    grouped[outputKey] = grouped[outputKey]
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
      .slice(0, 40);
  }

  return grouped;
}

function resolveSelectedOutputArtifacts(
  history: OutputArtifactHistoryView,
  params: Record<string, unknown>
) {
  const selected: Record<string, OutputArtifactView> = {};
  for (const [outputKey, entries] of Object.entries(history)) {
    if (entries.length === 0) continue;
    const selectionKey = `__selectedArtifact__${outputKey}`;
    const selectionRaw = params?.[selectionKey];
    const selectedArtifactId =
      typeof selectionRaw === "string" && selectionRaw.trim().length > 0 && selectionRaw !== LATEST_ARTIFACT_SENTINEL
        ? selectionRaw.trim()
        : null;
    selected[outputKey] = selectedArtifactId
      ? entries.find((entry) => entry.id === selectedArtifactId) ?? entries[0]
      : entries[0];
  }
  return selected;
}

function mergeOutputArtifactHistory(
  current: GraphNodeData["outputArtifactHistory"] | undefined,
  incoming: OutputArtifactHistoryView
) {
  const merged: OutputArtifactHistoryView = {};
  const keys = new Set<string>([...Object.keys(current ?? {}), ...Object.keys(incoming)]);
  for (const key of keys) {
    const combined = [...(incoming[key] ?? []), ...(current?.[key] ?? [])];
    const deduped: OutputArtifactView[] = [];
    const seen = new Set<string>();
    for (const entry of combined) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      deduped.push(entry);
    }
    merged[key] = deduped
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
      .slice(0, 40);
  }
  return merged;
}

function toScenePreviewStage(label: string, artifact: NodeArtifact): ScenePreviewStageView {
  return {
    id: artifact.id,
    kind: artifact.kind,
    label,
    hidden: Boolean(artifact.hidden),
    outputKey: artifact.outputKey ?? "default",
    url: artifact.url ?? null,
    previewUrl: artifact.previewUrl ?? null,
    createdAt: artifact.createdAt
  };
}

function buildSceneGenerationPreviewStages(nodeId: string, artifacts: NodeArtifact[]) {
  const relevant = artifacts
    .filter((artifact) => artifact.nodeId === nodeId || parseTemplateHostNodeId(artifact) === nodeId)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  if (relevant.length === 0) return null;

  const directArtifacts = relevant.filter((artifact) => artifact.nodeId === nodeId);
  const internalArtifacts = relevant.filter((artifact) => artifact.nodeId !== nodeId);

  const finalCandidate =
    directArtifacts.find((artifact) => (artifact.outputKey ?? "default") === "generatedScene") ??
    directArtifacts.find((artifact) => (artifact.outputKey ?? "default") === "scene") ??
    internalArtifacts.find(
      (artifact) =>
        parseTemplateNodeId(artifact) === "custom" &&
        ((artifact.outputKey ?? "default") === "scene" || (artifact.outputKey ?? "default") === "generatedScene")
    ) ??
    directArtifacts.find((artifact) => !artifact.hidden) ??
    directArtifacts[0] ??
    null;

  const detectionCandidate =
    internalArtifacts.find(
      (artifact) => parseTemplateNodeId(artifact) === "detect" && (artifact.outputKey ?? "default") === "descriptor"
    ) ?? null;

  const segmentationCandidate =
    internalArtifacts.find(
      (artifact) => parseTemplateNodeId(artifact) === "segment" && (artifact.outputKey ?? "default") === "overlay"
    ) ??
    internalArtifacts.find(
      (artifact) => parseTemplateNodeId(artifact) === "segment" && (artifact.outputKey ?? "default") === "config"
    ) ??
    null;

  const stages: Record<string, ScenePreviewStageView> = {};
  if (finalCandidate) {
    stages.final = toScenePreviewStage("Final scene", finalCandidate);
  }
  if (detectionCandidate) {
    stages.detection = toScenePreviewStage("Detection", detectionCandidate);
  }
  if (segmentationCandidate) {
    stages.segmentation = toScenePreviewStage("Segmentation", segmentationCandidate);
  }
  return Object.keys(stages).length > 0 ? stages : null;
}

function buildNodeData(base: Node<GraphNodeData>, artifacts: NodeArtifact[]) {
  const nodeType = base.type as WorkflowNodeType;
  const spec = nodeSpecRegistry[nodeType];
  const mergedParams = mergeNodeParamsWithDefaults(nodeType, base.data.params);
  const matched = artifacts
    .filter((a) => a.nodeId === base.id)
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());

  const outputArtifactHistory = buildOutputArtifactHistory(matched);
  const outputArtifacts = resolveSelectedOutputArtifacts(outputArtifactHistory, mergedParams);

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
  const scenePreviewStages =
    nodeType === "pipeline.scene_generation"
      ? buildSceneGenerationPreviewStages(base.id, artifacts)
      : null;
  const selectedScenePreviewStage =
    nodeType === "pipeline.scene_generation" && typeof mergedParams.ScenePreviewStage === "string"
      ? mergedParams.ScenePreviewStage
      : "final";
  const selectedScenePreview =
    scenePreviewStages?.[selectedScenePreviewStage] ??
    scenePreviewStages?.final ??
    null;
  const resolvedPreviewArtifact = selectedScenePreview ?? previewArtifact;

  const runtimeMetaCandidate = matched.find((artifact) => artifact.outputKey === "meta")?.meta ?? matched[0]?.meta ?? null;
  const runtimeMode = runtimeMetaCandidate && typeof runtimeMetaCandidate.mode === "string" ? runtimeMetaCandidate.mode : undefined;
  const runtimeWarning =
    runtimeMetaCandidate && Array.isArray(runtimeMetaCandidate.warnings) && runtimeMetaCandidate.warnings.length > 0
      ? String(runtimeMetaCandidate.warnings[0])
      : runtimeMetaCandidate && typeof runtimeMetaCandidate.warning === "string"
        ? runtimeMetaCandidate.warning
        : null;
  const inputNodeStorageKey =
    nodeType === "input.image" && typeof mergedParams.storageKey === "string"
      ? mergedParams.storageKey.trim()
      : "";
  const inputNodePreviewUrl = inputNodeStorageKey
    ? `/api/storage/object?key=${encodeURIComponent(inputNodeStorageKey)}`
    : null;

  return {
    // Keep only stable graph fields to avoid reusing persisted runtime node dimensions/styles.
    id: base.id,
    type: base.type,
    position: base.position,
    data: {
      ...base.data,
      label: typeof base.data.label === "string" && base.data.label.trim().length > 0 ? base.data.label : spec.title,
      params: mergedParams,
      status: base.data.status ?? "idle",
      latestArtifactId: resolvedPreviewArtifact?.id,
      latestArtifactKind: resolvedPreviewArtifact?.kind,
      previewUrl:
        resolvedPreviewArtifact?.previewUrl ??
        resolvedPreviewArtifact?.url ??
        inputNodePreviewUrl ??
        (nodeType === "input.image" && typeof base.data.previewUrl === "string" ? base.data.previewUrl : null),
      outputArtifacts,
      outputArtifactHistory: Object.keys(outputArtifactHistory).length > 0 ? outputArtifactHistory : undefined,
      scenePreviewStages: scenePreviewStages ?? undefined,
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
    type: edge.type ?? "flowing",
    animated: edge.animated ?? false,
    style: {
      stroke: "rgba(176, 191, 221, 0.42)",
      strokeWidth: 1.45,
      ...(edge.style ?? {})
    }
  };
}

function GraphCanvasInner({ projectId, projectName, initialGraph, versions: initialVersions, nodeArtifacts }: CanvasEditorProps) {
  const reactFlow = useReactFlow();
  const migratedInitialGraph = useMemo(() => migrateGraphDocument(initialGraph), [initialGraph]);
  const wrappedNodes = migratedInitialGraph.nodes.map((n) => buildNodeData(n as Node<GraphNodeData>, nodeArtifacts));
  const wrappedEdges = migratedInitialGraph.edges.map((edge) => withStyledEdge(edge as Edge));

  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNodeData>(wrappedNodes as Node<GraphNodeData>[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState(wrappedEdges);
  const [versions, setVersions] = useState(initialVersions);
  const snapToGrid = true;
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
  const [inspectedJsonArtifactId, setInspectedJsonArtifactId] = useState<string | null>(null);
  const [inspectedJsonContent, setInspectedJsonContent] = useState<string | null>(null);
  const [inspectedJsonError, setInspectedJsonError] = useState<string | null>(null);
  const [inspectedJsonLoading, setInspectedJsonLoading] = useState(false);
  const [paneMenu, setPaneMenu] = useState<PaneContextMenuState | null>(null);
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenuState | null>(null);
  const [pendingConnect, setPendingConnect] = useState<PendingConnectState | null>(null);
  const [activeMenuCategory, setActiveMenuCategory] = useState<ContextMenuCategory | null>(null);
  const [menuSearch, setMenuSearch] = useState("");
  const [showMiniMap, setShowMiniMap] = useState(true);
  const runPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runNodeRef = useRef<(nodeId: string) => void>(() => {});
  const uploadNodeRef = useRef<(nodeId: string, file: File) => void>(() => {});
  const updateNodeParamRef = useRef<(nodeId: string, key: string, value: string | number | boolean) => void>(() => {});
  const openViewerRef = useRef<(payload?: { artifactId?: string; nodeId?: string }) => void>(() => {});
  const canvasPanelRef = useRef<HTMLDivElement>(null);
  const paneMenuRef = useRef<HTMLDivElement>(null);
  const nodeMenuRef = useRef<HTMLDivElement>(null);
  const suppressNextPaneClickRef = useRef(false);
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didHydrateDraftRef = useRef(false);
  const draftStorageKey = useMemo(() => `tribalai.canvas.draft.${projectId}`, [projectId]);

  const selectedNode = useMemo(() => nodes.find((n) => n.selected), [nodes]);
  const hasNodeSelection = useMemo(() => nodes.some((n) => n.selected), [nodes]);
  const hasEdgeSelection = useMemo(() => edges.some((edge) => edge.selected), [edges]);
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
    setNodes((prev) => {
      const byId = new Map(prev.map((node) => [node.id, node]));
      const hasDescriptorByNode = new Set<string>();
      const hasImageByNode = new Set<string>();
      const previewArtifactByNode = new Map<
        string,
        {
          id: string;
          kind: string;
          previewUrl: string | null;
          url: string | null;
          hidden?: boolean;
          createdAt?: string;
        }
      >();

      for (const edge of edges) {
        const targetNode = byId.get(edge.target);
        if (!targetNode) continue;
        const targetType = targetNode.type as WorkflowNodeType;
        const targetSpec = nodeSpecRegistry[targetType];
        const inferredTargetHandle = edge.targetHandle ?? targetSpec.inputPorts[0]?.id;

        if (inferredTargetHandle === "descriptor" || inferredTargetHandle === "boxes" || inferredTargetHandle === "boxesConfig") {
          hasDescriptorByNode.add(edge.target);
        }
        if (inferredTargetHandle === "image") {
          hasImageByNode.add(edge.target);
        }

        if (targetType === "out.open_in_viewer") {
          const sourceNode = byId.get(edge.source);
          if (!sourceNode) continue;
          const sourceType = sourceNode.type as WorkflowNodeType;
          const sourceSpec = nodeSpecRegistry[sourceType];
          const sourceOutputHandle = edge.sourceHandle ?? sourceSpec.outputPorts[0]?.id;
          const sourcePortArtifact = sourceOutputHandle
            ? sourceNode.data.outputArtifacts?.[sourceOutputHandle]
            : undefined;
          const fallbackArtifact =
            !sourcePortArtifact && sourceNode.data.latestArtifactId && sourceNode.data.latestArtifactKind
              ? {
                  id: sourceNode.data.latestArtifactId,
                  kind: sourceNode.data.latestArtifactKind,
                  previewUrl: sourceNode.data.previewUrl ?? null,
                  url: sourceNode.data.previewUrl ?? null,
                  hidden: false,
                  createdAt: sourceNode.data.lastRunAt
                }
              : undefined;
          const resolved = sourcePortArtifact ?? fallbackArtifact;
          if (!resolved?.id) continue;
          previewArtifactByNode.set(edge.target, {
            id: resolved.id,
            kind: resolved.kind,
            previewUrl: resolved.previewUrl ?? null,
            url: resolved.url ?? null,
            hidden: resolved.hidden,
            createdAt: resolved.createdAt
          });
        }
      }

      let changed = false;
      const next = prev.map((node) => {
        if (node.type === "model.sam2") {
          const nextHasBoxes = hasDescriptorByNode.has(node.id);
          const nextHasImage = hasImageByNode.has(node.id);
          if (
            node.data.hasBoxesConfigConnection === nextHasBoxes &&
            node.data.hasImageConnection === nextHasImage
          ) {
            return node;
          }
          changed = true;
          return {
            ...node,
            data: {
              ...node.data,
              hasBoxesConfigConnection: nextHasBoxes,
              hasImageConnection: nextHasImage
            }
          };
        }

        if (node.type === "out.open_in_viewer") {
          const previewArtifact = previewArtifactByNode.get(node.id);
          const nextLatestArtifactId = previewArtifact?.id;
          const nextLatestArtifactKind = previewArtifact?.kind;
          const nextPreviewUrl = previewArtifact?.previewUrl ?? previewArtifact?.url ?? null;
          const nextOutputArtifacts = previewArtifact
            ? ({
                artifact: {
                  id: previewArtifact.id,
                  kind: previewArtifact.kind,
                  hidden: Boolean(previewArtifact.hidden),
                  url: previewArtifact.url,
                  previewUrl: previewArtifact.previewUrl,
                  createdAt: previewArtifact.createdAt
                }
              } as NonNullable<GraphNodeData["outputArtifacts"]>)
            : undefined;

          const currentArtifactEntry = node.data.outputArtifacts?.artifact;
          const outputArtifactsUnchanged = previewArtifact
            ? currentArtifactEntry?.id === previewArtifact.id &&
              currentArtifactEntry?.kind === previewArtifact.kind &&
              (currentArtifactEntry?.previewUrl ?? null) === (previewArtifact.previewUrl ?? null) &&
              (currentArtifactEntry?.url ?? null) === (previewArtifact.url ?? null)
            : !node.data.outputArtifacts || Object.keys(node.data.outputArtifacts).length === 0;

          if (
            (node.data.latestArtifactId ?? undefined) === nextLatestArtifactId &&
            (node.data.latestArtifactKind ?? undefined) === nextLatestArtifactKind &&
            (node.data.previewUrl ?? null) === nextPreviewUrl &&
            outputArtifactsUnchanged
          ) {
            return node;
          }

          changed = true;
          return {
            ...node,
            data: {
              ...node.data,
              latestArtifactId: nextLatestArtifactId,
              latestArtifactKind: nextLatestArtifactKind,
              previewUrl: nextPreviewUrl,
              outputArtifacts: nextOutputArtifacts
            }
          };
        }

        return node;
      });
      return changed ? next : prev;
    });
  }, [edges, nodes, setNodes]);

  useEffect(() => {
    return () => {
      if (runPollRef.current) {
        clearInterval(runPollRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!paneMenu && !nodeMenu) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as globalThis.Node | null;
      if (target && paneMenuRef.current?.contains(target)) {
        return;
      }
      if (target && nodeMenuRef.current?.contains(target)) {
        return;
      }
      setPaneMenu(null);
      setNodeMenu(null);
    };

    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPaneMenu(null);
        setNodeMenu(null);
      }
    };

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onEscape);
    };
  }, [nodeMenu, paneMenu]);

  useEffect(() => {
    if (!paneMenu) {
      setActiveMenuCategory(null);
      setMenuSearch("");
      setPendingConnect(null);
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
      const migratedGraph = migrateGraphDocument(graph);

      const restoredNodes = migratedGraph.nodes.map((node) => {
        // Always use fresh artifact-backed URLs. Signed preview URLs from local draft can be stale after restart.
        const hydrated = buildNodeData(node as Node<GraphNodeData>, nodeArtifacts) as Node<GraphNodeData>;
        return hydrated;
      }) as Node<GraphNodeData>[];

      setNodes(restoredNodes);
      setEdges(migratedGraph.edges.map((edge) => withStyledEdge(edge as Edge)));
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

      const wantsDisconnectShortcut =
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "x";
      if (wantsDisconnectShortcut) {
        event.preventDefault();
        const selectedEdgeIds = edges.filter((edge) => edge.selected).map((edge) => edge.id);
        if (selectedEdgeIds.length > 0) {
          const edgeSet = new Set(selectedEdgeIds);
          setEdges((prev) => prev.filter((edge) => !edgeSet.has(edge.id)));
          toast({
            title: "Connections removed",
            description: selectedEdgeIds.length > 1 ? `${selectedEdgeIds.length} connections removed` : "1 connection removed"
          });
          return;
        }
        const selectedNodeIds = nodes.filter((node) => node.selected).map((node) => node.id);
        if (selectedNodeIds.length === 0) return;
        const nodeSet = new Set(selectedNodeIds);
        setEdges((prev) => prev.filter((edge) => !nodeSet.has(edge.source) && !nodeSet.has(edge.target)));
        const removedCount = edges.filter((edge) => nodeSet.has(edge.source) || nodeSet.has(edge.target)).length;
        toast({
          title: "Node disconnected",
          description: removedCount > 0 ? `${removedCount} connections removed` : "No connected edges to remove"
        });
        return;
      }

      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const selectedNodeIds = nodes.filter((node) => node.selected).map((node) => node.id);
      const selectedEdgeIds = edges.filter((edge) => edge.selected).map((edge) => edge.id);
      if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return;
      event.preventDefault();
      if (selectedNodeIds.length > 0) {
        const nodeSet = new Set(selectedNodeIds);
        setNodes((prev) => prev.filter((node) => !nodeSet.has(node.id)));
        setEdges((prev) => prev.filter((edge) => !nodeSet.has(edge.source) && !nodeSet.has(edge.target)));
      }
      if (selectedEdgeIds.length > 0) {
        const edgeSet = new Set(selectedEdgeIds);
        setEdges((prev) => prev.filter((edge) => !edgeSet.has(edge.id)));
      }
      const parts: string[] = [];
      if (selectedNodeIds.length > 0) {
        parts.push(selectedNodeIds.length > 1 ? `${selectedNodeIds.length} nodes` : "1 node");
      }
      if (selectedEdgeIds.length > 0) {
        parts.push(selectedEdgeIds.length > 1 ? `${selectedEdgeIds.length} connections` : "1 connection");
      }
      toast({ title: "Selection deleted", description: `${parts.join(" + ")} removed` });
    };

    window.addEventListener("keydown", onDeleteShortcut);
    return () => window.removeEventListener("keydown", onDeleteShortcut);
  }, [edges, nodes, setEdges, setNodes]);

  useEffect(() => {
    setShowAdvancedInspector(false);
  }, [selectedNode?.id]);

  useEffect(() => {
    setInspectedJsonArtifactId(null);
    setInspectedJsonContent(null);
    setInspectedJsonError(null);
    setInspectedJsonLoading(false);
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

  const isConnectionValid = useCallback(
    (connection: Connection | Edge) => {
      if (!connection.source || !connection.target) return false;
      const sourceNode = nodes.find((node) => node.id === connection.source);
      const targetNode = nodes.find((node) => node.id === connection.target);
      if (!sourceNode || !targetNode) return false;

      const result = validateConnectionByNodeTypes({
        sourceNodeType: sourceNode.type as WorkflowNodeType,
        targetNodeType: targetNode.type as WorkflowNodeType,
        sourceHandleId: connection.sourceHandle,
        targetHandleId: connection.targetHandle
      });
      return result.valid;
    },
    [nodes]
  );

  const onConnect = useCallback<OnConnect>(
    (params) => {
      if (!isConnectionValid(params as Connection)) {
        toast({ title: "Invalid connection", description: "Port artifact types are not compatible." });
        return;
      }
      setPendingConnect(null);
      setEdges((eds) =>
        addEdge(
          withStyledEdge({
            ...params,
            id: `${params.source}-${params.target}-${Date.now()}`
          } as Edge),
          eds
        )
      );
    },
    [isConnectionValid, setEdges]
  );

  const onConnectStart = useCallback((_event: unknown, params: { nodeId?: string | null; handleId?: string | null; handleType?: "source" | "target" | null }) => {
    if (!params?.nodeId || !params.handleType) {
      setPendingConnect(null);
      return;
    }
    setPendingConnect({
      nodeId: params.nodeId,
      handleId: params.handleId ?? null,
      handleType: params.handleType
    });
  }, []);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState?: { isValid: boolean }) => {
      if (!pendingConnect) return;
      if (connectionState?.isValid) {
        setPendingConnect(null);
        return;
      }

      const target = event.target as HTMLElement | null;
      const droppedInsideCanvas = canvasPanelRef.current?.contains(target ?? null) ?? false;
      const droppedOnUiElement = Boolean(
        target?.closest(
          ".react-flow__node, .react-flow__handle, .react-flow__edgeupdater, .react-flow__controls, .react-flow__minimap, .react-flow__attribution, [data-no-connect-menu='true']"
        )
      );
      if (!droppedInsideCanvas || droppedOnUiElement) {
        setPendingConnect(null);
        return;
      }

      const clientX =
        "clientX" in event
          ? event.clientX
          : event.changedTouches && event.changedTouches[0]
            ? event.changedTouches[0].clientX
            : null;
      const clientY =
        "clientY" in event
          ? event.clientY
          : event.changedTouches && event.changedTouches[0]
            ? event.changedTouches[0].clientY
            : null;

      if (typeof clientX !== "number" || typeof clientY !== "number") {
        setPendingConnect(null);
        return;
      }

      const rect = canvasPanelRef.current?.getBoundingClientRect();
      const flow = reactFlow.screenToFlowPosition({ x: clientX, y: clientY });
      if (!rect) {
        suppressNextPaneClickRef.current = true;
        setTimeout(() => {
          suppressNextPaneClickRef.current = false;
        }, 0);
        setPaneMenu({ x: clientX, y: clientY, flowX: flow.x, flowY: flow.y });
        return;
      }

      const menuWidth = 318;
      const menuHeight = 540;
      const rawX = clientX - rect.left;
      const rawY = clientY - rect.top;
      const x = Math.max(10, Math.min(rawX, rect.width - menuWidth - 10));
      const y = Math.max(10, Math.min(rawY, rect.height - menuHeight - 10));
      suppressNextPaneClickRef.current = true;
      setTimeout(() => {
        suppressNextPaneClickRef.current = false;
      }, 0);
      setPaneMenu({ x, y, flowX: flow.x, flowY: flow.y });
    },
    [pendingConnect, reactFlow]
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
            updateNodeParamRef.current(currentNodeId, key, value),
          onOpenViewer: (payload?: { artifactId?: string; nodeId?: string }) => openViewerRef.current(payload)
        }
      };
      setNodes((prev) => [...prev, newNode]);
      return id;
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

  const deleteEdgesByIds = useCallback(
    (edgeIds: string[]) => {
      if (edgeIds.length === 0) return;
      const edgeSet = new Set(edgeIds);
      setEdges((prev) => prev.filter((edge) => !edgeSet.has(edge.id)));
      toast({
        title: "Connection removed",
        description: edgeIds.length > 1 ? `${edgeIds.length} connections removed` : "1 connection removed"
      });
    },
    [setEdges]
  );

  const disconnectEdgesForNodeIds = useCallback(
    (nodeIds: string[]) => {
      if (nodeIds.length === 0) return;
      const nodeSet = new Set(nodeIds);
      const connectedEdgeIds = edges
        .filter((edge) => nodeSet.has(edge.source) || nodeSet.has(edge.target))
        .map((edge) => edge.id);
      if (connectedEdgeIds.length === 0) {
        toast({ title: "No connections", description: "Selected node has no connected edges." });
        return;
      }
      deleteEdgesByIds(connectedEdgeIds);
    },
    [deleteEdgesByIds, edges]
  );

  const deleteSelectedEdges = useCallback(() => {
    const selectedIds = edges.filter((edge) => edge.selected).map((edge) => edge.id);
    deleteEdgesByIds(selectedIds);
  }, [deleteEdgesByIds, edges]);

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
      setNodeMenu(null);
      setPendingConnect(null);
      openPaneMenuAtScreenPoint(event.clientX, event.clientY);
    },
    [openPaneMenuAtScreenPoint]
  );

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      if (suppressNextPaneClickRef.current) {
        return;
      }
      if (event.detail >= 2) {
        setNodeMenu(null);
        setPendingConnect(null);
        openPaneMenuAtScreenPoint(event.clientX, event.clientY);
        return;
      }
      setPaneMenu(null);
      setNodeMenu(null);
      setPendingConnect(null);
    },
    [openPaneMenuAtScreenPoint]
  );

  const onCanvasDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest(".react-flow__node")) return;
      setNodeMenu(null);
      openPaneMenuAtScreenPoint(event.clientX, event.clientY);
    },
    [openPaneMenuAtScreenPoint]
  );

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node<GraphNodeData>) => {
      event.preventDefault();
      setPaneMenu(null);
      setPendingConnect(null);
      setNodes((prev) =>
        prev.map((entry) => ({
          ...entry,
          selected: entry.id === node.id
        }))
      );

      const rect = canvasPanelRef.current?.getBoundingClientRect();
      if (!rect) {
        setNodeMenu({ nodeId: node.id, x: event.clientX, y: event.clientY });
        return;
      }
      const menuWidth = 220;
      const menuHeight = 150;
      const rawX = event.clientX - rect.left;
      const rawY = event.clientY - rect.top;
      const x = Math.max(10, Math.min(rawX, rect.width - menuWidth - 10));
      const y = Math.max(10, Math.min(rawY, rect.height - menuHeight - 10));
      setNodeMenu({ nodeId: node.id, x, y });
    },
    [setNodes]
  );

  const addNodeFromContextMenu = useCallback(
    (nodeType: WorkflowNodeType) => {
      if (!paneMenu) return;
      const newNodeId = addNode(nodeType, paneMenu.flowX, paneMenu.flowY);
      if (pendingConnect) {
        const pendingNode = nodes.find((node) => node.id === pendingConnect.nodeId);
        if (!pendingNode) {
          setPendingConnect(null);
          setPaneMenu(null);
          return;
        }
        if (pendingConnect.handleType === "source") {
          const pendingSourceType = pendingNode.type as WorkflowNodeType;
          const sourceHandle = pendingConnect.handleId ?? undefined;
          const compatible =
            sourceHandle
              ? nodeSpecRegistry[nodeType].inputPorts
                  .map((port) =>
                    validateConnectionByNodeTypes({
                      sourceNodeType: pendingSourceType,
                      targetNodeType: nodeType,
                      sourceHandleId: sourceHandle,
                      targetHandleId: port.id
                    })
                  )
                  .find((result) => result.valid)
              : findFirstCompatibleHandles(pendingSourceType, nodeType);

          if (compatible) {
            setEdges((prev) =>
              addEdge(
                withStyledEdge({
                  id: `${pendingConnect.nodeId}-${newNodeId}-${Date.now()}`,
                  source: pendingConnect.nodeId,
                  sourceHandle: compatible.sourceHandleId ?? sourceHandle,
                  target: newNodeId,
                  targetHandle: compatible.targetHandleId
                } as Edge),
                prev
              )
            );
          }
        } else {
          const pendingTargetType = pendingNode.type as WorkflowNodeType;
          const targetHandle = pendingConnect.handleId ?? undefined;
          const compatible =
            targetHandle
              ? nodeSpecRegistry[nodeType].outputPorts
                  .map((port) =>
                    validateConnectionByNodeTypes({
                      sourceNodeType: nodeType,
                      targetNodeType: pendingTargetType,
                      sourceHandleId: port.id,
                      targetHandleId: targetHandle
                    })
                  )
                  .find((result) => result.valid)
              : findFirstCompatibleHandles(nodeType, pendingTargetType);

          if (compatible) {
            setEdges((prev) =>
              addEdge(
                withStyledEdge({
                  id: `${newNodeId}-${pendingConnect.nodeId}-${Date.now()}`,
                  source: newNodeId,
                  sourceHandle: compatible.sourceHandleId,
                  target: pendingConnect.nodeId,
                  targetHandle: compatible.targetHandleId ?? targetHandle
                } as Edge),
                prev
              )
            );
          }
        }
      }
      setPendingConnect(null);
      setPaneMenu(null);
    },
    [addNode, nodes, paneMenu, pendingConnect, setEdges]
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
    setNodeMenu(null);
    if (paneMenu) {
      setPaneMenu(null);
      return;
    }
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
  }, [openPaneMenuAtScreenPoint, paneMenu, reactFlow]);

  const resolvePresetAnchor = useCallback(
    (baseAnchor: { x: number; y: number }) => {
      let candidate = { ...baseAnchor };
      const collides = (anchor: { x: number; y: number }) =>
        nodes.some((node) => Math.abs(node.position.x - anchor.x) < 340 && Math.abs(node.position.y - anchor.y) < 220);

      let attempts = 0;
      while (attempts < 16 && collides(candidate)) {
        candidate = {
          x: candidate.x + (attempts % 2 === 0 ? 34 : -22),
          y: candidate.y + 210
        };
        attempts += 1;
      }
      return candidate;
    },
    [nodes]
  );

  const insertWorkflowPreset = useCallback(
    (presetId: string) => {
      const preset = workflowPresets.find((entry) => entry.id === presetId);
      if (!preset) return;

      const rect = canvasPanelRef.current?.getBoundingClientRect();
      const viewportCenter = rect
        ? reactFlow.screenToFlowPosition({
            x: rect.left + rect.width * 0.5,
            y: rect.top + rect.height * 0.5
          })
        : { x: 120, y: 120 };
      const anchor = resolvePresetAnchor(viewportCenter);

      const stamp = Date.now();
      let serial = 0;
      const createNodeId = (nodeType: WorkflowNodeType) => {
        serial += 1;
        return `${nodeType}-${(stamp + serial).toString(36)}`;
      };

      const built = preset.buildNodesAndEdges({
        anchor,
        createNodeId,
        uiScale: nodeScalePreset
      });

      const builtNodes = built.nodes.map((node) => node as unknown as Node<GraphNodeData>);
      const builtEdges = built.edges.map((edge) => withStyledEdge(edge as Edge));
      setNodes((prev) => [...prev, ...builtNodes]);
      setEdges((prev) => [...prev, ...builtEdges]);
      toast({ title: "Workflow inserted", description: `${preset.label} starter added to canvas.` });
    },
    [nodeScalePreset, reactFlow, resolvePresetAnchor, setEdges, setNodes]
  );

  const updateNodeParamById = useCallback(
    (nodeId: string, key: string, value: string | number | boolean) => {
      if (!nodeId) return;
      setNodes((prev) =>
        prev.map((node) => {
          if (node.id !== nodeId) return node;
          const nodeType = node.type as WorkflowNodeType;
          const spec = nodeSpecRegistry[nodeType];
          const nextParams = {
            ...node.data.params,
            [key]: value
          } as Record<string, unknown>;

          if (nodeType === "model.sam3d_objects") {
            if (key === "configPreset" && typeof value === "string") {
              const applied = applySceneGenerationPreset(nextParams, value as "Default" | "HighQuality" | "FastPreview" | "Custom");
              const outputArtifacts = node.data.outputArtifactHistory
                ? resolveSelectedOutputArtifacts(node.data.outputArtifactHistory, applied)
                : node.data.outputArtifacts;
              const hiddenOutputIds = new Set(spec.ui?.hiddenOutputIds ?? []);
              const previewArtifact =
                (spec.ui?.previewOutputIds ?? [])
                  .map((outputId) => outputArtifacts?.[outputId])
                  .find((artifact) => Boolean(artifact?.id)) ??
                Object.entries(outputArtifacts ?? {})
                  .filter(([outputId, artifact]) => !artifact.hidden && !hiddenOutputIds.has(outputId))
                  .sort((a, b) => new Date(b[1].createdAt ?? 0).getTime() - new Date(a[1].createdAt ?? 0).getTime())[0]?.[1] ??
                Object.values(outputArtifacts ?? {})[0] ??
                null;
              return {
                ...node,
                data: {
                  ...node.data,
                  params: applied,
                  outputArtifacts: outputArtifacts && Object.keys(outputArtifacts).length > 0 ? outputArtifacts : node.data.outputArtifacts,
                  latestArtifactId: previewArtifact?.id ?? node.data.latestArtifactId,
                  latestArtifactKind: previewArtifact?.kind ?? node.data.latestArtifactKind,
                  previewUrl: previewArtifact?.previewUrl ?? previewArtifact?.url ?? node.data.previewUrl ?? null
                }
              };
            }

            if (key !== "configPreset" && nextParams.configPreset !== "Custom") {
              nextParams.configPreset = "Custom";
            }
          }

          const outputArtifacts = node.data.outputArtifactHistory
            ? resolveSelectedOutputArtifacts(node.data.outputArtifactHistory, nextParams)
            : node.data.outputArtifacts;
          const hiddenOutputIds = new Set(spec.ui?.hiddenOutputIds ?? []);
          const previewArtifact =
            (spec.ui?.previewOutputIds ?? [])
              .map((outputId) => outputArtifacts?.[outputId])
              .find((artifact) => Boolean(artifact?.id)) ??
            Object.entries(outputArtifacts ?? {})
              .filter(([outputId, artifact]) => !artifact.hidden && !hiddenOutputIds.has(outputId))
              .sort((a, b) => new Date(b[1].createdAt ?? 0).getTime() - new Date(a[1].createdAt ?? 0).getTime())[0]?.[1] ??
            Object.values(outputArtifacts ?? {})[0] ??
            null;
          const selectedScenePreviewStage =
            nodeType === "pipeline.scene_generation" && typeof nextParams.ScenePreviewStage === "string"
              ? nextParams.ScenePreviewStage
              : "final";
          const selectedScenePreview =
            nodeType === "pipeline.scene_generation"
              ? node.data.scenePreviewStages?.[selectedScenePreviewStage] ?? node.data.scenePreviewStages?.final ?? null
              : null;
          const resolvedPreviewArtifact = selectedScenePreview ?? previewArtifact;

          return {
            ...node,
            data: {
              ...node.data,
              params: nextParams,
              outputArtifacts: outputArtifacts && Object.keys(outputArtifacts).length > 0 ? outputArtifacts : node.data.outputArtifacts,
              latestArtifactId: resolvedPreviewArtifact?.id ?? node.data.latestArtifactId,
              latestArtifactKind: resolvedPreviewArtifact?.kind ?? node.data.latestArtifactKind,
              previewUrl: resolvedPreviewArtifact?.previewUrl ?? resolvedPreviewArtifact?.url ?? node.data.previewUrl ?? null
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
    targetNodeId: string | null,
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
    const sourceResolved = new Set<string>();
    const errored = new Set<string>();
    const groupedArtifacts = artifactPairs.reduce<Record<string, typeof artifactPairs>>((acc, artifact) => {
      if (!acc[artifact.nodeId]) acc[artifact.nodeId] = [];
      acc[artifact.nodeId].push(artifact);
      return acc;
    }, {});

    lines.forEach((line) => {
      const executedMatch = line.match(/\] (.+) executed/);
      const cacheMatch = line.match(/\] (.+) cache-hit/);
      const sourceResolvedMatch = line.match(/\] (.+) source-resolved/);
      if (executedMatch?.[1]) executed.add(executedMatch[1]);
      if (cacheMatch?.[1]) cached.add(cacheMatch[1]);
      if (sourceResolvedMatch?.[1]) sourceResolved.add(sourceResolvedMatch[1]);
      if (line.includes("ERROR")) {
        const maybeNode = nodes.find((n) => line.includes(n.id));
        if (maybeNode) errored.add(maybeNode.id);
      }
    });

    setNodes((prev) => {
      const hasRunningOrQueued = status === "running" || status === "queued";
      return prev.map((node) => {
        if (targetNodeId && node.id !== targetNodeId) {
          return node;
        }

        const nodeType = node.type as WorkflowNodeType;
        const spec = nodeSpecRegistry[nodeType];
        const nodeArtifacts = [...(groupedArtifacts[node.id] ?? [])].sort(
          (a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()
        );
        const runHistory = buildOutputArtifactHistory(nodeArtifacts);
        const mergedHistory = mergeOutputArtifactHistory(node.data.outputArtifactHistory, runHistory);
        const artifactByOutput = resolveSelectedOutputArtifacts(mergedHistory, node.data.params ?? {});

        const previewArtifact =
          (spec.ui?.previewOutputIds ?? [])
            .map((outputId) => artifactByOutput[outputId])
            .find((artifact) => Boolean(artifact?.id)) ??
          Object.values(artifactByOutput).find((artifact) => !artifact.hidden) ??
          Object.values(artifactByOutput)[0];
        const scenePreviewStages =
          nodeType === "pipeline.scene_generation"
            ? buildSceneGenerationPreviewStages(node.id, artifactPairs)
            : null;
        const selectedScenePreviewStage =
          nodeType === "pipeline.scene_generation" && typeof node.data.params?.ScenePreviewStage === "string"
            ? node.data.params.ScenePreviewStage
            : "final";
        const selectedScenePreview =
          scenePreviewStages?.[selectedScenePreviewStage] ??
          scenePreviewStages?.final ??
          null;
        const resolvedPreviewArtifact = selectedScenePreview ?? previewArtifact;

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
        else if (sourceResolved.has(node.id)) runtimeStatus = "success";
        else if (executed.has(node.id)) runtimeStatus = "success";
        else if (hasRunningOrQueued && node.data.status === "running") runtimeStatus = "running";

        return {
          ...node,
          data: {
            ...node.data,
            status: runtimeStatus,
            runProgress: runtimeStatus === "running" ? runProgress : runtimeStatus === "success" || runtimeStatus === "cache-hit" ? 100 : 0,
            latestArtifactId: resolvedPreviewArtifact?.id ?? node.data.latestArtifactId,
            latestArtifactKind: resolvedPreviewArtifact?.kind ?? node.data.latestArtifactKind,
            previewUrl: resolvedPreviewArtifact?.previewUrl ?? resolvedPreviewArtifact?.url ?? node.data.previewUrl ?? null,
            outputArtifacts: Object.keys(artifactByOutput).length > 0 ? artifactByOutput : node.data.outputArtifacts,
            outputArtifactHistory:
              Object.keys(mergedHistory).length > 0 ? mergedHistory : node.data.outputArtifactHistory,
            scenePreviewStages:
              scenePreviewStages && Object.keys(scenePreviewStages).length > 0
                ? scenePreviewStages
                : node.data.scenePreviewStages,
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

  const pollRun = (runId: string, targetNodeId: string | null) => {
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
        targetNodeId,
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
        const logLines = String(data.run.logs ?? "")
          .split("\n")
          .map((line: string) => line.trim())
          .filter(Boolean);
        const descriptionBase = `Run ${runId.slice(0, 8)}`;
        let description = descriptionBase;

        if (data.run.status === "success") {
          const executedLine = [...logLines].reverse().find((line) => line.includes(" executed "));
          if (executedLine) {
            const nodeMatch = executedLine.match(/\]\s+([^\s]+)\s+executed/);
            const outputsMatch = executedLine.match(/outputs=([^\s]+)/);
            const warningsMatch = executedLine.match(/warnings=(.+)$/);
            const nodeText = nodeMatch?.[1] ?? "node";
            const outputsText = outputsMatch?.[1] ?? "outputs";
            description = `${nodeText} -> ${outputsText}`;
            if (warningsMatch?.[1]) {
              description = `${description} | ${warningsMatch[1]}`;
            }
          }
        } else if (data.run.status === "error") {
          const errorLine = [...logLines].reverse().find((line) => line.includes("ERROR:"));
          const errorLineIndex = errorLine ? logLines.lastIndexOf(errorLine) : -1;
          const detailsAfterError = errorLineIndex >= 0 ? logLines.slice(errorLineIndex + 1) : [];
          const detailLine = [...detailsAfterError].reverse().find((line) =>
            /(ReadTimeout|Timeout|No such file|not found|failed|Exception|ERROR conda)/i.test(line)
          );
          if (errorLine) {
            const shortError = errorLine.replace(/^.*ERROR:\s*/, "").trim();
            if (shortError.length > 0) {
              description = detailLine
                ? `${descriptionBase} | ${shortError} (${detailLine.slice(0, 140)})`
                : `${descriptionBase} | ${shortError}`;
            }
          }
        }

        toast({ title, description });
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

      setNodes((prev) =>
        prev.map((node) => ({
          ...node,
          data: {
            ...node.data,
            status: node.id === startNodeId && node.type !== "input.image" ? "running" : node.data.status,
            runProgress: node.id === startNodeId && node.type !== "input.image" ? 0 : node.data.runProgress ?? 0,
            runtimeWarning: node.id === startNodeId && node.type !== "input.image" ? null : node.data.runtimeWarning
          }
        }))
      );
    },
    [setNodes]
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
      pollRun(data.run.id, startNodeId ?? null);
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
  openViewerRef.current = (payload?: { artifactId?: string; nodeId?: string }) => {
    const params = new URLSearchParams();
    if (payload?.artifactId) {
      params.set("artifactId", payload.artifactId);
    }
    if (payload?.nodeId) {
      params.set("nodeId", payload.nodeId);
    }
    const query = params.toString();
    const href = query ? `/app/p/${projectId}/viewer?${query}` : `/app/p/${projectId}/viewer`;
    window.location.assign(href);
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
  const stableOpenViewerHandler = useCallback((payload?: { artifactId?: string; nodeId?: string }) => {
    openViewerRef.current(payload);
  }, []);

  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        if (
          node.data.onRunNode === stableNodeRunHandler &&
          node.data.onUploadImage === stableImageUploadHandler &&
          node.data.onUpdateParam === stableParamUpdateHandler &&
          node.data.onOpenViewer === stableOpenViewerHandler
        ) {
          return node;
        }
        return {
          ...node,
          data: {
            ...node.data,
            onRunNode: stableNodeRunHandler,
            onUploadImage: stableImageUploadHandler,
            onUpdateParam: stableParamUpdateHandler,
            onOpenViewer: stableOpenViewerHandler
          }
        };
      })
    );
  }, [stableImageUploadHandler, stableNodeRunHandler, stableOpenViewerHandler, stableParamUpdateHandler, setNodes]);

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
  const groundingDinoJsonArtifact = useMemo(() => {
    if (!selectedNode || selectedNode.type !== "model.groundingdino") return null;
    return selectedNodeArtifacts.find((artifact) => artifact.kind === "json") ?? null;
  }, [selectedNode, selectedNodeArtifacts]);
  const viewerArtifactId =
    selectedNode?.data.latestArtifactId ?? nodes.find((node) => Boolean(node.data.latestArtifactId))?.data.latestArtifactId ?? null;
  const viewerHref = viewerArtifactId
    ? `/app/p/${projectId}/viewer?artifactId=${viewerArtifactId}`
    : `/app/p/${projectId}/viewer`;

  const inspectArtifactJson = useCallback(
    async (artifactId: string) => {
      setInspectedJsonArtifactId(artifactId);
      setInspectedJsonLoading(true);
      setInspectedJsonError(null);
      setInspectedJsonContent(null);

      try {
        const metaRes = await fetch(`/api/artifacts/${artifactId}`, { cache: "no-store" });
        if (!metaRes.ok) {
          const errBody = await metaRes.json().catch(() => null);
          throw new Error(
            errBody && typeof errBody.error === "string"
              ? errBody.error
              : "Failed to load artifact metadata"
          );
        }

        const payload = await metaRes.json();
        const artifactUrl =
          payload && typeof payload.url === "string" ? payload.url : null;

        if (!artifactUrl) {
          throw new Error("Artifact URL missing");
        }

        const fileRes = await fetch(artifactUrl, { cache: "no-store" });
        if (!fileRes.ok) {
          throw new Error(`Failed to load artifact JSON (${fileRes.status})`);
        }

        const rawText = await fileRes.text();
        let formatted = rawText;
        try {
          const parsed = JSON.parse(rawText);
          formatted = JSON.stringify(parsed, null, 2);
        } catch {
          // Keep raw text when not valid JSON.
        }
        setInspectedJsonContent(formatted);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to inspect JSON";
        setInspectedJsonError(message);
      } finally {
        setInspectedJsonLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!groundingDinoJsonArtifact?.id) return;
    if (inspectedJsonArtifactId === groundingDinoJsonArtifact.id) return;
    void inspectArtifactJson(groundingDinoJsonArtifact.id);
  }, [groundingDinoJsonArtifact?.id, inspectArtifactJson, inspectedJsonArtifactId]);

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

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="rounded-xl">
                <SlidersHorizontal className="mr-1 h-4 w-4" /> Edit
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 rounded-xl border-border/70 bg-[#090d18]/95 text-zinc-100">
              <DropdownMenuLabel className="text-xs uppercase tracking-[0.15em] text-zinc-400">Selection</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={!hasNodeSelection && !hasEdgeSelection}
                onSelect={(event) => {
                  event.preventDefault();
                  const selectedNodeIds = nodes.filter((node) => node.selected).map((node) => node.id);
                  const selectedEdgeIds = edges.filter((edge) => edge.selected).map((edge) => edge.id);
                  if (selectedNodeIds.length === 0 && selectedEdgeIds.length === 0) return;
                  if (selectedNodeIds.length > 0) {
                    const nodeSet = new Set(selectedNodeIds);
                    setNodes((prev) => prev.filter((node) => !nodeSet.has(node.id)));
                    setEdges((prev) => prev.filter((edge) => !nodeSet.has(edge.source) && !nodeSet.has(edge.target)));
                  }
                  if (selectedEdgeIds.length > 0) {
                    const edgeSet = new Set(selectedEdgeIds);
                    setEdges((prev) => prev.filter((edge) => !edgeSet.has(edge.id)));
                  }
                  const parts: string[] = [];
                  if (selectedNodeIds.length > 0) {
                    parts.push(selectedNodeIds.length > 1 ? `${selectedNodeIds.length} nodes` : "1 node");
                  }
                  if (selectedEdgeIds.length > 0) {
                    parts.push(selectedEdgeIds.length > 1 ? `${selectedEdgeIds.length} connections` : "1 connection");
                  }
                  toast({ title: "Selection deleted", description: `${parts.join(" + ")} removed` });
                }}
              >
                Delete selected
                <span className="ml-auto text-[11px] text-zinc-500">Del</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!hasEdgeSelection}
                onSelect={(event) => {
                  event.preventDefault();
                  deleteSelectedEdges();
                }}
              >
                Disconnect selected edges
                <span className="ml-auto text-[11px] text-zinc-500">Ctrl+Shift+X</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!hasNodeSelection}
                onSelect={(event) => {
                  event.preventDefault();
                  const selectedIds = nodes.filter((node) => node.selected).map((node) => node.id);
                  disconnectEdgesForNodeIds(selectedIds);
                }}
              >
                Disconnect selected nodes
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs uppercase tracking-[0.15em] text-zinc-400">View</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setShowMiniMap((value) => !value);
                }}
              >
                {showMiniMap ? "Hide minimap" : "Show minimap"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="outline" className="rounded-xl" onClick={shareProject}>
            <Share2 className="mr-1 h-4 w-4" /> Share
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="rounded-xl">
                <WandSparkles className="mr-1 h-4 w-4" /> Workflow
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64 rounded-xl border-border/70 bg-[#090d18]/95 text-zinc-100">
              <DropdownMenuLabel className="text-xs uppercase tracking-[0.15em] text-zinc-400">Workflow</DropdownMenuLabel>
              {workflowPresets.map((preset) => (
                <DropdownMenuItem
                  key={`workflow-preset-${preset.id}`}
                  onSelect={(event) => {
                    event.preventDefault();
                    insertWorkflowPreset(preset.id);
                  }}
                >
                  {preset.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="rounded-xl">
                <PanelLeft className="mr-1 h-4 w-4" /> Nodes
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[360px] rounded-xl border-border/70 bg-[#090d18]/95 p-2 text-zinc-100">
              <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-zinc-400">Node Palette</p>
              <p className="mb-2 text-xs text-zinc-500">Right-click on canvas to add at cursor, or add at viewport center below.</p>
              <div className="mb-2 grid grid-cols-2 gap-1.5">
                <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => addNodeAtViewportCenter("input.image")}>
                  Input Image
                </Button>
                <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => addNodeAtViewportCenter("model.groundingdino")}>
                  ObjectDetection
                </Button>
                <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => addNodeAtViewportCenter("model.sam2")}>
                  SegmentScene
                </Button>
                <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs" onClick={() => addNodeAtViewportCenter("pipeline.scene_generation")}>
                  SceneGeneration
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
                              ? "Guided segmentation (from ObjectDetection)"
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
                              const boolValue =
                                value === true ||
                                value === "true" ||
                                value === 1 ||
                                value === "1";
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
                                  ) : field.input === "boolean" ? (
                                    <Button
                                      type="button"
                                      variant={boolValue ? "default" : "outline"}
                                      className="h-9 w-full justify-start rounded-xl"
                                      onClick={() => updateSelectedNodeParam(field.key, !boolValue)}
                                    >
                                      {boolValue ? "Enabled" : "Disabled"}
                                    </Button>
                                  ) : (
                                    <Input
                                      type={field.input === "number" ? "number" : "text"}
                                      value={String(value ?? "")}
                                      min={field.input === "number" ? field.min : undefined}
                                      max={field.input === "number" ? field.max : undefined}
                                      step={field.input === "number" ? field.step ?? "any" : undefined}
                                      onChange={(e) =>
                                        updateSelectedNodeParam(
                                          field.key,
                                          field.input === "number"
                                            ? Number.isFinite(Number(e.target.value))
                                              ? Number(e.target.value)
                                              : 0
                                            : e.target.value
                                        )
                                      }
                                      placeholder={field.placeholder}
                                      className="rounded-xl"
                                    />
                                  )}
                                </div>
                              );
                            })
                          )}
                          {(selectedNode.type === "model.groundingdino" ||
                            selectedNode.type === "model.sam2" ||
                            selectedNode.type === "model.sam3d_objects" ||
                            selectedNode.type === "pipeline.scene_generation") &&
                          selectedNodeArtifacts.length > 0 ? (
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
                          {groundingDinoJsonArtifact ? (
                            <div className="rounded-xl border border-border/70 bg-background/40 p-2.5">
                              <div className="mb-2 flex items-center justify-between gap-2">
                                <p className="text-xs font-medium text-zinc-300">ObjectDetection descriptor</p>
                                <div className="flex items-center gap-2">
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="rounded-lg"
                                    onClick={() => void inspectArtifactJson(groundingDinoJsonArtifact.id)}
                                    disabled={inspectedJsonLoading && inspectedJsonArtifactId === groundingDinoJsonArtifact.id}
                                  >
                                    {inspectedJsonLoading && inspectedJsonArtifactId === groundingDinoJsonArtifact.id
                                      ? "Loading..."
                                      : "Reload JSON"}
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="rounded-lg"
                                    onClick={() => window.open(`/api/artifacts/${groundingDinoJsonArtifact.id}`, "_blank")}
                                  >
                                    Open file
                                  </Button>
                                </div>
                              </div>
                              <p className="mb-2 text-[11px] text-zinc-500">Detection descriptor JSON generated by ObjectDetection.</p>
                              {inspectedJsonArtifactId === groundingDinoJsonArtifact.id && inspectedJsonError ? (
                                <p className="text-xs text-rose-300">{inspectedJsonError}</p>
                              ) : null}
                              {inspectedJsonArtifactId === groundingDinoJsonArtifact.id && inspectedJsonContent ? (
                                <pre className="max-h-56 overflow-auto rounded-lg border border-border/70 bg-background/70 p-2 text-xs text-zinc-200">
                                  {inspectedJsonContent}
                                </pre>
                              ) : null}
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
                                      onClick={() => window.location.assign(`/app/p/${projectId}/viewer?artifactId=${artifact.id}`)}
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
                                    <div className="mt-1 flex gap-2">
                                      {artifact.kind === "json" ? (
                                        <Button
                                          size="sm"
                                          variant="outline"
                                          className="rounded-lg"
                                          onClick={() => void inspectArtifactJson(artifact.id)}
                                          disabled={inspectedJsonLoading && inspectedJsonArtifactId === artifact.id}
                                        >
                                          {inspectedJsonLoading && inspectedJsonArtifactId === artifact.id
                                            ? "Loading..."
                                            : "Inspect JSON"}
                                        </Button>
                                      ) : null}
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="rounded-lg"
                                        onClick={() => window.open(`/api/artifacts/${artifact.id}`, "_blank")}
                                      >
                                        Open JSON/meta
                                      </Button>
                                    </div>
                                    {inspectedJsonArtifactId === artifact.id && inspectedJsonError ? (
                                      <p className="mt-2 text-xs text-rose-300">{inspectedJsonError}</p>
                                    ) : null}
                                    {inspectedJsonArtifactId === artifact.id && inspectedJsonContent ? (
                                      <pre className="mt-2 max-h-56 overflow-auto rounded-lg border border-border/70 bg-background/70 p-2 text-xs text-zinc-200">
                                        {inspectedJsonContent}
                                      </pre>
                                    ) : null}
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
                const migratedGraph = migrateGraphDocument(version.graphJson);
                const loadedNodes = migratedGraph.nodes.map((n) => buildNodeData(n as Node<GraphNodeData>, nodeArtifacts)) as Node<GraphNodeData>[];
                setNodes(loadedNodes);
                setEdges(migratedGraph.edges.map((edge) => withStyledEdge(edge as Edge)));
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

        <div className="canvas-dot-bg relative min-h-0 flex-1 bg-[#1e1e1e]" ref={canvasPanelRef} onDoubleClick={onCanvasDoubleClick}>
          <div className="pointer-events-none absolute left-3 top-3 z-20 rounded-md border border-[#4b4b4b] bg-[#2a2a2a]/95 px-3 py-2">
            <p className="text-[11px] font-medium text-zinc-200">{projectName}</p>
            <p className="text-[10px] text-zinc-500">Workspace canvas</p>
          </div>

          <div
            data-no-connect-menu="true"
            className="absolute left-3 top-1/2 z-20 flex -translate-y-1/2 flex-col items-center gap-1 rounded-md border border-[#4b4b4b] bg-[#2a2a2a]/95 p-2"
          >
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
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isConnectionValid}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onEdgeDoubleClick={(_, edge) => deleteEdgesByIds([edge.id])}
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={onPaneContextMenu}
            onPaneClick={onPaneClick}
            fitView
            panOnScroll
            panOnDrag
            selectionOnDrag
            zoomOnDoubleClick={false}
            minZoom={0.2}
            maxZoom={1.8}
            snapToGrid={snapToGrid}
            snapGrid={[20, 20]}
            className="h-full"
            defaultEdgeOptions={defaultEdgeOptions}
            connectionLineStyle={connectionLineStyle}
            proOptions={proOptions}
          >
            <Background color="rgba(255,255,255,0.06)" gap={16} />
            {showMiniMap ? <MiniMap pannable zoomable style={miniMapStyle} /> : null}
          </ReactFlow>

          {paneMenu ? (
            <div
              ref={paneMenuRef}
              data-no-connect-menu="true"
              className="absolute z-30 w-80 rounded-2xl border border-white/10 bg-[#151515]/95 p-3 shadow-[0_30px_80px_rgba(0,0,0,0.65)] backdrop-blur-md"
              style={{ left: paneMenu.x, top: paneMenu.y }}
            >
              <div className="mb-2">
                <p className="text-xs text-zinc-500">Add Node</p>
              </div>
              <div className="mb-2 rounded-xl border border-white/10 bg-white/[0.015] p-2">
                <p className="mb-1 text-xs text-zinc-500">Quick Add</p>
                <div className="grid grid-cols-2 gap-1.5">
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
                    Detect
                  </button>
                  <button
                    type="button"
                    onClick={() => addNodeFromContextMenu("model.sam2")}
                    className="rounded-lg border border-emerald-400/35 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-200 transition hover:bg-emerald-400/20"
                  >
                    Segment
                  </button>
                  <button
                    type="button"
                    onClick={() => addNodeFromContextMenu("pipeline.scene_generation")}
                    className="rounded-lg border border-cyan-400/35 bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-400/20"
                  >
                    SceneGeneration
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

          {nodeMenu ? (
            <div
              ref={nodeMenuRef}
              data-no-connect-menu="true"
              className="absolute z-30 w-56 rounded-xl border border-white/10 bg-[#151515]/95 p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur-md"
              style={{ left: nodeMenu.x, top: nodeMenu.y }}
            >
              <button
                type="button"
                className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/10"
                onClick={() => {
                  deleteNodesByIds([nodeMenu.nodeId]);
                  setNodeMenu(null);
                }}
              >
                Delete node
                <span className="float-right text-[11px] text-zinc-500">Del</span>
              </button>
              <button
                type="button"
                className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/10"
                onClick={() => {
                  disconnectEdgesForNodeIds([nodeMenu.nodeId]);
                  setNodeMenu(null);
                }}
              >
                Disconnect node
                <span className="float-right text-[11px] text-zinc-500">Ctrl+Shift+X</span>
              </button>
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
