/**
 * The auto-placer and polish, held to what they promise: on every shape of
 * diagram, the picture has nothing a reader would call wrong; a lock, a card's
 * canvas and an author's arrangement are respected; and no shape is forced.
 */
import { describe, expect, it } from "vitest";
import { arrangeBest, arrangeSelection, autoPlace, hasPlacement, layoutCandidates, polishLayout, straightenLines } from "./arrange";
import { ARRANGE_FIXTURES } from "./arrange.fixtures";
import { buildScene, lintLayout, type LayoutRuleId } from "./layout-lint";
import { autoLayout } from "./layout";
import { buildSystemPrompt, validateTemplate, type DiagramTemplate } from "./schema";

const FIXTURES = Object.entries(ARRANGE_FIXTURES);
const count = (t: DiagramTemplate, rule: LayoutRuleId, frames: "root" | "all" = "root") =>
  lintLayout(t, { frames }).counts[rule] ?? 0;

const service = (id: string, more: Record<string, unknown> = {}) => ({ id, label: id, kind: "service", ...more });
const line = (source: string, target: string, more: Record<string, unknown> = {}) => ({
  id: `${source}-${target}`,
  source,
  target,
  label: "",
  ...more,
});
const doc = (nodes: unknown[], edges: unknown[] = [], more: Record<string, unknown> = {}): DiagramTemplate =>
  validateTemplate({ version: 1, nodes, edges, ...more });

describe("autoPlace, on every shape of diagram", () => {
  for (const [name, make] of FIXTURES) {
    describe(name, () => {
      const placed = autoPlace(make(), { frames: "all" });

      it("nothing overlaps, spills, or hides behind a line", () => {
        for (const rule of ["box-overlap", "outside-container", "region-collision", "intruder"] as const) {
          expect(count(placed, rule, "all"), rule).toBe(0);
        }
        // Dense enough to leave no clean route is a diagram problem, not a free pass.
        expect(count(placed, "line-through-box", "all"), "line-through-box").toBe(0);
      });

      it("scores well", () => {
        // Two are dense enough that some crossings aren't the layout's to remove. The
        // large system's arrangement also gives up a few minor points on purpose: it's
        // picked for being legible when fitted, and has fewer crossings for it, not more.
        // Its floor fell from 65 when the linter learnt to count shallow crossings and
        // lines running close, which readers marked it down for: the arrangement is the
        // same, the measure is more honest. Routing that spaces lines out should lift it.
        const floor = name === "largeSystem" ? 55 : name === "bipartite" ? 75 : 90;
        expect(lintLayout(placed, { frames: "all" }).score).toBeGreaterThanOrEqual(floor);
      });

      it("gives the same answer every time", () => {
        const positions = (t: DiagramTemplate) => t.nodes.map((n) => [n.id, n.x, n.y, n.w, n.h]);
        expect(positions(autoPlace(make(), { frames: "all" }))).toEqual(positions(placed));
      });

      it("uses whole pixels, so nothing renders blurred", () => {
        for (const n of placed.nodes) {
          expect(Number.isInteger(n.x) && Number.isInteger(n.y), `${n.id} at ${n.x},${n.y}`).toBe(true);
        }
      });

      it("keeps every box and line", () => {
        const before = make();
        expect(placed.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort());
        const pairs = (t: DiagramTemplate) => t.edges.map((e) => `${e.source}>${e.target}`).sort();
        expect(pairs(placed)).toEqual(pairs(before));
      });

      it("survives a round through validation unchanged", () => {
        expect(validateTemplate(placed).nodes.map((n) => [n.id, n.x, n.y])).toEqual(placed.nodes.map((n) => [n.id, n.x, n.y]));
      });
    });
  }
});

describe("no shape is forced", () => {
  it("a chain stays a chain, however long", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const t = doc(ids.map((id) => service(id)), ids.slice(1).map((id, i) => line(ids[i]!, id)));
    const { width, height } = lintLayout(autoPlace(t)).metrics;
    expect(Math.max(width, height) / Math.min(width, height)).toBeGreaterThan(10);
  });

  it("a hub comes out round, not as one tall column", () => {
    const { width, height } = lintLayout(autoPlace(ARRANGE_FIXTURES.gatewayHub!())).metrics;
    expect(width / height).toBeLessThan(2.5);
    expect(height / width).toBeLessThan(2.5);
  });

  it("a shape can still be asked for", () => {
    const t = doc(Array.from({ length: 16 }, (_, i) => service(`n${i}`)));
    const ratio = (shape: "wide" | "tall") => {
      const { width, height } = lintLayout(autoPlace(t, { shape })).metrics;
      return width / height;
    };
    expect(ratio("wide")).toBeGreaterThan(ratio("tall"));
  });

  it("the prompt no longer asks for a direction or a node count", () => {
    for (const prompt of [buildSystemPrompt(), buildSystemPrompt({ geometry: false })]) {
      expect(prompt).not.toMatch(/6-14 nodes/);
      expect(prompt).not.toMatch(/Lay out left-to-right/);
      expect(prompt).toMatch(/any shape and any size/);
    }
  });
});

describe("direction", () => {
  it("a flow chart starts at its start", () => {
    const placed = autoPlace(ARRANGE_FIXTURES.flowchart!());
    const y = (id: string) => placed.nodes.find((n) => n.id === id)!.y;
    expect(y("start")).toBeLessThan(y("enter"));
    expect(y("enter")).toBeLessThan(y("valid"));
    expect(y("session")).toBeLessThan(y("end"));
  });

  it("a named direction is obeyed, and each one is the mirror of its opposite", () => {
    const t = ARRANGE_FIXTURES.pipeline!();
    const x = (doc: DiagramTemplate, id: string) => doc.nodes.find((n) => n.id === id)!.x;
    const y = (doc: DiagramTemplate, id: string) => doc.nodes.find((n) => n.id === id)!.y;
    expect(x(autoPlace(t, { direction: "right" }), "src")).toBeLessThan(x(autoPlace(t, { direction: "right" }), "dash"));
    expect(x(autoPlace(t, { direction: "left" }), "src")).toBeGreaterThan(x(autoPlace(t, { direction: "left" }), "dash"));
    expect(y(autoPlace(t, { direction: "down" }), "src")).toBeLessThan(y(autoPlace(t, { direction: "down" }), "dash"));
    expect(y(autoPlace(t, { direction: "up" }), "src")).toBeGreaterThan(y(autoPlace(t, { direction: "up" }), "dash"));
  });

  it("lines leave a box the way the flow runs, whatever the gap", () => {
    const placed = autoPlace(ARRANGE_FIXTURES.orgTree!(), { direction: "right", algorithm: "tree" });
    const scene = buildScene(placed);
    for (const l of scene.lines) {
      expect(l.samples[0]!.x, `${l.edge.source} → ${l.edge.target}`).toBeCloseTo(l.source.x + l.source.w, 0);
      expect(l.geo.tip.x).toBeCloseTo(l.target.x, 0);
    }
  });

  it("settings.layout is read, and an option beats it", () => {
    const t = ARRANGE_FIXTURES.pipeline!();
    const down: DiagramTemplate = { ...t, settings: { layout: { direction: "down" } } };
    const y = (d: DiagramTemplate, id: string) => d.nodes.find((n) => n.id === id)!.y;
    const x = (d: DiagramTemplate, id: string) => d.nodes.find((n) => n.id === id)!.x;
    expect(y(autoPlace(down), "src")).toBeLessThan(y(autoPlace(down), "dash"));
    expect(x(autoPlace(down, { direction: "right" }), "src")).toBeLessThan(x(autoPlace(down, { direction: "right" }), "dash"));
  });
});

describe("what a document asks of its layout", () => {
  it("a locked box stays put, and nothing lands on it", () => {
    const t = doc(
      [service("a"), service("b"), service("c"), service("pin", { x: 300, y: 20, locked: true })],
      [line("a", "b"), line("b", "c"), line("c", "pin")],
    );
    const placed = autoPlace(t);
    const pin = placed.nodes.find((n) => n.id === "pin")!;
    expect({ x: pin.x, y: pin.y }).toEqual({ x: 300, y: 20 });
    expect(count(placed, "box-overlap")).toBe(0);
  });

  it("a locked group keeps its place and its size, and what's in it still arranges", () => {
    const t = doc(
      [
        service("g", { kind: "group", x: 500, y: 300, w: 400, h: 300, locked: true }),
        service("inside", { parentId: "g", x: 40, y: 80 }),
        service("a"),
        service("b"),
      ],
      [line("a", "b"), line("b", "inside")],
    );
    const placed = autoPlace(t);
    const g = placed.nodes.find((n) => n.id === "g")!;
    expect([g.x, g.y, g.w, g.h]).toEqual([500, 300, 400, 300]);
    expect(count(placed, "outside-container")).toBe(0);
  });

  it("a locked zone stays, with its members", () => {
    const t = doc(
      [service("m", { zoneId: "z", x: 660, y: 460 }), service("a"), service("b")],
      [line("a", "b"), line("b", "m")],
      { zones: [{ id: "z", label: "Region", shape: "rect", x: 600, y: 400, w: 400, h: 300, locked: true }] },
    );
    const placed = autoPlace(t);
    expect(placed.zones![0]).toMatchObject({ x: 600, y: 400, w: 400, h: 300 });
    expect(count(placed, "outside-container")).toBe(0);
  });

  it("nothing is ever left on top of anything, however many locks are in the way", () => {
    const nodes = Array.from({ length: 30 }, (_, i) =>
      service(`n${i}`, i % 3 === 0 ? { locked: true, x: (i * 67) % 400, y: (i * 41) % 300 } : {}),
    );
    const placed = autoPlace(doc(nodes));
    const movable = placed.nodes.filter((n) => !n.locked);
    for (const a of movable) {
      for (const b of placed.nodes) {
        if (a === b) continue;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${a.id} on ${b.id}`).toBe(false);
      }
    }
  });

  it("provider alternates share one spot, and the slot isn't dealt twice", () => {
    const t = doc(
      [
        service("api", { zoneId: "z" }),
        service("rds", { zoneId: "z", providers: ["aws"], kind: "database" }),
        service("sql", { zoneId: "z", providers: ["azure"], kind: "database" }),
      ],
      [line("api", "rds"), line("api", "sql")],
      { zones: [{ id: "z", label: "Region", shape: "rect", provider: "aws", providers: ["aws", "azure"], x: 0, y: 0, w: 300, h: 200 }] },
    );
    const placed = autoPlace(t);
    const rds = placed.nodes.find((n) => n.id === "rds")!;
    const sql = placed.nodes.find((n) => n.id === "sql")!;
    expect([rds.x, rds.y]).toEqual([sql.x, sql.y]);
  });

  it("a card's children stay in their own canvas, and a default Tidy leaves them alone", () => {
    const t = doc(
      [service("card"), service("other"), service("k1", { parentId: "card", x: 11, y: 22 }), service("k2", { parentId: "card", x: 33, y: 44 })],
      [line("card", "other"), line("k1", "k2")],
    );
    const placed = autoPlace(t);
    expect(placed.nodes.find((n) => n.id === "k1")).toMatchObject({ x: 11, y: 22 });
    expect(placed.nodes.find((n) => n.id === "k2")).toMatchObject({ x: 33, y: 44 });
    const drilled = autoPlace(t, { frames: { drill: "card" } });
    expect(drilled.nodes.find((n) => n.id === "card")).toMatchObject({ x: 0, y: 0 });
    expect(drilled.nodes.find((n) => n.id === "k1")!.x).not.toBe(11);
  });

  it("a folded group is spaced as its chip, and still holds what it hides", () => {
    const t = doc(
      [
        service("g", { kind: "group", collapsed: true }),
        service("a", { parentId: "g" }),
        service("b", { parentId: "g" }),
        service("before"),
        service("after"),
      ],
      [line("before", "a"), line("b", "after"), line("a", "b")],
    );
    const placed = autoPlace(t);
    const a = placed.nodes.find((n) => n.id === "a")!;
    const b = placed.nodes.find((n) => n.id === "b")!;
    const g = placed.nodes.find((n) => n.id === "g")!;
    expect(a.x + a.w).toBeLessThanOrEqual(g.w);
    expect(b.y + b.h).toBeLessThanOrEqual(g.h);
    expect(count(placed, "box-overlap")).toBe(0);
  });

  it("a zone only counts as inside another when it draws on top", () => {
    const zone = (id: string, x: number, y: number, w: number, h: number, z?: number) => ({ id, label: id, shape: "rect", x, y, w, h, ...(z ? { z } : {}) });
    const members = [service("a", { zoneId: "host" }), service("b", { zoneId: "inner" })];
    const accident = autoPlace(doc(members, [], { zones: [zone("host", 0, 0, 800, 600), zone("inner", 100, 100, 200, 200)] }));
    expect(count(accident, "region-collision")).toBe(0);
    const [h, i] = accident.zones!;
    expect(i!.x >= h!.x + h!.w || i!.y >= h!.y + h!.h || h!.x >= i!.x + i!.w || h!.y >= i!.y + i!.h).toBe(true);

    const island = autoPlace(doc(members, [], { zones: [zone("host", 0, 0, 800, 600), zone("inner", 100, 100, 200, 200, 1)] }));
    const [host, inner] = island.zones!;
    expect(inner!.x).toBeGreaterThanOrEqual(host!.x);
    expect(inner!.x + inner!.w).toBeLessThanOrEqual(host!.x + host!.w);
  });

  it("a person's pin survives; the last layout's doesn't", () => {
    const t = ARRANGE_FIXTURES.orgTree!();
    const pinned: DiagramTemplate = {
      ...t,
      edges: t.edges.map((e, i) => (i === 0 ? { ...e, start: { side: "bottom" as const } } : { ...e, start: { side: "top" as const, auto: true } })),
    };
    const placed = autoPlace(pinned, { algorithm: "tree", direction: "down" });
    expect(placed.edges[0]!.start).toEqual({ side: "bottom" });
    for (const e of placed.edges.slice(1)) expect(e.start?.side).not.toBe("top");
  });

  it("clears hand-drawn routes on what it moved, since they described the old picture", () => {
    const t = doc([service("a"), service("b")], [line("a", "b", { points: [[900, 900]] })]);
    expect(autoPlace(t).edges[0]!.points).toBeUndefined();
  });

  it("grows a box its words don't fit, and only grows", () => {
    const t = doc([service("a", { label: "Payment reconciliation service", w: 120 }), service("b", { w: 400 })]);
    const placed = autoPlace(t);
    expect(placed.nodes.find((n) => n.id === "a")!.w).toBeGreaterThan(120);
    expect(placed.nodes.find((n) => n.id === "b")!.w).toBe(400);
    expect(count(placed, "text-clipped")).toBe(0);
    expect(autoPlace(t, { fitText: false }).nodes.find((n) => n.id === "a")!.w).toBe(120);
  });

  it("a note grows to fit its words, and is never made smaller than it was drawn", () => {
    const t = doc([
      service("roomy", { kind: "text", label: "hi", w: 400, h: 300 }),
      service("tight", { kind: "text", label: "A note with rather more to say than a box this small has room for.", w: 140, h: 30 }),
      service("a"),
    ]);
    const placed = autoPlace(t);
    expect(placed.nodes.find((n) => n.id === "roomy")).toMatchObject({ w: 400, h: 300 });
    const tight = placed.nodes.find((n) => n.id === "tight")!;
    expect(tight.w).toBeGreaterThanOrEqual(140);
    expect(tight.h).toBeGreaterThan(30);
  });

  it("an empty zone is given the room it's drawn at, so empty zones don't land on each other", () => {
    const zone = (id: string, w: number, h: number) => ({ id, label: id, shape: "rect", x: 0, y: 0, w, h });
    const t = doc([service("a"), service("b")], [], { zones: [zone("z1", 800, 600), zone("z2", 800, 600), zone("z3", 900, 700)] });
    const placed = autoPlace(t);
    expect(placed.zones!.map((z) => [z.w, z.h])).toEqual([[800, 600], [800, 600], [900, 700]]);
    expect(count(placed, "region-collision")).toBe(0);
    expect(count(placed, "intruder")).toBe(0);
  });

  it("a zone holding a locked box isn't slid to level a line, which would move the box", () => {
    const t = doc(
      [service("a", { zoneId: "z", locked: true, x: 350, y: 200 }), service("a2", { zoneId: "z", x: 350, y: 300 }), service("b"), service("c")],
      [line("b", "a"), line("a", "c"), line("a2", "c")],
      { zones: [{ id: "z", label: "Region", shape: "rect", x: 300, y: 100, w: 300, h: 400 }] },
    );
    const placed = autoPlace(t);
    expect(placed.nodes.find((n) => n.id === "a")).toMatchObject({ x: 350, y: 200 });
    expect(placed.zones![0]).toMatchObject({ x: 300, y: 100 });
  });

  it("a group holding a locked box stays where it is, and the rest of what's in it stays in it", () => {
    const t = doc(
      [
        service("g", { kind: "group", x: 600, y: 600, w: 400, h: 300 }),
        service("held", { parentId: "g", locked: true, x: 40, y: 60 }),
        service("free", { parentId: "g", x: 40, y: 60 }),
        service("outside"),
      ],
      [line("held", "free"), line("outside", "held")],
    );
    const placed = autoPlace(t);
    const at = (id: string) => placed.nodes.find((n) => n.id === id)!;
    // The lock is a place on the canvas: the group it's in can't carry it off.
    expect([at("g").x, at("g").y]).toEqual([600, 600]);
    expect(at("held")).toMatchObject({ x: 40, y: 60 });
    const free = at("free");
    expect(free.x).toBeGreaterThanOrEqual(0);
    expect(free.y).toBeGreaterThanOrEqual(0);
    expect(free.x + free.w).toBeLessThanOrEqual(at("g").w);
    expect(free.y + free.h).toBeLessThanOrEqual(at("g").h);
    expect(count(placed, "box-overlap")).toBe(0);
    expect(count(placed, "outside-container")).toBe(0);
  });

  it("a locked zone drawn on another keeps its members, and holds the zone under it in place", () => {
    const zone = (id: string, x: number, y: number, w: number, h: number, more: Record<string, unknown> = {}) => ({ id, label: id, shape: "rect", x, y, w, h, ...more });
    const t = doc(
      [
        service("a", { zoneId: "host", x: 40, y: 80 }),
        service("b", { zoneId: "host", x: 40, y: 300 }),
        service("c", { zoneId: "island", x: 2050, y: 2060 }),
        service("d", { x: 3200, y: 0 }),
      ],
      [line("a", "b"), line("b", "c"), line("d", "a")],
      { zones: [zone("host", 0, 0, 3000, 3000), zone("island", 2000, 2000, 400, 300, { z: 1, locked: true })] },
    );
    const placed = autoPlace(t);
    const [host, island] = placed.zones!;
    expect(island).toMatchObject({ x: 2000, y: 2000, w: 400, h: 300 });
    expect(host).toMatchObject({ x: 0, y: 0, w: 3000, h: 3000 });
    const c = placed.nodes.find((n) => n.id === "c")!;
    expect(c.x).toBeGreaterThanOrEqual(2000);
    expect(c.y).toBeGreaterThanOrEqual(2000);
    expect(c.x + c.w).toBeLessThanOrEqual(2400);
    expect(c.y + c.h).toBeLessThanOrEqual(2300);
  });

  it("on a card's own canvas, nothing lands on a locked box", () => {
    const t = doc(
      [
        service("card"),
        service("other"),
        service("k1", { parentId: "card", locked: true, x: 30, y: 200 }),
        service("k2", { parentId: "card" }),
        service("k3", { parentId: "card" }),
        service("k4", { parentId: "card" }),
      ],
      [line("card", "other"), line("k2", "k1"), line("k3", "k1"), line("k4", "k1")],
    );
    const placed = autoPlace(t, { frames: { drill: "card" } });
    const kids = placed.nodes.filter((n) => n.parentId === "card");
    expect(kids.find((n) => n.id === "k1")).toMatchObject({ x: 30, y: 200 });
    for (const a of kids) {
      for (const b of kids) {
        if (a.id >= b.id) continue;
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h, `${a.id} on ${b.id}`).toBe(false);
      }
    }
  });

  it("keeps a hand-drawn route between two boxes that didn't move", () => {
    const t = doc(
      [service("a", { locked: true, x: 0, y: 0 }), service("b", { locked: true, x: 600, y: 0 }), service("c")],
      [line("a", "b", { points: [[300, -200]] }), line("b", "c")],
    );
    expect(autoPlace(t).edges[0]!.points).toEqual([[300, -200]]);
  });

  it("ranks by the lines there are, whatever characters the ids hold", () => {
    // Keyed on a space, "a b" to "c" and "a" to "b c" were one line, and "b c" lost its place.
    const t = doc(
      [service("a b"), service("c"), service("a"), service("b c")],
      [line("a b", "c"), line("c", "a"), line("a", "b c")],
    );
    const placed = autoPlace(t, { direction: "right", algorithm: "layered" });
    const x = (id: string) => placed.nodes.find((n) => n.id === id)!.x;
    expect(x("a b")).toBeLessThan(x("c"));
    expect(x("c")).toBeLessThan(x("a"));
    expect(x("a")).toBeLessThan(x("b c"));
  });

  it("autoLayout's other modes are untouched", () => {
    const t = ARRANGE_FIXTURES.webApp!();
    const flow = autoLayout(t, { mode: "flow" });
    expect(flow.nodes.every((n) => n.w === t.nodes.find((o) => o.id === n.id)!.w)).toBe(true);
    expect(flow.edges.every((e) => !e.start?.auto)).toBe(true);
  });
});

describe("polishLayout", () => {
  const rough = () => ARRANGE_FIXTURES.roughlyPlaced!();

  it("keeps the arrangement: nothing changes its place in the reading order", () => {
    const before = rough();
    const after = polishLayout(before);
    const order = (t: DiagramTemplate) => {
      const y = (id: string) => t.nodes.find((n) => n.id === id)!.y;
      return [y("client") < y("api"), y("api") < y("orders"), y("orders") < y("odb")];
    };
    expect(order(after)).toEqual(order(before));
    const x = (t: DiagramTemplate, id: string) => t.nodes.find((n) => n.id === id)!.x;
    expect(x(after, "users")).toBeLessThan(x(after, "orders"));
    expect(x(after, "orders")).toBeLessThan(x(after, "stock"));
  });

  it("moves things by a little, not to somewhere else", () => {
    const before = rough();
    const after = polishLayout(before);
    for (const n of after.nodes) {
      const was = before.nodes.find((o) => o.id === n.id)!;
      // A box joined to only one other squares up to it, along its own row.
      const reach = n.id === "sdb" ? 200 : 120;
      expect(Math.hypot(n.x - was.x, n.y - was.y), n.id).toBeLessThan(reach);
    }
  });

  it("squares a box up to the one thing it hangs off, and leaves its row alone", () => {
    const after = polishLayout(rough());
    const at = (id: string) => after.nodes.find((n) => n.id === id)!;
    expect(at("sdb").x + at("sdb").w / 2).toBe(at("stock").x + at("stock").w / 2);
    expect(at("sdb").y).toBe(at("udb").y);
  });

  it("clears what the author got wrong", () => {
    const before = rough();
    expect(count(before, "box-overlap")).toBeGreaterThan(0);
    const after = polishLayout(before);
    expect(count(after, "box-overlap")).toBe(0);
    expect(count(after, "line-through-box")).toBe(0);
    expect(lintLayout(after).score).toBeGreaterThan(lintLayout(before).score);
  });

  it("never comes back measuring worse", () => {
    for (const [, make] of FIXTURES) {
      const placed = autoPlace(make());
      expect(lintLayout(polishLayout(placed)).cost).toBeLessThanOrEqual(lintLayout(placed).cost);
    }
  });

  it("settles: a second polish finds little left to move", () => {
    const once = polishLayout(rough());
    const twice = polishLayout(once);
    expect(lintLayout(twice).cost).toBeLessThanOrEqual(lintLayout(once).cost);
    for (const n of twice.nodes) {
      const was = once.nodes.find((o) => o.id === n.id)!;
      expect(Math.hypot(n.x - was.x, n.y - was.y), n.id).toBeLessThan(30);
    }
  });

  it("moves nothing locked", () => {
    const t = doc([service("a", { x: 0, y: 0, locked: true }), service("b", { x: 20, y: 10 })]);
    const after = polishLayout(t);
    expect(after.nodes.find((n) => n.id === "a")).toMatchObject({ x: 0, y: 0 });
    expect(count(after, "box-overlap")).toBe(0);
  });

  it("doesn't push a group aside when that would carry off a locked box inside it", () => {
    const t = doc([
      service("g", { kind: "group", x: 0, y: 0, w: 300, h: 220 }),
      service("held", { parentId: "g", locked: true, x: 40, y: 70 }),
      service("crowding", { x: 250, y: 60 }),
    ]);
    const after = polishLayout(t);
    const g = after.nodes.find((n) => n.id === "g")!;
    const held = after.nodes.find((n) => n.id === "held")!;
    expect([g.x + held.x, g.y + held.y]).toEqual([40, 70]);
    expect(count(after, "box-overlap")).toBe(0);
  });

  it("carries a zone's members with it when zones are pushed apart", () => {
    const t = doc(
      [service("m1", { zoneId: "a", x: 60, y: 80 }), service("m2", { zoneId: "b", x: 300, y: 80 })],
      [],
      { zones: [{ id: "a", label: "A", shape: "rect", x: 0, y: 0, w: 320, h: 240 }, { id: "b", label: "B", shape: "rect", x: 260, y: 0, w: 320, h: 240 }] },
    );
    const after = polishLayout(t);
    expect(count(after, "region-collision")).toBe(0);
    expect(count(after, "outside-container")).toBe(0);
  });

  it("keeps a hand-drawn route unless a box now sits on it", () => {
    const t = doc(
      [service("a", { x: 0, y: 0 }), service("b", { x: 400, y: 0 })],
      [line("a", "b", { points: [[300, -120]] })],
    );
    expect(polishLayout(t).edges[0]!.points).toEqual([[300, -120]]);
  });
});

describe("arrangeBest", () => {
  it("places what has no placement", () => {
    const t = ARRANGE_FIXTURES.webApp!();
    expect(hasPlacement(t)).toBe(false);
    expect(arrangeBest(t).source).toBe("placed");
  });

  it("keeps an author's arrangement that's any good, whatever shape it is", () => {
    const result = arrangeBest(ARRANGE_FIXTURES.roughlyPlaced!());
    expect(result.source).toBe("polished");
    // It read top to bottom, and it still does, though left to right would be shorter.
    const y = (id: string) => result.template.nodes.find((n) => n.id === id)!.y;
    expect(y("client")).toBeLessThan(y("api"));
  });

  it("gives up on one that's beyond polishing", () => {
    const t = doc(
      ["a", "b", "c", "d", "e", "f"].map((id, i) => service(id, { x: i * 3, y: i * 3 })),
      [line("a", "b"), line("b", "c"), line("c", "d"), line("d", "e"), line("e", "f")],
    );
    expect(arrangeBest(t).report.counts["box-overlap"] ?? 0).toBe(0);
  });

  it("leaves a clean arrangement exactly as it was", () => {
    const t = doc(
      [service("a", { x: 0, y: 0 }), service("b", { x: 300, y: 0 }), service("c", { x: 600, y: 0 })],
      [line("a", "b"), line("b", "c")],
    );
    const result = arrangeBest(t);
    expect(result.template.nodes.map((n) => [n.x, n.y])).toEqual([[0, 0], [300, 0], [600, 0]]);
  });
});

describe("layoutCandidates", () => {
  it("offers genuinely different arrangements: Best fit first, the rest by how they measure", () => {
    const candidates = layoutCandidates(ARRANGE_FIXTURES.gatewayHub!());
    expect(new Set(candidates.map((c) => c.id)).size).toBe(candidates.length);
    expect(candidates.length).toBeGreaterThan(2);
    expect(candidates[0]!.id).toBe("auto");
    for (let i = 2; i < candidates.length; i += 1) {
      expect(candidates[i]!.report.cost).toBeGreaterThanOrEqual(candidates[i - 1]!.report.cost);
    }
  });

  it("doesn't offer a data model a direction its row anchors can't use", () => {
    const ids = layoutCandidates(ARRANGE_FIXTURES.dataModel!()).map((c) => c.id);
    expect(ids).not.toContain("layered-down");
  });

  it("doesn't offer a work plan a direction Tidy would never give it", () => {
    const ids = layoutCandidates(ARRANGE_FIXTURES.taskPlan!()).map((c) => c.id);
    expect(ids).not.toContain("layered-down");
    expect(ids).not.toContain("tree-down");
  });
});

describe("arrangeSelection", () => {
  it("moves only what's selected, and keeps it where it was", () => {
    const t = doc(
      [service("a", { x: 1000, y: 1000 }), service("b", { x: 1010, y: 1010 }), service("c", { x: 1020, y: 1020 }), service("stay", { x: 0, y: 0 })],
      [line("a", "b"), line("b", "c"), line("a", "stay")],
    );
    const out = arrangeSelection(t, ["a", "b", "c"]);
    expect(out.nodes.find((n) => n.id === "stay")).toMatchObject({ x: 0, y: 0 });
    const a = out.nodes.find((n) => n.id === "a")!;
    expect(a.x).toBeGreaterThan(500);
    expect(a.y).toBeGreaterThan(500);
    expect(count(out, "box-overlap")).toBe(0);
  });

  it("does nothing with fewer than two boxes in one container", () => {
    const t = doc([service("a", { x: 5, y: 5 }), service("b", { x: 500, y: 5 })]);
    expect(arrangeSelection(t, ["a"])).toBe(t);
  });

  it("keeps what it arranges inside its group, which grows to hold it", () => {
    const t = doc(
      [
        service("g", { kind: "group", x: 100, y: 100, w: 440, h: 200 }),
        service("a", { parentId: "g", x: 32, y: 60 }),
        service("b", { parentId: "g", x: 232, y: 60 }),
        service("c", { parentId: "g", x: 132, y: 100 }),
      ],
      [line("a", "b"), line("b", "c")],
    );
    const out = arrangeSelection(t, ["a", "b", "c"]);
    const g = out.nodes.find((n) => n.id === "g")!;
    expect([g.x, g.y]).toEqual([100, 100]);
    for (const n of out.nodes.filter((k) => k.parentId === "g")) {
      expect(n.x, n.id).toBeGreaterThanOrEqual(0);
      expect(n.y, n.id).toBeGreaterThanOrEqual(0);
      expect(n.x + n.w, n.id).toBeLessThanOrEqual(g.w);
      expect(n.y + n.h, n.id).toBeLessThanOrEqual(g.h);
    }
    expect(count(out, "outside-container")).toBe(0);
  });

  it("arranges a zone's boxes within their zone, never into the one next door", () => {
    const zone = (id: string, x: number) => ({ id, label: id, shape: "rect", x, y: 0, w: 500, h: 400 });
    const t = doc(
      [
        service("a", { zoneId: "z1", x: 40, y: 80 }),
        service("a2", { zoneId: "z1", x: 60, y: 100 }),
        service("b", { zoneId: "z2", x: 840, y: 80 }),
        service("b2", { zoneId: "z2", x: 860, y: 100 }),
      ],
      [line("a", "b"), line("a", "a2"), line("b", "b2")],
      { zones: [zone("z1", 0), zone("z2", 800)] },
    );
    const out = arrangeSelection(t, ["a", "a2", "b", "b2"]);
    for (const n of out.nodes) {
      const z = out.zones!.find((zone) => zone.id === n.zoneId)!;
      expect(n.x, n.id).toBeGreaterThanOrEqual(z.x);
      expect(n.x + n.w, n.id).toBeLessThanOrEqual(z.x + z.w);
      expect(n.y, n.id).toBeGreaterThanOrEqual(z.y);
      expect(n.y + n.h, n.id).toBeLessThanOrEqual(z.y + z.h);
    }
    // The two that share a zone were still arranged: no longer one on the other.
    expect(count(out, "box-overlap")).toBe(0);
  });
});

describe("straightenLines", () => {
  it("runs a line dead straight along whichever axis it's nearer", () => {
    const t = doc([service("a", { x: 0, y: 0 }), service("b", { x: 400, y: 30 })], [line("a", "b")]);
    const out = straightenLines(t, ["a-b"]);
    expect(out.nodes.find((n) => n.id === "b")!.y).toBe(0);
    expect(out.nodes.find((n) => n.id === "b")!.x).toBe(400);
    const tall = doc([service("a", { x: 0, y: 0 }), service("b", { x: 30, y: 400 })], [line("a", "b")]);
    expect(straightenLines(tall, ["a-b"]).nodes.find((n) => n.id === "b")!.x).toBe(0);
  });

  it("won't land a box on a neighbour, or move a locked one", () => {
    const blocked = doc(
      [service("a", { x: 0, y: 0 }), service("b", { x: 400, y: 60 }), service("c", { x: 400, y: -40 })],
      [line("a", "b")],
    );
    expect(straightenLines(blocked, ["a-b"])).toBe(blocked);
    const locked = doc([service("a", { x: 0, y: 0 }), service("b", { x: 400, y: 30, locked: true })], [line("a", "b")]);
    const out = straightenLines(locked, ["a-b"]);
    expect(out.nodes.find((n) => n.id === "b")!.y).toBe(30);
    expect(out.nodes.find((n) => n.id === "a")!.y).toBe(30);
  });

  it("forgets the sides the last layout chose for what it moved, and keeps a person's", () => {
    const t = doc(
      [service("a", { x: 0, y: 0 }), service("b", { x: 400, y: 30 })],
      [line("a", "b", { start: { side: "right", auto: true }, end: { side: "top" } })],
    );
    const out = straightenLines(t, ["a-b"]);
    expect(out.edges[0]!.start).toBeUndefined();
    expect(out.edges[0]!.end).toEqual({ side: "top" });
  });
});

describe("a secondary line", () => {
  it("is drawn, but doesn't decide what comes after what", () => {
    const edges = [line("a", "b"), line("b", "c"), line("c", "a", { secondary: true })];
    const placed = autoPlace(doc([service("a"), service("b"), service("c")], edges), { direction: "right", algorithm: "layered" });
    const x = (id: string) => placed.nodes.find((n) => n.id === id)!.x;
    expect(x("a")).toBeLessThan(x("b"));
    expect(x("b")).toBeLessThan(x("c"));
    expect(placed.edges.find((e) => e.secondary)).toBeTruthy();
  });

  it("round-trips through validation, and only when it's true", () => {
    const t = doc([service("a"), service("b")], [line("a", "b", { secondary: true }), line("b", "a", { secondary: "yes" })]);
    expect(t.edges[0]!.secondary).toBe(true);
    expect(t.edges[1]!.secondary).toBeUndefined();
  });
});

describe("settings.layout", () => {
  it("keeps what it knows, and clamps a gap", () => {
    const t = doc([service("a")], [], {
      settings: { layout: { algorithm: "radial", direction: "up", inner: "left", shape: "tall", spacing: "airy", rankGap: 99999, nodeGap: 2, junk: true } },
    });
    expect(t.settings?.layout).toEqual({ algorithm: "radial", direction: "up", inner: "left", shape: "tall", spacing: "airy", rankGap: 480, nodeGap: 8 });
  });

  it("line ends spread by default, and bundle when asked", () => {
    const edges = [line("hub", "a"), line("hub", "b"), line("hub", "c")];
    const nodes = [service("hub"), service("a"), service("b"), service("c")];
    const fractions = (d: DiagramTemplate) => d.edges.map((e) => e.start?.t).filter((t) => t !== undefined);
    expect(fractions(autoPlace(doc(nodes, edges), { direction: "right", algorithm: "layered" })).length).toBe(3);
    const bundled = autoPlace(doc(nodes, edges, { settings: { layout: { ends: "bundled" } } }), { direction: "right", algorithm: "layered" });
    expect(fractions(bundled)).toEqual([]);
  });

  it("drops what it doesn't", () => {
    const t = doc([service("a")], [], { settings: { layout: { algorithm: "spiral", direction: "sideways" } } });
    expect(t.settings?.layout).toBeUndefined();
  });

  it("a gap beats spacing, and more room means more room", () => {
    const t = ARRANGE_FIXTURES.pipeline!();
    const width = (d: DiagramTemplate) => lintLayout(d).metrics.width;
    const at = (layout: Record<string, unknown>) => width(autoPlace(validateTemplate({ ...t, settings: { layout } }), { direction: "right" }));
    expect(at({ spacing: "airy" })).toBeGreaterThan(at({ spacing: "compact" }));
    expect(at({ spacing: "compact", rankGap: 300 })).toBeGreaterThan(at({ spacing: "airy" }));
  });

  it("an inner direction runs inside containers only", () => {
    const t = ARRANGE_FIXTURES.nestedGroups!();
    const placed = autoPlace(t, { direction: "right", inner: "down", algorithm: "layered" });
    const y = (id: string) => placed.nodes.find((n) => n.id === id)!.y;
    expect(y("web")).toBeLessThan(y("svc"));
  });
});

describe("how a ranked layout draws the lines that can't run straight", () => {
  const at = (t: DiagramTemplate, id: string) => t.nodes.find((n) => n.id === id)!;
  const stages = (n: number) => Array.from({ length: n }, (_, i) => service(`s${i}`));
  const chain = (n: number) => Array.from({ length: n - 1 }, (_, i) => line(`s${i}`, `s${i + 1}`));

  it("lines that skip ahead down a column go round as brackets on both sides of it, not as a pile on one", () => {
    const shortcuts = doc(stages(8), [...chain(8), line("s0", "s2"), line("s1", "s4"), line("s2", "s5"), line("s3", "s6"), line("s0", "s5"), line("s4", "s7")]);
    const placed = autoPlace(shortcuts, { direction: "down", algorithm: "layered" });
    const arcs = placed.edges.filter((e) => e.points?.length);
    expect(arcs).toHaveLength(6);
    expect(new Set(arcs.map((e) => e.start?.side))).toEqual(new Set(["left", "right"]));
    for (const arc of arcs) expect(arc.start?.side).toBe(arc.end?.side);
    // Three of the six spans interleave one another, so two crossings is the least any split can leave.
    expect(count(placed, "line-crossing")).toBeLessThanOrEqual(2);
    expect(count(placed, "line-overlap")).toBe(0);
    expect(count(placed, "close-lines")).toBe(0);
  });

  it("a line back against the flow goes round the outside, and two of them nest", () => {
    const loops = doc(stages(5), [...chain(5), line("s3", "s1"), line("s4", "s0")]);
    const placed = autoPlace(loops, { direction: "right", algorithm: "layered" });
    const inner = placed.edges.find((e) => e.id === "s3-s1")!;
    const outer = placed.edges.find((e) => e.id === "s4-s0")!;
    for (const arc of [inner, outer]) {
      expect(arc.start?.side).toBe(arc.end?.side);
      expect(arc.points?.length).toBeGreaterThan(0);
    }
    // On one side, the one that spans the other runs further out; on two sides, neither is in the other's way.
    if (inner.start!.side === outer.start!.side) {
      const out = (e: typeof inner) => Math.max(...e.points!.map(([, y]) => Math.abs(y - at(placed, "s0").y)));
      expect(out(outer)).toBeGreaterThan(out(inner));
    }
    expect(count(placed, "line-crossing")).toBe(0);
  });

  it("traffic both ways between neighbours is two lanes of one road", () => {
    const road = doc([service("client"), service("gateway")], [line("client", "gateway"), line("gateway", "client")]);
    const placed = autoPlace(road, { direction: "right", algorithm: "layered" });
    const answer = placed.edges.find((e) => e.id === "gateway-client")!;
    expect(answer.start).toMatchObject({ side: "left" });
    expect(answer.end).toMatchObject({ side: "right" });
    expect(answer.points).toBeUndefined();
    expect(count(placed, "line-overlap")).toBe(0);
  });

  it("a box that collects a fan sits in the middle of it, whether the fan is odd or even", () => {
    for (const size of [5, 6]) {
      const workers = Array.from({ length: size }, (_, i) => `w${i}`);
      const fan = doc(
        [service("router"), ...workers.map((id) => service(id)), service("collector")],
        [...workers.map((id) => line("router", id)), ...workers.map((id) => line(id, "collector"))],
      );
      const placed = autoPlace(fan, { direction: "right", algorithm: "layered" });
      const middle = workers.reduce((sum, id) => sum + at(placed, id).y, 0) / workers.length;
      expect(Math.abs(at(placed, "collector").y - middle)).toBeLessThanOrEqual(1);
      expect(Math.abs(at(placed, "router").y - middle)).toBeLessThanOrEqual(1);
    }
  });
});
