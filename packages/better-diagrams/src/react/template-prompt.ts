/**
 * template-prompt.ts — the document-aware system prompt.
 *
 * One document references some subset of the cloud packs; the prompt that
 * teaches an LLM to extend that document should advertise exactly those
 * packs' kinds and component sections, not all of them. The studio computes
 * this live for its AI panel; this module is that logic extracted so every
 * other surface — the welcome modal's copy button, a host's own "copy
 * schema" affordance — can produce the same prompt from the same document.
 *
 * Two levels: the `ResolvedRegistry` functions are what the studio calls (it
 * already resolved its registry); `templatePromptContext` is the public
 * entry for hosts, which typically hold raw `RegistryExtensions` and never
 * resolve — it resolves internally. Exporters play no part in prompts, so
 * resolution here deliberately skips them.
 */
import { buildSystemPrompt, type DiagramTemplate } from "../contract/schema";
import { CLOUD_PROVIDER_IDS, buildCloudPromptSections } from "../contract/cloud";
import { resolveRegistry } from "./registry";
import type { RegistryExtensions, ResolvedRegistry } from "./registry-types";

/** A cloud the modal can offer as a toggle chip. */
export interface CloudOption {
  id: string;
  label: string;
  color: string;
}

/** Everything a prompt-copying surface needs, derived from one document. */
export interface TemplatePromptContext {
  /** The prompt tailored to the clouds the document references. */
  systemPrompt: string;
  /** Which clouds those are — pack order, subset of CLOUD_PROVIDER_IDS. */
  referencedClouds: string[];
  /** Chip list for a cloud toggle UI (skips clouds an extension deleted). */
  cloudOptions: CloudOption[];
  /** Re-tailor for a manual cloud selection. */
  promptForClouds: (clouds: readonly string[]) => string;
}

/**
 * Every provider the document references: zone offerings, node/edge provider
 * lists, and the cloud tag of each node's kind (one aws-lambda makes the
 * whole AWS pack first-class).
 */
export function referencedProviders(
  template: DiagramTemplate,
  registry: ResolvedRegistry,
): Set<string> {
  const out = new Set<string>();
  for (const zone of template.zones ?? []) for (const p of zone.providers) out.add(p);
  for (const node of template.nodes) {
    for (const p of node.providers ?? []) out.add(p);
    const cloud = registry.nodeKinds[node.kind]?.provider;
    if (cloud) out.add(cloud);
  }
  for (const edge of template.edges) for (const p of edge.providers ?? []) out.add(p);
  return out;
}

/** The referenced providers that are cloud packs, in pack order. */
export function referencedCloudIds(
  template: DiagramTemplate,
  registry: ResolvedRegistry,
): string[] {
  const referenced = referencedProviders(template, registry);
  return CLOUD_PROVIDER_IDS.filter((p) => referenced.has(p));
}

/**
 * The system prompt for a given cloud selection. Registry-driven, not
 * pack-data-driven: an extension kind tagged provider:"aws" is advertised
 * exactly when AWS is — the same rule the kind picker groups by. The
 * `Provider ids:` enum stays the full registry list (additive; validation
 * accepts every provider regardless) — only kinds and the per-cloud
 * component sections narrow.
 */
export function promptForCloudSelection(
  registry: ResolvedRegistry,
  clouds: readonly string[],
): string {
  return buildSystemPrompt({
    kinds: registry.kindOrder.filter((kind) => {
      const provider = registry.nodeKinds[kind]?.provider;
      return !provider || clouds.includes(provider);
    }),
    icons: registry.iconNames,
    providers: registry.providerOrder,
    extraRules: [registry.promptExtraRules, buildCloudPromptSections(clouds)]
      .filter(Boolean)
      .join("\n"),
  });
}

/** Cloud chips — labels and colors from the registry, deleted clouds skipped. */
export function cloudOptionsFor(registry: ResolvedRegistry): CloudOption[] {
  return CLOUD_PROVIDER_IDS.filter((p) => p in registry.providers).map((p) => ({
    id: p,
    label: registry.providers[p].label,
    color: registry.providers[p].color,
  }));
}

/**
 * The full prompt context for a document — the host-facing entry.
 * Recompute whenever the document changes; it is pure and cheap.
 */
export function templatePromptContext(
  template: DiagramTemplate,
  extensions?: RegistryExtensions,
): TemplatePromptContext {
  const registry = resolveRegistry(extensions ?? {});
  const referencedClouds = referencedCloudIds(template, registry);
  return {
    systemPrompt: promptForCloudSelection(registry, referencedClouds),
    referencedClouds,
    cloudOptions: cloudOptionsFor(registry),
    promptForClouds: (clouds) => promptForCloudSelection(registry, clouds),
  };
}

/** Just the tailored prompt — the one-liner for a "copy schema" button. */
export function buildTemplateSystemPrompt(
  template: DiagramTemplate,
  extensions?: RegistryExtensions,
): string {
  return templatePromptContext(template, extensions).systemPrompt;
}
