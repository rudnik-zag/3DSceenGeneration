import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { nodeSpecRegistry } from "@/lib/graph/node-specs";
import type { NodeSpec, WorkflowNodeType } from "@/types/workflow";

type ExecutorSummary = {
  mode: "real" | "mock" | "inline" | "template" | "disabled" | "reference";
  label: string;
  detail: string;
};

type RuntimeIntegration = {
  title: string;
  nodeTypes: WorkflowNodeType[];
  endpoint: string;
  capability: string;
  outputs: string;
};

type GeneratedPage = {
  slug: string;
  title: string;
  description: string;
  body: string;
};

type SourceDocPage = {
  slug: string;
  title: string;
  description: string;
  sourcePath: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsOutputDir = path.join(repoRoot, "public", "technical-docs");
const legacyOutputPath = path.join(repoRoot, "public", "technical-docs.html");

const envSourceFiles = [
  "docs/PROJECT_DOCUMENTATION.md",
  "docs/IMPLEMENTATION_RUNBOOK.md",
  "docs/COMFYUI_INTEGRATION_PLAN.md",
  "docs/BILLING_SUBSCRIPTION_IMPLEMENTATION.md",
  "docs/OBSERVABILITY_ANALYTICS_GUIDE.md",
  "docs/SECURITY_IMPLEMENTATION.md",
  "lib/execution/executors/comfy-image.ts",
  "lib/execution/executors/depth-estimation.ts",
  "lib/execution/executors/groundingdino.ts",
  "lib/execution/executors/sam2.ts",
  "lib/execution/executors/scene-generation.ts",
  "lib/storage/s3.ts",
  "lib/billing/stripe.ts",
  "lib/env.ts"
];

const sourceDocPages: SourceDocPage[] = [
  {
    slug: "project",
    title: "Project Documentation",
    description: "Full project architecture, backend, database, workflow, viewer, analytics, and extension notes.",
    sourcePath: "docs/PROJECT_DOCUMENTATION.md"
  },
  {
    slug: "runbook",
    title: "Runbook",
    description: "Current local run instructions, infra setup, smoke tests, operational notes, and troubleshooting.",
    sourcePath: "docs/IMPLEMENTATION_RUNBOOK.md"
  },
  {
    slug: "comfyui",
    title: "ComfyUI Integration",
    description: "ComfyUI process control, workflow templates, Qwen defaults, and runtime environment keys.",
    sourcePath: "docs/COMFYUI_INTEGRATION_PLAN.md"
  },
  {
    slug: "security",
    title: "Security Implementation",
    description: "Authentication, authorization, validation, rate limiting, audit logs, and storage access controls.",
    sourcePath: "docs/SECURITY_IMPLEMENTATION.md"
  },
  {
    slug: "billing",
    title: "Billing and Subscription",
    description: "Billing surfaces, token accounting, Stripe integration, webhook handling, and rollout controls.",
    sourcePath: "docs/BILLING_SUBSCRIPTION_IMPLEMENTATION.md"
  },
  {
    slug: "observability",
    title: "Observability and Analytics",
    description: "Analytics views, Metabase playbooks, Sentry notes, and operational query references.",
    sourcePath: "docs/OBSERVABILITY_ANALYTICS_GUIDE.md"
  },
  {
    slug: "business",
    title: "Business Plan",
    description: "Business planning notes, market framing, financial model references, and go-to-market context.",
    sourcePath: "docs/BUSINESS_PLAN.md"
  }
];

const runtimeIntegrations: RuntimeIntegration[] = [
  {
    title: "Qwen-Distill / Z-Image-Turbo",
    nodeTypes: ["input.image"],
    endpoint: "ComfyUI /prompt API",
    capability: "Text-to-image generation from the Input Image node when Source Mode is generate.",
    outputs: "Image artifact with preview metadata."
  },
  {
    title: "Qwen Image Edit 2511",
    nodeTypes: ["model.qwen_image_edit"],
    endpoint: "ComfyUI /prompt API",
    capability: "Image-guided editing with prompt, optional references, turbo mode, sampler, scheduler, CFG, and denoise controls.",
    outputs: "Edited Image artifact."
  },
  {
    title: "GroundingDINO",
    nodeTypes: ["model.groundingdino"],
    endpoint: "Python executor wrapper",
    capability: "Open-vocabulary object detection from image and text prompt.",
    outputs: "Descriptor JSON containing boxes/classes/scores."
  },
  {
    title: "SAM2",
    nodeTypes: ["model.sam2"],
    endpoint: "Python executor wrapper",
    capability: "Guided or automatic segmentation, optionally consuming GroundingDINO boxes.",
    outputs: "MaskSet and segmentation metadata."
  },
  {
    title: "SAM 3D Objects",
    nodeTypes: ["model.sam3d_objects", "pipeline.scene_generation"],
    endpoint: "Python executor wrapper",
    capability: "Object-level 3D reconstruction from image masks and scene-generation presets.",
    outputs: "SceneAsset, mesh/point outputs, and stage preview artifacts."
  },
  {
    title: "Depth Anything 3",
    nodeTypes: ["geo.depth_estimation"],
    endpoint: "Depth-Anything-3 uv virtualenv",
    capability: "Image or MP4 depth estimation with selectable da3-base / da3metric-large runtime behavior.",
    outputs: "Depth map, depth sequence, preview video, sky/confidence/camera metadata where supported, optional GLB scene."
  },
  {
    title: "Depth to Point Cloud",
    nodeTypes: ["geo.pointcloud_from_depth"],
    endpoint: "Local TypeScript/Python-backed geometry executor",
    capability: "Back-projects depth and optional color/camera data into point cloud assets.",
    outputs: "PointCloud artifact."
  }
];

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function compactJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

async function readText(relativePath: string) {
  try {
    return await fs.readFile(path.join(repoRoot, relativePath), "utf8");
  } catch {
    return "";
  }
}

function splitExecutorCases(source: string) {
  const caseRegex = /^\s*case "([^"]+)":/gm;
  const matches = [...source.matchAll(caseRegex)];
  const blocks = new Map<string, string>();

  matches.forEach((match, index) => {
    const type = match[1] as WorkflowNodeType;
    const start = match.index ?? 0;
    const defaultIndex = source.indexOf("\n      default:", start);
    const nextCaseIndex = index + 1 < matches.length ? matches[index + 1].index ?? source.length : source.length;
    const end = defaultIndex !== -1 && defaultIndex < nextCaseIndex ? defaultIndex : nextCaseIndex;
    blocks.set(type, source.slice(start, end));
  });

  return blocks;
}

function summarizeExecutor(spec: NodeSpec, executorCases: Map<string, string>): ExecutorSummary {
  if (spec.ui?.available === false) {
    return {
      mode: "disabled",
      label: "Disabled",
      detail: spec.ui.unavailableReason ?? "Hidden from node creation because runtime is not production-ready."
    };
  }

  const block = executorCases.get(spec.type);
  if (!block) {
    return {
      mode: "reference",
      label: "Reference",
      detail: "No direct runner case. Used as a viewer/reference node or handled by connected UI state."
    };
  }

  const directExecutor = block.match(/return execute([A-Za-z0-9]+)Node\(ctx\)/);
  if (directExecutor) {
    return {
      mode: "real",
      label: "Real executor",
      detail: `Dispatches to execute${directExecutor[1]}Node(ctx).`
    };
  }

  if (block.includes("executeComfyQwenDistillNode") || block.includes("executeComfyZImageNode")) {
    return {
      mode: "real",
      label: "Conditional real executor",
      detail: "Dispatches to ComfyUI generation when Source Mode is generate; upload mode emits the stored image artifact."
    };
  }

  if (block.includes("template expansion")) {
    return {
      mode: "template",
      label: "Template expansion",
      detail: "Expanded into executable graph nodes by run-workflow instead of executed directly."
    };
  }

  if (block.includes("createMinimalGlbBuffer") || block.includes("placeholder") || block.includes("Mock")) {
    return {
      mode: "mock",
      label: "Mock/stub",
      detail: "Produces placeholder assets and should remain disabled or treated as non-production."
    };
  }

  return {
    mode: "inline",
    label: "Inline executor",
    detail: "Handled directly inside the node runner."
  };
}

function extractEnvNames(sources: string[]) {
  const names = new Set<string>();
  const relevant = /^(AUTH|BILLING|COMFYUI|DATABASE|DEPTH_ANYTHING3|GROUNDING_DINO|LOCAL_STORAGE|MINIO|NEXT_PUBLIC|NEXTAUTH|REDIS|S3|SAM2|SAM3D|SENTRY|STRIPE|UPLOAD|WORKER)_/;
  const exactNames = new Set(["DATABASE_URL", "NODE_ENV", "REDIS_URL"]);

  sources.forEach((source) => {
    for (const match of source.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
      const name = match[0];
      if (!name.endsWith("_") && (exactNames.has(name) || relevant.test(name))) {
        names.add(name);
      }
    }
  });

  return [...names].sort((left, right) => left.localeCompare(right));
}

function envGroupFor(name: string) {
  if (name.startsWith("COMFYUI")) return "ComfyUI";
  if (name.startsWith("DEPTH_ANYTHING3")) return "Depth Anything 3";
  if (name.startsWith("SAM2") || name.startsWith("SAM3D") || name.startsWith("GROUNDING")) return "ML Wrappers";
  if (name.startsWith("S3") || name.startsWith("MINIO") || name.startsWith("LOCAL_STORAGE") || name.startsWith("UPLOAD")) return "Storage";
  if (name.startsWith("DATABASE") || name.startsWith("REDIS")) return "Database / Queue";
  if (name.startsWith("STRIPE") || name.startsWith("BILLING")) return "Billing";
  if (name.startsWith("SENTRY")) return "Observability";
  if (name.startsWith("AUTH") || name.startsWith("NEXTAUTH") || name.startsWith("NEXT_PUBLIC") || name === "NODE_ENV") return "App Runtime";
  return "Other";
}

function renderInlineMarkdown(value: string) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const safeHref = href.startsWith("http") || href.startsWith("#") ? href : href.replaceAll(".md", ".html");
    return `<a href="${escapeHtml(safeHref)}">${label}</a>`;
  });
  return html;
}

function renderMarkdownTable(lines: string[]) {
  const rows = lines
    .filter((line, index) => index !== 1)
    .map((line) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
  const [head = [], ...body] = rows;
  return `<table><thead><tr>${head.map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}

function markdownToHtml(markdown: string) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  const paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let codeLanguage = "";
  let codeLines: string[] | null = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph.length = 0;
  }

  function closeList() {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (codeLines) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = null;
        codeLanguage = "";
      } else {
        flushParagraph();
        closeList();
        codeLanguage = trimmed.slice(3).trim();
        codeLines = [];
      }
      continue;
    }

    if (codeLines) {
      codeLines.push(codeLanguage ? line : line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    if (/^\|.+\|$/.test(trimmed) && index + 1 < lines.length && /^\|?[\s:-]+\|[\s|:-]+$/.test(lines[index + 1]?.trim() ?? "")) {
      flushParagraph();
      closeList();
      const tableLines = [trimmed, lines[index + 1]?.trim() ?? ""];
      index += 2;
      while (index < lines.length && /^\|.+\|$/.test(lines[index]?.trim() ?? "")) {
        tableLines.push(lines[index]?.trim() ?? "");
        index += 1;
      }
      index -= 1;
      html.push(renderMarkdownTable(tableLines));
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = trimmed.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      continue;
    }

    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  if (codeLines) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }

  return html.join("\n");
}

function renderPorts(ports: NodeSpec["inputPorts"] | NodeSpec["outputPorts"]) {
  if (ports.length === 0) return "<span class=\"muted\">None</span>";
  return ports
    .map((port) => {
      const required = port.required ? " required" : "";
      const hidden = port.hidden ? " hidden" : "";
      const advanced = port.advancedOnly ? " advanced" : "";
      return `<span class="pill">${escapeHtml(port.id)} · ${escapeHtml(port.artifactType)}${required}${hidden}${advanced}</span>`;
    })
    .join(" ");
}

function renderParams(spec: NodeSpec) {
  const fields = spec.paramFields.map((field) => {
    const defaultValue = spec.defaultParams[field.key];
    return `<tr><td><code>${escapeHtml(field.key)}</code></td><td>${escapeHtml(field.label)}</td><td>${escapeHtml(field.input)}</td><td><code>${escapeHtml(defaultValue === undefined ? "—" : compactJson(defaultValue))}</code></td></tr>`;
  });

  if (fields.length === 0) {
    return "<p class=\"muted\">No editable parameters.</p>";
  }

  return `<table><thead><tr><th>Key</th><th>Label</th><th>Input</th><th>Default</th></tr></thead><tbody>${fields.join("")}</tbody></table>`;
}

function statusClass(mode: ExecutorSummary["mode"]) {
  if (mode === "real") return "ok";
  if (mode === "disabled") return "disabled";
  if (mode === "mock") return "warn";
  if (mode === "template") return "info";
  return "neutral";
}

function renderNodeCards(specs: NodeSpec[], executorSummaries: Map<WorkflowNodeType, ExecutorSummary>) {
  return specs
    .map((spec) => {
      const executor = executorSummaries.get(spec.type) ?? {
        mode: "reference",
        label: "Reference",
        detail: "No executor summary available."
      };
      const defaultParams = compactJson(spec.defaultParams);

      return `<section class="node-card" id="${escapeHtml(spec.type)}">
        <div class="node-card-head">
          <div>
            <p class="eyebrow">${escapeHtml(spec.category)} · <code>${escapeHtml(spec.type)}</code></p>
            <h3>${escapeHtml(spec.title)}</h3>
          </div>
          <span class="badge ${statusClass(executor.mode)}">${escapeHtml(executor.label)}</span>
        </div>
        <p>${escapeHtml(spec.description)}</p>
        <div class="node-grid">
          <div><h4>Inputs</h4><div class="pill-row">${renderPorts(spec.inputPorts)}</div></div>
          <div><h4>Outputs</h4><div class="pill-row">${renderPorts(spec.outputPorts)}</div></div>
        </div>
        <details>
          <summary>Parameters and defaults</summary>
          ${renderParams(spec)}
          <h4>Default Params JSON</h4>
          <pre>${escapeHtml(defaultParams)}</pre>
        </details>
        <p class="executor-detail">${escapeHtml(executor.detail)}</p>
      </section>`;
    })
    .join("\n");
}

function renderModelRows(executorSummaries: Map<WorkflowNodeType, ExecutorSummary>) {
  return runtimeIntegrations
    .map((integration) => {
      const nodes = integration.nodeTypes.map((nodeType) => `<code>${escapeHtml(nodeType)}</code>`).join(" ");
      const modes = integration.nodeTypes
        .map((nodeType) => executorSummaries.get(nodeType)?.label ?? "Reference")
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(" / ");
      return `<tr>
        <td>${escapeHtml(integration.title)}</td>
        <td>${nodes}</td>
        <td>${escapeHtml(integration.endpoint)}</td>
        <td>${escapeHtml(integration.capability)}</td>
        <td>${escapeHtml(integration.outputs)}</td>
        <td><span class="badge ${modes.includes("Real") || modes.includes("Conditional") ? "ok" : "info"}">${escapeHtml(modes)}</span></td>
      </tr>`;
    })
    .join("\n");
}

function renderEnvGroups(envNames: string[]) {
  const grouped = new Map<string, string[]>();
  envNames.forEach((name) => {
    const group = envGroupFor(name);
    grouped.set(group, [...(grouped.get(group) ?? []), name]);
  });

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([group, names]) => `<section class="env-card">
      <h2>${escapeHtml(group)}</h2>
      <div class="pill-row">${names.map((name) => `<code class="env">${escapeHtml(name)}</code>`).join(" ")}</div>
    </section>`)
    .join("\n");
}

function renderStats(specs: NodeSpec[], executorSummaries: Map<WorkflowNodeType, ExecutorSummary>, envCount: number) {
  const enabledCount = specs.filter((spec) => spec.ui?.available !== false).length;
  const runnableCount = specs.filter((spec) => spec.ui?.nodeRunEnabled).length;
  const realExecutorCount = specs.filter((spec) => {
    const mode = executorSummaries.get(spec.type)?.mode;
    return mode === "real" || mode === "inline" || mode === "template";
  }).length;

  return `<div class="stats">
    <div><strong>${specs.length}</strong><span>Registered nodes</span></div>
    <div><strong>${enabledCount}</strong><span>Creatable nodes</span></div>
    <div><strong>${runnableCount}</strong><span>Run-button nodes</span></div>
    <div><strong>${realExecutorCount}</strong><span>Real/template executors</span></div>
    <div><strong>${envCount}</strong><span>Documented env keys</span></div>
  </div>`;
}

function renderCommandBlock(title: string, commands: string[]) {
  return `<section class="panel">
    <h2>${escapeHtml(title)}</h2>
    <pre><code>${escapeHtml(commands.join("\n"))}</code></pre>
  </section>`;
}

function renderRunQuickStart() {
  return `<section class="panel">
    <h2>Recommended Local Run</h2>
    <div class="step-grid">
      <div><span>1</span><h3>Start infra</h3><pre><code>docker compose up -d postgres redis minio</code></pre></div>
      <div><span>2</span><h3>Prepare app</h3><pre><code>cp .env.example .env
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm db:seed</code></pre></div>
      <div><span>3</span><h3>Run services</h3><pre><code># terminal A
pnpm dev

# terminal B
pnpm worker</code></pre></div>
      <div><span>4</span><h3>Open</h3><pre><code>http://localhost:3000
http://localhost:9001</code></pre></div>
    </div>
  </section>`;
}

function renderArchitecturePage() {
  return `<section class="panel">
    <h2>Runtime Components</h2>
    <div class="grid">
      <div><h3>Next.js Web App</h3><p>App Router pages, API routes, authentication, billing, uploads, storage access, GraphEditor, and viewer entry points.</p></div>
      <div><h3>Worker Runtime</h3><p>BullMQ worker executes graph runs, resolves artifacts, applies cache keys, stores outputs, and writes telemetry.</p></div>
      <div><h3>Graph System</h3><p>Node specs define typed ports, Zod parameters, defaults, UI hints, and creation availability.</p></div>
      <div><h3>Storage</h3><p>S3/MinIO is primary; local fallback stores generated files under <code>.local-storage/</code> when S3 is unavailable.</p></div>
      <div><h3>3D Viewer</h3><p>Three.js handles GLB/PLY and camera-path visualization; splat runtime handles Gaussian splat formats.</p></div>
      <div><h3>ML Integrations</h3><p>ComfyUI, GroundingDINO, SAM2, SAM3D, Depth Anything 3, and geometry exporters are called by node executors.</p></div>
    </div>
  </section>
  <section class="panel">
    <h2>Main Routes</h2>
    <table>
      <thead><tr><th>Route</th><th>Purpose</th></tr></thead>
      <tbody>
        <tr><td><code>/</code></td><td>Landing page and latest project gallery.</td></tr>
        <tr><td><code>/app</code></td><td>Authenticated dashboard.</td></tr>
        <tr><td><code>/app/p/[projectId]/graph-editor</code></td><td>GraphEditor workflow canvas.</td></tr>
        <tr><td><code>/app/p/[projectId]/runs</code></td><td>Run history, progress, logs, and artifacts.</td></tr>
        <tr><td><code>/app/p/[projectId]/viewer</code></td><td>3D artifact viewer and world scene controls.</td></tr>
        <tr><td><code>/billing</code></td><td>Token wallet, subscriptions, and transaction history.</td></tr>
      </tbody>
    </table>
  </section>
  <section class="panel">
    <h2>Execution Flow</h2>
    <ol>
      <li>User saves graph JSON from GraphEditor.</li>
      <li>Run endpoint creates a Run row and enqueues worker job.</li>
      <li>Worker topologically sorts graph tasks and resolves input artifacts.</li>
      <li>Each node validates merged default/user parameters and executes or uses cache.</li>
      <li>Artifacts are persisted with output keys, MIME metadata, preview data, and history.</li>
      <li>Run events, run steps, analytics rows, and billing usage are finalized.</li>
    </ol>
  </section>`;
}

function renderIndexPage(specs: NodeSpec[], executorSummaries: Map<WorkflowNodeType, ExecutorSummary>, envNames: string[]) {
  return `<section class="hero">
    <p class="eyebrow">Generated Documentation Site</p>
    <h1>TribalAI Technical Documentation</h1>
    <p>This static site is generated by <code>pnpm docs:generate</code>. It reads node specs, executor dispatch mappings, source documentation, and runtime env references, then writes pages under <code>public/technical-docs/</code>.</p>
    ${renderStats(specs, executorSummaries, envNames.length)}
  </section>
  <section class="panel">
    <h2>Documentation Map</h2>
    <div class="card-grid">
      <a class="card-link" href="runbook.html"><h3>Run Current Application</h3><p>Prerequisites, env setup, local infra, app/worker startup, Docker run, smoke tests, and troubleshooting.</p></a>
      <a class="card-link" href="architecture.html"><h3>Architecture</h3><p>Runtime components, routes, execution flow, artifact pipeline, and viewer responsibilities.</p></a>
      <a class="card-link" href="models.html"><h3>Models</h3><p>Attached ML models, executor endpoints, capabilities, outputs, and current runtime status.</p></a>
      <a class="card-link" href="nodes.html"><h3>Node Registry</h3><p>Every node type, input/output ports, editable params, defaults, and executor mapping.</p></a>
      <a class="card-link" href="environment.html"><h3>Environment</h3><p>Generated inventory of app, storage, billing, ComfyUI, and ML runtime environment keys.</p></a>
      <a class="card-link" href="project.html"><h3>Project Documentation</h3><p>Converted source documentation with backend, database, security, analytics, and extension details.</p></a>
    </div>
  </section>
  ${renderRunQuickStart()}`;
}

function renderModelsPage(executorSummaries: Map<WorkflowNodeType, ExecutorSummary>) {
  return `<section class="panel">
    <h2>Attached Models and Endpoints</h2>
    <p class="muted">Generated from curated runtime integration metadata and executor dispatch status from <code>lib/execution/mock-runner.ts</code>.</p>
    <table>
      <thead><tr><th>Model</th><th>Node</th><th>Endpoint</th><th>Capability</th><th>Outputs</th><th>Status</th></tr></thead>
      <tbody>${renderModelRows(executorSummaries)}</tbody>
    </table>
  </section>`;
}

function renderNodesPage(specs: NodeSpec[], executorSummaries: Map<WorkflowNodeType, ExecutorSummary>) {
  const categories = [...new Set(specs.map((spec) => spec.category))].sort();
  return `${categories
    .map((category) => {
      const categorySpecs = specs.filter((spec) => spec.category === category);
      return `<section id="category-${escapeHtml(category)}">
        <h2>${escapeHtml(category)}</h2>
        ${renderNodeCards(categorySpecs, executorSummaries)}
      </section>`;
    })
    .join("\n")}`;
}

function renderEnvironmentPage(envNames: string[]) {
  return `<section class="panel">
    <h2>Environment Inventory</h2>
    <p class="muted">Generated from selected docs and runtime files. This page lists variable names only; it never reads <code>.env</code> values.</p>
  </section>
  ${renderEnvGroups(envNames)}
  ${renderCommandBlock("Baseline Local Environment", [
    "cp .env.example .env",
    "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tribalai3d?schema=public",
    "REDIS_URL=redis://localhost:6379",
    "S3_ENDPOINT=http://localhost:9000",
    "S3_BUCKET=artifacts",
    "LOCAL_STORAGE_ROOT=.local-storage",
    "NEXT_PUBLIC_APP_URL=http://localhost:3000"
  ])}`;
}

function renderSourceDocPage(page: SourceDocPage, markdown: string) {
  return `<section class="panel">
    <p class="eyebrow">Source: <code>${escapeHtml(page.sourcePath)}</code></p>
    <p class="muted">This page is converted from the repository Markdown source when <code>pnpm docs:generate</code> runs.</p>
  </section>
  <article class="doc-article">${markdownToHtml(markdown)}</article>`;
}

function stylesheet() {
  return `:root {
  color-scheme: dark;
  --bg: #05070e;
  --panel: #0c1425;
  --panel-2: #101b31;
  --border: #243654;
  --text: #f6f8ff;
  --muted: #9fb0cf;
  --accent: #46e0ad;
  --blue: #7ca7ff;
  --warn: #f2c36b;
  --danger: #ff8b8b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: radial-gradient(circle at top left, rgba(70,224,173,0.12), transparent 32rem), var(--bg);
  color: var(--text);
  font: 15px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
a { color: var(--accent); text-decoration: none; }
p { color: #cdd8ee; }
code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace; }
pre {
  max-height: 420px;
  overflow: auto;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: rgba(3, 7, 18, 0.72);
  color: #d7e3ff;
}
table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 12px; margin: 14px 0; }
th, td { padding: 12px; border-bottom: 1px solid rgba(36,54,84,0.8); vertical-align: top; text-align: left; }
th { color: var(--muted); font-size: 0.76rem; text-transform: uppercase; letter-spacing: 0.08em; background: rgba(16,27,49,0.8); }
td { color: #d8e2f4; }
.site-shell { display: grid; grid-template-columns: 260px minmax(0, 1fr); min-height: 100vh; }
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: auto;
  padding: 24px;
  border-right: 1px solid var(--border);
  background: rgba(5, 7, 14, 0.88);
}
.brand { display: block; margin-bottom: 24px; color: var(--text); }
.brand strong { display: block; font-size: 1.05rem; }
.brand span { display: block; color: var(--muted); font-size: 0.78rem; }
.nav-group { margin: 18px 0; }
.nav-group-title { margin: 0 0 8px; color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.14em; }
.sidebar a.nav-link {
  display: block;
  padding: 8px 10px;
  border-radius: 10px;
  color: #dce6ff;
}
.sidebar a.nav-link:hover, .sidebar a.nav-link.active { background: rgba(70,224,173,0.1); color: var(--accent); }
main { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 40px 0 72px; }
.page-head { margin-bottom: 22px; }
.page-head h1, .hero h1 { font-size: clamp(2.2rem, 5vw, 4.6rem); line-height: 0.95; margin: 0 0 16px; letter-spacing: -0.06em; }
.page-head p { max-width: 860px; }
h2 { margin: 42px 0 18px; font-size: 1.55rem; }
h3 { margin: 0; font-size: 1.08rem; }
h4 { margin: 16px 0 8px; color: var(--muted); font-size: 0.78rem; letter-spacing: 0.08em; text-transform: uppercase; }
.hero, .panel, .node-card, .env-card, .card-link {
  border: 1px solid var(--border);
  border-radius: 22px;
  background: linear-gradient(180deg, rgba(16,27,49,0.95), rgba(8,14,27,0.95));
  box-shadow: 0 24px 70px rgba(0,0,0,0.28);
}
.hero, .panel { padding: 24px; margin-bottom: 18px; }
.muted { color: var(--muted); }
.eyebrow { margin: 0 0 8px; color: var(--accent); text-transform: uppercase; letter-spacing: 0.18em; font-size: 0.73rem; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-top: 24px; }
.stats div { padding: 18px; border: 1px solid var(--border); border-radius: 18px; background: rgba(12,20,37,0.72); }
.stats strong { display: block; font-size: 1.8rem; color: var(--accent); }
.stats span { color: var(--muted); }
.grid, .card-grid, .step-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
.card-link { display: block; padding: 20px; color: var(--text); }
.card-link p { color: var(--muted); }
.step-grid span {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  margin-bottom: 10px;
  border-radius: 999px;
  background: rgba(70,224,173,0.14);
  color: var(--accent);
}
.node-card, .env-card { padding: 22px; margin: 14px 0; }
.node-card-head, .node-grid { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 16px; align-items: start; }
.node-grid { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); margin-top: 14px; }
.pill-row { display: flex; flex-wrap: wrap; gap: 8px; }
.pill, .badge, .env {
  display: inline-flex;
  align-items: center;
  border: 1px solid rgba(124,167,255,0.32);
  border-radius: 999px;
  padding: 6px 10px;
  background: rgba(124,167,255,0.08);
  color: #dce6ff;
  font-size: 0.78rem;
}
.badge.ok { border-color: rgba(70,224,173,0.45); color: var(--accent); background: rgba(70,224,173,0.10); }
.badge.warn { border-color: rgba(242,195,107,0.55); color: var(--warn); background: rgba(242,195,107,0.10); }
.badge.disabled { border-color: rgba(255,139,139,0.45); color: var(--danger); background: rgba(255,139,139,0.10); }
.badge.info { border-color: rgba(124,167,255,0.5); color: var(--blue); background: rgba(124,167,255,0.10); }
.badge.neutral { color: var(--muted); }
.executor-detail { color: var(--muted); font-size: 0.92rem; }
details { margin-top: 16px; }
summary { cursor: pointer; color: var(--accent); }
.doc-article {
  padding: 24px;
  border: 1px solid var(--border);
  border-radius: 22px;
  background: rgba(12,20,37,0.72);
}
.doc-article h2:first-child { margin-top: 0; }
.doc-article li { margin: 5px 0; color: #d8e2f4; }
@media (max-width: 900px) {
  .site-shell { grid-template-columns: 1fr; }
  .sidebar { position: static; height: auto; }
  main { width: min(100% - 24px, 1120px); padding-top: 24px; }
  .node-card-head { grid-template-columns: 1fr; }
}`;
}

function navItems() {
  const primary = [
    ["index", "Overview"],
    ["runbook", "Run Current App"],
    ["architecture", "Architecture"],
    ["models", "Models"],
    ["nodes", "Node Registry"],
    ["environment", "Environment"]
  ] as const;

  return [
    ["Generated", primary],
    ["Source Docs", sourceDocPages.filter((page) => page.slug !== "runbook").map((page) => [page.slug, page.title] as const)]
  ] as const;
}

function renderPage(page: GeneratedPage) {
  const nav = navItems()
    .map(([group, links]) => `<div class="nav-group">
      <p class="nav-group-title">${escapeHtml(group)}</p>
      ${links.map(([slug, label]) => `<a class="nav-link ${slug === page.slug ? "active" : ""}" href="${slug}.html">${escapeHtml(label)}</a>`).join("")}
    </div>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(page.title)} · TribalAI Technical Docs</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div class="site-shell">
    <aside class="sidebar">
      <a class="brand" href="index.html"><strong>TribalAI Docs</strong><span>Static generated reference</span></a>
      ${nav}
    </aside>
    <main>
      <header class="page-head">
        <p class="eyebrow">Generated by <code>pnpm docs:generate</code></p>
        <h1>${escapeHtml(page.title)}</h1>
        <p>${escapeHtml(page.description)}</p>
      </header>
      ${page.body}
    </main>
  </div>
</body>
</html>
`;
}

function renderLegacyRedirect() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="0; url=/technical-docs/index.html" />
  <title>Redirecting to TribalAI Technical Docs</title>
</head>
<body>
  <p>Redirecting to <a href="/technical-docs/index.html">technical docs</a>.</p>
</body>
</html>
`;
}

async function main() {
  const [runnerSource, ...envSources] = await Promise.all([
    readText("lib/execution/mock-runner.ts"),
    ...envSourceFiles.map((file) => readText(file))
  ]);
  const sourceMarkdownEntries = await Promise.all(
    sourceDocPages.map(async (page) => [page.slug, await readText(page.sourcePath)] as const)
  );
  const sourceMarkdown = new Map(sourceMarkdownEntries);
  const specs = (Object.values(nodeSpecRegistry) as NodeSpec[]).sort((left, right) => {
    const categorySort = left.category.localeCompare(right.category);
    return categorySort === 0 ? left.type.localeCompare(right.type) : categorySort;
  });
  const executorCases = splitExecutorCases(runnerSource);
  const executorSummaries = new Map<WorkflowNodeType, ExecutorSummary>(
    specs.map((spec) => [spec.type, summarizeExecutor(spec, executorCases)])
  );
  const envNames = extractEnvNames(envSources);

  const pages: GeneratedPage[] = [
    {
      slug: "index",
      title: "Technical Documentation",
      description: "Generated static documentation for the current application, architecture, models, node registry, runtime environment, and source docs.",
      body: renderIndexPage(specs, executorSummaries, envNames)
    },
    {
      slug: "runbook",
      title: "Run Current Application",
      description: "How to run the current app locally, with infra, environment, app server, worker, Docker option, smoke tests, and troubleshooting.",
      body: `${renderRunQuickStart()}${renderSourceDocPage(sourceDocPages[1], sourceMarkdown.get("runbook") ?? "")}`
    },
    {
      slug: "architecture",
      title: "Architecture",
      description: "High-level technical architecture, routes, execution lifecycle, artifact storage, and viewer responsibilities.",
      body: renderArchitecturePage()
    },
    {
      slug: "models",
      title: "Attached Models",
      description: "Model integrations, endpoint strategy, capabilities, output artifacts, and executor status.",
      body: renderModelsPage(executorSummaries)
    },
    {
      slug: "nodes",
      title: "Node Registry",
      description: "Generated reference for all GraphEditor nodes, including ports, defaults, editable parameters, availability, and executor mapping.",
      body: renderNodesPage(specs, executorSummaries)
    },
    {
      slug: "environment",
      title: "Environment Configuration",
      description: "Generated inventory of environment variables used by the app, storage, billing, ComfyUI, and ML wrapper runtimes.",
      body: renderEnvironmentPage(envNames)
    },
    ...sourceDocPages
      .filter((page) => page.slug !== "runbook")
      .map((page) => ({
        slug: page.slug,
        title: page.title,
        description: page.description,
        body: renderSourceDocPage(page, sourceMarkdown.get(page.slug) ?? "")
      }))
  ];

  await fs.mkdir(docsOutputDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(docsOutputDir, "styles.css"), stylesheet()),
    fs.writeFile(legacyOutputPath, renderLegacyRedirect()),
    ...pages.map((page) => fs.writeFile(path.join(docsOutputDir, `${page.slug}.html`), renderPage(page)))
  ]);

  console.log(
    `[docs:generate] wrote ${pages.length} pages to ${path.relative(repoRoot, docsOutputDir)} from ${specs.length} node specs and ${envNames.length} env keys`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
