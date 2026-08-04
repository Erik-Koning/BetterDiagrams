/**
 * Tests for the visual-state space: which axes a document exposes, how combos
 * enumerate and count, the names they export under, and that materializing a
 * combo produces the same document the canonical transforms compose to.
 */
import { describe, expect, it } from "vitest";
import {
  comboLabel,
  comboSlug,
  countStateCombos,
  enumerateStateCombos,
  materializeCombo,
  materializeSequenceCombo,
  sequenceStateAxes,
  templateStateAxes,
} from "./states";
import { setZoneProvider, EXAMPLE_ZONED_TEMPLATE, type DiagramTemplate } from "./schema";
import { timelineView } from "./timeline";
import { validateSequence, type SequenceTemplate } from "./sequence";

// region: azure/aws/gcp; vendor: saas only. Stops: Mar 2 / Jun 15 / Sep 30 '26.
const zoned = EXAMPLE_ZONED_TEMPLATE;

const flow = (): SequenceTemplate =>
  validateSequence({
    version: 1,
    participants: [
      { id: "u", label: "User", kind: "actor" },
      { id: "api", label: "API", kind: "service" },
    ],
    messages: [
      { id: "m1", from: "u", to: "api", label: "call", style: "sync" },
      { id: "m2", from: "api", to: "u", label: "reply", style: "reply", date: "2026-09-30" },
    ],
    activations: [],
    fragments: [],
    notes: [],
  });

describe("templateStateAxes", () => {
  it("keeps only zones that actually vary", () => {
    const axes = templateStateAxes(zoned);
    // `vendor` offers a single provider — scenery, not an axis.
    expect(axes.zones.map((z) => z.zoneId)).toEqual(["region"]);
    expect(axes.zones[0]).toMatchObject({
      label: "Cloud Region",
      slug: "cloud-region",
      providers: ["azure", "aws", "gcp"],
      current: "azure",
    });
    expect(axes.stops).toEqual(["2026-03-02", "2026-06-15", "2026-09-30"]);
  });

  it("dedupes colliding slugs and falls back to the id for unsluggable labels", () => {
    const doc: DiagramTemplate = {
      ...zoned,
      zones: [
        { ...zoned.zones![0], id: "a", label: "Region" },
        { ...zoned.zones![0], id: "b", label: "region!" },
        { ...zoned.zones![0], id: "emoji", label: "🚀🚀" },
      ],
    };
    expect(templateStateAxes(doc).zones.map((z) => z.slug)).toEqual([
      "region",
      "region-2",
      "emoji",
    ]);
  });

  it("sequence documents expose only the date axis", () => {
    const axes = sequenceStateAxes(flow());
    expect(axes.zones).toEqual([]);
    expect(axes.stops).toEqual(["2026-09-30"]);
  });
});

describe("countStateCombos / enumerateStateCombos", () => {
  const axes = templateStateAxes(zoned);

  it("counts the full product", () => {
    expect(countStateCombos(axes)).toBe(9);
    expect(enumerateStateCombos(axes)).toHaveLength(9);
  });

  it("counts a subset, and an emptied axis collapses to zero", () => {
    expect(countStateCombos(axes, { providers: { region: ["aws"] } })).toBe(3);
    expect(countStateCombos(axes, { stops: ["2026-06-15"] })).toBe(3);
    expect(countStateCombos(axes, { providers: { region: [] } })).toBe(0);
    expect(countStateCombos(axes, { stops: [] })).toBe(0);
    expect(enumerateStateCombos(axes, { stops: [] })).toEqual([]);
  });

  it("orders zone axes outermost, stops ascending innermost", () => {
    const combos = enumerateStateCombos(axes);
    expect(combos[0]).toEqual({ providers: { region: "azure" }, at: "2026-03-02" });
    expect(combos[2]).toEqual({ providers: { region: "azure" }, at: "2026-09-30" });
    expect(combos[3]).toEqual({ providers: { region: "aws" }, at: "2026-03-02" });
    expect(combos[8]).toEqual({ providers: { region: "gcp" }, at: "2026-09-30" });
  });

  it("canonicalizes selection order and drops unknown ids", () => {
    const combos = enumerateStateCombos(axes, {
      providers: { region: ["gcp", "nonsense", "azure"] },
      stops: ["2026-06-15"],
    });
    expect(combos.map((c) => c.providers.region)).toEqual(["azure", "gcp"]);
  });

  it("an undated document enumerates one null-date combo per provider", () => {
    const undated: DiagramTemplate = {
      ...zoned,
      zones: zoned.zones!.map(({ date: _date, ...z }) => z),
      nodes: zoned.nodes.map(({ date: _date, ...n }) => n),
      edges: zoned.edges,
    };
    const combos = enumerateStateCombos(templateStateAxes(undated));
    expect(combos).toHaveLength(3);
    expect(combos.every((c) => c.at === null)).toBe(true);
  });

  it("a zoneless document enumerates one empty-provider combo per stop", () => {
    const zoneless: DiagramTemplate = { ...zoned, zones: [] };
    const combos = enumerateStateCombos(templateStateAxes(zoneless));
    // Nodes with `providers` but no surviving zone still carry their dates.
    expect(combos.every((c) => Object.keys(c.providers).length === 0)).toBe(true);
    expect(combos.map((c) => c.at)).toEqual(["2026-03-02", "2026-06-15", "2026-09-30"]);
  });
});

describe("comboSlug / comboLabel", () => {
  const axes = templateStateAxes(zoned);

  it("names a combo by its axes", () => {
    const combo = { providers: { region: "aws" }, at: "2026-06-15" };
    expect(comboSlug(axes, combo)).toBe("--cloud-region-aws--2026-06-15");
    expect(comboLabel(axes, combo)).toBe("Cloud Region: aws · Jun 15 ’26");
  });

  it("omits the parts a combo doesn't have", () => {
    expect(comboSlug(axes, { providers: { region: "aws" }, at: null })).toBe("--cloud-region-aws");
    expect(comboSlug(axes, { providers: {}, at: "2026-06-15" })).toBe("--2026-06-15");
    expect(comboSlug(axes, { providers: {}, at: null })).toBe("");
  });
});

describe("materializeCombo", () => {
  const axes = templateStateAxes(zoned);

  it("forces the zone provider without touching the input", () => {
    const before = JSON.stringify(zoned);
    const doc = materializeCombo(zoned, { providers: { region: "gcp" }, at: null });
    expect(doc.zones!.find((z) => z.id === "region")!.provider).toBe("gcp");
    expect(doc.zones!.find((z) => z.id === "vendor")!.provider).toBe("saas");
    expect(JSON.stringify(zoned)).toBe(before);
  });

  it("slices the timeline in hide mode", () => {
    const doc = materializeCombo(zoned, { providers: { region: "azure" }, at: "2026-03-02" });
    const ids = new Set(doc.nodes.map((n) => n.id));
    // Dated on-or-before the cursor stays; later drops — including the
    // vendor island zone, which carries its own September date.
    expect(ids.has("sql-az")).toBe(true);
    expect(ids.has("wrk")).toBe(false);
    expect(ids.has("pay")).toBe(false);
    expect(doc.zones!.map((z) => z.id)).toEqual(["region"]);
  });

  it("matches the manual composition of the canonical transforms", () => {
    const combo = { providers: { region: "aws" }, at: "2026-06-15" };
    const manual = timelineView(setZoneProvider(zoned, "region", "aws"), "2026-06-15", "hide")
      .template;
    expect(materializeCombo(zoned, combo)).toEqual(manual);
  });

  it("the full enumeration is 9 distinct documents", () => {
    const docs = enumerateStateCombos(axes).map((c) => JSON.stringify(materializeCombo(zoned, c)));
    expect(new Set(docs).size).toBe(9);
  });
});

describe("materializeSequenceCombo", () => {
  it("drops messages dated after the cursor", () => {
    const doc = materializeSequenceCombo(flow(), { providers: {}, at: "2026-01-01" });
    expect(doc.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("null cursor returns the document as-is", () => {
    const template = flow();
    expect(materializeSequenceCombo(template, { providers: {}, at: null })).toEqual(template);
  });
});
