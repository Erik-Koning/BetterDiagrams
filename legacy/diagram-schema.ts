/**
 * diagram-schema.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Portable contract between your LLM and React Flow.
 *
 * Flow:  LLM  ──(DIAGRAM_SYSTEM_PROMPT)──▶  DiagramTemplate JSON
 *        DiagramTemplate  ──(validateTemplate + toReactFlow)──▶  <ReactFlow />
 *
 * Drop this file into your LLM project. It has zero dependencies; the React
 * Flow types at the bottom are structural so you don't need @xyflow/react at
 * schema level — the output is directly assignable to its Node[] / Edge[].
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const NODE_KINDS = [
  "service", "database", "queue", "gateway", "client", "external",
  "group", // container / boundary — other nodes nest inside via parentId
  "text",  // free-floating annotation; the text lives in `label`
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const ICON_NAMES = [
  "none", "user", "users", "database", "server", "layers", "globe", "cloud",
  "window", "mobile", "lock", "gear", "bolt", "doc", "code", "mail", "box", "shield",
] as const;
export type IconName = (typeof ICON_NAMES)[number];

export const EDGE_STYLES = ["solid", "dashed", "dotted"] as const;
export type EdgeStyle = (typeof EDGE_STYLES)[number];

export const EDGE_COLORS = ["slate", "sky", "emerald", "amber", "rose", "violet"] as const;
export type EdgeColor = (typeof EDGE_COLORS)[number];

export const EDGE_COLOR_HEX: Record<EdgeColor, string> = {
  slate: "#64748b", sky: "#38bdf8", emerald: "#34d399",
  amber: "#f59e0b", rose: "#fb7185", violet: "#a78bfa",
};

export const EDGE_DASH: Record<EdgeStyle, number[]> = {
  solid: [], dashed: [8, 5], dotted: [2, 4],
};

// ─── Template shape (what the LLM generates) ─────────────────────────────────

export interface DiagramNode {
  /** Unique slug, e.g. "api", "postgres", "vpc" */
  id: string;
  /** Display name — or the full annotation text when kind === "text" */
  label: string;
  kind: NodeKind;
  /** Visual glyph; "none" hides it. Ignored for group/text. */
  icon: IconName;
  /** One short line of tech detail rendered under the label. "" to omit. */
  description: string;
  /** id of the enclosing group, or null for canvas root */
  parentId: string | null;
  /** Position — RELATIVE to parent group's top-left when parentId is set */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Only meaningful for kind === "text" (default 13) */
  fontSize?: number;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  /** Short verb phrase or "" */
  label: string;
  /** Label position along the arrow, 0.15–0.85 (default 0.5 = midpoint) */
  labelT?: number;
  style: EdgeStyle;
  color: EdgeColor;
}

export interface DiagramTemplate {
  version: 1;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

// ─── System prompt for the generating LLM ────────────────────────────────────

export const DIAGRAM_SYSTEM_PROMPT = `You convert software requirements, source code, or natural-language descriptions into an architecture diagram template. Respond with ONLY compact valid JSON (no markdown fences, no commentary) matching:
{"version":1,"nodes":[{"id":"slug","label":"Name","kind":"service|database|queue|gateway|client|external|group|text","icon":"none|user|users|database|server|layers|globe|cloud|window|mobile|lock|gear|bolt|doc|code|mail|box|shield","description":"one short line or empty","parentId":null,"x":0,"y":0,"w":170,"h":76,"fontSize":13}],"edges":[{"id":"e1","source":"id","target":"id","label":"","labelT":0.5,"style":"solid|dashed|dotted","color":"slate|sky|emerald|amber|rose|violet"}]}
Rules:
- "group" = boundary (VPC, cluster, tier, bounded context). Children set parentId; child x/y are RELATIVE to the group's top-left. Size groups to contain all children (+24px sides, +48px top).
- "text" = free annotation; put the sentence in label, fontSize 12-16, w~300 h~60, no edges.
- Regular nodes: w 160-200, h 64-84. Pick a fitting icon. description is an optional one-line tech detail.
- Edge style semantics: dashed = async/event-driven, dotted = cache/optional/telemetry, solid = synchronous. Vary color by concern (e.g. amber = data, violet = messaging). labelT (0.15-0.85) slides the label along the arrow to avoid collisions.
- Lay out left-to-right by request flow, spread vertically, no overlapping nodes. 6-14 nodes total. fontSize only on text nodes. Keep JSON compact.`;

// ─── Runtime validation (no deps — swap for zod if you prefer) ───────────────

export function validateTemplate(raw: unknown): DiagramTemplate {
  const r = raw as Partial<DiagramTemplate>;
  if (!r || !Array.isArray(r.nodes)) throw new Error("Template missing nodes array");
  const ids = new Set<string>();
  const nodes: DiagramNode[] = r.nodes
    .filter((n): n is DiagramNode => !!n && typeof (n as DiagramNode).id === "string")
    .map((n) => {
      let id = String(n.id);
      while (ids.has(id)) id += "_2";
      ids.add(id);
      const kind: NodeKind = (NODE_KINDS as readonly string[]).includes(n.kind) ? n.kind : "service";
      return {
        id,
        label: String(n.label ?? id),
        kind,
        icon: (ICON_NAMES as readonly string[]).includes(n.icon) ? n.icon : "none",
        description: n.description ? String(n.description) : "",
        parentId: n.parentId ? String(n.parentId) : null,
        x: Number(n.x) || 0,
        y: Number(n.y) || 0,
        w: Number(n.w) || (kind === "group" ? 320 : kind === "text" ? 300 : 170),
        h: Number(n.h) || (kind === "group" ? 240 : kind === "text" ? 60 : 76),
        fontSize: Number(n.fontSize) || 13,
      };
    });
  const idSet = new Set(nodes.map((n) => n.id));
  for (const n of nodes) if (n.parentId && !idSet.has(n.parentId)) n.parentId = null;
  const edges: DiagramEdge[] = (Array.isArray(r.edges) ? r.edges : [])
    .filter((e) => !!e && idSet.has(String(e.source)) && idSet.has(String(e.target)))
    .map((e, i) => ({
      id: e.id ? String(e.id) : `e${i}`,
      source: String(e.source),
      target: String(e.target),
      label: e.label ? String(e.label) : "",
      labelT: Math.min(0.85, Math.max(0.15, Number(e.labelT) || 0.5)),
      style: (EDGE_STYLES as readonly string[]).includes(e.style) ? e.style : "solid",
      color: (EDGE_COLORS as readonly string[]).includes(e.color) ? e.color : "slate",
    }));
  return { version: 1, nodes, edges };
}

/** Strip markdown fences / prose and parse the first JSON object in an LLM reply. */
export function parseLlmTemplate(llmText: string): DiagramTemplate {
  const cleaned = llmText.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON object found in LLM output");
  return validateTemplate(JSON.parse(cleaned.slice(s, e + 1)));
}

// ─── React Flow conversion ───────────────────────────────────────────────────
// Structural stand-ins so this file compiles without @xyflow/react installed.
// In your app: import type { Node, Edge } from "@xyflow/react" and cast/assign.

export interface RFNode {
  id: string;
  type: "group" | "annotation" | "default";
  data: { label: string; kind: NodeKind; icon: IconName; description: string; fontSize?: number };
  position: { x: number; y: number };
  parentId?: string;
  extent?: "parent";
  style: { width: number; height: number };
}

export interface RFEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  style: { stroke: string; strokeDasharray?: string };
  data: { style: EdgeStyle; color: EdgeColor; labelT?: number };
}

/**
 * Convert a validated template into React Flow nodes/edges.
 * NOTE: React Flow requires parents to appear BEFORE children in the nodes
 * array for sub-flows to render — this sorts accordingly.
 */
export function toReactFlow(t: DiagramTemplate): { nodes: RFNode[]; edges: RFEdge[] } {
  const depth = (id: string, guard = 0): number => {
    const n = t.nodes.find((m) => m.id === id);
    return n && n.parentId && guard < 32 ? 1 + depth(n.parentId, guard + 1) : 0;
  };
  const nodes: RFNode[] = [...t.nodes]
    .sort((a, b) => depth(a.id) - depth(b.id))
    .map((n) => ({
      id: n.id,
      type: n.kind === "group" ? "group" : n.kind === "text" ? "annotation" : "default",
      data: { label: n.label, kind: n.kind, icon: n.icon, description: n.description, fontSize: n.fontSize },
      position: { x: n.x, y: n.y },
      ...(n.parentId ? { parentId: n.parentId, extent: "parent" as const } : {}),
      style: { width: n.w, height: n.h },
    }));
  const edges: RFEdge[] = t.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label || undefined,
    style: {
      stroke: EDGE_COLOR_HEX[e.color],
      strokeDasharray: EDGE_DASH[e.style].join(" ") || undefined,
    },
    data: { style: e.style, color: e.color, labelT: e.labelT },
  }));
  return { nodes, edges };
}

/** Inverse: lift a React Flow export back into the template shape. */
export function fromReactFlow(nodes: RFNode[], edges: RFEdge[]): DiagramTemplate {
  return validateTemplate({
    version: 1,
    nodes: nodes.map((n) => ({
      id: n.id,
      label: n.data?.label ?? n.id,
      kind: n.data?.kind ?? (n.type === "group" ? "group" : "service"),
      icon: n.data?.icon ?? "none",
      description: n.data?.description ?? "",
      parentId: n.parentId ?? null,
      x: n.position.x,
      y: n.position.y,
      w: n.style?.width ?? 170,
      h: n.style?.height ?? 76,
      fontSize: n.data?.fontSize ?? 13,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: typeof e.label === "string" ? e.label : "",
      style: e.data?.style ?? "solid",
      color: e.data?.color ?? "slate",
      labelT: e.data?.labelT ?? 0.5,
    })),
  });
}

// ─── Minimal example ─────────────────────────────────────────────────────────

export const EXAMPLE_TEMPLATE: DiagramTemplate = {
  version: 1,
  nodes: [
    { id: "u",   label: "End User",   kind: "client",   icon: "user",     description: "Web app",        parentId: null,  x: 20,  y: 120, w: 170, h: 76 },
    { id: "vpc", label: "VPC",        kind: "group",    icon: "none",     description: "",               parentId: null,  x: 260, y: 20,  w: 420, h: 300 },
    { id: "api", label: "API",        kind: "service",  icon: "box",      description: "Node/TS",        parentId: "vpc", x: 30,  y: 60,  w: 170, h: 76 },
    { id: "q",   label: "Events",     kind: "queue",    icon: "layers",   description: "",               parentId: "vpc", x: 230, y: 180, w: 160, h: 64 },
    { id: "db",  label: "Postgres",   kind: "database", icon: "database", description: "Primary store",  parentId: null,  x: 740, y: 120, w: 170, h: 76 },
    { id: "n1",  label: "All calls authenticated via OIDC.", kind: "text", icon: "none", description: "", parentId: null, x: 260, y: 350, w: 300, h: 50, fontSize: 13 },
  ],
  edges: [
    { id: "e1", source: "u",   target: "api", label: "HTTPS",   style: "solid",  color: "sky" },
    { id: "e2", source: "api", target: "q",   label: "publish", style: "dashed", color: "violet" },
    { id: "e3", source: "api", target: "db",  label: "",        style: "solid",  color: "amber" },
  ],
};
