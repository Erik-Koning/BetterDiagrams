/**
 * types.ts — the contracts shared by the registry and the exporters.
 *
 * These live in their own module so `exporters.ts` does not have to import
 * `registry.ts` (which imports the exporters to seed its defaults). Without
 * this split the two modules form a runtime import cycle.
 */
import type { IconPaths } from "./icons";
import type { DiagramTemplate, IconName, NodeKind } from "../contract/schema";
import { DEFAULT_ZONE_OPACITY } from "../contract/schema";
import type { DiagramZone } from "../contract/zones";
import type { LintRuleDef } from "../contract/lint";

// ─── Node kinds ──────────────────────────────────────────────────────────────

/** Node silhouette, C4-style: shape conveys the element's nature at a glance. */
export type NodeShape = "card" | "person" | "cylinder" | "pipe";

export interface NodeKindDef {
  /** Shown in the inspector dropdown and as the small caps label on the node. */
  label: string;
  /** Node body background. Ignored for container/annotation kinds. */
  fill: string;
  /** Left accent bar, icon tint, selection colour. */
  accent: string;
  /** Title text colour. */
  text: string;
  /** Icon used when a node of this kind is created. */
  icon: IconName;
  /**
   * Silhouette: `person` (actor), `cylinder` (data store), `pipe` (queue/bus),
   * or the default `card`. Registry-level — shape follows kind, so a document
   * never stores it and a registry override restyles every node of the kind.
   */
  shape?: NodeShape;
  /** Other nodes may nest inside this one via `parentId`. */
  container?: boolean;
  /** Rendered as bare text with no box or icon. */
  annotation?: boolean;
  /**
   * Cloud pack tag ("aws" | "azure" | "gcp" | …). Registry-level metadata:
   * the UI groups the kind under its provider and demotes it when the
   * document doesn't reference that provider. Documents never store it.
   */
  provider?: string;
}

/** Used for kinds that are referenced but not registered. */
export const FALLBACK_KIND: NodeKindDef = {
  label: "Node",
  fill: "#1e293b",
  accent: "#64748b",
  text: "#e2e8f0",
  icon: "none",
};

// ─── Infra providers ─────────────────────────────────────────────────────────

export interface ProviderDef {
  /** Shown in the zone toggle, the legend, and the scenario control. */
  label: string;
  /** Zone tint and legend swatch. The zone fill is this at low opacity. */
  color: string;
  /** Optional glyph for the legend row. */
  icon?: IconName;
}

/** Used for provider ids referenced by a zone but not registered. */
export const FALLBACK_PROVIDER: ProviderDef = {
  label: "Unknown",
  color: "#64748b",
};

// ─── Exporters ───────────────────────────────────────────────────────────────

export interface ExportContext<TDoc = DiagramTemplate> {
  /** The current document, already validated. */
  template: TDoc;
  /** The resolved registry, so exporters can read kind colours and icon paths. */
  registry: ResolvedRegistry;
  /** Base filename with no extension, e.g. "architecture". */
  filename: string;
  /**
   * Colours for image exports, derived from the editor's theme so a light-mode
   * app exports light images. Untyped here to keep this module cycle-free;
   * the concrete shape is `ExportPalette` from the exporters.
   */
  palette?: Record<string, string>;
}

export interface ExportResult {
  blob: Blob;
  /** Full filename including extension. */
  filename: string;
}

export interface ExporterDef<TDoc = DiagramTemplate> {
  /** Menu entry text. */
  label: string;
  /** Secondary line under the label. */
  hint?: string;
  /**
   * Receive the WHOLE document even while the editor is scrubbed with later
   * elements hidden. Static formats export the slice on screen — a PNG of the
   * June view should look like June — but an exporter that carries its own
   * timeline (the interactive HTML) needs every element and every date, or
   * the file it produces would have nothing left to scrub.
   */
  fullDocument?: boolean;
  /**
   * Produce a file to download, or return void/undefined if the exporter
   * delivered the result itself (clipboard, postMessage, a network upload).
   */
  run(ctx: ExportContext<TDoc>): ExportResult | void | Promise<ExportResult | void>;
}

// ─── Registry ────────────────────────────────────────────────────────────────

export interface RegistryExtensions {
  /**
   * Add or override node kinds. A partial value merges over the built-in of
   * the same key; `null` removes a built-in.
   */
  nodeKinds?: Record<string, (Partial<NodeKindDef> & { label?: string }) | null>;
  /** Add or override icons, as 24x24 viewBox path data. `null` removes one. */
  icons?: Record<string, IconPaths | null>;
  /** Add or override export formats. `null` removes a built-in. */
  exporters?: Record<string, ExporterDef | null>;
  /** Add or override infra providers for zones. `null` removes a built-in. */
  providers?: Record<string, (Partial<ProviderDef> & { label?: string }) | null>;
  /** Add or override lint rules for the Checks menu. `null` removes a built-in. */
  lintRules?: Record<string, LintRuleDef | null>;
  /** Appended verbatim to the generated LLM system prompt. */
  promptExtraRules?: string;
}

export interface ResolvedRegistry {
  nodeKinds: Record<string, NodeKindDef>;
  kindOrder: string[];
  icons: Record<string, IconPaths>;
  iconNames: string[];
  exporters: Record<string, ExporterDef>;
  exporterOrder: string[];
  providers: Record<string, ProviderDef>;
  providerOrder: string[];
  lintRules: Record<string, LintRuleDef>;
  containerKinds: string[];
  annotationKinds: string[];
  promptExtraRules?: string;
}

// ─── Lookups ─────────────────────────────────────────────────────────────────

/** Look up a kind, falling back to a neutral definition for unknown kinds. */
export function kindDef(registry: ResolvedRegistry, kind: NodeKind): NodeKindDef {
  return registry.nodeKinds[kind as string] ?? FALLBACK_KIND;
}

/** Look up icon path data; returns undefined for "none" and unknown names. */
export function iconPaths(registry: ResolvedRegistry, icon: IconName): IconPaths | undefined {
  if (!icon || icon === "none") return undefined;
  return registry.icons[icon as string];
}

/** Look up a provider, falling back to a neutral grey for unregistered ids. */
export function providerDef(registry: ResolvedRegistry, provider: string): ProviderDef {
  return registry.providers[provider] ?? { ...FALLBACK_PROVIDER, label: provider || "Unknown" };
}

// ─── Zone colour resolution ──────────────────────────────────────────────────
//
// One resolver for every surface that paints a zone — the canvas, the minimap,
// and the image emitter. The model: a zone stores (or inherits) its INK, the
// vivid outline colour a human actually reads; the background fill is DERIVED
// from it as the same colour at low alpha, which composites duller against
// either theme's canvas. Inlining this in three places is how the editor and
// the exports would drift apart.

/** The zone's ink: its own override, else its provider's colour. */
export function zoneInk(
  registry: ResolvedRegistry,
  zone: Pick<DiagramZone, "color" | "provider">,
): string {
  return zone.color ?? providerDef(registry, zone.provider).color;
}

/**
 * The derived background fill, as a CSS `rgba()` string.
 *
 * Byte-for-byte the same arithmetic as the canvas exporter's `rgba()` helper
 * in draw.ts, so what the editor paints and what a PNG shows cannot disagree.
 * Returns `transparent` when the zone opts out of a fill entirely.
 */
export function zoneFill(
  registry: ResolvedRegistry,
  zone: Pick<DiagramZone, "color" | "provider" | "opacity" | "fill">,
): string {
  if (zone.fill === false) return "transparent";
  const ink = zoneInk(registry, zone);
  const alpha = zone.opacity ?? DEFAULT_ZONE_OPACITY;
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(ink.trim());
  if (!m) return ink; // non-hex ink (host-supplied provider colour) — use as-is
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => Number.parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
