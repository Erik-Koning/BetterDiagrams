/**
 * cloud.ts tests — the pack data and the prompt appendix. Pure node env.
 */
import { describe, expect, it } from "vitest";
import {
  CLOUD_COMPONENTS,
  CLOUD_PROVIDER_IDS,
  buildCloudPromptSections,
  cloudKindIds,
  cloudResources,
} from "./cloud";

describe("CLOUD_COMPONENTS", () => {
  it("ships the curated component counts per cloud", () => {
    // Deliberate pins — growing a pack should be a conscious edit here too.
    expect(CLOUD_COMPONENTS.aws).toHaveLength(10);
    expect(CLOUD_COMPONENTS.azure).toHaveLength(16);
    expect(CLOUD_COMPONENTS.gcp).toHaveLength(15);
  });

  it("prefixes every id with its provider, uniquely across clouds", () => {
    const all = CLOUD_PROVIDER_IDS.flatMap((p) => CLOUD_COMPONENTS[p].map((c) => c.id));
    expect(new Set(all).size).toBe(all.length);
    for (const provider of CLOUD_PROVIDER_IDS) {
      for (const component of CLOUD_COMPONENTS[provider]) {
        expect(component.id.startsWith(`${provider}-`)).toBe(true);
      }
    }
  });

  it("never collides with the generic builtin kinds", () => {
    const generic = ["service", "database", "queue", "gateway", "client", "external", "group", "text"];
    const all = new Set(CLOUD_PROVIDER_IDS.flatMap((p) => CLOUD_COMPONENTS[p].map((c) => c.id)));
    for (const kind of generic) expect(all.has(kind)).toBe(false);
  });
});

describe("cloudKindIds", () => {
  it("returns the selected providers' ids in pack order, ignoring unknowns", () => {
    const ids = cloudKindIds(["aws", "onprem", "gcp"]);
    expect(ids[0]).toBe("aws-lambda");
    expect(ids).toContain("gcp-pubsub");
    expect(ids).toContain("gcp-vertex-ai");
    expect(ids).toHaveLength(CLOUD_COMPONENTS.aws.length + CLOUD_COMPONENTS.gcp.length);
    expect(ids.some((id) => id.startsWith("azure-"))).toBe(false);
  });

  it("is empty for no selection", () => {
    expect(cloudKindIds([])).toEqual([]);
  });
});

describe("buildCloudPromptSections", () => {
  it("describes exactly the selected clouds", () => {
    const text = buildCloudPromptSections(["aws"]);
    expect(text).toContain("### AWS components");
    expect(text).toContain("aws-lambda — Lambda (serverless function)");
    expect(text).toContain('"providers":["aws"]');
    expect(text).not.toContain("azure-");
    expect(text).not.toContain("gcp-");
  });

  it("stacks sections for a multi-select", () => {
    const text = buildCloudPromptSections(["azure", "gcp"]);
    expect(text).toContain("### Azure components");
    expect(text).toContain("### GCP components");
    expect(text.indexOf("Azure components")).toBeLessThan(text.indexOf("GCP components"));
  });

  it("is empty for no selection", () => {
    expect(buildCloudPromptSections([])).toBe("");
  });

  it("narrows a section to the chosen components", () => {
    const text = buildCloudPromptSections(["azure"], {
      components: ["azure-blob", "azure-app-service"],
    });
    expect(text).toContain("### Azure components");
    expect(text).toContain("azure-blob — Blob Storage");
    expect(text).toContain("azure-app-service — App Service");
    expect(text).not.toContain("azure-cosmos");
    expect(text).not.toContain("azure-openai");
  });

  it("drops a provider whose components were all deselected", () => {
    // Not "Azure with an empty list" — no Azure heading at all, so an empty
    // pick can't reintroduce the cloud through its section title.
    const text = buildCloudPromptSections(["aws", "azure"], { components: ["aws-s3"] });
    expect(text).toContain("### AWS components");
    expect(text).toContain("aws-s3 — S3");
    expect(text).not.toContain("aws-lambda");
    expect(text).not.toContain("Azure");
  });

  it("an empty component list yields nothing at all", () => {
    expect(buildCloudPromptSections(["aws", "gcp"], { components: [] })).toBe("");
  });
});

describe("cloudResources", () => {
  it("flattens the packs into rows carrying their provider", () => {
    const rows = cloudResources(["gcp"]);
    expect(rows).toHaveLength(CLOUD_COMPONENTS.gcp.length);
    expect(rows.every((row) => row.provider === "gcp")).toBe(true);
    expect(rows[0]).toMatchObject({ id: "gcp-cloud-run", label: "Cloud Run" });
  });

  it("ignores non-cloud providers and an empty selection", () => {
    expect(cloudResources(["onprem", "k8s"])).toEqual([]);
    expect(cloudResources([])).toEqual([]);
  });
});

describe("cloud kinds in the base vocabulary", () => {
  it("survive bare validateTemplate — no registry required", async () => {
    const { validateTemplate } = await import("./schema");
    const t = validateTemplate({
      version: 1,
      nodes: [
        { id: "fn", label: "Fn", kind: "aws-lambda" },
        { id: "ai", label: "Model", kind: "gcp-vertex-ai" },
        { id: "web", label: "Site", kind: "azure-app-service" },
      ],
      edges: [],
    });
    expect(t.nodes.map((n) => n.kind)).toEqual(["aws-lambda", "gcp-vertex-ai", "azure-app-service"]);
  });
});
