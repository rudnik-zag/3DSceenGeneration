import { ArtifactKind } from "@prisma/client";

import { ArtifactType, PayloadKind } from "@/types/workflow";

const LEGACY_PAYLOAD_TO_ARTIFACT: Record<string, ArtifactType> = {
  Image: "Image",
  Mask: "MaskSet",
  MaskDir: "MaskSet",
  Boxes: "Descriptor",
  BoxesJson: "Descriptor",
  MaskImage: "MaskSet",
  OverlayImage: "Image",
  JsonMeta: "JsonData",
  Text: "JsonData",
  Json: "JsonData",
  Depth: "DepthMap",
  PointCloud: "PointCloud",
  Mesh: "Mesh",
  TextureSet: "TextureSet",
  Scene: "SceneAsset",
  Descriptor: "Descriptor",
  MaskSet: "MaskSet",
  SceneAsset: "SceneAsset",
  JsonData: "JsonData",
  DepthMap: "DepthMap",
  GaussianSplat: "GaussianSplat"
};

const ALL_ARTIFACT_TYPES: ArtifactType[] = [
  "Image",
  "Descriptor",
  "MaskSet",
  "SceneAsset",
  "JsonData",
  "DepthMap",
  "PointCloud",
  "Mesh",
  "TextureSet",
  "GaussianSplat"
];

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === "string" && ALL_ARTIFACT_TYPES.includes(value as ArtifactType);
}

export function artifactTypeFromLegacyPayloadKind(payload: PayloadKind | string): ArtifactType {
  if (isArtifactType(payload)) return payload;
  return LEGACY_PAYLOAD_TO_ARTIFACT[payload] ?? "JsonData";
}

export function normalizeArtifactType(value: unknown, fallback: ArtifactType = "JsonData"): ArtifactType {
  if (isArtifactType(value)) return value;
  if (typeof value === "string") {
    return LEGACY_PAYLOAD_TO_ARTIFACT[value] ?? fallback;
  }
  return fallback;
}

export function areArtifactTypesCompatible(source: ArtifactType, target: ArtifactType) {
  return source === target;
}

export function artifactTypeFromArtifactKind(kind: ArtifactKind, meta?: Record<string, unknown>): ArtifactType {
  const fromMeta = normalizeArtifactType(meta?.artifactType, "JsonData");
  if (fromMeta !== "JsonData" || meta?.artifactType === "JsonData") {
    return fromMeta;
  }

  switch (kind) {
    case "image":
      return "Image";
    case "mask":
      return "MaskSet";
    case "mesh_glb":
      return "SceneAsset";
    case "point_ply":
      return "SceneAsset";
    case "splat_ksplat":
      return "SceneAsset";
    case "json":
    default:
      return "JsonData";
  }
}

export function artifactKindFromArtifactType(type: ArtifactType, preferredKind?: ArtifactKind): ArtifactKind {
  if (preferredKind) return preferredKind;
  switch (type) {
    case "Image":
    case "DepthMap":
      return "image";
    case "MaskSet":
      return "json";
    case "PointCloud":
      return "point_ply";
    case "GaussianSplat":
      return "splat_ksplat";
    case "Mesh":
      return "mesh_glb";
    case "SceneAsset":
      return "mesh_glb";
    case "Descriptor":
    case "TextureSet":
    case "JsonData":
    default:
      return "json";
  }
}
