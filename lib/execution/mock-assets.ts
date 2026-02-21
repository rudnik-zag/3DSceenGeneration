export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/w8AAgMBgX6f66kAAAAASUVORK5CYII=",
  "base64"
);

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function createGeneratedImageSvgBuffer(params: { model: string; prompt: string }) {
  const model = escapeXml(params.model || "Z-Image-Turbo");
  const prompt = escapeXml(params.prompt || "Generated scene");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="576" viewBox="0 0 1024 576">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#081126"/>
      <stop offset="50%" stop-color="#143a55"/>
      <stop offset="100%" stop-color="#1f6c7f"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="576" fill="url(#bg)"/>
  <circle cx="170" cy="140" r="120" fill="#5fd3b7" fill-opacity="0.18"/>
  <circle cx="860" cy="120" r="160" fill="#8dc9ff" fill-opacity="0.14"/>
  <rect x="70" y="368" width="884" height="150" rx="18" fill="#05080f" fill-opacity="0.42"/>
  <text x="88" y="422" fill="#e6f4f1" font-size="28" font-family="Inter, Arial, sans-serif">${model}</text>
  <text x="88" y="462" fill="#c4d6e4" font-size="20" font-family="Inter, Arial, sans-serif">${prompt}</text>
  <text x="88" y="496" fill="#8ea8bf" font-size="16" font-family="Inter, Arial, sans-serif">Mock generated image output</text>
</svg>`;

  return Buffer.from(svg, "utf8");
}

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
