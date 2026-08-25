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
import { CLOUD_PROVIDER_IDS, buildCloudPromptSections, cloudResources } from "../contract/cloud";
import { resolveRegistry } from "./registry";
import type { RegistryExtensions, ResolvedRegistry } from "./registry-types";

/** A cloud the modal can offer as a toggle chip. */
export interface CloudOption {
  id: string;
  label: string;
  color: string;
}

/** One selectable service inside a cloud — a row in the "resources" picker. */
export interface CloudResourceOption {
  /** The node kind id, e.g. "azure-blob". */
  id: string;
  /** The cloud pack it belongs to. */
  cloud: string;
  label: string;
  /** The pack's one-line "what it is"; absent for a registry extension. */
  hint?: string;
}

/** How much vocabulary a copied prompt should carry. */
export interface PromptScopeOptions {
  /** `false` asks for the CONTENT form — elements only, no geometry. */
  geometry?: boolean;
  /**
   * Restrict the cloud vocabulary to these kind ids. Absent = every kind the
   * selected clouds ship. A cloud left with nothing contributes no section
   * and no kinds, exactly as if it had never been selected.
   */
  components?: readonly string[];
}

/** Everything a prompt-copying surface needs, derived from one document. */
export interface TemplatePromptContext {
  /** The prompt tailored to the clouds the document references. */
  systemPrompt: string;
  /**
   * The same prompt in the CONTENT form — elements only, no geometry. Hand
   * this to an AI when the editor (not the model) owns the layout.
   */
  systemPromptContent: string;
  /** Which clouds those are — pack order, subset of CLOUD_PROVIDER_IDS. */
  referencedClouds: string[];
  /** Chip list for a cloud toggle UI (skips clouds an extension deleted). */
  cloudOptions: CloudOption[];
  /** Every selectable service, all clouds — the resource picker's menu. */
  cloudResources: CloudResourceOption[];
  /** The cloud kinds this document actually uses — the "what's here" preset. */
  usedResources: string[];
  /** Re-tailor for a manual cloud selection; `geometry: false` = content form. */
  promptForClouds: (clouds: readonly string[], opts?: PromptScopeOptions) => string;
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
 *
 * `opts.components` narrows a second time, to chosen services inside those
 * clouds. Nothing selected at all yields the cloudless base prompt: no kinds,
 * no sections, and — because `exampleProviders` goes empty too — no provider
 * standing in as the example. That is the correct output for "the user hasn't
 * said which cloud yet", not a degenerate case to paper over.
 */
export function promptForCloudSelection(
  registry: ResolvedRegistry,
  clouds: readonly string[],
  opts?: PromptScopeOptions,
): string {
  const wanted = opts?.components ? new Set(opts.components) : null;
  const kinds = registry.kindOrder.filter((kind) => {
    const provider = registry.nodeKinds[kind]?.provider;
    if (!provider) return true;
    if (!clouds.includes(provider)) return false;
    return !wanted || wanted.has(kind);
  });
  // A cloud whose every resource was unticked is not "selected" any more —
  // dropping it here keeps the skeleton's example provider honest too.
  const live = clouds.filter((cloud) =>
    kinds.some((kind) => registry.nodeKinds[kind]?.provider === cloud),
  );
  return buildSystemPrompt({
    kinds,
    icons: registry.iconNames,
    providers: registry.providerOrder,
    exampleProviders: live,
    extraRules: [
      registry.promptExtraRules,
      buildCloudPromptSections(clouds, opts?.components ? { components: opts.components } : {}),
    ]
      .filter(Boolean)
      .join("\n"),
    ...(opts?.geometry === false ? { geometry: false } : {}),
  });
}

/**
 * Every cloud service the registry knows, as picker rows: pack order, labels
 * from the registry (so an override shows the host's wording), hints from the
 * pack data. `clouds` narrows to those packs; omitted, it returns them all.
 * Extension kinds tagged with a cloud provider are included — they are part
 * of that cloud's vocabulary as far as the prompt is concerned.
 */
export function cloudResourceOptions(
  registry: ResolvedRegistry,
  clouds?: readonly string[],
): CloudResourceOption[] {
  const hints = new Map(cloudResources(CLOUD_PROVIDER_IDS).map((r) => [r.id, r.hint]));
  const out: CloudResourceOption[] = [];
  for (const id of registry.kindOrder) {
    const cloud = registry.nodeKinds[id]?.provider;
    if (!cloud || !(CLOUD_PROVIDER_IDS as readonly string[]).includes(cloud)) continue;
    if (clouds && !clouds.includes(cloud)) continue;
    const hint = hints.get(id);
    out.push({ id, cloud, label: registry.nodeKinds[id]?.label ?? id, ...(hint ? { hint } : {}) });
  }
  return out;
}

/** The cloud-pack kinds a document actually uses, in pack order. */
export function usedCloudResources(
  template: DiagramTemplate,
  registry: ResolvedRegistry,
): string[] {
  const used = new Set(template.nodes.map((node) => node.kind));
  return cloudResourceOptions(registry)
    .filter((resource) => used.has(resource.id))
    .map((resource) => resource.id);
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
    systemPromptContent: promptForCloudSelection(registry, referencedClouds, { geometry: false }),
    referencedClouds,
    cloudOptions: cloudOptionsFor(registry),
    cloudResources: cloudResourceOptions(registry),
    usedResources: usedCloudResources(template, registry),
    promptForClouds: (clouds, opts) => promptForCloudSelection(registry, clouds, opts),
  };
}

/** Just the tailored prompt — the one-liner for a "copy schema" button. */
export function buildTemplateSystemPrompt(
  template: DiagramTemplate,
  extensions?: RegistryExtensions,
): string {
  return templatePromptContext(template, extensions).systemPrompt;
}
