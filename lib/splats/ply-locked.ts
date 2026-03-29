import { createReadStream, promises as fs } from "fs";

import {
  LOCKED_SPLAT_PLY_FLOATS_PER_VERTEX,
  LOCKED_SPLAT_PLY_PROPERTIES,
  LOCKED_SPLAT_PLY_RECORD_BYTES
} from "@/lib/splats/types";

const MAX_HEADER_BYTES = 1024 * 1024;

export interface LockedSplatPlyHeader {
  format: "binary_little_endian";
  vertexCount: number;
  headerByteLength: number;
  recordByteLength: number;
}

function parseHeaderText(headerText: string) {
  const lines = headerText.split(/\r?\n/).map((line) => line.trim());
  if (lines[0] !== "ply") {
    throw new Error("Invalid PLY file: missing magic 'ply' header.");
  }

  const formatLine = lines.find((line) => line.startsWith("format "));
  if (formatLine !== "format binary_little_endian 1.0") {
    throw new Error(`Unsupported PLY format. Expected "binary_little_endian 1.0", got "${formatLine ?? "missing"}".`);
  }

  let vertexCount = 0;
  let inVertexElement = false;
  const vertexProperties: string[] = [];

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith("element ")) {
      const [, elementName, countToken] = line.split(/\s+/);
      inVertexElement = elementName === "vertex";
      if (inVertexElement) {
        const parsed = Number.parseInt(countToken ?? "", 10);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`Invalid vertex count in PLY header: "${countToken ?? ""}".`);
        }
        vertexCount = parsed;
      }
      continue;
    }

    if (inVertexElement && line.startsWith("property ")) {
      const [, type, propertyName] = line.split(/\s+/);
      if (type !== "float") {
        throw new Error(`Unsupported PLY vertex property type "${type}" for "${propertyName}". Expected float.`);
      }
      vertexProperties.push(propertyName ?? "");
    }

    if (line === "end_header") {
      break;
    }
  }

  if (vertexCount <= 0) {
    throw new Error("PLY header does not define a valid vertex element count.");
  }

  if (vertexProperties.length !== LOCKED_SPLAT_PLY_FLOATS_PER_VERTEX) {
    throw new Error(
      `Unsupported PLY vertex schema: expected ${LOCKED_SPLAT_PLY_FLOATS_PER_VERTEX} properties, got ${vertexProperties.length}.`
    );
  }

  for (let i = 0; i < LOCKED_SPLAT_PLY_PROPERTIES.length; i += 1) {
    if (vertexProperties[i] !== LOCKED_SPLAT_PLY_PROPERTIES[i]) {
      throw new Error(
        `Unsupported PLY schema order at index ${i}: expected "${LOCKED_SPLAT_PLY_PROPERTIES[i]}", got "${vertexProperties[i]}".`
      );
    }
  }

  return { vertexCount };
}

export async function parseLockedSplatPlyHeader(filePath: string): Promise<LockedSplatPlyHeader> {
  const handle = await fs.open(filePath, "r");
  try {
    let offset = 0;
    let headerBuffer = Buffer.alloc(0);
    let headerByteLength = -1;

    while (offset < MAX_HEADER_BYTES && headerByteLength < 0) {
      const readBuffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, offset);
      if (bytesRead <= 0) break;

      offset += bytesRead;
      headerBuffer = Buffer.concat([headerBuffer, readBuffer.subarray(0, bytesRead)]);

      const endHeaderIndex = headerBuffer.indexOf("end_header");
      if (endHeaderIndex >= 0) {
        const newLineIndex = headerBuffer.indexOf(0x0a, endHeaderIndex);
        if (newLineIndex >= 0) {
          headerByteLength = newLineIndex + 1;
          break;
        }
      }
    }

    if (headerByteLength < 0) {
      throw new Error("Could not find PLY end_header marker.");
    }

    const headerText = headerBuffer.subarray(0, headerByteLength).toString("utf8");
    const parsed = parseHeaderText(headerText);
    const stat = await handle.stat();
    const expectedBytes = parsed.vertexCount * LOCKED_SPLAT_PLY_RECORD_BYTES;
    const actualBytes = stat.size - headerByteLength;
    if (actualBytes < expectedBytes) {
      throw new Error(
        `PLY file appears truncated. Expected at least ${expectedBytes} data bytes, found ${actualBytes}.`
      );
    }

    return {
      format: "binary_little_endian",
      vertexCount: parsed.vertexCount,
      headerByteLength,
      recordByteLength: LOCKED_SPLAT_PLY_RECORD_BYTES
    };
  } finally {
    await handle.close();
  }
}

export function createLockedSplatPlyHeader(vertexCount: number) {
  if (!Number.isFinite(vertexCount) || vertexCount < 0) {
    throw new Error(`Invalid PLY vertex count: ${vertexCount}`);
  }

  const header = [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${Math.floor(vertexCount)}`,
    "property float x",
    "property float y",
    "property float z",
    "property float nx",
    "property float ny",
    "property float nz",
    "property float f_dc_0",
    "property float f_dc_1",
    "property float f_dc_2",
    "property float opacity",
    "property float scale_0",
    "property float scale_1",
    "property float scale_2",
    "property float rot_0",
    "property float rot_1",
    "property float rot_2",
    "property float rot_3",
    "end_header",
    ""
  ].join("\n");

  return Buffer.from(header, "utf8");
}

export interface IterateLockedPlyRecordsOptions {
  filePath: string;
  header: LockedSplatPlyHeader;
  onRecord: (record: Buffer, vertexIndex: number) => void | Promise<void>;
}

export async function iterateLockedPlyRecords(options: IterateLockedPlyRecordsOptions) {
  const stream = createReadStream(options.filePath, {
    start: options.header.headerByteLength,
    highWaterMark: 4 * 1024 * 1024
  });

  let carry = Buffer.alloc(0);
  let vertexIndex = 0;

  for await (const chunk of stream) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const buffer = carry.length > 0 ? Buffer.concat([carry, chunkBuffer]) : chunkBuffer;
    const fullRecordBytes = Math.floor(buffer.length / LOCKED_SPLAT_PLY_RECORD_BYTES) * LOCKED_SPLAT_PLY_RECORD_BYTES;
    const remainderStart = fullRecordBytes;

    for (let offset = 0; offset < fullRecordBytes; offset += LOCKED_SPLAT_PLY_RECORD_BYTES) {
      const record = buffer.subarray(offset, offset + LOCKED_SPLAT_PLY_RECORD_BYTES);
      await options.onRecord(record, vertexIndex);
      vertexIndex += 1;
    }

    carry = remainderStart < buffer.length ? buffer.subarray(remainderStart) : Buffer.alloc(0);
  }

  if (carry.length > 0) {
    throw new Error("Unexpected trailing bytes in PLY stream (record alignment mismatch).");
  }
}

export function readLockedPlyPosition(record: Buffer): [number, number, number] {
  return [record.readFloatLE(0), record.readFloatLE(4), record.readFloatLE(8)];
}

