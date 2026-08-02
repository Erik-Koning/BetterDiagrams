import { useState, useRef, useMemo, useEffect, useCallback } from "react";

// ─── Icons: shared SVG path data (screen <svg> + canvas Path2D export) ───────
const ICON_PATHS = {
  user:     ["M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8", "M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"],
  users:    ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8", "M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7", "M16 3.5a4 4 0 0 1 0 7.4", "M17.5 14.5c2.7 1 4.5 3.4 4.5 6.5"],
  database: ["M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3", "M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"],
  server:   ["M3 4h18v6H3z", "M3 14h18v6H3z", "M7 7h0.01", "M7 17h0.01"],
  layers:   ["M12 2l10 6-10 6L2 8z", "M2 16l10 6 10-6"],
  globe:    ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20", "M2 12h20", "M12 2c3 3.5 3 16.5 0 20", "M12 2c-3 3.5-3 16.5 0 20"],
  cloud:    ["M7 18a5 5 0 1 1 1.2-9.9A6 6 0 0 1 19.7 10.5 4 4 0 0 1 19 18z"],
  window:   ["M3 5h18v14H3z", "M3 9h18", "M6 7h0.01"],
  mobile:   ["M8 3h8v18H8z", "M11 18h2"],
  lock:     ["M6 11h12v10H6z", "M9 11V8a3 3 0 0 1 6 0v3"],
  gear:     ["M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8", "M12 2v3", "M12 19v3", "M2 12h3", "M19 12h3", "M4.5 4.5l2.2 2.2", "M17.3 17.3l2.2 2.2", "M19.5 4.5l-2.2 2.2", "M4.5 19.5l2.2-2.2"],
  bolt:     ["M13 2L4 14h6l-1 8 9-12h-6z"],
  doc:      ["M6 2h9l4 4v16H6z", "M15 2v4h4", "M9 13h6", "M9 17h6"],
  code:     ["M8 6l-5 6 5 6", "M16 6l5 6-5 6"],
  mail:     ["M3 5h18v14H3z", "M3 6l9 7 9-7"],
  box:      ["M12 2l9 5v10l-9 5-9-5V7z", "M3 7l9 5 9-5", "M12 12v10"],
  shield:   ["M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z"],
};
const ICON_NAMES = ["none", ...Object.keys(ICON_PATHS)];

function SvgIcon({ name, size = 22, color = "#94a3b8" }) {
  const paths = ICON_PATHS[name];
  if (!paths) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

// ─── Node kinds ──────────────────────────────────────────────────────────────
const KINDS = {
  service:  { label: "Service",  fill: "#082f49", accent: "#38bdf8", text: "#bae6fd", icon: "box" },
  database: { label: "Database", fill: "#451a03", accent: "#f59e0b", text: "#fde68a", icon: "database" },
  queue:    { label: "Queue",    fill: "#2e1065", accent: "#a78bfa", text: "#ddd6fe", icon: "layers" },
  gateway:  { label: "Gateway",  fill: "#022c22", accent: "#34d399", text: "#a7f3d0", icon: "shield" },
  client:   { label: "Client",   fill: "#1e293b", accent: "#94a3b8", text: "#e2e8f0", icon: "user" },
  external: { label: "External", fill: "#0f172a", accent: "#64748b", text: "#cbd5e1", icon: "globe" },
  group:    { label: "Group",    fill: "",        accent: "#475569", text: "#94a3b8", icon: "none" },
  text:     { label: "Text",     fill: "",        accent: "#38bdf8", text: "#e2e8f0", icon: "none" },
};
const KIND_ORDER = ["service", "database", "queue", "gateway", "client", "external", "group", "text"];

// ─── Edge styling ────────────────────────────────────────────────────────────
const EDGE_COLORS = { slate: "#64748b", sky: "#38bdf8", emerald: "#34d399", amber: "#f59e0b", rose: "#fb7185", violet: "#a78bfa" };
const EDGE_DASH = { solid: [], dashed: [8, 5], dotted: [2, 4] };
const EDGE_STYLES = Object.keys(EDGE_DASH);

// ─── Sample diagram ──────────────────────────────────────────────────────────
const SAMPLE = {
  nodes: [
    { id: "u",     label: "Clinic Staff",       kind: "client",   icon: "users",  description: "Dentists & admins on desktop", parentId: null,  x: 30,  y: 190, w: 180, h: 76 },
    { id: "gw",    label: "API Gateway",        kind: "gateway",  icon: "shield", description: "Auth, rate limiting",          parentId: null,  x: 280, y: 190, w: 170, h: 76 },
    { id: "vpc",   label: "Application VPC",    kind: "group",    icon: "none",   description: "",                             parentId: null,  x: 520, y: 40,  w: 440, h: 380 },
    { id: "api",   label: "REST API",           kind: "service",  icon: "box",    description: "Node / TypeScript",            parentId: "vpc", x: 30,  y: 60,  w: 170, h: 76 },
    { id: "wrk",   label: "Worker Service",     kind: "service",  icon: "gear",   description: "Billing & claim jobs",         parentId: "vpc", x: 30,  y: 260, w: 170, h: 76 },
    { id: "q",     label: "Job Queue",          kind: "queue",    icon: "layers", description: "",                             parentId: "vpc", x: 250, y: 165, w: 160, h: 64 },
    { id: "db",    label: "Postgres",           kind: "database", icon: "database", description: "Per-tenant schemas",         parentId: null,  x: 1030, y: 110, w: 170, h: 76 },
    { id: "cache", label: "Redis",              kind: "database", icon: "bolt",   description: "Sessions & cache",             parentId: null,  x: 1030, y: 270, w: 170, h: 76 },
    { id: "note",  label: "All traffic is TLS. Tenant isolation enforced at the schema layer.", kind: "text", icon: "none", description: "", parentId: null, x: 520, y: 460, w: 340, h: 60, fontSize: 13 },
  ],
  edges: [
    { id: "e1", source: "u",   target: "gw",    label: "HTTPS",     style: "solid",  color: "slate" },
    { id: "e2", source: "gw",  target: "api",   label: "",          style: "solid",  color: "sky" },
    { id: "e3", source: "api", target: "q",     label: "enqueue",   style: "dashed", color: "violet" },
    { id: "e4", source: "q",   target: "wrk",   label: "consume",   style: "dashed", color: "violet" },
    { id: "e5", source: "api", target: "db",    label: "read/write", style: "solid", color: "amber" },
    { id: "e6", source: "api", target: "cache", label: "",          style: "dotted", color: "rose" },
    { id: "e7", source: "wrk", target: "db",    label: "",          style: "solid",  color: "amber" },
  ],
};

// ─── LLM schema prompt (kept in sync with diagram-schema.ts) ─────────────────
const SCHEMA_PROMPT = `You convert software requirements, source code, or natural-language descriptions into an architecture diagram template. Respond with ONLY compact valid JSON (no markdown, no commentary).
Schema:
{"version":1,"nodes":[{"id":"slug","label":"Name","kind":"service|database|queue|gateway|client|external|group|text","icon":"none|user|users|database|server|layers|globe|cloud|window|mobile|lock|gear|bolt|doc|code|mail|box|shield","description":"one short line or empty","parentId":null,"x":0,"y":0,"w":170,"h":76,"fontSize":13}],"edges":[{"id":"e1","source":"id","target":"id","label":"","labelT":0.5,"style":"solid|dashed|dotted","color":"slate|sky|emerald|amber|rose|violet"}]}
Rules:
- "group" = boundary (VPC, cluster, tier). Children set parentId; child x/y are RELATIVE to the group's top-left. Size groups to contain children (+24px sides, +48px top).
- "text" = free annotation; put the sentence in label, set fontSize 12-16, w~300 h~60.
- Regular nodes: w 160-200, h 64-84. Pick a fitting icon. description is optional tech detail.
- Edge style: dashed for async/events, dotted for cache/optional, solid otherwise. Vary colors by concern. labelT (0.15-0.85) slides the label along the arrow; use it to avoid label collisions.
- Left-to-right by request flow, spread vertically, no overlaps. 6-14 nodes. fontSize only on text nodes. Compact JSON.`;

function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("No JSON found in response");
  return JSON.parse(cleaned.slice(s, e + 1));
}

function sanitizeDiagram(raw) {
  if (!raw || !Array.isArray(raw.nodes)) throw new Error("Response missing nodes array");
  const ids = new Set();
  const nodes = raw.nodes.filter((n) => n && n.id && (n.label !== undefined)).map((n) => {
    let id = String(n.id);
    while (ids.has(id)) id += "_2";
    ids.add(id);
    const kind = KINDS[n.kind] ? n.kind : "service";
    return {
      id, label: String(n.label), kind,
      icon: ICON_PATHS[n.icon] ? n.icon : (n.icon === "none" ? "none" : KINDS[kind].icon),
      description: n.description ? String(n.description) : "",
      parentId: n.parentId ? String(n.parentId) : null,
      x: Number(n.x) || 0, y: Number(n.y) || 0,
      w: Number(n.w) || (kind === "group" ? 320 : kind === "text" ? 300 : 170),
      h: Number(n.h) || (kind === "group" ? 240 : kind === "text" ? 60 : 76),
      fontSize: Number(n.fontSize) || 13,
    };
  });
  const idSet = new Set(nodes.map((n) => n.id));
  nodes.forEach((n) => { if (n.parentId && !idSet.has(n.parentId)) n.parentId = null; });
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .filter((e) => e && idSet.has(String(e.source)) && idSet.has(String(e.target)))
    .map((e, i) => ({
      id: e.id ? String(e.id) : `e${i}`,
      source: String(e.source), target: String(e.target),
      label: e.label ? String(e.label) : "",
      labelT: Math.min(0.85, Math.max(0.15, Number(e.labelT) || 0.5)),
      style: EDGE_DASH[e.style] ? e.style : "solid",
      color: EDGE_COLORS[e.color] ? e.color : "slate",
    }));
  return { nodes, edges };
}

// ─── Download helper ─────────────────────────────────────────────────────────
function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function ArchitectureStudio() {
  const [nodes, setNodes] = useState(SAMPLE.nodes);
  const [edges, setEdges] = useState(SAMPLE.edges);
  const [view, setView] = useState({ x: 30, y: 50, z: 0.75 });
  const [selected, setSelected] = useState(null);
  const [selectedEdge, setSelectedEdge] = useState(null);
  const [connectFrom, setConnectFrom] = useState(null);
  const [mode, setMode] = useState("select");
  const [panelOpen, setPanelOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [input, setInput] = useState("");
  const [refine, setRefine] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const fileRef = useRef(null);

  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes]);

  const getAbs = useCallback((id) => {
    const n = byId[id];
    if (!n) return { x: 0, y: 0, w: 0, h: 0 };
    let x = n.x, y = n.y, p = n.parentId, g = 0;
    while (p && byId[p] && g++ < 32) { x += byId[p].x; y += byId[p].y; p = byId[p].parentId; }
    return { x, y, w: n.w, h: n.h };
  }, [byId]);

  const depthOf = useCallback((id) => {
    let d = 0, p = byId[id] && byId[id].parentId, g = 0;
    while (p && byId[p] && g++ < 32) { d++; p = byId[p].parentId; }
    return d;
  }, [byId]);

  const descendantsOf = useCallback((id) => {
    const out = new Set();
    const walk = (pid) => nodes.forEach((n) => { if (n.parentId === pid && !out.has(n.id)) { out.add(n.id); walk(n.id); } });
    walk(id);
    return out;
  }, [nodes]);

  // ─── Viewport ──────────────────────────────────────────────────────────────
  const screenToWorld = (cx, cy) => {
    const r = canvasRef.current.getBoundingClientRect();
    return { x: (cx - r.left - view.x) / view.z, y: (cy - r.top - view.y) / view.z };
  };

  const zoomAt = useCallback((factor, cx, cy) => {
    setView((v) => {
      const r = canvasRef.current.getBoundingClientRect();
      const px = cx !== undefined ? cx - r.left : r.width / 2;
      const py = cy !== undefined ? cy - r.top : r.height / 2;
      const z = Math.min(2.5, Math.max(0.2, v.z * factor));
      return { x: px - ((px - v.x) / v.z) * z, y: py - ((py - v.y) / v.z) * z, z };
    });
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.08 : 0.92, e.clientX, e.clientY); };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const boundsOf = (list) => {
    const map = Object.fromEntries(list.map((n) => [n.id, n]));
    const abs = (n) => {
      let x = n.x, y = n.y, p = n.parentId, g = 0;
      while (p && map[p] && g++ < 32) { x += map[p].x; y += map[p].y; p = map[p].parentId; }
      return { x, y, w: n.w, h: n.h };
    };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    list.forEach((n) => {
      const a = abs(n);
      minX = Math.min(minX, a.x); minY = Math.min(minY, a.y);
      maxX = Math.max(maxX, a.x + a.w); maxY = Math.max(maxY, a.y + a.h);
    });
    return { minX, minY, maxX, maxY };
  };

  const fitView = useCallback((ns) => {
    const list = ns || nodes;
    if (!list.length || !canvasRef.current) return;
    const b = boundsOf(list);
    const r = canvasRef.current.getBoundingClientRect();
    const bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    const z = Math.min(1.4, Math.max(0.2, Math.min((r.width - 80) / bw, (r.height - 120) / bh)));
    setView({ x: (r.width - bw * z) / 2 - b.minX * z, y: (r.height - bh * z) / 2 - b.minY * z + 16, z });
  }, [nodes]);

  // ─── Drag / connect / resize ───────────────────────────────────────────────
  const onCanvasDown = (e) => {
    if (e.target !== e.currentTarget && !e.target.dataset.bg) return;
    setSelected(null); setSelectedEdge(null); setConnectFrom(null); setExportOpen(false);
    dragRef.current = { type: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onNodeDown = (e, id) => {
    e.stopPropagation();
    setExportOpen(false);
    if (mode === "connect") {
      if (!connectFrom) setConnectFrom(id);
      else if (connectFrom !== id) {
        setEdges((es) => [...es, { id: `e${Date.now()}`, source: connectFrom, target: id, label: "", labelT: 0.5, style: "solid", color: "slate" }]);
        setConnectFrom(null);
      }
      return;
    }
    setSelected(id); setSelectedEdge(null);
    const n = byId[id];
    dragRef.current = { type: "node", id, sx: e.clientX, sy: e.clientY, ox: n.x, oy: n.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onResizeDown = (e, id) => {
    e.stopPropagation();
    const n = byId[id];
    dragRef.current = { type: "resize", id, sx: e.clientX, sy: e.clientY, ow: n.w, oh: n.h };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.type === "pan") {
      setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }));
    } else if (d.type === "node") {
      const dx = (e.clientX - d.sx) / view.z, dy = (e.clientY - d.sy) / view.z;
      setNodes((ns) => ns.map((n) => (n.id === d.id ? { ...n, x: d.ox + dx, y: d.oy + dy } : n)));
    } else if (d.type === "resize") {
      const dx = (e.clientX - d.sx) / view.z, dy = (e.clientY - d.sy) / view.z;
      const n = byId[d.id];
      const minW = n.kind === "group" ? 160 : 90, minH = n.kind === "group" ? 120 : 40;
      setNodes((ns) => ns.map((m) => (m.id === d.id ? { ...m, w: Math.max(minW, d.ow + dx), h: Math.max(minH, d.oh + dy) } : m)));
    } else if (d.type === "edgeLabel") {
      const p = screenToWorld(e.clientX, e.clientY);
      const edge = edges.find((x) => x.id === d.id);
      if (edge) {
        const g = edgeGeometry(edge);
        if (g) {
          let best = 0.5, bd = Infinity;
          for (let i = 3; i <= 17; i++) {
            const tt = i / 20;
            const q = g.bez(tt);
            const dist = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
            if (dist < bd) { bd = dist; best = tt; }
          }
          setEdges((es) => es.map((x) => (x.id === d.id ? { ...x, labelT: best } : x)));
        }
      }
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.type !== "node") return;
    const node = byId[d.id];
    if (!node) return;
    const excluded = descendantsOf(d.id); excluded.add(d.id);
    const a = getAbs(d.id);
    const cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    let target = null, targetDepth = -1;
    nodes.forEach((g) => {
      if (g.kind !== "group" || excluded.has(g.id)) return;
      const ga = getAbs(g.id);
      if (cx > ga.x && cx < ga.x + ga.w && cy > ga.y && cy < ga.y + ga.h) {
        const dep = depthOf(g.id);
        if (dep > targetDepth) { targetDepth = dep; target = g; }
      }
    });
    const newParent = target ? target.id : null;
    if (newParent !== node.parentId) {
      const pa = target ? getAbs(target.id) : { x: 0, y: 0 };
      setNodes((ns) => ns.map((n) => (n.id === d.id ? { ...n, parentId: newParent, x: a.x - pa.x, y: a.y - pa.y } : n)));
      setToast(target ? `Moved into ${target.label}` : "Moved to canvas root");
      setTimeout(() => setToast(""), 1600);
    }
  };

  // ─── Mutations ─────────────────────────────────────────────────────────────
  const addNode = (kind) => {
    const r = canvasRef.current.getBoundingClientRect();
    const c = screenToWorld(r.left + r.width / 2, r.top + r.height / 2);
    const id = `n${Date.now()}`;
    const preset = kind === "group" ? { w: 320, h: 240, label: "New Group" }
      : kind === "text" ? { w: 280, h: 56, label: "Double-tap the inspector to edit this note." }
      : { w: 170, h: 76, label: `New ${KINDS[kind].label}` };
    setNodes((ns) => [...ns, {
      id, kind, icon: KINDS[kind].icon, description: "", parentId: null,
      x: c.x - preset.w / 2, y: c.y - preset.h / 2, fontSize: 13, ...preset,
    }]);
    setSelected(id);
  };

  const deleteSelected = () => {
    if (selectedEdge) { setEdges((es) => es.filter((e) => e.id !== selectedEdge)); setSelectedEdge(null); return; }
    if (!selected) return;
    const gone = descendantsOf(selected); gone.add(selected);
    setNodes((ns) => ns.filter((n) => !gone.has(n.id)));
    setEdges((es) => es.filter((e) => !gone.has(e.source) && !gone.has(e.target)));
    setSelected(null);
  };

  const updateSelected = (patch) => setNodes((ns) => ns.map((n) => (n.id === selected ? { ...n, ...patch } : n)));
  const updateEdge = (patch) => setEdges((es) => es.map((e) => (e.id === selectedEdge ? { ...e, ...patch } : e)));

  // ─── AI generation ─────────────────────────────────────────────────────────
  const generate = async (isRefine) => {
    const text = isRefine ? refine : input;
    if (!text.trim()) return;
    setBusy(true); setError("");
    try {
      const userMsg = isRefine
        ? `${SCHEMA_PROMPT}\n\nCURRENT DIAGRAM TEMPLATE:\n${JSON.stringify({ version: 1, nodes, edges })}\n\nMODIFY IT PER THIS INSTRUCTION and return the FULL updated template JSON:\n${text}`
        : `${SCHEMA_PROMPT}\n\nINPUT (requirements / code / description):\n${text}`;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: userMsg }] }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "API error");
      const textOut = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const d = sanitizeDiagram(extractJson(textOut));
      setNodes(d.nodes); setEdges(d.edges);
      setSelected(null); setSelectedEdge(null);
      if (isRefine) setRefine("");
      setPanelOpen(false);
      setTimeout(() => fitView(d.nodes), 50);
    } catch (err) {
      setError(err.message || "Generation failed — try a shorter input.");
    } finally { setBusy(false); }
  };

  // ─── Canvas rendering for PNG / PDF (always reads current state) ──────────
  const wrapText = (ctx, text, maxW, maxLines) => {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line); line = w;
        if (lines.length === maxLines) { lines[maxLines - 1] = lines[maxLines - 1].replace(/.{2}$/, "…"); return lines; }
      } else line = test;
    }
    if (line) lines.push(line);
    return lines.slice(0, maxLines);
  };

  const rr = (ctx, x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  const drawIconOnCanvas = (ctx, name, x, y, size, color) => {
    const paths = ICON_PATHS[name];
    if (!paths) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 24, size / 24);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    paths.forEach((d) => ctx.stroke(new Path2D(d)));
    ctx.restore();
  };

  const renderToCanvas = () => {
    const pad = 48, scale = 2;
    const b = boundsOf(nodes);
    const w = b.maxX - b.minX + pad * 2, h = b.maxY - b.minY + pad * 2;
    const cv = document.createElement("canvas");
    cv.width = w * scale; cv.height = h * scale;
    const ctx = cv.getContext("2d");
    ctx.scale(scale, scale);
    ctx.translate(-b.minX + pad, -b.minY + pad);
    // background
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(b.minX - pad, b.minY - pad, w, h);
    ctx.fillStyle = "#1e293b";
    for (let gx = Math.floor((b.minX - pad) / 24) * 24; gx < b.maxX + pad; gx += 24)
      for (let gy = Math.floor((b.minY - pad) / 24) * 24; gy < b.maxY + pad; gy += 24)
        ctx.fillRect(gx, gy, 1.2, 1.2);
    const sorted = [...nodes].sort((a2, b2) => depthOf(a2.id) - depthOf(b2.id));
    // groups first
    sorted.filter((n) => n.kind === "group").forEach((n) => {
      const a = getAbs(n.id);
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = "#64748b";
      ctx.lineWidth = 1.2;
      ctx.fillStyle = "rgba(30,41,59,0.28)";
      rr(ctx, a.x, a.y, a.w, a.h, 10); ctx.fill(); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#1e293b";
      const tw = ctx.measureText(n.label).width + 18;
      rr(ctx, a.x, a.y, Math.max(60, tw), 22, 6); ctx.fill();
      ctx.fillStyle = "#cbd5e1";
      ctx.font = "11px ui-monospace, monospace";
      ctx.fillText(n.label, a.x + 9, a.y + 15);
      ctx.restore();
    });
    // edges
    edges.forEach((e) => {
      const g = edgeGeometry(e);
      if (!g) return;
      const col = EDGE_COLORS[e.color] || EDGE_COLORS.slate;
      ctx.save();
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.8;
      ctx.setLineDash(EDGE_DASH[e.style] || []);
      ctx.stroke(new Path2D(g.d));
      ctx.setLineDash([]);
      ctx.fillStyle = col;
      ctx.translate(g.end.x, g.end.y);
      ctx.rotate(g.endDir);
      ctx.beginPath(); ctx.moveTo(0, -4.5); ctx.lineTo(9, 0); ctx.lineTo(0, 4.5); ctx.closePath(); ctx.fill();
      ctx.restore();
      if (e.label) {
        ctx.save();
        ctx.font = "11px ui-monospace, monospace";
        const lw = ctx.measureText(e.label).width;
        ctx.fillStyle = "#0f172a";
        ctx.fillRect(g.mid.x - lw / 2 - 4, g.mid.y - 15, lw + 8, 15);
        ctx.fillStyle = "#94a3b8";
        ctx.textAlign = "center";
        ctx.fillText(e.label, g.mid.x, g.mid.y - 4);
        ctx.restore();
      }
    });
    // leaf nodes + text
    sorted.filter((n) => n.kind !== "group").forEach((n) => {
      const a = getAbs(n.id);
      if (n.kind === "text") {
        ctx.save();
        ctx.fillStyle = "#e2e8f0";
        ctx.font = `${n.fontSize || 13}px ui-sans-serif, system-ui`;
        const lines = wrapText(ctx, n.label, a.w - 8, Math.max(1, Math.floor(a.h / ((n.fontSize || 13) + 5))));
        lines.forEach((ln, i) => ctx.fillText(ln, a.x + 4, a.y + (n.fontSize || 13) + i * ((n.fontSize || 13) + 5)));
        ctx.restore();
        return;
      }
      const k = KINDS[n.kind];
      ctx.save();
      ctx.fillStyle = k.fill;
      ctx.strokeStyle = "#334155";
      ctx.lineWidth = 1;
      rr(ctx, a.x, a.y, a.w, a.h, 8); ctx.fill(); ctx.stroke();
      ctx.fillStyle = k.accent;
      rr(ctx, a.x, a.y, 4, a.h, 2); ctx.fill();
      const hasIcon = n.icon && n.icon !== "none";
      const tx = a.x + (hasIcon ? 42 : 14);
      if (hasIcon) drawIconOnCanvas(ctx, n.icon, a.x + 12, a.y + a.h / 2 - 11, 22, k.accent);
      ctx.fillStyle = "#64748b";
      ctx.font = "9px ui-monospace, monospace";
      ctx.fillText(k.label.toUpperCase(), tx, a.y + 16);
      ctx.fillStyle = k.text;
      ctx.font = "600 13px ui-sans-serif, system-ui";
      const nameLines = wrapText(ctx, n.label, a.w - (tx - a.x) - 10, 1);
      ctx.fillText(nameLines[0] || "", tx, a.y + 31);
      if (n.description) {
        ctx.fillStyle = "#94a3b8";
        ctx.font = "10.5px ui-sans-serif, system-ui";
        wrapText(ctx, n.description, a.w - (tx - a.x) - 10, 2)
          .forEach((ln, i) => ctx.fillText(ln, tx, a.y + 45 + i * 13));
      }
      ctx.restore();
    });
    return { canvas: cv, w, h };
  };

  const exportPng = () => {
    try {
      const { canvas } = renderToCanvas();
      canvas.toBlob((blob) => blob && downloadBlob(blob, "architecture.png"), "image/png");
    } catch { setError("PNG export failed."); setPanelOpen(true); }
    setExportOpen(false);
  };

  const exportPdf = () => {
    try {
      const { canvas, w, h } = renderToCanvas();
      const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
      const bin = atob(dataUrl.split(",")[1]);
      const jpg = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) jpg[i] = bin.charCodeAt(i);
      const enc = new TextEncoder();
      const parts = [];
      let offset = 0;
      const offsets = {};
      const push = (data) => { const b = typeof data === "string" ? enc.encode(data) : data; parts.push(b); offset += b.length; };
      push("%PDF-1.4\n");
      offsets[1] = offset; push("1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n");
      offsets[2] = offset; push("2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n");
      offsets[3] = offset; push(`3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${w} ${h}]/Contents 4 0 R/Resources<</XObject<</Im0 5 0 R>>>>>>endobj\n`);
      const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
      offsets[4] = offset; push(`4 0 obj<</Length ${content.length}>>stream\n${content}\nendstream endobj\n`);
      offsets[5] = offset;
      push(`5 0 obj<</Type/XObject/Subtype/Image/Width ${canvas.width}/Height ${canvas.height}/ColorSpace/DeviceRGB/BitsPerComponent 8/Filter/DCTDecode/Length ${jpg.length}>>stream\n`);
      push(jpg);
      push("\nendstream endobj\n");
      const xrefStart = offset;
      let xref = "xref\n0 6\n0000000000 65535 f \n";
      for (let i = 1; i <= 5; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
      push(xref + `trailer<</Size 6/Root 1 0 R>>\nstartxref\n${xrefStart}\n%%EOF`);
      const total = parts.reduce((s, p) => s + p.length, 0);
      const out = new Uint8Array(total);
      let pos = 0;
      parts.forEach((p) => { out.set(p, pos); pos += p.length; });
      downloadBlob(new Blob([out], { type: "application/pdf" }), "architecture.pdf");
    } catch { setError("PDF export failed."); setPanelOpen(true); }
    setExportOpen(false);
  };

  const exportTemplate = () => {
    downloadBlob(new Blob([JSON.stringify({ version: 1, nodes, edges }, null, 2)], { type: "application/json" }), "architecture.template.json");
    setExportOpen(false);
  };

  const exportReactFlow = () => {
    const rf = {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.kind === "group" ? "group" : n.kind === "text" ? "annotation" : "default",
        data: { label: n.label, kind: n.kind, icon: n.icon, description: n.description, fontSize: n.fontSize },
        position: { x: n.x, y: n.y },
        ...(n.parentId ? { parentId: n.parentId, extent: "parent" } : {}),
        style: { width: n.w, height: n.h },
      })),
      edges: edges.map((e) => ({
        id: e.id, source: e.source, target: e.target, label: e.label || undefined,
        style: { stroke: EDGE_COLORS[e.color], strokeDasharray: (EDGE_DASH[e.style] || []).join(" ") || undefined },
        data: { style: e.style, color: e.color },
      })),
    };
    downloadBlob(new Blob([JSON.stringify(rf, null, 2)], { type: "application/json" }), "architecture.reactflow.json");
    setExportOpen(false);
  };

  const importJson = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result);
        const looksRF = raw.nodes && raw.nodes[0] && raw.nodes[0].position;
        const internal = looksRF
          ? {
              nodes: raw.nodes.map((n) => ({
                id: n.id,
                label: (n.data && n.data.label) || n.id,
                kind: (n.data && n.data.kind) || (n.type === "group" ? "group" : "service"),
                icon: (n.data && n.data.icon) || undefined,
                description: (n.data && n.data.description) || "",
                fontSize: (n.data && n.data.fontSize) || 13,
                parentId: n.parentId || null,
                x: n.position.x, y: n.position.y,
                w: (n.style && n.style.width) || 170, h: (n.style && n.style.height) || 76,
              })),
              edges: (raw.edges || []).map((e) => ({ ...e, ...(e.data || {}) })),
            }
          : raw;
        const d = sanitizeDiagram(internal);
        setNodes(d.nodes); setEdges(d.edges);
        setTimeout(() => fitView(d.nodes), 50);
      } catch { setError("Import failed: not a valid diagram JSON."); setPanelOpen(true); }
    };
    reader.readAsText(file);
  };

  // ─── Edge geometry (shared: screen + export) ───────────────────────────────
  const edgeGeometry = useCallback((e) => {
    const s = getAbs(e.source), t = getAbs(e.target);
    if (!s.w || !t.w) return null;
    const scx = s.x + s.w / 2, scy = s.y + s.h / 2;
    const tcx = t.x + t.w / 2, tcy = t.y + t.h / 2;
    const dx = tcx - scx, dy = tcy - scy;
    let p1, p2, c1, c2;
    if (Math.abs(dx) >= Math.abs(dy)) {
      p1 = { x: dx > 0 ? s.x + s.w : s.x, y: scy };
      p2 = { x: dx > 0 ? t.x : t.x + t.w, y: tcy };
      const off = Math.max(40, Math.abs(dx) * 0.35);
      c1 = { x: p1.x + (dx > 0 ? off : -off), y: p1.y };
      c2 = { x: p2.x + (dx > 0 ? -off : off), y: p2.y };
    } else {
      p1 = { x: scx, y: dy > 0 ? s.y + s.h : s.y };
      p2 = { x: tcx, y: dy > 0 ? t.y : t.y + t.h };
      const off = Math.max(40, Math.abs(dy) * 0.35);
      c1 = { x: p1.x, y: p1.y + (dy > 0 ? off : -off) };
      c2 = { x: p2.x, y: p2.y + (dy > 0 ? -off : off) };
    }
    const bez = (tt) => {
      const u = 1 - tt;
      return {
        x: u * u * u * p1.x + 3 * u * u * tt * c1.x + 3 * u * tt * tt * c2.x + tt * tt * tt * p2.x,
        y: u * u * u * p1.y + 3 * u * u * tt * c1.y + 3 * u * tt * tt * c2.y + tt * tt * tt * p2.y,
      };
    };
    const t = Math.min(0.85, Math.max(0.15, e.labelT === undefined ? 0.5 : e.labelT));
    return {
      d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`,
      mid: bez(t), bez,
      end: p2, endDir: Math.atan2(p2.y - c2.y, p2.x - c2.x),
    };
  }, [getAbs]);

  const edgePaths = useMemo(() => edges.map((e) => {
    const g = edgeGeometry(e);
    return g ? { ...e, ...g } : null;
  }).filter(Boolean), [edges, edgeGeometry]);

  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => depthOf(a.id) - depthOf(b.id) || (a.kind === "group" ? -1 : 1) - (b.kind === "group" ? -1 : 1)),
    [nodes, depthOf]
  );

  const selNode = selected ? byId[selected] : null;
  const selEdgeObj = selectedEdge ? edges.find((e) => e.id === selectedEdge) : null;
  const btn = "px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors select-none";
  const btnIdle = `${btn} border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-slate-100`;
  const btnOn = `${btn} border-sky-500 bg-sky-950 text-sky-200`;

  return (
    <div className="w-full h-screen flex flex-col bg-slate-950 text-slate-200 font-sans overflow-hidden">
      {/* ─── Top bar ─── */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 bg-slate-950/95 flex-wrap z-40">
        <div className="flex items-center gap-2 mr-1">
          <div className="w-5 h-5 rounded-sm border border-sky-500 grid grid-cols-2 gap-px p-0.5">
            <div className="bg-sky-500/70 rounded-sm" /><div className="bg-slate-700 rounded-sm" />
            <div className="bg-slate-700 rounded-sm" /><div className="bg-sky-500/40 rounded-sm" />
          </div>
          <span className="font-mono text-sm font-semibold tracking-tight text-slate-100">arch·studio</span>
        </div>
        <button className={panelOpen ? btnOn : `${btn} border-sky-600 bg-sky-600/20 text-sky-200 hover:bg-sky-600/30`} onClick={() => setPanelOpen((o) => !o)}>
          ✦ AI
        </button>
        <div className="flex items-center gap-1.5">
          <button className={btnIdle} onClick={() => addNode("service")}>+ Node</button>
          <button className={btnIdle} onClick={() => addNode("group")}>+ Group</button>
          <button className={btnIdle} onClick={() => addNode("text")}>+ Text</button>
          <button className={mode === "connect" ? btnOn : btnIdle}
            onClick={() => { setMode((m) => (m === "connect" ? "select" : "connect")); setConnectFrom(null); }}>
            {mode === "connect" ? "Connecting…" : "Connect"}
          </button>
        </div>
        <div className="flex items-center gap-1.5 ml-auto">
          <button className={btnIdle} onClick={() => zoomAt(0.85)}>−</button>
          <span className="text-xs font-mono text-slate-500 w-10 text-center">{Math.round(view.z * 100)}%</span>
          <button className={btnIdle} onClick={() => zoomAt(1.18)}>+</button>
          <button className={btnIdle} onClick={() => fitView()}>Fit</button>
          <div className="relative">
            <button className={exportOpen ? btnOn : btnIdle} onClick={() => setExportOpen((o) => !o)}>Export ▾</button>
            {exportOpen && (
              <div className="absolute right-0 top-9 z-50 w-52 rounded-lg border border-slate-700 bg-slate-900 shadow-xl overflow-hidden">
                {[
                  ["PNG image", exportPng, "Raster snapshot of the current canvas"],
                  ["PDF document", exportPdf, "Single-page PDF"],
                  ["Template (.json)", exportTemplate, "Raw schema — the format LLMs generate"],
                  ["React Flow (.json)", exportReactFlow, "Drop into @xyflow/react"],
                ].map(([name, fn, hint]) => (
                  <button key={name} onClick={fn} className="w-full text-left px-3 py-2.5 hover:bg-slate-800 border-b border-slate-800 last:border-0">
                    <div className="text-xs font-medium text-slate-200">{name}</div>
                    <div className="text-[10px] text-slate-500">{hint}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className={btnIdle} onClick={() => fileRef.current && fileRef.current.click()}>Import</button>
          <input ref={fileRef} type="file" accept=".json" className="hidden"
            onChange={(e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ""; }} />
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {/* ─── AI panel ─── */}
        {panelOpen && (
          <div className="absolute inset-y-0 left-0 z-30 w-full sm:w-96 bg-slate-950/97 border-r border-slate-800 p-4 flex flex-col gap-3 overflow-y-auto backdrop-blur">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-100">Generate architecture</h2>
              <button className="text-slate-500 hover:text-slate-200 text-lg leading-none px-1" onClick={() => setPanelOpen(false)}>×</button>
            </div>
            <textarea value={input} onChange={(e) => setInput(e.target.value)}
              placeholder={"Paste requirements, source code, or plain English…"}
              className="w-full h-40 rounded-lg bg-slate-900 border border-slate-700 focus:border-sky-500 outline-none p-3 text-sm text-slate-200 placeholder-slate-600 resize-y font-mono" />
            <button onClick={() => generate(false)} disabled={busy || !input.trim()}
              className="w-full py-2.5 rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold text-white transition-colors">
              {busy ? "Designing…" : "Generate diagram"}
            </button>
            <div className="border-t border-slate-800 pt-3 flex flex-col gap-2">
              <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wide">Refine current diagram</h3>
              <input value={refine} onChange={(e) => setRefine(e.target.value)}
                placeholder={'"make the queue edges dotted rose" · "add a CDN"'}
                className="w-full rounded-lg bg-slate-900 border border-slate-700 focus:border-sky-500 outline-none px-3 py-2 text-sm text-slate-200 placeholder-slate-600" />
              <button onClick={() => generate(true)} disabled={busy || !refine.trim()}
                className="w-full py-2 rounded-lg border border-sky-600 text-sky-300 hover:bg-sky-950 disabled:opacity-40 text-sm font-medium transition-colors">
                {busy ? "Working…" : "Apply refinement"}
              </button>
            </div>
            {error && <div className="text-xs text-rose-300 bg-rose-950/60 border border-rose-800 rounded-lg p-2.5">{error}</div>}
            <p className="text-[11px] text-slate-600 mt-auto">
              Exports always capture the live, cursor-edited state. Template JSON matches the schema in diagram-schema.ts.
            </p>
          </div>
        )}

        {/* ─── Canvas ─── */}
        <div ref={canvasRef} data-bg="1"
          className="absolute inset-0 touch-none cursor-grab active:cursor-grabbing"
          style={{
            backgroundImage: "radial-gradient(circle, #1e293b 1px, transparent 1px)",
            backgroundSize: `${24 * view.z}px ${24 * view.z}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          onPointerDown={onCanvasDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
          <div className="absolute" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, transformOrigin: "0 0" }}>
            {/* Edges */}
            <svg className="absolute overflow-visible" style={{ width: 1, height: 1, zIndex: 30 }}>
              {edgePaths.map((e) => {
                const col = EDGE_COLORS[e.color] || EDGE_COLORS.slate;
                const sel = selectedEdge === e.id;
                return (
                  <g key={e.id} onPointerDown={(ev) => { ev.stopPropagation(); setSelectedEdge(e.id); setSelected(null); }} className="cursor-pointer">
                    <path d={e.d} fill="none" stroke="transparent" strokeWidth={14} />
                    <path d={e.d} fill="none" stroke={sel ? "#f8fafc" : col} strokeWidth={sel ? 2.6 : 1.8}
                      strokeDasharray={(EDGE_DASH[e.style] || []).join(" ") || undefined} />
                    <polygon points="0,-4.5 9,0 0,4.5" fill={sel ? "#f8fafc" : col}
                      transform={`translate(${e.end.x},${e.end.y}) rotate(${(e.endDir * 180) / Math.PI})`} />
                    {e.label && (
                      <g className="cursor-move"
                        onPointerDown={(ev) => {
                          ev.stopPropagation();
                          setSelectedEdge(e.id); setSelected(null);
                          dragRef.current = { type: "edgeLabel", id: e.id };
                          ev.currentTarget.setPointerCapture(ev.pointerId);
                        }}>
                        <rect x={e.mid.x - e.label.length * 3.5 - 6} y={e.mid.y - 17}
                          width={e.label.length * 7 + 12} height={20} fill="transparent" />
                        <text x={e.mid.x} y={e.mid.y - 5} textAnchor="middle" className="select-none"
                          fill={sel ? "#f8fafc" : "#94a3b8"} fontSize="11" fontFamily="ui-monospace, monospace"
                          style={{ paintOrder: "stroke", stroke: "#020617", strokeWidth: 4 }}>
                          {e.label}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* Nodes */}
            {sortedNodes.map((n) => {
              const a = getAbs(n.id);
              const k = KINDS[n.kind];
              const isSel = selected === n.id;
              const isConnSrc = connectFrom === n.id;
              const z = n.kind === "group" ? 10 + depthOf(n.id) : 31 + depthOf(n.id);
              return (
                <div key={n.id} onPointerDown={(e) => onNodeDown(e, n.id)}
                  className={`absolute select-none ${mode === "connect" ? "cursor-crosshair" : "cursor-move"}`}
                  style={{ left: a.x, top: a.y, width: n.w, height: n.h, zIndex: z }}>
                  {n.kind === "group" ? (
                    <div className={`w-full h-full rounded-lg border border-dashed ${isSel || isConnSrc ? "border-sky-400" : "border-slate-600"} bg-slate-800/25`}>
                      <div className="absolute -top-px -left-px px-2 py-0.5 rounded-tl-lg rounded-br-md bg-slate-800 border border-slate-600 text-[11px] font-mono text-slate-300 max-w-full truncate">
                        {n.label}
                      </div>
                    </div>
                  ) : n.kind === "text" ? (
                    <div className={`w-full h-full rounded-md border border-dashed px-1.5 py-1 overflow-hidden ${isSel || isConnSrc ? "border-sky-400 bg-slate-900/40" : "border-transparent"}`}>
                      <p className="text-slate-200 whitespace-pre-wrap leading-snug" style={{ fontSize: n.fontSize || 13 }}>{n.label}</p>
                    </div>
                  ) : (
                    <div className={`w-full h-full rounded-lg border flex items-center gap-2.5 px-3 py-1.5 overflow-hidden ${isSel || isConnSrc ? "border-sky-400 shadow-lg shadow-sky-900/40" : "border-slate-700"}`}
                      style={{ background: k.fill, borderLeft: `4px solid ${isSel || isConnSrc ? "#38bdf8" : k.accent}` }}>
                      {n.icon !== "none" && <SvgIcon name={n.icon} size={Math.min(24, n.h - 40) < 16 ? 18 : 22} color={k.accent} />}
                      <div className="min-w-0 flex-1">
                        <div className="text-[9px] font-mono uppercase tracking-wider text-slate-500 leading-tight">{k.label}</div>
                        <div className="text-sm font-semibold leading-snug truncate" style={{ color: k.text }}>{n.label}</div>
                        {n.description && (
                          <div className="text-[11px] text-slate-400 leading-tight"
                            style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                            {n.description}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {isSel && (
                    <div onPointerDown={(e) => onResizeDown(e, n.id)}
                      className="absolute -bottom-1.5 -right-1.5 w-4 h-4 rounded-sm bg-sky-500 border border-slate-950 cursor-nwse-resize" />
                  )}
                </div>
              );
            })}
          </div>

          <div className="absolute bottom-3 left-3 z-40 flex flex-col gap-1.5 pointer-events-none">
            {mode === "connect" && (
              <div className="text-[11px] font-mono text-sky-300 bg-slate-900/90 border border-sky-800 rounded-md px-2.5 py-1.5">
                {connectFrom ? "Now tap the target node" : "Tap the source node"}
              </div>
            )}
            {toast && <div className="text-[11px] font-mono text-emerald-300 bg-slate-900/90 border border-emerald-800 rounded-md px-2.5 py-1.5">{toast}</div>}
            <div className="text-[10px] font-mono text-slate-600">drag to pan · scroll to zoom · drop nodes into groups to nest · slide labels along arrows</div>
          </div>
        </div>

        {/* ─── Inspector ─── */}
        {(selNode || selEdgeObj) && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-slate-900/97 border border-slate-700 rounded-xl px-3 py-2 shadow-xl backdrop-blur max-w-[96vw] flex-wrap justify-center">
            {selNode && (
              <>
                {selNode.kind === "text" ? (
                  <textarea value={selNode.label} onChange={(e) => updateSelected({ label: e.target.value })}
                    rows={2} className="bg-slate-800 border border-slate-600 focus:border-sky-500 outline-none rounded-md px-2.5 py-1.5 text-sm text-slate-100 w-60 resize-none" />
                ) : (
                  <input value={selNode.label} onChange={(e) => updateSelected({ label: e.target.value })}
                    className="bg-slate-800 border border-slate-600 focus:border-sky-500 outline-none rounded-md px-2.5 py-1.5 text-sm text-slate-100 w-40" />
                )}
                <select value={selNode.kind} onChange={(e) => updateSelected({ kind: e.target.value, icon: KINDS[e.target.value].icon })}
                  className="bg-slate-800 border border-slate-600 rounded-md px-2 py-1.5 text-sm text-slate-200 outline-none">
                  {KIND_ORDER.map((k2) => <option key={k2} value={k2}>{KINDS[k2].label}</option>)}
                </select>
                {selNode.kind !== "group" && selNode.kind !== "text" && (
                  <>
                    <select value={selNode.icon} onChange={(e) => updateSelected({ icon: e.target.value })}
                      className="bg-slate-800 border border-slate-600 rounded-md px-2 py-1.5 text-sm text-slate-200 outline-none">
                      {ICON_NAMES.map((i2) => <option key={i2} value={i2}>{i2 === "none" ? "no icon" : `icon: ${i2}`}</option>)}
                    </select>
                    <input value={selNode.description} onChange={(e) => updateSelected({ description: e.target.value })}
                      placeholder="Description…"
                      className="bg-slate-800 border border-slate-600 focus:border-sky-500 outline-none rounded-md px-2.5 py-1.5 text-sm text-slate-100 w-44" />
                  </>
                )}
                {selNode.kind === "text" && (
                  <select value={selNode.fontSize || 13} onChange={(e) => updateSelected({ fontSize: Number(e.target.value) })}
                    className="bg-slate-800 border border-slate-600 rounded-md px-2 py-1.5 text-sm text-slate-200 outline-none">
                    {[11, 13, 16, 20, 26].map((s2) => <option key={s2} value={s2}>{s2}px</option>)}
                  </select>
                )}
              </>
            )}
            {selEdgeObj && (
              <>
                <input value={selEdgeObj.label || ""} onChange={(ev) => updateEdge({ label: ev.target.value })} placeholder="Edge label"
                  className="bg-slate-800 border border-slate-600 focus:border-sky-500 outline-none rounded-md px-2.5 py-1.5 text-sm text-slate-100 w-36" />
                <select value={selEdgeObj.style} onChange={(ev) => updateEdge({ style: ev.target.value })}
                  className="bg-slate-800 border border-slate-600 rounded-md px-2 py-1.5 text-sm text-slate-200 outline-none">
                  {EDGE_STYLES.map((s2) => <option key={s2} value={s2}>{s2}</option>)}
                </select>
                <div className="flex items-center gap-1">
                  {Object.entries(EDGE_COLORS).map(([name, hex]) => (
                    <button key={name} onClick={() => updateEdge({ color: name })} title={name}
                      className={`w-5 h-5 rounded-full border-2 ${selEdgeObj.color === name ? "border-white" : "border-slate-700"}`}
                      style={{ background: hex }} />
                  ))}
                </div>
              </>
            )}
            <button onClick={deleteSelected} className="px-2.5 py-1.5 rounded-md text-sm bg-rose-950 border border-rose-800 text-rose-300 hover:bg-rose-900 transition-colors">Delete</button>
            <button onClick={() => { setSelected(null); setSelectedEdge(null); }} className="text-slate-500 hover:text-slate-200 px-1 text-lg leading-none">×</button>
          </div>
        )}
      </div>
    </div>
  );
}
