/**
 * The content/presentation split: the round-trip law, the containment guards,
 * incremental placement, and the repair rules of the layout document itself.
 */
import { describe, expect, it } from "vitest";
import {
  PRESENTATION_FORMAT,
  mergeTemplate,
  splitTemplate,
  validatePresentation,
} from "./presentation";
import { placeUnpositioned } from "./layout";
import { diffTemplates } from "./diff";
import { validateTemplate, type DiagramTemplate } from "./schema";

/** A document that exercises groups, zones, routes, and non-default labels. */
const FIXTURE: DiagramTemplate = validateTemplate({
  version: 1,
  meta: { title: "Split me", routing: "orthogonal" },
  zones: [{ id: "aws", label: "AWS", provider: "aws", providers: ["aws"], x: 40, y: 40, w: 500, h: 400 }],
  nodes: [
    { id: "g", label: "Core", kind: "group", icon: "none", description: "", parentId: null, x: 600, y: 80, w: 400, h: 300 },
    { id: "api", label: "API", kind: "service", icon: "box", description: "", parentId: "g", x: 30, y: 60, w: 170, h: 76 },
    { id: "db", label: "DB", kind: "database", icon: "database", description: "", parentId: null, zoneId: "aws", x: 90, y: 120, w: 170, h: 76, status: "planned", date: "2026-11-01" },
    { id: "cdn", label: "CDN", kind: "service", icon: "globe", description: "", parentId: null, x: 60, y: 520, w: 170, h: 76 },
  ],
  edges: [
    { id: "e1", source: "api", target: "db", label: "reads", style: "solid", color: "sky", labelT: 0.3, start: { side: "left" }, points: [[420, 200]] },
    { id: "e2", source: "cdn", target: "db", label: "", style: "dashed", color: "slate" },
  ],
});

describe("splitTemplate", () => {
  const { content, presentation } = splitTemplate(FIXTURE);

  it("strips placement from content and captures it in records", () => {
    for (const n of content.nodes) {
      expect("x" in n, n.id).toBe(false);
      expect("w" in n, n.id).toBe(false);
    }
    expect(presentation.nodes?.api).toEqual({ x: 30, y: 60, w: 170, h: 76, parent: "g" });
    expect(presentation.nodes?.db).toEqual({ x: 90, y: 120, w: 170, h: 76, zone: "aws" });
  });

  it("keeps zone boxes in content — zone geometry is membership", () => {
    expect(content.zones?.[0].x).toBe(40);
    expect(content.zones?.[0].w).toBe(500);
  });

  it("records only non-default routes, with captured endpoints", () => {
    expect(presentation.edges?.e1).toEqual({
      source: "api",
      target: "db",
      labelT: 0.3,
      start: { side: "left" },
      points: [[420, 200]],
    });
    // e2 is all defaults — a record would say nothing.
    expect(presentation.edges?.e2).toBeUndefined();
  });

  it("keeps everything semantic in content", () => {
    const db = content.nodes.find((n) => n.id === "db")!;
    expect(db.status).toBe("planned");
    expect(db.date).toBe("2026-11-01");
    expect(content.meta?.routing).toBe("orthogonal");
  });
});

describe("mergeTemplate — the round-trip law", () => {
  it("merge(split(t)) is byte-identical for a canonical document", () => {
    const { content, presentation } = splitTemplate(FIXTURE);
    const merged = mergeTemplate(content, presentation);
    expect(JSON.stringify(merged)).toBe(JSON.stringify(FIXTURE));
  });

  it("a full template as content with no presentation is the identity", () => {
    expect(JSON.stringify(mergeTemplate(FIXTURE))).toBe(JSON.stringify(FIXTURE));
  });

  it("survives a JSON round trip of both halves", () => {
    const { content, presentation } = splitTemplate(FIXTURE);
    const merged = mergeTemplate(JSON.parse(JSON.stringify(content)), JSON.parse(JSON.stringify(presentation)));
    expect(JSON.stringify(merged)).toBe(JSON.stringify(FIXTURE));
  });
});

describe("mergeTemplate — guards and fallbacks", () => {
  it("discards a position whose parent moved, keeps the size, re-places the node", () => {
    const { content, presentation } = splitTemplate(FIXTURE);
    // A content edit pulled `api` out of the group.
    const edited = {
      ...content,
      nodes: content.nodes.map((n) => (n.id === "api" ? { ...n, parentId: null } : n)),
    };
    const merged = mergeTemplate(edited, presentation);
    const api = merged.nodes.find((n) => n.id === "api")!;
    // Not the stale parent-relative coords…
    expect([api.x, api.y]).not.toEqual([30, 60]);
    // …but the captured size survives.
    expect([api.w, api.h]).toEqual([170, 76]);
  });

  it("discards a position whose zone moved", () => {
    const { content, presentation } = splitTemplate(FIXTURE);
    const edited = {
      ...content,
      nodes: content.nodes.map((n) => (n.id === "db" ? { ...n, zoneId: null } : n)),
    };
    const merged = mergeTemplate(edited, presentation);
    const db = merged.nodes.find((n) => n.id === "db")!;
    expect([db.x, db.y]).not.toEqual([90, 120]);
  });

  it("finds a renamed edge's route by its captured endpoints", () => {
    const { content, presentation } = splitTemplate(FIXTURE);
    const edited = {
      ...content,
      edges: content.edges.map((e) => (e.id === "e1" ? { ...e, id: "renamed" } : e)),
    };
    const merged = mergeTemplate(edited, presentation);
    const e = merged.edges.find((x) => x.id === "renamed")!;
    expect(e.labelT).toBe(0.3);
    expect(e.start).toEqual({ side: "left" });
    expect(e.points).toEqual([[420, 200]]);
  });

  it("ignores records for elements the content no longer has", () => {
    const { content, presentation } = splitTemplate(FIXTURE);
    const edited = { ...content, nodes: content.nodes.filter((n) => n.id !== "cdn") };
    const merged = mergeTemplate(edited, presentation);
    expect(merged.nodes.find((n) => n.id === "cdn")).toBeUndefined();
  });

  it("gives a bare content doc the full auto-layout, not a single stack", () => {
    const node = (id: string) => ({
      id, label: id.toUpperCase(), kind: "service", icon: "box", description: "", parentId: null,
    });
    const edge = (id: string, source: string, target: string) => ({
      id, source, target, label: "", style: "solid", color: "slate",
    });
    const merged = mergeTemplate({
      version: 1,
      nodes: [node("a"), node("b"), node("c")],
      edges: [edge("e1", "a", "b"), edge("e2", "b", "c")],
    } as never);
    // A request chain ranks left-to-right; incremental stacking would put all
    // three in one column. This is the "no layout at all" ↔ autoLayout rule.
    const x = (id: string) => merged.nodes.find((n) => n.id === id)!.x;
    expect(x("b")).toBeGreaterThan(x("a"));
    expect(x("c")).toBeGreaterThan(x("b"));
  });

  it("places brand-new content without moving anything positioned", () => {
    const { content, presentation } = splitTemplate(FIXTURE);
    const edited = {
      ...content,
      nodes: [
        ...content.nodes,
        { id: "cache", label: "Cache", kind: "cache", icon: "box", description: "", parentId: "g", zoneId: null },
      ],
    };
    const merged = mergeTemplate(edited, presentation);
    const cache = merged.nodes.find((n) => n.id === "cache")!;
    const api = merged.nodes.find((n) => n.id === "api")!;
    // The sibling kept its exact spot; the newcomer stacked below it.
    expect([api.x, api.y]).toEqual([30, 60]);
    expect(cache.y).toBeGreaterThan(api.y + api.h);
    // The group grew to hold it rather than letting it spill.
    const g = merged.nodes.find((n) => n.id === "g")!;
    expect(g.h).toBeGreaterThanOrEqual(cache.y + cache.h);
  });
});

describe("placeUnpositioned", () => {
  it("returns the same reference when there is nothing to place", () => {
    expect(placeUnpositioned(FIXTURE, [])).toBe(FIXTURE);
    expect(placeUnpositioned(FIXTURE, ["ghost"])).toBe(FIXTURE);
  });

  it("stacks zone arrivals inside the zone and grows it", () => {
    const t = validateTemplate({
      ...JSON.parse(JSON.stringify(FIXTURE)),
      nodes: [
        ...FIXTURE.nodes,
        { id: "new1", label: "N1", kind: "service", icon: "box", description: "", parentId: null, zoneId: "aws", x: 0, y: 0, w: 170, h: 76 },
      ],
    });
    const placed = placeUnpositioned(t, ["new1"]);
    const zone = placed.zones![0];
    const n = placed.nodes.find((x) => x.id === "new1")!;
    expect(n.x).toBeGreaterThanOrEqual(zone.x);
    expect(n.y).toBeGreaterThan(zone.y);
    expect(zone.h).toBeGreaterThanOrEqual(n.y + n.h - zone.y);
    // The zone's origin never moves — growth only.
    expect(zone.x).toBe(40);
    expect(zone.y).toBe(40);
  });

  it("drops root arrivals below everything already on the canvas", () => {
    const placed = placeUnpositioned(FIXTURE, ["cdn"]);
    const cdn = placed.nodes.find((n) => n.id === "cdn")!;
    const bottoms = FIXTURE.nodes
      .filter((n) => !n.parentId && n.id !== "cdn")
      .map((n) => n.y + n.h);
    expect(cdn.y).toBeGreaterThan(Math.max(...bottoms));
  });
});

describe("per-view records (meta.views)", () => {
  /** FIXTURE plus a drill parent with a saved ghost placement for its view. */
  const viewedDoc = () =>
    validateTemplate({
      ...JSON.parse(JSON.stringify(FIXTURE)),
      meta: {
        title: "Split me",
        routing: "orthogonal",
        views: {
          api: {
            nodes: { "ghost:db": { x: -220, y: 40, w: 170, h: 76 } },
            edges: { "ghost:e1": { labelT: 0.3 } },
          },
        },
      },
    });

  it("round-trips byte-identically through split and merge", () => {
    const t = viewedDoc();
    const { content, presentation } = splitTemplate(t);
    // The overrides moved home: out of content, into the layout doc.
    expect(content.meta && "views" in content.meta).toBe(false);
    expect(presentation.views?.api.nodes?.["ghost:db"]).toEqual({ x: -220, y: 40, w: 170, h: 76 });
    expect(JSON.stringify(mergeTemplate(content, presentation))).toBe(JSON.stringify(t));
  });

  it("survives when views are meta's only key", () => {
    const t = validateTemplate({
      ...JSON.parse(JSON.stringify(FIXTURE)),
      meta: { views: { api: { nodes: { "ghost:db": { x: 1, y: 2, w: 10, h: 10 } } } } },
    });
    const { content, presentation } = splitTemplate(t);
    expect("meta" in content).toBe(false);
    expect(JSON.stringify(mergeTemplate(content, presentation))).toBe(JSON.stringify(t));
  });

  it("is invisible to diffTemplates — a ghost drag is not a content change", () => {
    const t = viewedDoc();
    const moved = validateTemplate({
      ...JSON.parse(JSON.stringify(t)),
      meta: {
        ...t.meta,
        views: { api: { nodes: { "ghost:db": { x: -300, y: 90, w: 170, h: 76 } } } },
      },
    });
    const diff = diffTemplates(t, moved);
    expect(diff.summary).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it("repairs garbage views and strips empty layers", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [{ id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 }],
      edges: [],
      meta: {
        views: {
          a: {
            nodes: {
              ok: { x: 1, y: 2, w: 100, h: 50 },
              bad: { x: "NaN", y: 2, w: 100, h: 50 },
              flat: { x: 1, y: 2, w: 0, h: 50 },
            },
            edges: { silent: { labelT: 0.5 }, routed: { start: { side: "left" }, points: [[1.4, 2.6]] } },
          },
          empty: {},
          junk: "nope",
        },
      },
    } as never);
    const views = t.meta?.views as Record<string, { nodes?: object; edges?: object }>;
    expect(Object.keys(views)).toEqual(["a"]);
    expect(Object.keys(views.a.nodes ?? {})).toEqual(["ok"]);
    expect(views.a.edges).toEqual({ routed: { start: { side: "left" }, points: [[1, 3]] } });
  });

  it("canonicalises views to the last meta key", () => {
    const t = validateTemplate({
      version: 1,
      nodes: [],
      edges: [],
      meta: { views: { x: { nodes: { "ghost:y": { x: 0, y: 0, w: 10, h: 10 } } } }, title: "After" },
    } as never);
    expect(Object.keys(t.meta!)).toEqual(["title", "views"]);
  });
});

describe("validatePresentation", () => {
  it("is idempotent and stamps the format", () => {
    const { presentation } = splitTemplate(FIXTURE);
    const once = validatePresentation(presentation);
    expect(once.format).toBe(PRESENTATION_FORMAT);
    expect(JSON.stringify(validatePresentation(once))).toBe(JSON.stringify(once));
  });

  it("drops broken records and empty routes, keeps dangling ids", () => {
    const cleaned = validatePresentation({
      nodes: {
        ok: { x: 1, y: 2, w: 100, h: 50 },
        bad: { x: "NaN", y: 2, w: 100, h: 50 },
        flat: { x: 1, y: 2, w: 0, h: 50 },
        dangling: { x: 9, y: 9, w: 10, h: 10 },
      },
      edges: {
        says_nothing: { source: "a", target: "b" },
        routed: { start: { side: "up" }, end: { side: "top", t: 2 }, points: [[1.4, 2.6]] },
      },
    });
    expect(Object.keys(cleaned.nodes ?? {})).toEqual(["ok", "dangling"]);
    expect(cleaned.edges?.says_nothing).toBeUndefined();
    // Unknown side dropped, t clamped, points rounded.
    expect(cleaned.edges?.routed).toEqual({ end: { side: "top", t: 1 }, points: [[1, 3]] });
  });

  it("repairs garbage to an empty layout file", () => {
    expect(validatePresentation(null)).toEqual({ version: 1, format: PRESENTATION_FORMAT });
    expect(validatePresentation("nope")).toEqual({ version: 1, format: PRESENTATION_FORMAT });
  });
});
