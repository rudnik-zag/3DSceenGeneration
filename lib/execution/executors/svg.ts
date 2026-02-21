export interface NormalizedBox {
  label: string;
  score: number;
  bbox: [number, number, number, number];
}

export function buildDetectionOverlaySvg(params: {
  width?: number;
  height?: number;
  title: string;
  boxes: NormalizedBox[];
}) {
  const width = params.width ?? 768;
  const height = params.height ?? 432;

  const rows = params.boxes
    .map((box) => {
      const [x, y, w, h] = box.bbox;
      const px = Math.round(x * width);
      const py = Math.round(y * height);
      const pw = Math.max(1, Math.round(w * width));
      const ph = Math.max(1, Math.round(h * height));
      const label = `${box.label} ${(box.score * 100).toFixed(1)}%`;
      const labelY = Math.max(16, py - 6);
      return `
        <rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="6" ry="6" fill="none" stroke="#6EF2BD" stroke-width="3"/>
        <rect x="${px}" y="${labelY - 14}" width="${Math.max(74, label.length * 7)}" height="18" rx="5" fill="rgba(0,0,0,0.65)" />
        <text x="${px + 8}" y="${labelY}" font-size="12" font-family="Inter, sans-serif" fill="#D8FCEB">${label}</text>
      `;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0E1B2F" />
      <stop offset="100%" stop-color="#0A0F1D" />
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)" />
  <text x="20" y="30" fill="#A7B7CE" font-family="Inter, sans-serif" font-size="14">${params.title}</text>
  ${rows}
</svg>`;
}

export function buildMaskSvg(params: {
  width?: number;
  height?: number;
  mode: "guided" | "full";
  boxes?: NormalizedBox[];
}) {
  const width = params.width ?? 768;
  const height = params.height ?? 432;

  const guided = (params.boxes ?? [])
    .map((box, idx) => {
      const [x, y, w, h] = box.bbox;
      const px = Math.round(x * width);
      const py = Math.round(y * height);
      const pw = Math.max(1, Math.round(w * width));
      const ph = Math.max(1, Math.round(h * height));
      const fillOpacity = 0.22 + (idx % 3) * 0.14;
      return `<rect x="${px}" y="${py}" width="${pw}" height="${ph}" fill="rgba(120,255,189,${fillOpacity})" />`;
    })
    .join("");

  const full = `
    <circle cx="${Math.round(width * 0.25)}" cy="${Math.round(height * 0.35)}" r="${Math.round(height * 0.22)}" fill="rgba(120,255,189,0.28)" />
    <circle cx="${Math.round(width * 0.6)}" cy="${Math.round(height * 0.55)}" r="${Math.round(height * 0.29)}" fill="rgba(142,194,255,0.28)" />
    <circle cx="${Math.round(width * 0.8)}" cy="${Math.round(height * 0.25)}" r="${Math.round(height * 0.16)}" fill="rgba(255,161,120,0.28)" />
  `;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="${width}" height="${height}" fill="#0B1220" />
  ${params.mode === "guided" ? guided : full}
  <text x="20" y="30" fill="#C8D2E8" font-family="Inter, sans-serif" font-size="14">
    SAM2 ${params.mode === "guided" ? "Guided segmentation" : "Full segmentation"}
  </text>
</svg>`;
}
