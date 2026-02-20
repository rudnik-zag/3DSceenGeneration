export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgX6f66kAAAAASUVORK5CYII=",
  "base64"
);

export function createJsonBuffer(data: unknown) {
  return Buffer.from(JSON.stringify(data, null, 2), "utf8");
}

export function createPointCloudPlyBuffer() {
  const ply = `ply
format ascii 1.0
element vertex 8
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
-0.5 -0.5 -0.5 255 0 0
0.5 -0.5 -0.5 0 255 0
0.5 0.5 -0.5 0 0 255
-0.5 0.5 -0.5 255 255 0
-0.5 -0.5 0.5 255 0 255
0.5 -0.5 0.5 0 255 255
0.5 0.5 0.5 255 255 255
-0.5 0.5 0.5 127 127 127
`;
  return Buffer.from(ply, "utf8");
}

function padTo4(buf: Buffer) {
  const pad = (4 - (buf.length % 4)) % 4;
  return pad ? Buffer.concat([buf, Buffer.from(" ".repeat(pad))]) : buf;
}

export function createMinimalGlbBuffer() {
  const json = {
    asset: { version: "2.0", generator: "tribalai-workflow-studio" },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: []
  };

  const jsonChunk = padTo4(Buffer.from(JSON.stringify(json), "utf8"));
  const totalLength = 12 + 8 + jsonChunk.length;

  const header = Buffer.alloc(12);
  header.write("glTF", 0, 4, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);

  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonChunk.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4);

  return Buffer.concat([header, chunkHeader, jsonChunk]);
}
