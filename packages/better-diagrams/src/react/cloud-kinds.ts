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

/**
 * The icon a role gets when its components have nothing more specific to say.
 *
 * A role is a coarse bucket by design — it is what keeps a newly added
 * component from landing with no glyph at all — so this is the FALLBACK half
 * of a two-layer map. `COMPONENT_ICON` below is the other half, for the
 * services a bucket cannot tell apart.
 */
const ROLE_ICON: Record<CloudComponentRole, IconName> = {
  compute: "bolt",
  // A container is a box. `gear` used to stand for this whole role, which
  // meant a Kubernetes cluster wore the universal SETTINGS glyph and said
  // nothing about containers to a reader.
  containers: "box",
  // A bucket is a folder, and this frees `box` for the containers above.
  storage: "folder",
  database: "database",
  cache: "layers",
  queue: "layers",
  // Fan-out, not correspondence: SNS and Event Grid deliver one event to many
  // subscribers, which is what the three-node `share` glyph draws.
  events: "share",
  gateway: "shield",
  cdn: "globe",
  ai: "sparkle",
  security: "lock",
};

/**
 * Per-service icons, for the places a role is too coarse to be useful.
 *
 * The `compute` role is the reason this exists: a virtual machine, a
 * serverless function and a serverless container service all sit in it, and
 * all three drew the same lightning bolt — so a GCP diagram could not tell
 * Compute Engine, Cloud Functions and Cloud Run apart at a glance. The roles
 * stay as they are (they feed the generated prompt, not just the picture);
 * only the glyph is overridden.
 *
 * Anything absent falls back to its role, so a new component still gets a
 * sensible icon without an entry here.
 */
const COMPONENT_ICON: Record<string, IconName> = {
  // A machine you rent by the hour. `server` was unused by every cloud role.
  "aws-ec2": "server",
  "azure-vm": "server",
  "gcp-compute": "server",
  // A managed Kubernetes cluster is a FLEET — a set of identical nodes, which
  // is what the four squares of `grid` draw. This is also what separates a
  // cluster from the single container service above it.
  "aws-eks": "grid",
  "azure-aks": "grid",
  "gcp-gke": "grid",
  // Cloud Run is a serverless container service filed under `compute`, where
  // Azure files the same idea under `containers`. Until those two agree, the
  // icon is what makes them look alike, which is the part a reader sees.
  "gcp-cloud-run": "box",
  // A managed web app, not a function: it serves pages and APIs.
  "azure-app-service": "window",
  // The one glyph that means "shared evenly across the back ends", rather
  // than the `shield` its API-gateway role-mates wear.
  "gcp-load-balancing": "balance",
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
        icon: COMPONENT_ICON[component.id] ?? ROLE_ICON[component.role],
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
