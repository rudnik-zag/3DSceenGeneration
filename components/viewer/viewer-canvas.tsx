"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { Camera, Crosshair, Download, Move3D, PanelLeft, RefreshCw, RotateCcw, SlidersHorizontal } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { loadSplatPlaceholder } from "@/components/viewer/use-splat-loader";
import { cn } from "@/lib/utils";

interface ViewerArtifact {
  id: string;
  kind: "mesh_glb" | "point_ply" | "splat_ksplat" | string;
  url: string;
  mimeType: string;
  meta: Record<string, unknown> | null;
}

interface TreeNode {
  id: string;
  name: string;
  visible: boolean;
  depth: number;
  object: THREE.Object3D;
}

type PLYScalarType = "char" | "uchar" | "short" | "ushort" | "int" | "uint" | "float" | "double";

interface ParsedPlyHeader {
  format: "ascii" | "binary_little_endian" | "binary_big_endian";
  headerLength: number;
  vertexCount: number;
  vertexStride: number;
  propertyOffsets: Record<string, { offset: number; type: PLYScalarType }>;
}

interface LoadedPly {
  geometry: THREE.BufferGeometry;
  message?: string;
}

const PLY_MAX_POINTS = 2_000_000;
const SH_DC_SCALE = 0.28209479177387814;
const POINT_SIZE_MIN = 0.001;
const POINT_SIZE_MAX = POINT_SIZE_MIN * 5;
const POINT_SIZE_STEP = 0.0001;

const plyScalarSize: Record<PLYScalarType, number> = {
  char: 1,
  uchar: 1,
  short: 2,
  ushort: 2,
  int: 4,
  uint: 4,
  float: 4,
  double: 8
};

function clamp01(value: number) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parsePlyHeader(buffer: ArrayBuffer): ParsedPlyHeader | null {
  const probeBytes = Math.min(buffer.byteLength, 512 * 1024);
  const probe = new TextDecoder().decode(buffer.slice(0, probeBytes));

  const headerMatch = probe.match(/end_header\r?\n/);
  if (!headerMatch || headerMatch.index === undefined) {
    return null;
  }

  const headerLength = headerMatch.index + headerMatch[0].length;
  const headerText = probe.slice(0, headerLength);
  const lines = headerText.split(/\r?\n/);

  let format: ParsedPlyHeader["format"] | null = null;
  let vertexCount = 0;
  let inVertex = false;
  const propertyOffsets: ParsedPlyHeader["propertyOffsets"] = {};
  let vertexStride = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("format ")) {
      const token = line.split(/\s+/)[1] as ParsedPlyHeader["format"] | undefined;
      if (token === "ascii" || token === "binary_little_endian" || token === "binary_big_endian") {
        format = token;
      }
      continue;
    }

    if (line.startsWith("element ")) {
      const [, elementName, countToken] = line.split(/\s+/);
      inVertex = elementName === "vertex";
      if (inVertex) {
        vertexCount = Number.parseInt(countToken ?? "0", 10) || 0;
        vertexStride = 0;
      }
      continue;
    }

    if (inVertex && line.startsWith("property ")) {
      const tokens = line.split(/\s+/);
      if (tokens[1] === "list") {
        continue;
      }

      const type = tokens[1] as PLYScalarType;
      const name = tokens[2];
      if (!name || !(type in plyScalarSize)) continue;

      propertyOffsets[name] = { offset: vertexStride, type };
      vertexStride += plyScalarSize[type];
    }
  }

  if (!format || vertexCount <= 0 || vertexStride <= 0) {
    return null;
  }

  return {
    format,
    headerLength,
    vertexCount,
    vertexStride,
    propertyOffsets
  };
}

function parseGaussianBinaryPly(buffer: ArrayBuffer): LoadedPly | null {
  const header = parsePlyHeader(buffer);
  if (!header || header.format !== "binary_little_endian") {
    return null;
  }

  const required = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2"] as const;
  const hasRequired = required.every((name) => header.propertyOffsets[name]);
  if (!hasRequired) {
    return null;
  }

  const typeMismatch = required.some((name) => header.propertyOffsets[name].type !== "float");
  if (typeMismatch) {
    return null;
  }

  const dataOffset = header.headerLength;
  const expectedSize = dataOffset + header.vertexCount * header.vertexStride;
  if (buffer.byteLength < expectedSize) {
    throw new Error("Invalid PLY: file is truncated.");
  }

  const sampleStep = Math.max(1, Math.ceil(header.vertexCount / PLY_MAX_POINTS));
  const sampledCount = Math.ceil(header.vertexCount / sampleStep);

  const positions = new Float32Array(sampledCount * 3);
  const colors = new Float32Array(sampledCount * 3);
  const normalsAvailable =
    header.propertyOffsets.nx?.type === "float" &&
    header.propertyOffsets.ny?.type === "float" &&
    header.propertyOffsets.nz?.type === "float";
  const normals = normalsAvailable ? new Float32Array(sampledCount * 3) : null;

  const view = new DataView(buffer);
  const xOffset = header.propertyOffsets.x.offset;
  const yOffset = header.propertyOffsets.y.offset;
  const zOffset = header.propertyOffsets.z.offset;
  const dc0Offset = header.propertyOffsets.f_dc_0.offset;
  const dc1Offset = header.propertyOffsets.f_dc_1.offset;
  const dc2Offset = header.propertyOffsets.f_dc_2.offset;
  const nxOffset = normalsAvailable ? header.propertyOffsets.nx.offset : 0;
  const nyOffset = normalsAvailable ? header.propertyOffsets.ny.offset : 0;
  const nzOffset = normalsAvailable ? header.propertyOffsets.nz.offset : 0;

  let outIndex = 0;
  for (let vertex = 0; vertex < header.vertexCount; vertex += sampleStep) {
    const base = dataOffset + vertex * header.vertexStride;

    positions[outIndex * 3] = view.getFloat32(base + xOffset, true);
    positions[outIndex * 3 + 1] = view.getFloat32(base + yOffset, true);
    positions[outIndex * 3 + 2] = view.getFloat32(base + zOffset, true);

    const dc0 = view.getFloat32(base + dc0Offset, true);
    const dc1 = view.getFloat32(base + dc1Offset, true);
    const dc2 = view.getFloat32(base + dc2Offset, true);

    colors[outIndex * 3] = clamp01(0.5 + SH_DC_SCALE * dc0);
    colors[outIndex * 3 + 1] = clamp01(0.5 + SH_DC_SCALE * dc1);
    colors[outIndex * 3 + 2] = clamp01(0.5 + SH_DC_SCALE * dc2);

    if (normals) {
      normals[outIndex * 3] = view.getFloat32(base + nxOffset, true);
      normals[outIndex * 3 + 1] = view.getFloat32(base + nyOffset, true);
      normals[outIndex * 3 + 2] = view.getFloat32(base + nzOffset, true);
    }

    outIndex += 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  if (normals) {
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  }
  geometry.computeBoundingSphere();

  const message =
    sampleStep > 1
      ? `Loaded ${sampledCount.toLocaleString()} / ${header.vertexCount.toLocaleString()} points (step ${sampleStep}) for interactive performance.`
      : `Loaded ${sampledCount.toLocaleString()} points.`;

  return { geometry, message };
}

async function loadPlyGeometry(url: string): Promise<LoadedPly> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download PLY (${response.status})`);
  }

  const buffer = await response.arrayBuffer();
  const gaussianPly = parseGaussianBinaryPly(buffer);
  if (gaussianPly) {
    return gaussianPly;
  }

  const loader = new PLYLoader();
  const geometry = loader.parse(buffer);
  geometry.computeBoundingSphere();
  return { geometry };
}

export function ViewerCanvas({ artifact }: { artifact: ViewerArtifact }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const transformRef = useRef<TransformControls | null>(null);
  const rootObjectRef = useRef<THREE.Object3D | null>(null);
  const selectionHelperRef = useRef<THREE.BoxHelper | null>(null);
  const requestRef = useRef<number | null>(null);
  const lastRenderRef = useRef<number>(performance.now());

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pointSize, setPointSize] = useState([POINT_SIZE_MIN]);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [gizmoMode, setGizmoMode] = useState<"translate" | "rotate" | "scale">("translate");
  const [stats, setStats] = useState({ fps: 0, triangles: 0, drawCalls: 0, materials: 0, textures: 0 });
  const [splatWarning, setSplatWarning] = useState<string | null>(null);
  const [plyMessage, setPlyMessage] = useState<string | null>(null);

  const selectedNode = useMemo(() => tree.find((node) => node.id === selectedId) ?? null, [tree, selectedId]);

  const selectedMaterialNames = useMemo(() => {
    if (!selectedNode) return [];
    const materials = new Set<string>();

    selectedNode.object.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((m) => materials.add(m.name || m.type));
      } else if (material) {
        materials.add(material.name || material.type);
      }
    });

    return [...materials];
  }, [selectedNode]);

  const updateCameraClipping = () => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const distance = camera.position.distanceTo(controls.target);
    const near = THREE.MathUtils.clamp(distance / 3000, 0.00005, 0.2);
    const far = Math.max(1000, distance * 5000);

    if (Math.abs(camera.near - near) > near * 0.2 || Math.abs(camera.far - far) > far * 0.2) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  };

  const requestRender = () => {
    if (requestRef.current) return;
    requestRef.current = requestAnimationFrame(() => {
      requestRef.current = null;
      const renderer = rendererRef.current;
      const scene = sceneRef.current;
      const camera = cameraRef.current;
      if (!renderer || !scene || !camera) return;

      updateCameraClipping();

      if (selectionHelperRef.current) {
        selectionHelperRef.current.update();
      }

      const now = performance.now();
      const delta = Math.max(now - lastRenderRef.current, 16);
      lastRenderRef.current = now;

      renderer.render(scene, camera);

      const materials = new Set<THREE.Material>();
      const textures = new Set<THREE.Texture>();

      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => materials.add(m));
        else if (mat) materials.add(mat);
      });

      materials.forEach((material) => {
        Object.values(material).forEach((value) => {
          if (value instanceof THREE.Texture) {
            textures.add(value);
          }
        });
      });

      setStats({
        fps: Math.round(1000 / delta),
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.calls,
        materials: materials.size,
        textures: textures.size
      });
    });
  };

  const updateTree = () => {
    const root = rootObjectRef.current;
    if (!root) {
      setTree([]);
      return;
    }

    const flat: TreeNode[] = [];
    const walk = (obj: THREE.Object3D, depth: number) => {
      flat.push({
        id: obj.uuid,
        name: obj.name || obj.type,
        visible: obj.visible,
        depth,
        object: obj
      });
      obj.children.forEach((child) => walk(child, depth + 1));
    };

    walk(root, 0);
    setTree(flat);
  };

  const fitObject = (target?: THREE.Object3D | null) => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const scene = sceneRef.current;
    if (!camera || !controls || !scene) return;

    const source = target ?? rootObjectRef.current;
    if (!source) return;

    const box = new THREE.Box3().setFromObject(source);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = THREE.MathUtils.degToRad(camera.fov);
    const distance = Math.max(maxDim / Math.tan(fov / 2), 1.8);

    camera.position.copy(center.clone().add(new THREE.Vector3(distance, distance * 0.85, distance)));
    camera.near = Math.max(0.00005, distance / 3000);
    camera.far = Math.max(1000, distance * 5000);
    camera.updateProjectionMatrix();

    controls.target.copy(center);
    controls.update();
    requestRender();
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let splatCleanup: (() => void) | undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#070a12");
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.0001, 2000);
    camera.position.set(4, 3, 4);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x111828, 1.12);
    hemi.position.set(0, 30, 0);
    scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.45);
    dir.position.set(8, 12, 4);
    scene.add(dir);

    scene.add(new THREE.GridHelper(20, 40, 0x2d3748, 0x151b2b));

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.zoomSpeed = 0.35;
    controls.addEventListener("change", () => {
      updateCameraClipping();
      requestRender();
    });
    controlsRef.current = controls;

    const transform = new TransformControls(camera, renderer.domElement);
    transform.setSpace("world");
    transform.setMode(gizmoMode);
    transform.addEventListener("change", requestRender);
    transform.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
    });
    scene.add(transform);
    transformRef.current = transform;

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();

    const updateSelection = (obj: THREE.Object3D | null) => {
      const transformControls = transformRef.current;
      if (!transformControls) return;

      const existingHelper = selectionHelperRef.current;
      if (existingHelper) {
        scene.remove(existingHelper);
        selectionHelperRef.current = null;
      }

      if (!obj) {
        transformControls.detach();
        setSelectedId(null);
        requestRender();
        return;
      }

      transformControls.attach(obj);
      setSelectedId(obj.uuid);

      const helper = new THREE.BoxHelper(obj, 0x4ade80);
      selectionHelperRef.current = helper;
      scene.add(helper);
      requestRender();
    };

    const onPointerDown = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);

      const root = rootObjectRef.current;
      if (!root) return;

      const hits = raycaster.intersectObjects(root.children, true);
      const picked = hits[0]?.object ?? null;
      updateSelection(picked);
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);

    const onResize = () => {
      if (!containerRef.current || !rendererRef.current || !cameraRef.current) return;
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      rendererRef.current.setSize(width, height);
      cameraRef.current.aspect = width / height;
      cameraRef.current.updateProjectionMatrix();
      requestRender();
    };

    window.addEventListener("resize", onResize);

    const disposeSceneObject = (object: THREE.Object3D) => {
      object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();

        const disposeMaterial = (material: THREE.Material) => {
          Object.values(material).forEach((value) => {
            if (value instanceof THREE.Texture) value.dispose();
          });
          material.dispose();
        };

        if (Array.isArray(mesh.material)) mesh.material.forEach(disposeMaterial);
        else if (mesh.material) disposeMaterial(mesh.material);
      });
    };

    const loadArtifact = async () => {
      try {
        setReady(false);
        setError(null);
        setSplatWarning(null);
        setPlyMessage(null);
        if (artifact.kind === "mesh_glb") {
          const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
          const loader = new GLTFLoader();

          const { DRACOLoader } = await import("three/examples/jsm/loaders/DRACOLoader.js");
          const draco = new DRACOLoader();
          draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
          loader.setDRACOLoader(draco);

          const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
          loader.setMeshoptDecoder(MeshoptDecoder);

          const { KTX2Loader } = await import("three/examples/jsm/loaders/KTX2Loader.js");
          const ktx2 = new KTX2Loader();
          ktx2.setTranscoderPath("https://unpkg.com/three@0.170.0/examples/jsm/libs/basis/");
          ktx2.detectSupport(renderer);
          loader.setKTX2Loader(ktx2);

          const gltf = await loader.loadAsync(artifact.url);
          rootObjectRef.current = gltf.scene;
          scene.add(gltf.scene);
          updateTree();
          fitObject(gltf.scene);
          setReady(true);
        } else if (artifact.kind === "point_ply") {
          const { geometry, message } = await loadPlyGeometry(artifact.url);
          setPlyMessage(message ?? null);

          const hasColor = Boolean(geometry.getAttribute("color"));
          const material = new THREE.PointsMaterial({
            size: pointSize[0],
            vertexColors: hasColor,
            color: hasColor ? undefined : new THREE.Color("#4ade80")
          });

          const points = new THREE.Points(geometry, material);
          points.name = "PointCloud";

          rootObjectRef.current = new THREE.Group();
          rootObjectRef.current.add(points);
          scene.add(rootObjectRef.current);
          updateTree();
          fitObject(rootObjectRef.current);
          setReady(true);
        } else if (artifact.kind === "splat_ksplat") {
          const result = await loadSplatPlaceholder(artifact.url, scene);
          splatCleanup = result.dispose;
          setSplatWarning(result.warning ?? null);
          rootObjectRef.current = new THREE.Group();
          scene.add(rootObjectRef.current);
          updateTree();
          requestRender();
          setReady(true);
        } else {
          throw new Error(`Unsupported artifact kind: ${artifact.kind}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load artifact");
      }
    };

    loadArtifact();
    requestRender();

    return () => {
      disposed = true;
      if (disposed) {
        if (requestRef.current) {
          cancelAnimationFrame(requestRef.current);
          requestRef.current = null;
        }

        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("resize", onResize);
        controls.dispose();
        transform.dispose();

        if (rootObjectRef.current) {
          disposeSceneObject(rootObjectRef.current);
        }

        if (selectionHelperRef.current) {
          scene.remove(selectionHelperRef.current);
        }

        splatCleanup?.();

        scene.clear();
        renderer.dispose();
        if (renderer.domElement.parentNode) {
          renderer.domElement.parentNode.removeChild(renderer.domElement);
        }
      }
    };
  }, [artifact.id, artifact.kind, artifact.url]);

  useEffect(() => {
    const transform = transformRef.current;
    if (!transform) return;
    transform.setMode(gizmoMode);
    requestRender();
  }, [gizmoMode]);

  useEffect(() => {
    if (artifact.kind !== "point_ply") return;
    const root = rootObjectRef.current;
    if (!root) return;

    root.traverse((obj) => {
      if (obj instanceof THREE.Points) {
        const material = obj.material as THREE.PointsMaterial;
        material.size = pointSize[0];
        material.needsUpdate = true;
      }
    });

    requestRender();
  }, [artifact.kind, pointSize]);

  useEffect(() => {
    const scene = sceneRef.current;
    const transform = transformRef.current;
    if (!scene || !transform) return;

    const existingHelper = selectionHelperRef.current;
    if (existingHelper) {
      scene.remove(existingHelper);
      selectionHelperRef.current = null;
    }

    if (!selectedNode) {
      transform.detach();
      requestRender();
      return;
    }

    transform.attach(selectedNode.object);
    const helper = new THREE.BoxHelper(selectedNode.object, 0x4ade80);
    selectionHelperRef.current = helper;
    scene.add(helper);
    requestRender();
  }, [selectedNode]);

  const toggleVisibility = (node: TreeNode) => {
    node.object.visible = !node.object.visible;
    updateTree();
    requestRender();
  };

  const isolate = (node: TreeNode) => {
    const root = rootObjectRef.current;
    if (!root) return;

    const visibleSet = new Set<string>();
    node.object.traverse((obj) => visibleSet.add(obj.uuid));
    let parent: THREE.Object3D | null = node.object.parent;
    while (parent) {
      visibleSet.add(parent.uuid);
      parent = parent.parent;
    }

    root.traverse((obj) => {
      obj.visible = visibleSet.has(obj.uuid);
    });

    updateTree();
    requestRender();
  };

  const resetScene = () => {
    const root = rootObjectRef.current;
    if (!root) return;
    root.traverse((obj) => {
      obj.visible = true;
    });
    setSelectedId(null);
    fitObject(root);
    updateTree();
  };

  const captureScreenshot = () => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const url = renderer.domElement.toDataURL("image/png");
    const link = document.createElement("a");
    link.href = url;
    link.download = `artifact_${artifact.id}.png`;
    link.click();
  };

  return (
    <div className="relative h-full w-full overflow-hidden rounded-none bg-[#04060d] md:rounded-2xl md:border md:border-border/70">
      <div className="absolute left-3 top-3 z-30 flex flex-wrap items-center gap-2 rounded-xl border border-border/70 bg-black/45 p-2 backdrop-blur-sm">
        <Button size="sm" variant="outline" className="rounded-xl" onClick={resetScene}>
          <RefreshCw className="mr-1 h-4 w-4" /> Reset
        </Button>
        <Button size="sm" variant="outline" className="rounded-xl" onClick={() => fitObject()}>
          <Crosshair className="mr-1 h-4 w-4" /> Fit
        </Button>
        <Button size="sm" variant="outline" className="rounded-xl" disabled={!selectedNode} onClick={() => fitObject(selectedNode?.object)}>
          <Camera className="mr-1 h-4 w-4" /> Fit selected
        </Button>
        <div className="inline-flex rounded-xl border border-border/70 bg-background/70 p-0.5">
          {(["translate", "rotate", "scale"] as const).map((mode) => (
            <Button
              key={mode}
              size="sm"
              variant={gizmoMode === mode ? "default" : "ghost"}
              className="h-8 rounded-lg px-2.5"
              onClick={() => setGizmoMode(mode)}
            >
              {mode === "translate" ? <Move3D className="h-4 w-4" /> : mode === "rotate" ? <RotateCcw className="h-4 w-4" /> : "S"}
            </Button>
          ))}
        </div>
        <Button size="sm" variant="outline" className="rounded-xl" onClick={captureScreenshot}>
          <Download className="mr-1 h-4 w-4" /> Screenshot
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="rounded-xl">
              <PanelLeft className="mr-1 h-4 w-4" /> Scene
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[340px] rounded-xl border-border/70 bg-[#090d18]/95 p-2 text-zinc-100">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-zinc-400">Scene Graph</p>
            <ScrollArea className="h-[58vh] pr-2">
              <div className="space-y-1">
                {tree.map((node) => (
                  <div
                    key={node.id}
                    className={cn(
                      "flex items-center justify-between rounded-lg px-2 py-1.5 text-xs",
                      node.id === selectedId ? "bg-primary/25" : "hover:bg-accent/70"
                    )}
                    style={{ paddingLeft: `${8 + node.depth * 10}px` }}
                    onClick={() => setSelectedId(node.id)}
                  >
                    <span className="max-w-[140px] truncate text-zinc-200">{node.name}</span>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" className="h-6 rounded-md px-2 text-[11px]" onClick={() => toggleVisibility(node)}>
                        {node.visible ? "Hide" : "Show"}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 rounded-md px-2 text-[11px]" onClick={() => isolate(node)}>
                        Iso
                      </Button>
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
          <DropdownMenuContent align="end" className="w-[360px] rounded-xl border-border/70 bg-[#090d18]/95 p-2 text-zinc-100">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-zinc-400">Artifact</span>
              <Badge variant="secondary" className="rounded-full border border-border/70 bg-background/60">
                {artifact.kind}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-2 rounded-xl border border-border/70 bg-background/45 p-2 text-xs">
              <span className="text-muted-foreground">FPS</span>
              <span>{stats.fps}</span>
              <span className="text-muted-foreground">Triangles</span>
              <span>{stats.triangles}</span>
              <span className="text-muted-foreground">Draw calls</span>
              <span>{stats.drawCalls}</span>
              <span className="text-muted-foreground">Materials</span>
              <span>{stats.materials}</span>
              <span className="text-muted-foreground">Textures</span>
              <span>{stats.textures}</span>
            </div>

            <ScrollArea className="mt-2 h-[38vh] rounded-xl border border-border/70 bg-background/35 p-2">
              {selectedNode ? (
                <div className="space-y-2 text-xs">
                  <p className="font-medium text-white">Selected: {selectedNode.name}</p>
                  <p>Position: {selectedNode.object.position.toArray().map((v) => v.toFixed(2)).join(", ")}</p>
                  <p>Rotation: {selectedNode.object.rotation.toArray().slice(0, 3).map((v) => v.toFixed(2)).join(", ")}</p>
                  <p>Scale: {selectedNode.object.scale.toArray().map((v) => v.toFixed(2)).join(", ")}</p>
                  <p className="font-medium">Materials</p>
                  {selectedMaterialNames.length > 0 ? (
                    <p>{selectedMaterialNames.join(", ")}</p>
                  ) : (
                    <p className="text-muted-foreground">No materials on selected object</p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">Pick an object in viewport or in the scene graph.</p>
              )}
            </ScrollArea>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="absolute left-3 top-20 z-20 space-y-2">
        {splatWarning ? (
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{splatWarning}</div>
        ) : null}
        {error ? <div className="rounded-xl border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</div> : null}
        {!ready && !error ? <div className="rounded-xl border border-border/70 bg-background/40 px-3 py-2 text-sm text-zinc-300">Loading scene...</div> : null}
      </div>

      {artifact.kind === "point_ply" ? (
        <div className="absolute bottom-3 left-3 z-20 w-[300px] rounded-xl border border-border/70 bg-black/55 p-3 backdrop-blur-sm">
          <p className="mb-2 text-sm font-medium text-zinc-100">Point size</p>
          <Slider value={pointSize} min={POINT_SIZE_MIN} max={POINT_SIZE_MAX} step={POINT_SIZE_STEP} onValueChange={setPointSize} />
          {plyMessage ? <p className="mt-2 text-xs text-zinc-400">{plyMessage}</p> : null}
        </div>
      ) : null}

      <div ref={containerRef} className="h-full w-full" />

      <div className="pointer-events-none absolute right-3 top-3 z-20 rounded-lg border border-white/10 bg-black/55 px-2 py-1 text-[11px] text-zinc-300">
        {stats.fps} fps • {stats.triangles} tri • {stats.drawCalls} calls
      </div>
    </div>
  );
}
