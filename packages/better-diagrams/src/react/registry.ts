/**
 * registry.ts — opt-in extensibility.
 *
 * Everything the editor knows about the world is a plain record: node kinds,
 * icons, and exporters. A host app extends any of them by passing a partial
 * record, which is shallow-merged over the built-ins:
 *
 *   <ArchitectureStudio
 *     registry={{
 *       nodeKinds: { lambda: { label: "Lambda", accent: "#f59e0b", icon: "bolt" } },
 *       icons:     { lambda: ["M13 2L4 14h6l-1 8 9-12h-6z"] },
 *       exporters: { terraform: myTerraformExporter, pdf: null },
 *     }}
 *   />
 *
 * The three rules that make this lightweight:
 *   - Omit a key and you get the built-in. Nothing to re-declare.
 *   - Provide a key that exists and you override it (partially — a kind that
 *     only sets `accent` keeps the built-in label, fill, and icon).
 *   - Provide `null` and the built-in is removed.
 *
 * Registered kinds automatically appear in the inspector's kind dropdown AND in
 * the generated LLM system prompt, so an extension is understood end-to-end
 * without touching library source.
 */
import { BUILTIN_ICON_PATHS } from "./icons";
import { CLOUD_KIND_ORDER, CLOUD_NODE_KINDS } from "./cloud-kinds";
import { BUILTIN_LINT_RULES } from "../contract/lint";
import type { LintRuleDef } from "../contract/lint";
import {
  FALLBACK_KIND,
  FALLBACK_PROVIDER,
  type NodeKindDef,
  type ProviderDef,
  type RegistryExtensions,
  type ResolvedRegistry,
  type ExporterDef,
} from "./registry-types";
import type { IconPaths } from "./icons";

export type {
  NodeKindDef,
  NodeShape,
  ProviderDef,
  RegistryExtensions,
  ResolvedRegistry,
  ExportContext,
  ExportResult,
  ExporterDef,
} from "./registry-types";
export { kindDef, iconPaths, providerDef, zoneInk, zoneFill, FALLBACK_KIND, FALLBACK_PROVIDER } from "./registry-types";

/**
 * Infra providers a zone can be switched between.
 *
 * Colours are the recognisable brand hues — the zone fill is this at ~14%
 * opacity, so it reads as a tint behind the nodes rather than a slab of colour
 * competing with them.
 */
export const BUILTIN_PROVIDERS: Record<string, ProviderDef> = {
  azure: { label: "Azure", color: "#0078d4", icon: "cloud" },
  aws: { label: "AWS", color: "#ff9900", icon: "cloud" },
  gcp: { label: "GCP", color: "#4285f4", icon: "cloud" },
  onprem: { label: "On-prem", color: "#94a3b8", icon: "server" },
  k8s: { label: "Kubernetes", color: "#326ce5", icon: "box" },
  saas: { label: "SaaS", color: "#a78bfa", icon: "globe" },
};

const BUILTIN_PROVIDER_ORDER = ["azure", "aws", "gcp", "onprem", "k8s", "saas"];

export const BUILTIN_NODE_KINDS: Record<string, NodeKindDef> = {
  service: { label: "Service", fill: "#082f49", accent: "#38bdf8", text: "#bae6fd", icon: "box" },
  database: { label: "Database", fill: "#451a03", accent: "#f59e0b", text: "#fde68a", icon: "database", shape: "cylinder" },
  queue: { label: "Queue", fill: "#2e1065", accent: "#a78bfa", text: "#ddd6fe", icon: "layers", shape: "pipe" },
  gateway: { label: "Gateway", fill: "#022c22", accent: "#34d399", text: "#a7f3d0", icon: "shield" },
  // Plain card, not the actor silhouette: the head circle read as a glyph
  // stuck to the box rather than as a person, and every other kind in this
  // list says what it is with its icon. `person` stays available for a
  // registry that wants it.
  client: { label: "Client", fill: "#1e293b", accent: "#94a3b8", text: "#e2e8f0", icon: "user" },
  external: { label: "External", fill: "#0f172a", accent: "#64748b", text: "#cbd5e1", icon: "globe" },
  table: { label: "Table", fill: "#042f2e", accent: "#2dd4bf", text: "#99f6e4", icon: "none", record: true },
  group: { label: "Group", fill: "transparent", accent: "#475569", text: "#94a3b8", icon: "none", container: true },
  text: { label: "Text", fill: "transparent", accent: "#38bdf8", text: "#e2e8f0", icon: "none", annotation: true },
  decision: { label: "Decision", fill: "#431407", accent: "#fb923c", text: "#fed7aa", icon: "none", shape: "diamond" },
  terminator: { label: "Start / End", fill: "#052e16", accent: "#4ade80", text: "#bbf7d0", icon: "none", shape: "pipe" },
  io: { label: "Input / Output", fill: "#172554", accent: "#60a5fa", text: "#bfdbfe", icon: "none", shape: "parallelogram" },
  point: { label: "Point", fill: "transparent", accent: "#64748b", text: "#94a3b8", icon: "none", point: true },
};

/** Order the built-ins appear in the inspector. Extensions append after these. */
const BUILTIN_KIND_ORDER = [
  "service",
  "database",
  "queue",
  "gateway",
  "client",
  "external",
  "table",
  "group",
  "text",
  "decision",
  "terminator",
  "io",
  "point",
];

/**
 * Merge extensions over the built-ins into the shape the editor consumes.
 * Pure and cheap — memoise on the `extensions` identity in React.
 */
export function resolveRegistry(
  extensions: RegistryExtensions = {},
  /**
   * The exporters to start from. Injected rather than imported so this module
   * does not depend on `exporters.ts`, which depends on this one for its
   * types — the cycle that `registry-types.ts` exists to break at the type
   * level, closed properly at the value level.
   */
  builtinExporters: Record<string, ExporterDef> = {},
): ResolvedRegistry {
  // -- node kinds ------------------------------------------------------------
  // Cloud packs are built-ins too: always-valid vocabulary, surfaced in the
  // UI by relevance (the kind picker demotes clouds the document doesn't
  // reference). Extensions apply over them like over any builtin.
  const nodeKinds: Record<string, NodeKindDef> = { ...BUILTIN_NODE_KINDS, ...CLOUD_NODE_KINDS };
  const extraKindOrder: string[] = [];

  for (const [key, value] of Object.entries(extensions.nodeKinds ?? {})) {
    if (value === null) {
      delete nodeKinds[key];
      continue;
    }
    const base = nodeKinds[key];
    if (base) {
      nodeKinds[key] = { ...base, ...value };
    } else {
      // A brand-new kind only has to supply what differs from the fallback.
      nodeKinds[key] = { ...FALLBACK_KIND, label: titleCase(key), ...value };
      extraKindOrder.push(key);
    }
  }

  const kindOrder = [
    ...BUILTIN_KIND_ORDER.filter((k) => k in nodeKinds),
    ...CLOUD_KIND_ORDER.filter((k) => k in nodeKinds),
    ...extraKindOrder,
  ];

  // -- icons -----------------------------------------------------------------
  const icons: Record<string, IconPaths> = { ...BUILTIN_ICON_PATHS };
  for (const [key, value] of Object.entries(extensions.icons ?? {})) {
    if (value === null) delete icons[key];
    else icons[key] = value;
  }
  // "none" is always offered and always renders nothing.
  const iconNames = ["none", ...Object.keys(icons)];

  // -- exporters -------------------------------------------------------------
  const exporters = { ...builtinExporters };
  const extraExporterOrder: string[] = [];
  for (const [key, value] of Object.entries(extensions.exporters ?? {})) {
    if (value === null) {
      delete exporters[key];
      continue;
    }
    if (!(key in builtinExporters)) extraExporterOrder.push(key);
    exporters[key] = value;
  }
  const exporterOrder = [
    ...Object.keys(builtinExporters).filter((k) => k in exporters),
    ...extraExporterOrder,
  ];

  // -- providers -------------------------------------------------------------
  const providers: Record<string, ProviderDef> = { ...BUILTIN_PROVIDERS };
  const extraProviderOrder: string[] = [];
  for (const [key, value] of Object.entries(extensions.providers ?? {})) {
    if (value === null) {
      delete providers[key];
      continue;
    }
    const base = providers[key];
    if (base) {
      providers[key] = { ...base, ...value };
    } else {
      providers[key] = { ...FALLBACK_PROVIDER, label: titleCase(key), ...value };
      extraProviderOrder.push(key);
    }
  }
  const providerOrder = [
    ...BUILTIN_PROVIDER_ORDER.filter((k) => k in providers),
    ...extraProviderOrder,
  ];

  // -- lint rules ------------------------------------------------------------
  const lintRules: Record<string, LintRuleDef> = { ...BUILTIN_LINT_RULES };
  for (const [key, value] of Object.entries(extensions.lintRules ?? {})) {
    if (value === null) delete lintRules[key];
    else lintRules[key] = value;
  }

  return {
    nodeKinds,
    kindOrder,
    icons,
    iconNames,
    exporters,
    exporterOrder,
    providers,
    providerOrder,
    lintRules,
    containerKinds: kindOrder.filter((k) => nodeKinds[k]?.container),
    annotationKinds: kindOrder.filter((k) => nodeKinds[k]?.annotation),
    pointKinds: kindOrder.filter((k) => nodeKinds[k]?.point),
    promptExtraRules: extensions.promptExtraRules,
  };
}

function titleCase(s: string): string {
  return s.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
