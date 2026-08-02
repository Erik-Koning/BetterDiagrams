/**
 * Tests for the sequence export formats — text fidelity and the image
 * emitter's palette-parameterized structure.
 */
import { describe, expect, it } from "vitest";
import { EXAMPLE_SEQUENCE, validateSequence } from "../contract/sequence";
import { emitSequence } from "./sequence-draw";
import { LIGHT_EXPORT_PALETTE } from "./draw";
import {
  renderSequenceToMermaid,
  renderSequenceToPlantUml,
  renderSequenceToSvg,
} from "./sequence-exporters";

const t = validateSequence(EXAMPLE_SEQUENCE);

describe("renderSequenceToMermaid", () => {
  const out = renderSequenceToMermaid(t);

  it("declares the diagram, autonumber, and participants in order", () => {
    expect(out).toMatch(/^sequenceDiagram/);
    expect(out).toContain("  autonumber");
    expect(out).toContain("actor user as Customer");
    expect(out).toContain("participant pay as Payment Gateway");
    // Participants appear before any message.
    expect(out.indexOf("actor user")).toBeLessThan(out.indexOf("user->>web"));
  });

  it("maps styles to arrows and carries tech in the label", () => {
    expect(out).toContain("user->>web: Place order");
    expect(out).toContain("api-)pay: Charge [gRPC]");
    expect(out).toContain("db-->>api: order id");
    // Self-message.
    expect(out).toContain("api->>api: Validate cart");
  });

  it("wraps fragments and activations around the right messages", () => {
    expect(out).toContain("loop retry ×3");
    expect(out).toContain("alt card valid");
    expect(out).toContain("else card declined");
    expect((out.match(/^ {2}end$/gm) ?? []).length).toBe(2);
    expect(out).toContain("activate api");
    expect(out).toContain("deactivate api");
    // The db activation closes right after its reply.
    const deactivateDb = out.indexOf("deactivate db");
    expect(deactivateDb).toBeGreaterThan(out.indexOf("db-->>api"));
  });

  it("emits notes beside their anchor", () => {
    expect(out).toContain("Note right of api: Idempotent by order id");
  });

  it("comments out lost/found messages Mermaid cannot express", () => {
    const lossy = renderSequenceToMermaid(
      validateSequence({
        participants: [{ id: "a", label: "A" }],
        messages: [{ id: "m", from: "a", to: null, label: "fire" }],
      }),
    );
    expect(lossy).toContain("%% lost: a -> ? : fire");
  });
});

describe("renderSequenceToPlantUml", () => {
  const out = renderSequenceToPlantUml(t);

  it("uses kind keywords and stereotypes", () => {
    expect(out).toMatch(/^@startuml/);
    expect(out.trimEnd()).toMatch(/@enduml$/);
    expect(out).toContain('actor "Customer" as user');
    expect(out).toContain('database "Orders DB" as db');
    expect(out).toContain('participant "Payment Gateway" as pay <<external>>');
    expect(out).toContain("title Order flow");
  });

  it("keeps full fidelity for lost/found messages", () => {
    const lossy = renderSequenceToPlantUml(
      validateSequence({
        participants: [{ id: "a", label: "A" }],
        messages: [
          { id: "m1", from: "a", to: null, label: "fire" },
          { id: "m2", from: null, to: "a", label: "webhook" },
        ],
      }),
    );
    expect(lossy).toContain("a ->] : fire");
    expect(lossy).toContain("[-> a : webhook");
  });

  it("emits fragments, activations, and notes", () => {
    expect(out).toContain("loop retry ×3");
    expect(out).toContain("alt card valid");
    expect(out).toContain("else card declined");
    expect(out).toContain("activate pay");
    expect(out).toContain("deactivate pay");
    expect(out).toContain("note right of api : Idempotent by order id");
  });
});

describe("emitSequence images", () => {
  it("renders the whole example to SVG with every element family", () => {
    const svg = renderSequenceToSvg(t);
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain("Customer");
    expect(svg).toContain("Place order");
    // Autonumbered labels.
    expect(svg).toContain("1. Place order");
    // Fragment operator tabs.
    expect(svg).toContain(">loop</text>");
    expect(svg).toContain(">alt</text>");
    // The note.
    expect(svg).toContain("Idempotent by order id");
  });

  it("includes every label and tag family: teams, tech, eyebrows, guards", () => {
    const svg = renderSequenceToSvg(
      validateSequence({ ...t, meta: { ...t.meta, versionTag: "v3" } }),
    );
    // Owning-team pills.
    expect(svg).toContain(">Frontend</text>");
    expect(svg).toContain(">Platform</text>");
    // Tech tags on messages.
    expect(svg).toContain("[gRPC]");
    expect(svg).toContain("[SQL]");
    // Kind eyebrows and the version tag.
    expect(svg).toContain("ACTOR");
    expect(svg).toContain("SERVICE");
    expect(svg).toContain(">v3</text>");
    // Fragment guard + branch labels.
    expect(svg).toContain("[card valid]");
    expect(svg).toContain("[card declined]");
  });

  it("grows the image bounds to contain notes beside the outer columns", () => {
    const withEdgeNotes = validateSequence({
      ...t,
      notes: [
        ...(t.notes ?? []),
        { id: "nl", text: "left of first", side: "left", participant: "user" },
        { id: "nr", text: "right of last", side: "right", participant: "pay" },
      ],
    });
    const e = emitSequence(withEdgeNotes);
    // Every drawn text lands inside the image after the origin translate.
    for (const cmd of e.cmds) {
      if (cmd.op === "text") {
        expect(cmd.x + e.originX).toBeGreaterThanOrEqual(0);
        expect(cmd.x + e.originX).toBeLessThanOrEqual(e.width);
      }
    }
    const svg = renderSequenceToSvg(withEdgeNotes);
    expect(svg).toContain("left of first");
    expect(svg).toContain("right of last");
  });

  it("changes only colours between palettes, never structure", () => {
    const dark = emitSequence(t);
    const light = emitSequence(t, LIGHT_EXPORT_PALETTE);
    expect(light.cmds.length).toBe(dark.cmds.length);
    expect(light.cmds.map((c) => c.op)).toEqual(dark.cmds.map((c) => c.op));
    expect(light.width).toBe(dark.width);
    const svg = renderSequenceToSvg(t, LIGHT_EXPORT_PALETTE);
    expect(svg).toContain('fill="#f8fafc"');
    expect(svg).not.toContain('fill="#0b1220"');
  });
});
