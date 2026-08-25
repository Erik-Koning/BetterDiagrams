/**
 * nestContents / inlineContents — moving a container's contents between C4
 * levels. Pure node env: these are document transforms, not rendering.
 *
 * The headline is what they DON'T touch. Cross-level connections are derived
 * from the parent chain, so a transform that rewrote edges would be doing the
 * renderer's job badly; every test here that asserts "edges unchanged" is
 * guarding that.
 */
import { describe, expect, it } from "vitest";
import { inlineContents, nestContents } from "./nesting";
import { EXAMPLE_TEMPLATE, validateTemplate, type DiagramTemplate } from "./schema";

/** The Clinic platform: group `vpc` holds api/wrk/q, with edges crossing both ways. */
const doc = (): DiagramTemplate => validateTemplate(structuredClone(EXAMPLE_TEMPLATE));
const node = (t: DiagramTemplate, id: string) => t.nodes.find((n) => n.id === id)!;

describe("nestContents", () => {
  it("turns the frame into a card of the chosen kind, centred where it stood", () => {
    const before = node(doc(), "vpc");
    const after = node(nestContents(doc(), "vpc", { kind: "azure-app-service" }), "vpc");

    expect(after.kind).toBe("azure-app-service");
    expect({ w: after.w, h: after.h }).toEqual({ w: 170, h: 76 });
    // The card sits on the frame's centre, not its corner.
    expect(after.x + after.w / 2).toBe(before.x + before.w / 2);
    expect(after.y + after.h / 2).toBe(before.y + before.h / 2);
    // Identity survives — this is the same box, differently drawn.
    expect(after.label).toBe(before.label);
    expect(after.parentId).toBe(before.parentId);
  });

  it("leaves every child and every edge exactly as it found them", () => {
    const base = doc();
    const after = nestContents(base, "vpc");

    for (const id of ["api", "wrk", "q"]) {
      expect(node(after, id)).toEqual(node(base, id));
    }
    expect(after.edges).toEqual(base.edges);
  });

  it("drops the frame vocabulary a card cannot render", () => {
    const styled = doc();
    Object.assign(node(styled, "vpc"), {
      fill: false,
      outline: "dotted" as const,
      color: "#8b5cf6",
      opacity: 0.4,
      collapsed: true,
    });
    const after = node(nestContents(styled, "vpc"), "vpc");

    for (const key of ["fill", "outline", "color", "opacity", "collapsed"]) {
      expect(key in after, key).toBe(false);
    }
  });

  it("defaults to a service — C4's 'container' — and adopts a given icon", () => {
    expect(node(nestContents(doc(), "vpc"), "vpc").kind).toBe("service");
    expect(node(nestContents(doc(), "vpc", { icon: "server" }), "vpc").icon).toBe("server");
  });

  it("does nothing to a node that isn't a container, or holds nothing", () => {
    const base = doc();
    expect(nestContents(base, "api")).toBe(base); // a card already
    expect(nestContents(base, "db")).toBe(base); // no children
  });

  it("throws on an id that isn't there — that's a caller bug, not a no-op", () => {
    expect(() => nestContents(doc(), "nope")).toThrow(/unknown node id/);
  });

  it("takes a nested container down with everything else, as one unit", () => {
    const base = validateTemplate({
      version: 1,
      nodes: [
        { id: "outer", label: "Outer", kind: "group", x: 0, y: 0, w: 600, h: 400 },
        { id: "inner", label: "Inner", kind: "group", parentId: "outer", x: 24, y: 48, w: 300, h: 200 },
        { id: "leaf", label: "Leaf", kind: "service", parentId: "inner", x: 24, y: 48, w: 170, h: 76 },
      ],
      edges: [],
    }) as DiagramTemplate;
    const after = nestContents(base, "outer");

    // Only the subject changed kind; the inner frame is still a frame, one
    // level further down than it was.
    expect(node(after, "outer").kind).toBe("service");
    expect(node(after, "inner").kind).toBe("group");
    expect(node(after, "inner").parentId).toBe("outer");
    expect(node(after, "leaf").parentId).toBe("inner");
  });
});

describe("inlineContents", () => {
  it("turns the card back into a frame sized around its contents", () => {
    const nested = nestContents(doc(), "vpc");
    const after = inlineContents(nested, "vpc");
    const frame = node(after, "vpc");

    expect(frame.kind).toBe("group");
    // Every child clears the frame's inset, and the frame clears every child.
    for (const id of ["api", "wrk", "q"]) {
      const child = node(after, id);
      expect(child.x).toBeGreaterThanOrEqual(24);
      expect(child.y).toBeGreaterThanOrEqual(48);
      expect(child.x + child.w).toBeLessThanOrEqual(frame.w - 24 + 1);
      expect(child.y + child.h).toBeLessThanOrEqual(frame.h - 24 + 1);
    }
    // Unfolded around the card rather than off its corner.
    expect(node(nested, "vpc").x + node(nested, "vpc").w / 2).toBe(frame.x + frame.w / 2);
  });

  it("shifts direct children only — a grandchild rides its own parent", () => {
    const base = validateTemplate({
      version: 1,
      nodes: [
        { id: "card", label: "Card", kind: "service", x: 0, y: 0, w: 170, h: 76 },
        { id: "mid", label: "Mid", kind: "service", parentId: "card", x: 200, y: 300, w: 170, h: 76 },
        { id: "deep", label: "Deep", kind: "service", parentId: "mid", x: 10, y: 20, w: 170, h: 76 },
      ],
      edges: [],
    }) as DiagramTemplate;
    const after = inlineContents(base, "card");

    expect({ x: node(after, "mid").x, y: node(after, "mid").y }).toEqual({ x: 24, y: 48 });
    expect({ x: node(after, "deep").x, y: node(after, "deep").y }).toEqual({ x: 10, y: 20 });
  });

  it("does nothing to a frame, or to a card with no internals", () => {
    const base = doc();
    expect(inlineContents(base, "vpc")).toBe(base); // already a frame
    expect(inlineContents(base, "db")).toBe(base); // nothing inside
  });

  it("round-trips: the pair changes structure, never content", () => {
    const base = doc();
    const back = inlineContents(nestContents(base, "vpc"), "vpc");

    // Same nodes, same parents, same kinds, same edges — only the frame's own
    // geometry and its children's offsets are allowed to have moved.
    expect(back.nodes.map((n) => `${n.id}:${n.kind}:${n.parentId ?? ""}`)).toEqual(
      base.nodes.map((n) => `${n.id}:${n.kind}:${n.parentId ?? ""}`),
    );
    expect(back.edges).toEqual(base.edges);
    // And the frame still surrounds its contents, which is what a group means.
    const frame = node(back, "vpc");
    expect(frame.w).toBeGreaterThan(Math.max(...["api", "wrk", "q"].map((id) => node(back, id).w)));
  });
});
