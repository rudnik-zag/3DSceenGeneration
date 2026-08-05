import { inflateSync } from "zlib";

import { ArtifactKind } from "@prisma/client";

import { NodeExecutionContext, NodeExecutionResult } from "@/lib/execution/contracts";

type DecodedPng = {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
  pixels: Buffer;
};

type PointCloudBuffers = {
  positions: Float32Array;
  colors: Float32Array;
  pointCount: number;
  boundsMin: [number, number, number];
  boundsMax: [number, number, number];
};

type CameraIntrinsics = {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_POINT_COUNT = 200_000;

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function paethPredictor(left: number, above: number, upperLeft: number) {
  const estimate = left + above - upperLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceAbove = Math.abs(estimate - above);
  const distanceUpperLeft = Math.abs(estimate - upperLeft);
  if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
  if (distanceAbove <= distanceUpperLeft) return above;
  return upperLeft;
}

function decodePng(buffer: Buffer): DecodedPng {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Depth to Point Cloud currently expects PNG depth input.");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error("Invalid PNG chunk length.");
    }

    const data = buffer.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idatChunks.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }

  if (width <= 0 || height <= 0 || idatChunks.length === 0) {
    throw new Error("Invalid PNG depth image.");
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error("Depth to Point Cloud supports non-interlaced 8-bit PNG images.");
  }

  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : null;
  if (!channels) {
    throw new Error(`Unsupported PNG color type ${colorType}.`);
  }

  const raw = inflateSync(Buffer.concat(idatChunks));
  const rowBytes = width * channels;
  const pixels = Buffer.alloc(rowBytes * height);
  let rawOffset = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset];
    rawOffset += 1;
    const previousRowStart = y > 0 ? (y - 1) * rowBytes : -1;
    const currentRowStart = y * rowBytes;

    for (let x = 0; x < rowBytes; x += 1) {
      const rawValue = raw[rawOffset + x];
      const left = x >= channels ? pixels[currentRowStart + x - channels] : 0;
      const above = previousRowStart >= 0 ? pixels[previousRowStart + x] : 0;
      const upperLeft = previousRowStart >= 0 && x >= channels ? pixels[previousRowStart + x - channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : filter === 4
                  ? paethPredictor(left, above, upperLeft)
                  : null;
      if (predictor === null) {
        throw new Error(`Unsupported PNG filter ${filter}.`);
      }
      pixels[currentRowStart + x] = (rawValue + predictor) & 0xff;
    }
    rawOffset += rowBytes;
  }

  return { width, height, channels: channels as 1 | 2 | 3 | 4, pixels };
}

function luminanceAt(image: DecodedPng, x: number, y: number) {
  const index = (y * image.width + x) * image.channels;
  if (image.channels <= 2) return image.pixels[index];
  const red = image.pixels[index];
  const green = image.pixels[index + 1];
  const blue = image.pixels[index + 2];
  return Math.round(0.2126 * red + 0.7152 * green + 0.0722 * blue);
}

function colorAt(image: DecodedPng | null, depthImage: DecodedPng, x: number, y: number, depthValue: number) {
  if (!image) {
    return [depthValue, depthValue, depthValue] as const;
  }

  const colorX = Math.max(0, Math.min(image.width - 1, Math.round((x / Math.max(1, depthImage.width - 1)) * (image.width - 1))));
  const colorY = Math.max(0, Math.min(image.height - 1, Math.round((y / Math.max(1, depthImage.height - 1)) * (image.height - 1))));
  const index = (colorY * image.width + colorX) * image.channels;
  if (image.channels <= 2) {
    const value = image.pixels[index] / 255;
    return [value, value, value] as const;
  }
  return [image.pixels[index] / 255, image.pixels[index + 1] / 255, image.pixels[index + 2] / 255] as const;
}

function parseCameraIntrinsics(buffer: Buffer): CameraIntrinsics | null {
  try {
    const payload = JSON.parse(buffer.toString("utf8")) as { intrinsics?: unknown };
    const rawIntrinsics = payload.intrinsics;
    if (!Array.isArray(rawIntrinsics)) return null;
    const intrinsics = Array.isArray(rawIntrinsics[0]) && Array.isArray(rawIntrinsics[0][0])
      ? rawIntrinsics[0]
      : rawIntrinsics;
    if (!Array.isArray(intrinsics)) return null;
    const fx = Number(intrinsics[0]?.[0]);
    const fy = Number(intrinsics[1]?.[1]);
    const cx = Number(intrinsics[0]?.[2]);
    const cy = Number(intrinsics[1]?.[2]);
    if (![fx, fy, cx, cy].every(Number.isFinite) || fx <= 0 || fy <= 0) return null;
    return { fx, fy, cx, cy };
  } catch {
    return null;
  }
}

function buildPointCloud(
  depthImage: DecodedPng,
  colorImage: DecodedPng | null,
  cameraIntrinsics: CameraIntrinsics | null,
  density: number,
  depthScale: number
): PointCloudBuffers {
  let stride = Math.max(1, Math.round(1 / density));
  while (Math.ceil(depthImage.width / stride) * Math.ceil(depthImage.height / stride) > MAX_POINT_COUNT) {
    stride += 1;
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const aspect = depthImage.width / Math.max(1, depthImage.height);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (let y = 0; y < depthImage.height; y += stride) {
    for (let x = 0; x < depthImage.width; x += stride) {
      const depthValue = luminanceAt(depthImage, x, y) / 255;
      const depth = depthValue * depthScale;
      const px = cameraIntrinsics ? ((x - cameraIntrinsics.cx) / cameraIntrinsics.fx) * depth : ((x / Math.max(1, depthImage.width - 1)) - 0.5) * aspect;
      const py = cameraIntrinsics ? -((y - cameraIntrinsics.cy) / cameraIntrinsics.fy) * depth : 0.5 - y / Math.max(1, depthImage.height - 1);
      const pz = -depth;
      const [red, green, blue] = colorAt(colorImage, depthImage, x, y, depthValue);

      positions.push(px, py, pz);
      colors.push(red, green, blue);
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      minZ = Math.min(minZ, pz);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
      maxZ = Math.max(maxZ, pz);
    }
  }

  if (positions.length === 0) {
    positions.push(0, 0, 0);
    colors.push(0, 0, 0);
    minX = minY = minZ = maxX = maxY = maxZ = 0;
  }

  return {
    positions: Float32Array.from(positions),
    colors: Float32Array.from(colors),
    pointCount: positions.length / 3,
    boundsMin: [minX, minY, minZ],
    boundsMax: [maxX, maxY, maxZ]
  };
}

function createPlyBuffer(pointCloud: PointCloudBuffers) {
  const lines = [
    "ply",
    "format ascii 1.0",
    `element vertex ${pointCloud.pointCount}`,
    "property float x",
    "property float y",
    "property float z",
    "property uchar red",
    "property uchar green",
    "property uchar blue",
    "end_header"
  ];

  for (let index = 0; index < pointCloud.pointCount; index += 1) {
    const positionOffset = index * 3;
    const red = Math.round(pointCloud.colors[positionOffset] * 255);
    const green = Math.round(pointCloud.colors[positionOffset + 1] * 255);
    const blue = Math.round(pointCloud.colors[positionOffset + 2] * 255);
    lines.push(
      `${pointCloud.positions[positionOffset].toFixed(6)} ${pointCloud.positions[positionOffset + 1].toFixed(6)} ${pointCloud.positions[
        positionOffset + 2
      ].toFixed(6)} ${red} ${green} ${blue}`
    );
  }

  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export async function executePointcloudFromDepthNode(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
  const depthInput = ctx.inputs.depth?.[0];
  if (!depthInput) {
    throw new Error("Depth to Point Cloud requires a depth map input.");
  }

  const depthImage = decodePng(await ctx.loadInputBuffer(depthInput));
  const density = clampNumber(ctx.params.density, 1, 0.1, 2);
  const depthScale = clampNumber(ctx.params.depthScale, 1, 0.01, 100);

  let colorImage: DecodedPng | null = null;
  const colorInput = ctx.inputs.image?.[0] ?? null;
  if (colorInput?.mimeType === "image/png") {
    try {
      colorImage = decodePng(await ctx.loadInputBuffer(colorInput));
    } catch {
      colorImage = null;
    }
  }
  const cameraInput = ctx.inputs.camera?.[0] ?? null;
  const cameraIntrinsics = cameraInput ? parseCameraIntrinsics(await ctx.loadInputBuffer(cameraInput)) : null;

  const pointCloud = buildPointCloud(depthImage, colorImage, cameraIntrinsics, density, depthScale);
  const now = new Date().toISOString();
  return {
    outputs: [
      {
        outputId: "pointcloud",
        kind: "point_ply" as ArtifactKind,
        artifactType: "PointCloud",
        mimeType: "application/octet-stream",
        extension: "ply",
        buffer: createPlyBuffer(pointCloud),
        meta: {
          outputKey: "pointcloud",
          source: "depth-to-pointcloud",
          points: pointCloud.pointCount,
          density,
          depthScale,
          cameraIntrinsics: cameraIntrinsics ? "used" : "none",
          createdAt: now
        },
        hidden: false
      }
    ]
  };
}
