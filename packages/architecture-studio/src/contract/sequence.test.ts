/**
 * Tests for the sequence-diagram contract: repair rules, the id-anchored
 * span model, adapter totality, and the order-from-geometry pipeline.
 */
import { describe, expect, it } from "vitest";
import {
  EXAMPLE_SEQUENCE,
  buildSequencePrompt,
  fromSequenceFlow,
  migrateSequence,
  parseLlmSequence,
  sequenceFromTemplate,
  toSequenceFlow,
  validateSequence,
  type SequenceTemplate,
} from "./sequence";
import { validateTemplate } from "./schema";
import {
  FIRST_MSG_Y,
  ROW_HEIGHT,
  messageRowAt,
  orderByCoordinate,
  rowY,
  slotX,
} from "./sequence-layout";

const base = (over: Partial<SequenceTemplate> = {}): SequenceTemplate =>
  validateSequence({
    version: 1,
    participants: [
      { id: "a", label: "A", kind: "service" },
      { id: "b", label: "B", kind: "service" },
    ],
    messages: [
      { id: "m1", from: "a", to: "b", label: "one", style: "sync" },
      { id: "m2", from: "b", to: "a", label: "two", style: "reply" },
      { id: "m3", from: "a", to: "b", label: "three", style: "async" },
    ],
    ...over,
  });

describe("validateSequence — repair", () => {
  it("coerces unknown kinds and styles", () => {
    const t = validateSequence({
      participants: [{ id: "a", kind: "spaceship" }],
      messages: [{ id: "m", from: "a", to: "a", style: "smoke-signal" }],
    });
    expect(t.participants[0].kind).toBe("service");
    expect(t.messages[0].style).toBe("sync");
  });

  it("suffixes duplicate ids and invents missing ones", () => {
    const t = validateSequence({
      participants: [{ id: "a" }, { id: "a" }, {}],
      messages: [],
    });
    expect(t.participants.map((p) => p.id)).toEqual(["a", "a_2", "p3"]);
  });

  it("round-trips a validated document byte-identically", () => {
    const t = validateSequence(EXAMPLE_SEQUENCE);
    expect(JSON.stringify(validateSequence(JSON.parse(JSON.stringify(t))))).toBe(
      JSON.stringify(t),
    );
  });

  it("keeps self-messages and lost/found endpoints, drops both-null", () => {
    const t = validateSequence({
      participants: [{ id: "a" }],
      messages: [
        { id: "self", from: "a", to: "a", label: "tick" },
        { id: "lost", from: "a", to: null, label: "fire-and-forget" },
        { id: "found", from: null, to: "a", label: "webhook" },
        { id: "void", from: null, to: null, label: "meaningless" },
      ],
    });
    expect(t.messages.map((m) => m.id)).toEqual(["self", "lost", "found"]);
  });

  it("drops a message with a dangling endpoint, cascading to its activation", () => {
    const t = validateSequence({
      participants: [{ id: "a" }],
      messages: [{ id: "m", from: "a", to: "ghost" }],
      activations: [{ id: "act", participant: "a", from: "m" }],
    });
    expect(t.messages).toHaveLength(0);
    expect(t.activations).toBeUndefined();
  });

  it("strips the default status and keeps team/status like the architecture schema", () => {
    const t = validateSequence({
      participants: [
        { id: "a", team: " Core ", status: "deprecated" },
        { id: "b", status: "active" },
      ],
      messages: [],
    });
    expect(t.participants[0].team).toBe("Core");
    expect(t.participants[0].status).toBe("deprecated");
    expect("status" in t.participants[1]).toBe(false);
  });
});

describe("activation anchoring", () => {
  it("deleting the closing message degrades the bar to open-ended", () => {
    const t = base({
      activations: [{ id: "act", participant: "a", from: "m1", to: "ghost" }],
    });
    expect(t.activations![0].from).toBe("m1");
    expect("to" in t.activations![0]).toBe(false);
  });

  it("deleting the opening message drops the bar", () => {
    const t = base({ activations: [{ id: "act", participant: "a", from: "ghost", to: "m2" }] });
    expect(t.activations).toBeUndefined();
  });

  it("a closer before the opener is degraded away", () => {
    const t = base({ activations: [{ id: "act", participant: "a", from: "m3", to: "m1" }] });
    expect("to" in t.activations![0]).toBe(false);
  });
});

describe("fragment anchoring", () => {
  it("swaps reversed endpoints and drops out-of-span else markers", () => {
    const t = base({
      fragments: [
        {
          id: "f",
          kind: "alt",
          label: "ok",
          from: "m3",
          to: "m1",
          elses: [
            { label: "in", at: "m2" },
            { label: "out", at: "m1" }, // at === from after swap → not strictly inside
            { label: "gone", at: "ghost" },
          ],
        },
      ],
    });
    const f = t.fragments![0];
    expect([f.from, f.to]).toEqual(["m1", "m3"]);
    expect(f.elses).toEqual([{ label: "in", at: "m2" }]);
  });

  it("keeps at most one branch divider per row", () => {
    const t = base({
      fragments: [
        {
          id: "f",
          kind: "alt",
          label: "a",
          from: "m1",
          to: "m3",
          elses: [
            { label: "first", at: "m2" },
            { label: "duplicate", at: "m2" },
          ],
        },
      ],
    });
    expect(t.fragments![0].elses).toEqual([{ label: "first", at: "m2" }]);
  });

  it("drops the fragment when an endpoint is gone", () => {
    const t = base({ fragments: [{ id: "f", kind: "loop", label: "", from: "m1", to: "ghost" }] });
    expect(t.fragments).toBeUndefined();
  });

  it("a message inserted inside the span joins it (id-anchored range)", () => {
    const t = base({ fragments: [{ id: "f", kind: "loop", label: "", from: "m1", to: "m3" }] });
    const withInsert = validateSequence({
      ...t,
      messages: [
        t.messages[0],
        { id: "new", from: "a", to: "b", label: "inserted", style: "sync" },
        ...t.messages.slice(1),
      ],
    });
    // The span is (from..to) by index, so the inserted message is inside it.
    const idx = new Map(withInsert.messages.map((m, i) => [m.id, i]));
    expect(idx.get("new")!).toBeGreaterThan(idx.get("m1")!);
    expect(idx.get("new")!).toBeLessThan(idx.get("m3")!);
    expect(withInsert.fragments![0]).toMatchObject({ from: "m1", to: "m3" });
  });
});

describe("note anchoring", () => {
  it("defining participant gone drops the note; auxiliary anchors degrade", () => {
    const t = base({
      notes: [
        { id: "n1", text: "keep", side: "left", participant: "a", across: "ghost", at: "ghost" },
        { id: "n2", text: "drop", side: "right", participant: "ghost" },
      ],
    });
    expect(t.notes).toHaveLength(1);
    expect(t.notes![0].id).toBe("n1");
    expect("across" in t.notes![0]).toBe(false);
    expect("at" in t.notes![0]).toBe(false);
  });
});

describe("versioning", () => {
  it("a future version throws; a missing version is v1", () => {
    expect(() => migrateSequence({ version: 9 })).toThrow(/v9/);
    expect(validateSequence({ participants: [], messages: [] }).version).toBe(1);
  });
});

describe("adapters", () => {
  it("toSequenceFlow ∘ fromSequenceFlow is the identity on the full-feature example", () => {
    const t = validateSequence(EXAMPLE_SEQUENCE);
    const { nodes, edges } = toSequenceFlow(t);
    const back = fromSequenceFlow(nodes, edges, { meta: t.meta });
    expect(JSON.stringify(back)).toBe(JSON.stringify(t));
  });

  it("derives participant order from x and message order from y", () => {
    const t = base();
    const { nodes, edges } = toSequenceFlow(t);
    // Drag B left of A and message three above message one.
    const moved = nodes.map((n) =>
      n.id === "b" ? { ...n, position: { ...n.position, x: slotX(0) - 10 } } : n,
    );
    const rows = edges.map((e) =>
      e.id === "m3" ? { ...e, data: { ...e.data, y: FIRST_MSG_Y - 10 } } : e,
    );
    const back = fromSequenceFlow(moved, rows);
    expect(back.participants.map((p) => p.id)).toEqual(["b", "a"]);
    expect(back.messages.map((m) => m.id)).toEqual(["m3", "m1", "m2"]);
  });

  it("materializes lost/found messages with real node endpoints", () => {
    const t = validateSequence({
      participants: [{ id: "a" }],
      messages: [{ id: "lost", from: "a", to: null }],
    });
    const { edges } = toSequenceFlow(t);
    expect(edges[0].source).toBe("a");
    expect(edges[0].target).toBe("a");
    expect(edges[0].data.message.to).toBeNull();
  });
});

describe("sequenceFromTemplate", () => {
  const arch = validateTemplate({
    version: 1,
    meta: { title: "Checkout" },
    nodes: [
      { id: "u", label: "User", kind: "client", icon: "user", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
      { id: "api", label: "API", kind: "service", icon: "box", description: "Node", parentId: null, team: "Core", x: 300, y: 0, w: 170, h: 76 },
      { id: "db", label: "DB", kind: "database", icon: "database", description: "", parentId: null, status: "deprecated", x: 600, y: 0, w: 170, h: 76 },
      { id: "misc", label: "Misc", kind: "service", icon: "box", description: "", parentId: null, x: 900, y: 0, w: 170, h: 76 },
    ],
    edges: [
      // Deliberately out of order: seq decides, not array position.
      { id: "e2", source: "api", target: "db", label: "query", style: "solid", color: "amber", tech: "SQL", seq: 2, direction: "both" },
      { id: "e1", source: "u", target: "api", label: "request", style: "dashed", color: "slate", seq: 1 },
      { id: "e3", source: "api", target: "misc", label: "not in flow", style: "solid", color: "slate" },
    ],
  });

  it("builds the base sequence from the numbered flow, in seq order", () => {
    const seq = sequenceFromTemplate(arch);
    // Participants appear in first-use order; nodes outside the flow stay out.
    expect(seq.participants.map((p) => p.id)).toEqual(["u", "api", "db"]);
    expect(seq.messages.map((m) => m.id)).toEqual(["e1", "e2", "e2__reply"]);
    expect(seq.meta?.title).toBe("Checkout");
    expect(seq.meta?.autonumber).toBe(true);
  });

  it("maps kinds and carries team, status, and tech", () => {
    const seq = sequenceFromTemplate(arch);
    expect(seq.participants.find((p) => p.id === "u")!.kind).toBe("actor");
    expect(seq.participants.find((p) => p.id === "db")!.kind).toBe("database");
    expect(seq.participants.find((p) => p.id === "api")!.team).toBe("Core");
    expect(seq.participants.find((p) => p.id === "db")!.status).toBe("deprecated");
    const query = seq.messages.find((m) => m.id === "e2")!;
    expect(query.style).toBe("sync");
    expect(query.tech).toBe("SQL");
    // dashed → async; direction both → an extra dashed reply.
    expect(seq.messages.find((m) => m.id === "e1")!.style).toBe("async");
    expect(seq.messages.find((m) => m.id === "e2__reply")).toMatchObject({
      from: "db",
      to: "api",
      style: "reply",
    });
  });

  it("falls back to every edge in document order when nothing is numbered", () => {
    const plain = validateTemplate({
      ...arch,
      edges: arch.edges.map(({ seq: _seq, ...e }) => e),
    });
    const seq = sequenceFromTemplate(plain);
    expect(seq.messages.map((m) => m.id)).toEqual(["e2", "e2__reply", "e1", "e3"]);
    expect(seq.participants.map((p) => p.id)).toContain("misc");
  });
});

describe("sequence LLM contract", () => {
  it("buildSequencePrompt advertises the exact vocabulary", () => {
    const prompt = buildSequencePrompt();
    expect(prompt).toContain("actor|service|database|queue|external");
    expect(prompt).toContain("sync|async|reply");
    expect(prompt).toContain("loop|alt|opt|par|break");
    expect(prompt).toContain("left|right|over");
    expect(prompt).toContain("ARRAY ORDER is time");
  });

  it("parseLlmSequence strips fences and validates", () => {
    const t = parseLlmSequence(
      'Sure! Here it is:\n```json\n{"version":1,"participants":[{"id":"a","label":"A"}],"messages":[]}\n```',
    );
    expect(t.participants).toHaveLength(1);
    expect(() => parseLlmSequence("no json here")).toThrow(/No JSON/);
  });
});

describe("sequence layout", () => {
  it("rowY and messageRowAt are exact inverses at row centres", () => {
    for (const i of [0, 1, 5, 12]) expect(messageRowAt(rowY(i))).toBe(i);
    expect(messageRowAt(rowY(2) + ROW_HEIGHT / 2 - 1)).toBe(2);
  });

  it("orderByCoordinate is stable, hence idempotent", () => {
    const items = [
      { id: "x", c: 5 },
      { id: "y", c: 5 },
      { id: "z", c: 1 },
    ];
    const once = orderByCoordinate(items, (i) => i.c);
    const twice = orderByCoordinate(once, (i) => i.c);
    expect(once.map((i) => i.id)).toEqual(["z", "x", "y"]);
    expect(twice).toEqual(once);
  });
});
