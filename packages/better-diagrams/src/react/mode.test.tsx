/**
 * @vitest-environment jsdom
 *
 * The presentation mode: `mode="marketing"` is a restyle of the same
 * document, and `"technical"` (the default) must be pixel-for-pixel what
 * shipped before the prop existed — so the default adds nothing to the DOM
 * a host stylesheet could have matched on, and marketing changes only what
 * a stylesheet cannot (an icon's pixel size, a gradient def) plus the hooks
 * the stylesheet reads.
 */
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { SequenceStudio } from "./sequence/SequenceStudio";
import { ICON_SIZE } from "./nodes";
import {
  DEFAULT_STUDIO_MODE,
  STUDIO_MODES,
  modeClassName,
  modeLayoutOptions,
  resolveStudioMode,
} from "./theme";
import { autoLayout, validateTemplate, type DiagramTemplate } from "../contract";
import { validateSequence } from "../contract/sequence";
import { layoutIfUnpositioned, parseArchitectureText } from "./welcome-parse";

vi.mock("./JsonCodeEditor", () => ({
  JsonCodeEditor: () => <textarea aria-label="Diagram JSON" />,
}));

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

const doc: DiagramTemplate = validateTemplate({
  version: 1,
  nodes: [
    { id: "api", label: "API", kind: "service", icon: "server", status: "planned", x: 0, y: 0 },
    { id: "db", label: "Store", kind: "database", icon: "database", x: 300, y: 0 },
    { id: "who", label: "Customer", kind: "client", icon: "user", x: 600, y: 0 },
  ],
  edges: [{ id: "e1", source: "api", target: "db", label: "reads", tech: "SQL" }],
});

describe("resolveStudioMode", () => {
  it("defaults to technical and accepts only the two modes", () => {
    expect(DEFAULT_STUDIO_MODE).toBe("technical");
    expect(STUDIO_MODES).toEqual(["technical", "marketing"]);
    expect(resolveStudioMode(undefined)).toBe("technical");
    expect(resolveStudioMode("marketing")).toBe("marketing");
    expect(resolveStudioMode("technical")).toBe("technical");
    // A typo or a future value never half-applies a look.
    expect(resolveStudioMode("Marketing")).toBe("technical");
    expect(resolveStudioMode("glossy")).toBe("technical");
    expect(resolveStudioMode(42)).toBe("technical");
  });

  it("technical adds no root class; marketing adds exactly one", () => {
    expect(modeClassName(undefined)).toBe("");
    expect(modeClassName("technical")).toBe("");
    expect(modeClassName("marketing")).toBe("as-root--marketing");
  });

  it("marketing spreads the auto-layout wider; technical passes nothing", () => {
    expect(modeLayoutOptions("technical")).toEqual({});
    expect(modeLayoutOptions(undefined)).toEqual({});
    const wide = modeLayoutOptions("marketing");
    expect(wide.rankGap).toBeGreaterThan(90);
    expect(wide.nodeGap).toBeGreaterThan(28);

    // The gaps are real: the same document tidied in marketing mode lands
    // its second rank further right than the technical tidy does.
    const dense = autoLayout(doc);
    const spread = autoLayout(doc, wide);
    const right = (t: DiagramTemplate, id: string) => t.nodes.find((n) => n.id === id)!.x!;
    expect(right(spread, "db") - right(spread, "api")).toBeGreaterThan(
      right(dense, "db") - right(dense, "api"),
    );
  });
});

/** A CONTENT doc: nothing placed, so every door lays it out. */
const content = {
  version: 1,
  nodes: [
    { id: "api", label: "API", kind: "service" },
    { id: "db", label: "Store", kind: "database" },
    { id: "who", label: "Customer", kind: "client" },
  ],
  edges: [
    { id: "e1", source: "api", target: "db" },
    { id: "e2", source: "who", target: "api" },
  ],
} as unknown as DiagramTemplate;

const xOf = (t: DiagramTemplate, id: string) => t.nodes.find((n) => n.id === id)!.x!;
const rankSpan = (t: DiagramTemplate) => xOf(t, "db") - xOf(t, "who");

describe("the doors lay out at the mode's spacing", () => {
  it("layoutIfUnpositioned and the welcome parser take the gaps", () => {
    const wide = modeLayoutOptions("marketing");
    const dense = layoutIfUnpositioned(validateTemplate(content));
    const spread = layoutIfUnpositioned(validateTemplate(content), wide);
    expect(rankSpan(spread)).toBeGreaterThan(rankSpan(dense));
    // A placed document is untouched either way.
    expect(layoutIfUnpositioned(doc, wide)).toBe(doc);

    const parsedDense = parseArchitectureText(JSON.stringify(content));
    const parsedSpread = parseArchitectureText(JSON.stringify(content), {}, wide);
    expect(rankSpan(parsedSpread)).toBeGreaterThan(rankSpan(parsedDense));
  });

  it("a content doc mounts further apart in marketing mode than in technical", () => {
    const x = (container: HTMLElement, id: string) => {
      const el = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!;
      return Number(/translate\((-?[\d.]+)px/.exec(el.style.transform)![1]);
    };
    const tech = mount(<ArchitectureStudio defaultValue={content} welcome={false} />).container;
    const mk = mount(<ArchitectureStudio defaultValue={content} mode="marketing" welcome={false} />).container;
    const span = (c: HTMLElement) => x(c, "db") - x(c, "who");
    expect(span(mk)).toBeGreaterThan(span(tech));
  });
});

describe("ArchitectureStudio mode", () => {
  it("renders technical by default with no mode class on the root", () => {
    const { container } = mount(<ArchitectureStudio value={doc} welcome={false} />);
    const root = container.querySelector(".as-root")!;
    expect(root.classList.contains("as-root--marketing")).toBe(false);
    expect(root.getAttribute("data-mode")).toBe("technical");
    // Icons keep their 17px glyph.
    const icon = container.querySelector(".as-node__iconbox svg")!;
    expect(icon.getAttribute("width")).toBe(String(ICON_SIZE.technical));
    // The kind eyebrow still spells the kind out.
    expect(container.querySelector(".as-node__kindname")!.textContent).toBe("Service");
  });

  it("marketing flags the root and grows the icon glyph, changing nothing else in the document", () => {
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio value={doc} onChange={onChange} mode="marketing" welcome={false} />,
    );
    const root = container.querySelector(".as-root")!;
    expect(root.classList.contains("as-root--marketing")).toBe(true);
    expect(root.getAttribute("data-mode")).toBe("marketing");
    const icon = container.querySelector(".as-node__iconbox svg")!;
    expect(icon.getAttribute("width")).toBe(String(ICON_SIZE.marketing));
    expect(ICON_SIZE.marketing).toBeGreaterThan(ICON_SIZE.technical);

    // Everything is still IN the DOM — the stylesheet decides what shows, so
    // the inspector, exports, and a host that reads the DOM see it all.
    expect(container.querySelector(".as-node__kindname")!.textContent).toBe("Service");
    expect(container.querySelector(".as-node__status")!.textContent).toContain("planned");
    expect(container.querySelector(".as-node__statussep")).not.toBeNull();
    // The cylinder silhouette carries its gradient def, referenced by a
    // per-node id so two shaped nodes never share one.
    const grad = container.querySelector(".as-node__silhouette-grad")!;
    expect(grad.getAttribute("fill")).toMatch(/^url\(#as-grad-/);
    expect(container.querySelector(`#${grad.getAttribute("fill")!.slice(5, -1)}`)).not.toBeNull();
    // A restyle never edits the document.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("an unknown mode string renders as technical", () => {
    const { container } = mount(
      // @ts-expect-error — a host threading a raw string through
      <ArchitectureStudio value={doc} mode="shiny" welcome={false} />,
    );
    const root = container.querySelector(".as-root")!;
    expect(root.classList.contains("as-root--marketing")).toBe(false);
    expect(root.getAttribute("data-mode")).toBe("technical");
  });

  it("keeps a host className alongside the mode class", () => {
    const { container } = mount(
      <ArchitectureStudio value={doc} mode="marketing" className="host" welcome={false} />,
    );
    const root = container.querySelector(".as-root")!;
    expect(root.className).toBe("as-root as-root--marketing host");
  });
});

describe("SequenceStudio mode", () => {
  const seq = validateSequence({
    version: 1,
    participants: [{ id: "a", label: "App", kind: "service" }],
    messages: [],
  });

  it("takes the same prop and flags the root the same way", () => {
    const { container } = mount(<SequenceStudio value={seq} mode="marketing" welcome={false} />);
    const root = container.querySelector(".as-root")!;
    expect(root.classList.contains("as-root--marketing")).toBe(true);
    expect(root.getAttribute("data-mode")).toBe("marketing");
  });

  it("defaults to technical", () => {
    const { container } = mount(<SequenceStudio value={seq} welcome={false} />);
    const root = container.querySelector(".as-root")!;
    expect(root.classList.contains("as-root--marketing")).toBe(false);
    expect(root.getAttribute("data-mode")).toBe("technical");
  });
});
