/**
 * cloud-kinds.ts — the visual half of the cloud component packs.
 *
 * contract/cloud.ts owns WHICH components exist and what the prompt says;
 * this maps the same ids to NodeKindDef visuals: one palette per provider
 * (brand color on a dark fill, matching how the builtin kinds are styled),
 * icon and silhouette by role. Registered as built-ins in registry.ts, after
 * the generic kinds — always valid data, surfaced in the UI by relevance.
 */
import {
  CLOUD_COMPONENTS,
  CLOUD_PROVIDER_IDS,
  type CloudComponentRole,
  type CloudProviderId,
} from "../contract/cloud";
import type { IconName } from "../contract/schema";
import type { NodeKindDef, NodeShape } from "./registry-types";

/** Brand color on a dark fill — the same recipe the builtin kinds use. */
const PROVIDER_PALETTE: Record<CloudProviderId, { fill: string; accent: string; text: string }> = {
  aws: { fill: "#331f05", accent: "#ff9900", text: "#fed7aa" },
  azure: { fill: "#04223d", accent: "#2b9fe8", text: "#bfdbfe" },
  gcp: { fill: "#0a1f44", accent: "#4285f4", text: "#c7d7fd" },
};

const ROLE_ICON: Record<CloudComponentRole, IconName> = {
  compute: "bolt",
  containers: "gear",
  storage: "box",
  database: "database",
  cache: "layers",
  queue: "layers",
  events: "mail",
  gateway: "shield",
  cdn: "globe",
  ai: "code",
  security: "lock",
};

const ROLE_SHAPE: Partial<Record<CloudComponentRole, NodeShape>> = {
  database: "cylinder",
  queue: "pipe",
};

function buildCloudKinds(): { kinds: Record<string, NodeKindDef>; order: string[] } {
  const kinds: Record<string, NodeKindDef> = {};
  const order: string[] = [];
  for (const provider of CLOUD_PROVIDER_IDS) {
    const palette = PROVIDER_PALETTE[provider];
    for (const component of CLOUD_COMPONENTS[provider]) {
      kinds[component.id] = {
        label: component.label,
        ...palette,
        icon: ROLE_ICON[component.role],
        ...(ROLE_SHAPE[component.role] ? { shape: ROLE_SHAPE[component.role] } : {}),
        provider,
      };
      order.push(component.id);
    }
  }
  return { kinds, order };
}

const built = buildCloudKinds();

/** All cloud kinds keyed by id, ready to merge after BUILTIN_NODE_KINDS. */
export const CLOUD_NODE_KINDS: Record<string, NodeKindDef> = built.kinds;

/** Pack order: aws, then azure, then gcp — appended after the builtin order. */
export const CLOUD_KIND_ORDER: string[] = built.order;
