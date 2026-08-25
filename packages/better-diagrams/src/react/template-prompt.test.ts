/**
 * The document-aware prompt: which clouds a document references, and that the
 * prompt narrows its kinds and component sections to exactly those.
 */
import { describe, expect, it } from "vitest";
import {
  buildTemplateSystemPrompt,
  cloudResourceOptions,
  promptForCloudSelection,
  referencedCloudIds,
  templatePromptContext,
  usedCloudResources,
} from "./template-prompt";
import { resolveRegistry } from "./registry";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";

const doc = (over: Record<string, unknown> = {}): DiagramTemplate =>
  validateTemplate({
    version: 1,
    nodes: [
      { id: "a", label: "A", kind: "service", icon: "box", x: 0, y: 0, w: 170, h: 76 },
    ],
    edges: [],
    ...over,
  });

const awsZone = {
  id: "z",
  label: "Region",
  shape: "rounded",
  x: 0,
  y: 0,
  w: 400,
  h: 300,
  providers: ["aws"],
  provider: "aws",
};

describe("referencedCloudIds", () => {
  const registry = resolveRegistry();

  it("sees zone offerings, node/edge provider lists, and cloud-tagged kinds", () => {
    expect(referencedCloudIds(doc({ zones: [awsZone] }), registry)).toEqual(["aws"]);
    expect(
      referencedCloudIds(
        doc({ nodes: [{ id: "a", label: "A", kind: "service", icon: "box", x: 0, y: 0, w: 170, h: 76, providers: ["gcp"] }] }),
        registry,
      ),
    ).toEqual(["gcp"]);
    // One azure-tagged kind makes the whole Azure pack referenced.
    const tagged = doc();
    tagged.nodes[0].kind = "azure-functions";
    expect(referencedCloudIds(validateTemplate(tagged), registry)).toEqual(["azure"]);
  });

  it("ignores non-cloud providers", () => {
    const t = doc({ zones: [{ ...awsZone, providers: ["onprem", "k8s"], provider: "onprem" }] });
    expect(referencedCloudIds(t, registry)).toEqual([]);
  });
});

describe("templatePromptContext", () => {
  it("tailors sections to the referenced clouds only", () => {
    const ctx = templatePromptContext(doc({ zones: [awsZone] }));
    expect(ctx.referencedClouds).toEqual(["aws"]);
    expect(ctx.systemPrompt).toContain("AWS components");
    expect(ctx.systemPrompt).not.toContain("Azure components");
    expect(ctx.systemPrompt).not.toContain("GCP components");
  });

  it("a cloudless document gets the base prompt and no sections", () => {
    const ctx = templatePromptContext(doc());
    expect(ctx.referencedClouds).toEqual([]);
    expect(ctx.systemPrompt).not.toContain("components\n");
    // Cloud kinds are not advertised when their cloud isn't referenced.
    expect(ctx.systemPrompt).not.toContain("aws-lambda");
  });

  it("custom providers ride the enum but contribute no section or chip", () => {
    const ctx = templatePromptContext(
      doc({ zones: [{ ...awsZone, providers: ["fly"], provider: "fly" }] }),
      { providers: { fly: { label: "Fly.io", color: "#7c3aed" } } },
    );
    expect(ctx.systemPrompt).toContain("fly");
    expect(ctx.referencedClouds).toEqual([]);
    expect(ctx.cloudOptions.map((c) => c.id)).toEqual(["aws", "azure", "gcp"]);
  });

  it("respects a registry that deleted a cloud", () => {
    const ctx = templatePromptContext(doc(), { providers: { gcp: null } });
    expect(ctx.cloudOptions.map((c) => c.id)).toEqual(["aws", "azure"]);
  });

  it("promptForClouds matches the direct composition", () => {
    const ctx = templatePromptContext(doc());
    expect(ctx.promptForClouds(["gcp"])).toBe(promptForCloudSelection(resolveRegistry(), ["gcp"]));
  });

  it("buildTemplateSystemPrompt is the context's prompt", () => {
    const t = doc({ zones: [awsZone] });
    expect(buildTemplateSystemPrompt(t)).toBe(templatePromptContext(t).systemPrompt);
  });

  it("registry promptExtraRules ride along", () => {
    const ctx = templatePromptContext(doc(), { promptExtraRules: "- Always use eu-west-1." });
    expect(ctx.systemPrompt).toContain("Always use eu-west-1.");
  });

  it("a cloudless document names no cloud anywhere in the prompt", () => {
    // The end-to-end version of the schema audit: nothing in the pipeline —
    // skeleton, rules, sections, kind enum — may pick a cloud on its own.
    const prompt = templatePromptContext(doc()).systemPrompt;
    expect(prompt).not.toContain('"provider":"azure"');
    expect(prompt).not.toContain("azure-");
    expect(prompt).not.toContain("aws-");
    expect(prompt).not.toContain("gcp-");
  });

  it("a zone with no stated provider does not make the document cloudy", () => {
    const registry = resolveRegistry();
    const t = doc({ zones: [{ ...awsZone, providers: [], provider: "" }] });
    expect(referencedCloudIds(t, registry)).toEqual([]);
  });
});

describe("resource-level scoping", () => {
  const registry = resolveRegistry();

  it("narrows both the kind enum and the section to the chosen services", () => {
    const prompt = promptForCloudSelection(registry, ["azure"], {
      components: ["azure-blob", "azure-sql"],
    });
    expect(prompt).toContain("azure-blob");
    expect(prompt).toContain("azure-sql");
    expect(prompt).not.toContain("azure-functions");
    expect(prompt).not.toContain("azure-openai");
    expect(prompt).toContain("### Azure components");
  });

  it("a cloud with nothing ticked drops out entirely, example provider included", () => {
    const prompt = promptForCloudSelection(registry, ["aws", "gcp"], {
      components: ["gcp-storage"],
    });
    expect(prompt).toContain("gcp-storage");
    expect(prompt).toContain('"providers":["gcp"],"provider":"gcp"');
    expect(prompt).not.toContain("AWS components");
    expect(prompt).not.toContain("aws-s3");
  });

  it("no components option means the whole pack, as before", () => {
    expect(promptForCloudSelection(registry, ["aws"], {})).toBe(
      promptForCloudSelection(registry, ["aws"]),
    );
  });

  it("cloudResourceOptions lists the packs' services, narrowable by cloud", () => {
    const all = cloudResourceOptions(registry);
    expect(all.find((r) => r.id === "azure-blob")).toMatchObject({
      cloud: "azure",
      label: "Blob Storage",
      hint: "object storage container",
    });
    const gcpOnly = cloudResourceOptions(registry, ["gcp"]);
    expect(gcpOnly.every((r) => r.cloud === "gcp")).toBe(true);
    expect(gcpOnly.length).toBeLessThan(all.length);
  });

  it("cloudResourceOptions includes an extension kind tagged with a cloud", () => {
    const extended = resolveRegistry({
      nodeKinds: { "aws-athena": { label: "Athena", provider: "aws" } },
    });
    const rows = cloudResourceOptions(extended, ["aws"]);
    expect(rows.find((r) => r.id === "aws-athena")).toMatchObject({ label: "Athena" });
    // The pack has no hint for a host's own kind, and none is invented.
    expect(rows.find((r) => r.id === "aws-athena")?.hint).toBeUndefined();
  });

  it("usedResources reports only the cloud kinds the document actually uses", () => {
    const t = doc();
    t.nodes[0].kind = "azure-functions";
    const validated = validateTemplate(t);
    expect(usedCloudResources(validated, registry)).toEqual(["azure-functions"]);
    expect(templatePromptContext(validated).usedResources).toEqual(["azure-functions"]);
  });
});
