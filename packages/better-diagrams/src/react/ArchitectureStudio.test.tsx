/**
 * @vitest-environment jsdom
 *
 * Component smoke tests.
 *
 * These mount the real component with React Flow inside jsdom. They are not a
 * substitute for using it, but they do prove the thing renders, honours its
 * props, and wires the registry through to the UI — which the type checker and
 * the pure-logic tests cannot tell us.
 */
import { StrictMode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { clearWelcomeSuppression } from "./WelcomeModal";

// The welcome modal's CodeMirror editor is stubbed with a textarea — typing
// into a real EditorView is unreliable in jsdom, and its own mounting is
// covered by JsonCodeEditor.test.tsx.
vi.mock("./JsonCodeEditor", () => ({
  JsonCodeEditor: ({
    value,
    onChange,
    placeholder,
    ariaLabel,
  }: {
    value: string;
    onChange: (text: string) => void;
    placeholder?: string;
    ariaLabel?: string;
  }) => (
    <textarea
      aria-label={ariaLabel ?? "Diagram JSON"}
      placeholder={placeholder}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
import { LIGHT_THEME, paletteFromTheme } from "./theme";
import { copyFragment } from "../contract/clipboard";
import { PRESENTATION_FORMAT, splitTemplate } from "../contract/presentation";
import {
  EXAMPLE_TEMPLATE,
  EXAMPLE_ZONED_TEMPLATE,
  validateTemplate,
  type DiagramTemplate,
} from "../contract/schema";

/** The component fills its parent, so give it a real box in the test DOM. */
function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), {
      style: "width: 1200px; height: 800px",
    }),
  });
}

/** Toolbar actions live in dropdowns — open the menu, then click the entry. */
async function fromMenu(
  user: ReturnType<typeof userEvent.setup>,
  menu: string | RegExp,
  item: string | RegExp,
) {
  await user.click(screen.getByRole("button", { name: menu }));
  await user.click(screen.getByRole("menuitem", { name: item }));
}

describe("ArchitectureStudio", () => {
  it("mounts and renders the toolbar", () => {
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);
    expect(screen.getByText("arch·studio")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Insert ▾" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Arrange ▾" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export ▾" })).toBeInTheDocument();
  });

  it("opens one toolbar menu at a time and closes on outside click", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);

    await user.click(screen.getByRole("button", { name: "Insert ▾" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // Opening another menu replaces the first — never two at once.
    await user.click(screen.getByRole("button", { name: "Arrange ▾" }));
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: /^Tidy / })).toBeInTheDocument();

    // A click anywhere outside closes it.
    await user.click(screen.getByText("arch·studio"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("renders the diagram's nodes", () => {
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);
    expect(screen.getByText("REST API")).toBeInTheDocument();
    expect(screen.getByText("Postgres")).toBeInTheDocument();
    // The container node renders its label chip.
    expect(screen.getByText("Application VPC")).toBeInTheDocument();
    // The annotation renders as bare text.
    expect(screen.getByText(/Tenant isolation enforced/)).toBeInTheDocument();
  });

  it("renders an empty diagram without crashing", () => {
    mount(<ArchitectureStudio defaultValue={{ version: 1, nodes: [], edges: [] }} />);
    expect(screen.getByText("arch·studio")).toBeInTheDocument();
    // A brand-new document also greets with the welcome modal.
    expect(screen.getByRole("dialog", { name: "Get started" })).toBeInTheDocument();
  });

  it("hides editing affordances in readOnly mode", () => {
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} readOnly />);
    expect(screen.queryByRole("button", { name: "Insert ▾" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Import" })).not.toBeInTheDocument();
    // Export stays available — read-only should still be exportable.
    expect(screen.getByRole("button", { name: "Export ▾" })).toBeInTheDocument();
  });

  it("omits the AI panel entirely when no generator is supplied", () => {
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);
    expect(screen.queryByRole("button", { name: /AI/ })).not.toBeInTheDocument();
  });

  it("shows the AI panel when a generator is supplied", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} generate={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /AI/ }));
    expect(screen.getByText("Generate architecture")).toBeInTheDocument();
  });

  it("shows a Save button only when onSave is provided", () => {
    const { unmount } = mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    unmount();

    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("calls onSave with the current template", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onSave={onSave} />);

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledTimes(1);

    const saved = onSave.mock.calls[0][0] as DiagramTemplate;
    expect(saved.version).toBe(1);
    expect(saved.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length);
    expect(saved.meta).toEqual(EXAMPLE_TEMPLATE.meta);
  });

  it("emits onChange when a node is added", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    await fromMenu(user, "Insert ▾", /^Node /);

    expect(onChange).toHaveBeenCalled();
    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length + 1);
  });

  it("lists registry-contributed exporters in the export menu", async () => {
    const user = userEvent.setup();
    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        registry={{
          exporters: {
            terraform: { label: "Terraform", hint: "HCL", run: () => undefined },
            pdf: null,
          },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Export ▾" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Terraform")).toBeInTheDocument();
    expect(within(menu).getByText("PNG image")).toBeInTheDocument();
    // Removed via `pdf: null`.
    expect(within(menu).queryByText("PDF document")).not.toBeInTheDocument();
  });

  it("runs a custom exporter with the live template", async () => {
    const user = userEvent.setup();
    const run = vi.fn().mockReturnValue(undefined);
    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        registry={{ exporters: { custom: { label: "Custom", run } } }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Export ▾" }));
    await user.click(screen.getByText("Custom"));

    expect(run).toHaveBeenCalledTimes(1);
    const ctx = run.mock.calls[0][0];
    expect(ctx.template.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length);
    expect(ctx.filename).toBe("architecture");
    expect(ctx.registry.nodeKinds.service.label).toBe("Service");
  });

  it("renders a registry-contributed node kind with its own colours", () => {
    mount(
      <ArchitectureStudio
        registry={{
          nodeKinds: { lambda: { label: "Lambda", accent: "#fb923c", icon: "bolt" } },
        }}
        defaultValue={{
          version: 1,
          nodes: [
            {
              id: "fn",
              label: "Thumbnailer",
              kind: "lambda",
              icon: "bolt",
              description: "",
              parentId: null,
              x: 0,
              y: 0,
              w: 170,
              h: 76,
            },
          ],
          edges: [],
        }}
      />,
    );
    expect(screen.getByText("Thumbnailer")).toBeInTheDocument();
    // The kind's label renders as the small-caps eyebrow on the node.
    expect(screen.getByText("Lambda")).toBeInTheDocument();
  });

  it("applies theme tokens as CSS custom properties", () => {
    const { container } = mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} theme={{ accent: "#ff0000" }} />,
    );
    const root = container.querySelector(".as-root") as HTMLElement;
    expect(root.style.getPropertyValue("--as-accent")).toBe("#ff0000");
  });

  it("LIGHT_THEME overrides every token and derives a light export palette", () => {
    const { container } = mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} theme={LIGHT_THEME} />,
    );
    const root = container.querySelector(".as-root") as HTMLElement;
    expect(root.style.getPropertyValue("--as-bg")).toBe("#f8fafc");
    expect(root.style.getPropertyValue("--as-text")).toBe("#0f172a");
    expect(root.style.getPropertyValue("--as-accent-ink")).toBe("#ffffff");

    // Exports must follow the screen: the derived palette flips the same way.
    const palette = paletteFromTheme(LIGHT_THEME)!;
    expect(palette.bg).toBe("#f8fafc");
    expect(palette.accentInk).toBe("#ffffff");
    // The exporters' third text tier falls back to the theme's dim text.
    expect(palette.textFaint).toBe(LIGHT_THEME.textDim);
  });

  it("adopts an externally changed `value` in controlled mode", () => {
    const { rerender } = mount(<ArchitectureStudio value={EXAMPLE_TEMPLATE} onChange={vi.fn()} />);
    expect(screen.getByText("REST API")).toBeInTheDocument();

    rerender(
      <ArchitectureStudio
        value={{
          version: 1,
          nodes: [
            {
              id: "solo",
              label: "Replaced Service",
              kind: "service",
              icon: "box",
              description: "",
              parentId: null,
              x: 0,
              y: 0,
              w: 170,
              h: 76,
            },
          ],
          edges: [],
        }}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Replaced Service")).toBeInTheDocument();
    expect(screen.queryByText("REST API")).not.toBeInTheDocument();
  });

  it("does not re-render from the echo of its own onChange", async () => {
    // A controlled parent that mirrors onChange straight back into value is the
    // most common integration shape; it must not cause a feedback loop.
    const user = userEvent.setup();
    let current: DiagramTemplate = EXAMPLE_TEMPLATE;
    const onChange = vi.fn((next: DiagramTemplate) => {
      current = next;
    });

    const { rerender } = mount(<ArchitectureStudio value={current} onChange={onChange} />);
    await fromMenu(user, "Insert ▾", /^Node /);
    rerender(<ArchitectureStudio value={current} onChange={onChange} />);

    expect(current.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length + 1);
    // The echoed value must not have reset the editor back to the old document.
    expect(onChange.mock.calls.at(-1)![0].nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length + 1);
  });

  it("enables undo only after an edit, and reverts it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toBeDisabled();

    await fromMenu(user, "Insert ▾", /^Node /);
    expect(undo).toBeEnabled();

    await user.click(undo);
    const afterUndo = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(afterUndo.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length);
  });

  // ── Infra zones ───────────────────────────────────────────────────────────

  it("renders zones with their labels and provider toggles", () => {
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);
    expect(screen.getByText("Cloud Region")).toBeInTheDocument();
    expect(screen.getByText("Stripe")).toBeInTheDocument();
    // Three-way segmented toggle on the region.
    const toggle = screen.getByRole("group", { name: "Cloud Region provider" });
    expect(within(toggle).getByRole("button", { name: "Azure" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(toggle).getByRole("button", { name: "AWS" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("shows only the provider-matching node for the active selection", () => {
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);
    expect(screen.getByText("Azure SQL")).toBeInTheDocument();
    expect(screen.queryByText("Amazon RDS")).not.toBeInTheDocument();
    expect(screen.queryByText("Cloud SQL")).not.toBeInTheDocument();
  });

  it("swaps the visible nodes when the zone toggle is switched", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);

    const toggle = screen.getByRole("group", { name: "Cloud Region provider" });
    await user.click(within(toggle).getByRole("button", { name: "AWS" }));

    expect(screen.getByText("Amazon RDS")).toBeInTheDocument();
    expect(screen.queryByText("Azure SQL")).not.toBeInTheDocument();
    // Redis exists on azure and aws, so it survives the switch.
    expect(screen.getByText("Redis")).toBeInTheDocument();
    // The SaaS island has its own provider and is untouched.
    expect(screen.getByText("Payments")).toBeInTheDocument();
  });

  it("tints the deployment toast with the provider's colour", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);

    await user.selectOptions(screen.getByLabelText("Scenario"), "aws");

    // Tinted like the subject — the same plumbing colours the
    // "Now on <zone>" toast when a dragged node lands in a zone.
    const toast = screen.getByText("Showing the AWS deployment");
    expect(toast).toHaveClass("as-toast--tinted");
    expect(toast.style.getPropertyValue("--as-toast-color")).toBe("#ff9900");
  });

  it("hides a node absent from the newly selected provider", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);

    const toggle = screen.getByRole("group", { name: "Cloud Region provider" });
    await user.click(within(toggle).getByRole("button", { name: "GCP" }));

    expect(screen.getByText("Cloud SQL")).toBeInTheDocument();
    // No managed Redis in the GCP build.
    expect(screen.queryByText("Redis")).not.toBeInTheDocument();
  });

  it("never loses hidden nodes across a toggle round-trip", async () => {
    // The data-loss guard, end to end through the component: React Flow only
    // ever holds the visible subset, so a naive derivation would delete the
    // others on the first edit after a switch.
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} onChange={onChange} />);

    const toggle = screen.getByRole("group", { name: "Cloud Region provider" });
    await user.click(within(toggle).getByRole("button", { name: "AWS" }));
    await user.click(within(toggle).getByRole("button", { name: "GCP" }));
    await user.click(within(toggle).getByRole("button", { name: "Azure" }));

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length);
    expect(latest.edges).toHaveLength(EXAMPLE_ZONED_TEMPLATE.edges.length);
    for (const id of ["sql-az", "sql-aws", "sql-gcp", "cache"]) {
      expect(latest.nodes.find((n) => n.id === id), `${id} survived`).toBeTruthy();
    }
  });

  it("renders the infra legend with one row per provider on show", () => {
    const { container } = mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);
    // Scope to the legend — the provider names also appear on the zone toggles.
    const legend = container.querySelector(".as-legend") as HTMLElement;
    expect(legend).toBeTruthy();
    expect(within(legend).getByText("Infrastructure")).toBeInTheDocument();
    // Azure (the region) and SaaS (the island) are both on show.
    expect(within(legend).getByText("Azure")).toBeInTheDocument();
    expect(within(legend).getByText("SaaS")).toBeInTheDocument();
    // AWS and GCP are offered but not active, so they are not in the legend.
    expect(within(legend).queryByText("AWS")).not.toBeInTheDocument();
  });

  it("omits the legend when the diagram has no zones", () => {
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);
    expect(screen.queryByText("Infrastructure")).not.toBeInTheDocument();
  });

  it("drives every capable zone from the global scenario control", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} onChange={onChange} />);

    await user.selectOptions(screen.getByRole("combobox", { name: /scenario/i }), "aws");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.zones!.find((z) => z.id === "region")!.provider).toBe("aws");
    // The SaaS island cannot be AWS, so it keeps its own provider.
    expect(latest.zones!.find((z) => z.id === "vendor")!.provider).toBe("saas");
    expect(screen.getByText("Amazon RDS")).toBeInTheDocument();
  });

  it("adds a zone offering every registered provider", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    await fromMenu(user, "Insert ▾", /^Zone /);

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.zones).toHaveLength(1);
    expect(latest.zones![0].providers.length).toBeGreaterThan(1);
    expect(screen.getByText("New Zone")).toBeInTheDocument();
  });

  it("uses registry-contributed providers for zones", () => {
    mount(
      <ArchitectureStudio
        registry={{ providers: { fly: { label: "Fly.io", color: "#8b5cf6" } } }}
        defaultValue={{
          version: 1,
          zones: [
            {
              id: "z",
              label: "Edge",
              shape: "rounded",
              x: 0,
              y: 0,
              w: 400,
              h: 300,
              providers: ["fly", "aws"],
              provider: "fly",
            },
          ],
          nodes: [],
          edges: [],
        }}
      />,
    );
    const toggle = screen.getByRole("group", { name: "Edge provider" });
    expect(within(toggle).getByRole("button", { name: "Fly.io" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("hides zone toggles in readOnly mode", () => {
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} readOnly />);
    const toggle = screen.getByRole("group", { name: "Cloud Region provider" });
    expect(within(toggle).getByRole("button", { name: "AWS" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Insert ▾" })).not.toBeInTheDocument();
  });

  // ── The example app's exact wiring: StrictMode + controlled ───────────────
  //
  // StrictMode double-invokes render in development. Any render-phase side
  // effect — like advancing the derivation base inside a useMemo — runs twice,
  // and the second pass sees state the first pass already moved. The app
  // shipped in StrictMode while these tests didn't, which is how a
  // provider-toggle data-loss bug passed 172 tests and then reproduced in the
  // browser within a minute. These tests exist so that can't happen again.

  function ControlledHost({
    spy,
    initial,
  }: {
    spy: (t: DiagramTemplate) => void;
    initial: DiagramTemplate;
  }) {
    const [template, setTemplate] = useState(initial);
    spy(template);
    return (
      <ArchitectureStudio
        value={template}
        onChange={(next) => {
          setTemplate(next);
        }}
      />
    );
  }

  it("survives a provider toggle in StrictMode + controlled mode", async () => {
    const user = userEvent.setup();
    const seen: DiagramTemplate[] = [];
    mount(
      <StrictMode>
        <ControlledHost spy={(t) => seen.push(t)} initial={EXAMPLE_ZONED_TEMPLATE} />
      </StrictMode>,
    );

    const toggle = screen.getByRole("group", { name: "Cloud Region provider" });
    await user.click(within(toggle).getByRole("button", { name: "AWS" }));

    // The AWS node must APPEAR — under the bug it was deleted before the
    // rebuild could reveal it, so the toggle only ever removed things.
    expect(screen.getByText("Amazon RDS")).toBeInTheDocument();
    expect(screen.queryByText("Azure SQL")).not.toBeInTheDocument();
    const afterAws = seen.at(-1)!;
    expect(afterAws.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length);
  });

  it("returns components when toggling away and back, in StrictMode + controlled mode", async () => {
    const user = userEvent.setup();
    const seen: DiagramTemplate[] = [];
    mount(
      <StrictMode>
        <ControlledHost spy={(t) => seen.push(t)} initial={EXAMPLE_ZONED_TEMPLATE} />
      </StrictMode>,
    );

    const toggle = screen.getByRole("group", { name: "Cloud Region provider" });
    await user.click(within(toggle).getByRole("button", { name: "AWS" }));
    await user.click(within(toggle).getByRole("button", { name: "GCP" }));
    await user.click(within(toggle).getByRole("button", { name: "Azure" }));

    // The reported symptom: components never came back.
    expect(screen.getByText("Azure SQL")).toBeInTheDocument();
    expect(screen.getByText("Redis")).toBeInTheDocument();

    const finalT = seen.at(-1)!;
    expect(finalT.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length);
    for (const id of ["sql-az", "sql-aws", "sql-gcp", "cache"]) {
      expect(finalT.nodes.find((n) => n.id === id), `${id} survived`).toBeTruthy();
    }
  });

  it("keeps ordinary edits working in StrictMode + controlled mode", async () => {
    const user = userEvent.setup();
    const seen: DiagramTemplate[] = [];
    mount(
      <StrictMode>
        <ControlledHost spy={(t) => seen.push(t)} initial={EXAMPLE_ZONED_TEMPLATE} />
      </StrictMode>,
    );

    await fromMenu(user, "Insert ▾", /^Node /);
    expect(seen.at(-1)!.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length + 1);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(seen.at(-1)!.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length);
  });

  it("undoes a provider toggle without losing nodes, in StrictMode + controlled mode", async () => {
    const user = userEvent.setup();
    const seen: DiagramTemplate[] = [];
    mount(
      <StrictMode>
        <ControlledHost spy={(t) => seen.push(t)} initial={EXAMPLE_ZONED_TEMPLATE} />
      </StrictMode>,
    );

    const toggle = screen.getByRole("group", { name: "Cloud Region provider" });
    await user.click(within(toggle).getByRole("button", { name: "AWS" }));
    await user.click(screen.getByRole("button", { name: "Undo" }));

    const finalT = seen.at(-1)!;
    expect(finalT.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length);
    expect(finalT.zones!.find((z) => z.id === "region")!.provider).toBe("azure");
    expect(screen.getByText("Azure SQL")).toBeInTheDocument();
  });

  // ── The newest toolbar wiring ─────────────────────────────────────────────

  it("tidies overlapping nodes into distinct positions", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const stacked: DiagramTemplate = {
      version: 1,
      nodes: ["a", "b", "c"].map((id) => ({
        id,
        label: id.toUpperCase(),
        kind: "service",
        icon: "box",
        description: "",
        parentId: null,
        x: 0,
        y: 0,
        w: 170,
        h: 76,
      })),
      edges: [
        { id: "e1", source: "a", target: "b", label: "", style: "solid", color: "slate" },
        { id: "e2", source: "b", target: "c", label: "", style: "solid", color: "slate" },
      ],
    };
    mount(<ArchitectureStudio defaultValue={stacked} onChange={onChange} />);

    await fromMenu(user, "Arrange ▾", /^Tidy /);

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const xs = latest.nodes.map((n) => n.x);
    expect(new Set(xs).size, "each node got its own column").toBe(3);
  });

  it("offers Show hidden only when something is hidden, and reveals ghosts", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);

    // Two of the three databases are hidden under Azure.
    await user.click(screen.getByRole("button", { name: /^View/ }));
    const toggle = screen.getByRole("checkbox", { name: /Show hidden nodes/ });
    expect(toggle).toBeInTheDocument();
    expect(screen.queryByText("Amazon RDS")).not.toBeInTheDocument();

    await user.click(toggle);

    expect(screen.getByText("Amazon RDS")).toBeInTheDocument();
    expect(screen.getByText("Cloud SQL")).toBeInTheDocument();
    // Ghosts are visually distinguished, and the shown one is not a ghost.
    expect(container.querySelectorAll(".as-ghost").length).toBeGreaterThan(0);
    expect(screen.getByText("Azure SQL").closest(".as-ghost")).toBeNull();
  });

  it("has no Show hidden control when nothing is hidden", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);
    await user.click(screen.getByRole("button", { name: /^View/ }));
    expect(screen.queryByRole("checkbox", { name: /Show hidden nodes/ })).not.toBeInTheDocument();
  });

  it("keeps a ghosted node deletable rather than resurrecting it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /^View/ }));
    await user.click(screen.getByRole("checkbox", { name: /Show hidden nodes/ }));
    fireEvent.click(screen.getByText("Amazon RDS"));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "sql-aws")).toBeUndefined();
    // And nothing else went with it.
    expect(latest.nodes).toHaveLength(EXAMPLE_ZONED_TEMPLATE.nodes.length - 1);
  });

  it("duplicates the selection with ⌘D, carrying direct connections", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    await user.keyboard("{Meta>}d{/Meta}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length + 1);
    // The copy is a distinct node, offset from the original.
    const copies = latest.nodes.filter((n) => n.label === "Postgres");
    expect(copies).toHaveLength(2);
    expect(copies[0].x).not.toBe(copies[1].x);

    // Postgres has two incoming lines (api→db, wrk→db); the clone gets both,
    // attached to the same neighbours.
    const clone = copies.find((n) => n.id !== "db")!;
    const mirrored = latest.edges.filter((e) => e.source === clone.id || e.target === clone.id);
    expect(mirrored.map((e) => e.source).sort()).toEqual(["api", "wrk"]);
  });

  it("duplicates from the inspector's ⧉ button with connections", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    await user.click(screen.getByRole("button", { name: "Duplicate with connections" }));

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const clone = latest.nodes.find((n) => n.label === "Postgres" && n.id !== "db")!;
    expect(clone).toBeTruthy();
    expect(
      latest.edges.filter((e) => e.source === clone.id || e.target === clone.id),
    ).toHaveLength(2);
  });

  it("copy-paste of a single node does not bring its lines", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    await user.keyboard("{Meta>}c{/Meta}");
    await user.keyboard("{Meta>}v{/Meta}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length + 1);
    // A pasted fragment keeps only lines wholly inside the selection — a
    // single node has none.
    expect(latest.edges).toHaveLength(EXAMPLE_TEMPLATE.edges.length);
  });

  it("leaves every original line attached to the original node, and lands the copy clear of it", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    await user.keyboard("{Meta>}c{/Meta}");
    await user.keyboard("{Meta>}v{/Meta}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    // Identity, not count: a retargeted edge keeps the total the same, so the
    // count assertion above cannot see one. Every original line must still
    // join the same two nodes it always did.
    for (const original of EXAMPLE_TEMPLATE.edges) {
      expect(latest.edges.find((e) => e.id === original.id)).toMatchObject({
        source: original.source,
        target: original.target,
      });
    }

    // The reported "paste deleted my edges" was an edge-less copy landing on
    // top of the original at the old 28px offset, hiding it and its lines.
    // The copy must now be shifted far enough in BOTH axes to read as a second
    // box — in particular clear of the original's left edge, where its two
    // incoming lines attach.
    const db = EXAMPLE_TEMPLATE.nodes.find((n) => n.id === "db")!;
    const copy = latest.nodes.find((n) => n.label === "Postgres" && n.id !== "db")!;
    expect(copy.x - db.x).toBeGreaterThanOrEqual(60);
    expect(copy.y - db.y).toBeGreaterThanOrEqual(60);
  });

  it("cascades repeat pastes instead of stacking them", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    await user.keyboard("{Meta>}c{/Meta}");
    await user.keyboard("{Meta>}v{/Meta}");
    await user.keyboard("{Meta>}v{/Meta}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const copies = latest.nodes.filter((n) => n.label === "Postgres" && n.id !== "db");
    expect(copies).toHaveLength(2);
    expect(copies[0].x).not.toBe(copies[1].x);
  });

  it("pastes a copy of a grouped node beside it, not into the canvas corner", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    // "REST API" is stored at 30,60 RELATIVE to the VPC group at 520,40 —
    // absolute 550,100. Re-rooted on paste, those relative numbers used to be
    // read as canvas coordinates and dropped the copy ~500px away.
    fireEvent.click(screen.getByText("REST API"));
    await user.keyboard("{Meta>}c{/Meta}");
    await user.keyboard("{Meta>}v{/Meta}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const copy = latest.nodes.find((n) => n.label === "REST API" && n.id !== "api")!;
    expect(copy.parentId).toBeNull();
    expect(copy.x).toBeGreaterThan(500);
    expect(copy.y).toBeGreaterThan(80);
  });

  it("pasting a connected multi-selection keeps the line between the copies", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    // Clinic Staff and API Gateway are directly connected by e1 — a copied
    // pair carries that internal line (and nothing else) through paste.
    const fragment = copyFragment(EXAMPLE_TEMPLATE, ["u", "gw"]);
    await navigator.clipboard.writeText(JSON.stringify(fragment));
    await user.keyboard("{Meta>}v{/Meta}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length + 2);
    expect(latest.edges).toHaveLength(EXAMPLE_TEMPLATE.edges.length + 1);
    const newEdge = latest.edges.find((e) => !EXAMPLE_TEMPLATE.edges.some((o) => o.id === e.id))!;
    const originalIds = new Set(EXAMPLE_TEMPLATE.nodes.map((n) => n.id));
    expect(originalIds.has(newEdge.source)).toBe(false);
    expect(originalIds.has(newEdge.target)).toBe(false);
  });

  // ── The professional/C4 batch ─────────────────────────────────────────────

  it("shows a chip for a custom provider a zone already lists, and removes it", async () => {
    // The reported bug: chips iterated registry providers only, so a custom
    // entry (kept deliberately by validation) rendered nothing and could
    // never be removed.
    const user = userEvent.setup();
    const onChange = vi.fn();
    const doc: DiagramTemplate = {
      version: 1,
      zones: [
        {
          id: "z",
          label: "Edge",
          shape: "rounded",
          x: 0,
          y: 0,
          w: 400,
          h: 300,
          providers: ["heroku", "aws"],
          provider: "heroku",
        },
      ],
      nodes: [],
      edges: [],
    };
    mount(<ArchitectureStudio defaultValue={doc} onChange={onChange} />);

    fireEvent.click(screen.getByText("Edge"));
    const group = screen.getByRole("group", { name: "Providers this zone supports" });
    // Custom entry renders (neutral fallback label = its id) and is active.
    const heroku = within(group).getByRole("button", { name: /heroku/i });
    expect(heroku).toHaveAttribute("aria-pressed", "true");

    await user.click(heroku);
    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.zones![0].providers).toEqual(["aws"]);
    expect(latest.zones![0].provider).toBe("aws");
  });

  // ── Polygon vertex editing ────────────────────────────────────────────────

  const polyDoc: DiagramTemplate = {
    version: 1,
    zones: [
      {
        id: "p",
        label: "Poly",
        shape: "polygon",
        x: 0,
        y: 0,
        w: 400,
        h: 200,
        points: [
          [0, 0],
          [1, 0],
          [0.5, 1],
        ],
        providers: ["azure"],
        provider: "azure",
      },
    ],
    nodes: [],
    edges: [],
  };

  /** jsdom measures everything as 0×0; give the vertex SVG the zone's box. */
  function measureVertexSvg(container: HTMLElement): SVGSVGElement {
    const svg = container.querySelector(".as-zone__vertices") as SVGSVGElement;
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, x: 0, y: 0 }) as DOMRect;
    return svg;
  }

  it("adds a polygon point on pointer-down and drags it in the same gesture", async () => {
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={polyDoc} onChange={onChange} />);

    fireEvent.click(screen.getByText("Poly"));
    measureVertexSvg(container);

    // First midpoint handle sits between [0,0] and [1,0].
    const add = container.querySelector(".as-zone__vertex--add") as SVGCircleElement;
    fireEvent.pointerDown(add, { pointerId: 1, clientX: 200, clientY: 0 });
    // Still holding: the just-added point follows the pointer.
    fireEvent.pointerMove(add, { pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(add, { pointerId: 1 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const pts = (onChange.mock.calls.at(-1)![0] as DiagramTemplate).zones![0].points!;
    expect(pts).toHaveLength(4);
    expect(pts[1][0]).toBeCloseTo(300 / 400);
    expect(pts[1][1]).toBeCloseTo(100 / 200);
  });

  it("grows the zone when a vertex is dragged past its edge", async () => {
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio defaultValue={polyDoc} onChange={onChange} />);

    fireEvent.click(screen.getByText("Poly"));
    measureVertexSvg(container);

    // The [1, 0] vertex, dragged 30% past the right edge.
    const vertices = container.querySelectorAll(".as-zone__vertex:not(.as-zone__vertex--add)");
    const v1 = vertices[1] as SVGCircleElement;
    fireEvent.pointerDown(v1, { pointerId: 1, clientX: 400, clientY: 0 });
    fireEvent.pointerMove(v1, { pointerId: 1, clientX: 520, clientY: 0 });
    fireEvent.pointerUp(v1, { pointerId: 1 });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const zone = (onChange.mock.calls.at(-1)![0] as DiagramTemplate).zones![0];
    // The box grew to hold the vertex…
    expect(zone.w).toBeCloseTo(400 * 1.3);
    // …and every stored point is normalised back into 0..1.
    for (const [px, py] of zone.points!) {
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(1);
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...zone.points!.map((p) => p[0]))).toBeCloseTo(1);
  });

  it("duplicates a whole zone with its members via ⌘D", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const doc: DiagramTemplate = {
      version: 1,
      zones: [
        { id: "z", label: "Region", shape: "rounded", x: 0, y: 0, w: 500, h: 400, providers: ["azure"], provider: "azure" },
      ],
      nodes: [
        { id: "in", label: "Inside", kind: "service", icon: "box", description: "", parentId: null, zoneId: "z", x: 60, y: 80, w: 170, h: 76 },
        { id: "out", label: "Outside", kind: "service", icon: "box", description: "", parentId: null, x: 700, y: 80, w: 170, h: 76 },
      ],
      edges: [{ id: "e", source: "in", target: "out", label: "", style: "solid", color: "slate" }],
    };
    mount(<ArchitectureStudio defaultValue={doc} onChange={onChange} />);

    fireEvent.click(screen.getByText("Region"));
    await user.keyboard("{Meta>}d{/Meta}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    // A second region exists, under a fresh id, with a cloned member.
    expect(latest.zones).toHaveLength(2);
    expect(latest.zones!.filter((z) => z.id === "z")).toHaveLength(1);
    const clone = latest.nodes.find((n) => n.label === "Inside" && n.id !== "in")!;
    expect(clone).toBeTruthy();
    // The member's boundary edge is mirrored to the outside neighbour.
    expect(latest.edges.some((e) => e.source === clone.id && e.target === "out")).toBe(true);
    // The original wiring is untouched.
    expect(latest.edges.find((e) => e.id === "e")).toMatchObject({ source: "in", target: "out" });
  });

  it("copies and pastes a zone with ⌘C/⌘V", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const doc: DiagramTemplate = {
      version: 1,
      zones: [
        { id: "z", label: "Region", shape: "hexagon", x: 0, y: 0, w: 500, h: 400, providers: ["aws", "gcp"], provider: "gcp" },
      ],
      nodes: [
        { id: "in", label: "Inside", kind: "service", icon: "box", description: "", parentId: null, zoneId: "z", x: 60, y: 80, w: 170, h: 76 },
      ],
      edges: [],
    };
    mount(<ArchitectureStudio defaultValue={doc} onChange={onChange} />);

    fireEvent.click(screen.getByText("Region"));
    await user.keyboard("{Meta>}c{/Meta}");
    await user.keyboard("{Meta>}v{/Meta}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.zones).toHaveLength(2);
    const pastedZone = latest.zones!.find((z) => z.id !== "z")!;
    // The clone keeps the zone's semantics: shape, providers, active provider.
    expect(pastedZone.shape).toBe("hexagon");
    expect(pastedZone.providers).toEqual(["aws", "gcp"]);
    expect(pastedZone.provider).toBe("gcp");
    expect(latest.nodes.filter((n) => n.label === "Inside")).toHaveLength(2);
  });

  it("adds a custom provider to Supports via the free-text input", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Cloud Region"));
    const input = screen.getByLabelText("Providers this zone supports — add");
    await user.type(input, "fly{Enter}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.zones!.find((z) => z.id === "region")!.providers).toContain("fly");
    // And it now renders as a chip so it can be toggled/removed.
    const group = screen.getByRole("group", { name: "Providers this zone supports" });
    expect(within(group).getByRole("button", { name: /fly/i })).toBeInTheDocument();
  });

  it("collapses and expands a group without losing its contents (StrictMode + controlled)", async () => {
    const user = userEvent.setup();
    const seen: DiagramTemplate[] = [];
    mount(
      <StrictMode>
        <ControlledHost spy={(t) => seen.push(t)} initial={EXAMPLE_TEMPLATE} />
      </StrictMode>,
    );
    expect(screen.getByText("REST API")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse Application VPC" }));
    // Children leave the canvas; the chip stands in.
    expect(screen.queryByText("REST API")).not.toBeInTheDocument();
    expect(screen.queryByText("Worker Service")).not.toBeInTheDocument();
    // The document keeps every node — collapse is presentation, not deletion.
    const collapsed = seen.at(-1)!;
    expect(collapsed.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length);
    expect(collapsed.nodes.find((n) => n.id === "vpc")).toMatchObject({
      collapsed: true,
      w: 440,
      h: 380, // stored size survives the 180×44 chip
    });

    await user.click(screen.getByRole("button", { name: "Expand Application VPC" }));
    expect(screen.getByText("REST API")).toBeInTheDocument();
    const expanded = seen.at(-1)!;
    expect(expanded.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length);
    expect(expanded.edges).toHaveLength(EXAMPLE_TEMPLATE.edges.length);
  });

  it("reports the canvas selection to the host in template terms", async () => {
    const onSelectionChange = vi.fn();
    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_ZONED_TEMPLATE}
        onSelectionChange={onSelectionChange}
      />,
    );

    // The mount itself reports (an empty selection), so a host that remounts
    // the editor per file never keeps the previous document's selection.
    expect(onSelectionChange).toHaveBeenCalledWith({ nodes: [], edges: [], zones: [] });

    fireEvent.click(screen.getByText("REST API"));
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith({ nodes: ["api"], edges: [], zones: [] }),
    );

    // A zone reports under `zones` with its DOCUMENT id — no canvas prefix.
    fireEvent.click(screen.getByText("Cloud Region"));
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        nodes: [],
        edges: [],
        zones: ["region"],
      }),
    );
  });

  it("search selects and centres a match on Enter", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);

    await user.type(screen.getByLabelText("Search nodes"), "Postgres{Enter}");

    const wrapper = container.querySelector('[data-id="db"]');
    expect(wrapper?.classList.contains("selected")).toBe(true);
    expect(screen.getByText("1/1")).toBeInTheDocument();
  });

  it("sets diagram-wide routing through meta from the connector picker", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Arrange ▾" }));
    await user.click(screen.getByRole("radio", { name: "Right-angle connectors" }));
    expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).meta?.routing).toBe("orthogonal");

    // The menu stays open for repeated switching.
    await user.click(screen.getByRole("radio", { name: "Straight connectors" }));
    expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).meta?.routing).toBe("straight");

    await user.click(screen.getByRole("radio", { name: "Curved connectors" }));
    expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).meta?.routing).toBe("curved");
  });

  it("re-attaches a dragged edge end through the controlled studio and emits the new target", async () => {
    const onChange = vi.fn();
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 100, h: 50 },
        { id: "b", label: "B", kind: "service", icon: "box", description: "", parentId: null, x: 300, y: 0, w: 100, h: 50 },
        { id: "c", label: "C", kind: "service", icon: "box", description: "", parentId: null, x: 300, y: 300, w: 100, h: 50 },
      ],
      edges: [{ id: "e1", source: "a", target: "b", label: "", style: "solid", color: "slate" }],
    });
    const { container } = mount(<ArchitectureStudio defaultValue={doc} onChange={onChange} />);

    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    // Select the edge so its endpoint handles appear.
    fireEvent.click(container.querySelector(".as-edge__hit")!);
    await waitFor(() => expect(container.querySelectorAll(".as-edge__endpoint")).toHaveLength(2));

    // Map flow coordinates to client coordinates through the live viewport
    // transform — fitView has been at work, so identity can't be assumed.
    const viewport = container.querySelector(".react-flow__viewport") as HTMLElement;
    const m = viewport.style.transform.match(
      /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/,
    );
    const [tx, ty, k] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1];
    const client = (x: number, y: number) => ({ clientX: x * k + tx, clientY: y * k + ty });

    // Drag the target end from node b down into node c's box.
    const endHandle = container.querySelectorAll(".as-edge__endpoint")[1];
    fireEvent.pointerDown(endHandle, { pointerId: 1, button: 0, ...client(300, 25) });
    fireEvent.pointerMove(endHandle, { pointerId: 1, ...client(350, 330) });
    fireEvent.pointerUp(endHandle, { pointerId: 1 });

    await waitFor(() => {
      const latest = onChange.mock.calls.at(-1)?.[0] as DiagramTemplate | undefined;
      expect(latest?.edges[0]?.target).toBe("c");
    });
  });

  /** The live canvas transform, for tests that must aim at flow coordinates. */
  function flowToClient(container: HTMLElement) {
    const viewport = container.querySelector(".react-flow__viewport") as HTMLElement;
    const m = viewport.style.transform.match(
      /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)\s*scale\(([\d.]+)\)/,
    );
    const [tx, ty, k] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 1];
    return (x: number, y: number) => ({ clientX: x * k + tx, clientY: y * k + ty });
  }

  it("drops a dragged-out connection in space as a dangling arrow to a new point", async () => {
    const onChange = vi.fn();
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 100, h: 50 },
      ],
      edges: [],
    });
    const { container } = mount(<ArchitectureStudio defaultValue={doc} onChange={onChange} />);

    await waitFor(() =>
      expect(container.querySelector('.react-flow__handle[data-nodeid="a"]')).toBeTruthy(),
    );
    // Let fitView finish animating: probe the transform until two consecutive
    // reads agree, or the client coordinates would aim at a moving target.
    let prev = "";
    await waitFor(() => {
      const t = (container.querySelector(".react-flow__viewport") as HTMLElement).style.transform;
      expect(t).toMatch(/scale/);
      if (t !== prev) {
        prev = t;
        throw new Error("viewport still animating");
      }
    });
    const client = flowToClient(container);
    const handle = container.querySelector('.react-flow__handle[data-nodeid="a"]')!;

    // A connection drag that ends far from any node or handle. The handle
    // starts the drag on MOUSEDOWN, then tracks it through document-level
    // mousemove/mouseup.
    fireEvent.mouseDown(handle, { button: 0, ...client(100, 25) });
    fireEvent.mouseMove(document, { ...client(600, 400) });
    fireEvent.mouseUp(document, { ...client(600, 400) });

    await waitFor(() => {
      const t = onChange.mock.calls.at(-1)?.[0] as DiagramTemplate | undefined;
      const point = t?.nodes.find((n) => n.kind === "point");
      expect(point).toBeDefined();
      // A 12px dot, well away from node a in the drop's direction. The exact
      // spot is not asserted: connection drags auto-pan the canvas, and
      // jsdom's zero-sized container makes every position "near the edge",
      // shifting the viewport under any precomputed client coordinates.
      // (Precise drop→coordinate maths is covered by anchorFromPoint and the
      // identity-viewport tests in edges.test.tsx.)
      expect(point!.w).toBe(12);
      expect(point!.h).toBe(12);
      expect(point!.x).toBeGreaterThan(300);
      expect(point!.y).toBeGreaterThan(200);
      expect(t!.edges.some((e) => e.source === "a" && e.target === point!.id)).toBe(true);
    });
  });

  it("changing a dot's kind materializes a full-size node the arrow already points at", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 100, h: 50 },
        { id: "p", label: "", kind: "point", icon: "none", description: "", parentId: null, x: 400, y: 200 },
      ],
      edges: [{ id: "e1", source: "a", target: "p", label: "", style: "solid", color: "slate" }],
    });
    const { container } = mount(<ArchitectureStudio defaultValue={doc} onChange={onChange} />);

    await waitFor(() => expect(container.querySelector('[data-id="p"]')).toBeTruthy());
    fireEvent.click(container.querySelector('[data-id="p"]')!);
    await user.click(await screen.findByRole("button", { name: "Node kind" }));
    await user.click(screen.getByRole("option", { name: "Service" }));

    await waitFor(() => {
      const t = onChange.mock.calls.at(-1)?.[0] as DiagramTemplate | undefined;
      const node = t?.nodes.find((n) => n.id === "p");
      expect(node?.kind).toBe("service");
      // Not the dot's 12×12 sliver — a freshly inserted service's box.
      expect(node?.w).toBe(170);
      expect(node?.h).toBe(76);
      // The arrow it grew out of still points at it.
      expect(t?.edges[0]?.target).toBe("p");
    });
  });

  it("arms a dot's connect handles only from its trigger, never on mere hover", async () => {
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 100, h: 50 },
        { id: "p", label: "", kind: "point", icon: "none", description: "", parentId: null, x: 400, y: 200 },
      ],
      edges: [{ id: "e1", source: "a", target: "p", label: "", style: "solid", color: "slate" }],
    });
    const { container } = mount(<ArchitectureStudio defaultValue={doc} />);

    await waitFor(() => expect(container.querySelector(".as-point")).toBeTruthy());
    const point = container.querySelector(".as-point")!;
    // The handles stay MOUNTED regardless — React Flow measures the edge's
    // attachment from them (see ConnectHandles) — arming is a class the
    // stylesheet maps to visibility and pointer events.
    expect(point.querySelectorAll(".react-flow__handle")).toHaveLength(4);

    // Hovering the head itself does not arm them…
    fireEvent.mouseOver(point.querySelector(".as-point__dot")!, { relatedTarget: document.body });
    expect(point.classList.contains("as-point--armed")).toBe(false);

    // …resting exactly on the trigger dot does…
    fireEvent.mouseOver(point.querySelector(".as-point__arm")!, { relatedTarget: document.body });
    expect(point.classList.contains("as-point--armed")).toBe(true);

    // …and leaving the whole cluster puts them away.
    fireEvent.mouseOut(point, { relatedTarget: document.body });
    expect(point.classList.contains("as-point--armed")).toBe(false);
  });

  it("deleting a dangling edge sweeps its stranded dot", async () => {
    const onChange = vi.fn();
    const doc = validateTemplate({
      version: 1,
      nodes: [
        { id: "a", label: "A", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 100, h: 50 },
        { id: "p", label: "", kind: "point", icon: "none", description: "", parentId: null, x: 400, y: 200 },
      ],
      edges: [{ id: "e1", source: "a", target: "p", label: "", style: "solid", color: "slate" }],
    });
    const { container } = mount(<ArchitectureStudio defaultValue={doc} onChange={onChange} />);

    await waitFor(() => expect(container.querySelector(".as-edge__hit")).toBeTruthy());
    fireEvent.click(container.querySelector(".as-edge__hit")!);
    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => {
      const t = onChange.mock.calls.at(-1)?.[0] as DiagramTemplate | undefined;
      expect(t?.edges).toHaveLength(0);
      // The dot existed only to hold that arrow's loose end — it goes with it.
      expect(t?.nodes.some((n) => n.kind === "point")).toBe(false);
      expect(t?.nodes.some((n) => n.id === "a")).toBe(true);
    });
  });

  it("locks a node from the inspector", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    await user.click(screen.getByRole("button", { name: "Lock in place" }));

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "db")!.locked).toBe(true);
  });

  it("adds a tag from the inspector and dims non-matching nodes via the filter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />,
    );

    fireEvent.click(screen.getByText("Postgres"));
    await user.type(screen.getByLabelText("Node tags — add"), "pci{Enter}");
    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "db")!.tags).toEqual(["pci"]);

    // Filter on it: the tagged node stays crisp, everything else dims.
    await user.click(screen.getByRole("button", { name: /^View/ }));
    await user.click(screen.getByRole("checkbox", { name: "pci" }));
    expect(container.querySelector('[data-id="db"] .as-node--dimmed')).toBeNull();
    expect(container.querySelector('[data-id="api"] .as-node--dimmed')).not.toBeNull();
  });

  it("centres and wraps a node's text from the inspector, growing the box", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />,
    );

    fireEvent.click(screen.getByText("Postgres"));
    await user.selectOptions(screen.getByLabelText("Text alignment"), "center");
    await user.selectOptions(screen.getByLabelText("Vertical text alignment"), "top");
    await user.click(screen.getByRole("checkbox", { name: "Wrap" }));

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "db")).toMatchObject({
      textAlign: "center",
      textVAlign: "top",
      wrap: true,
    });
    expect(container.querySelector('[data-id="db"] .as-node--align-center')).not.toBeNull();
    expect(container.querySelector('[data-id="db"] .as-node--valign-top')).not.toBeNull();
    expect(container.querySelector('[data-id="db"] .as-node--wrap')).not.toBeNull();
  });

  it("keeps a wrapped node's grown height across the next derive", async () => {
    // validateTemplate grows `h` for a wrapped label, but the document is
    // DERIVED from the canvas — so unless the canvas node grows too, the very
    // next edit reads the old height back off it and the extra lines spill out
    // of the box. This pins the round-trip, not just the first commit.
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    await user.clear(screen.getByLabelText("Node label"));
    await user.type(
      screen.getByLabelText("Node label"),
      "Primary Transactional Postgres Cluster For Billing",
    );
    await user.click(screen.getByRole("checkbox", { name: "Wrap" }));

    const grown = (onChange.mock.calls.at(-1)![0] as DiagramTemplate).nodes.find(
      (n) => n.id === "db",
    )!.h;
    expect(grown).toBeGreaterThan(76);

    // Any other edit re-derives the document from the canvas.
    await user.type(screen.getByLabelText("Node description"), "!");

    const after = (onChange.mock.calls.at(-1)![0] as DiagramTemplate).nodes.find(
      (n) => n.id === "db",
    )!;
    expect(after.h).toBe(grown);
    expect(after.wrap).toBe(true);
  });

  it("leaves a node with default text layout completely unmarked", () => {
    const { container } = mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);
    // Opt-in means opt-in: an untouched document carries none of the classes,
    // so it renders exactly as it did before the feature existed.
    expect(container.querySelector(".as-node--align-center")).toBeNull();
    expect(container.querySelector(".as-node--align-right")).toBeNull();
    expect(container.querySelector(".as-node--valign-top")).toBeNull();
    expect(container.querySelector(".as-node--wrap")).toBeNull();
  });

  it("makes a group's frame invisible while keeping it a container", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />,
    );

    fireEvent.click(screen.getByText("Application VPC"));
    await user.selectOptions(screen.getByLabelText("Frame outline style"), "none");
    await user.click(screen.getByRole("checkbox", { name: "Fill" }));

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const vpc = latest.nodes.find((n) => n.id === "vpc")!;
    expect(vpc).toMatchObject({ outline: "none", fill: false });
    // Still a container: its children keep parenting to it, so an invisible
    // frame is a grouping box rather than a decoration.
    expect(latest.nodes.filter((n) => n.parentId === "vpc").length).toBeGreaterThan(0);

    const frame = container.querySelector('[data-id="vpc"] .as-group') as HTMLElement;
    expect(frame.style.getPropertyValue("--as-group-fill")).toBe("transparent");
    expect(frame.style.getPropertyValue("--as-group-border-width")).toBe("0");
  });

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  it("selects everything with ⌘A and cuts it with ⌘X", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    await user.keyboard("{Meta>}a{/Meta}");
    await user.keyboard("{Meta>}x{/Meta}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes).toHaveLength(0);
    // Cut is copy-then-delete, so the fragment is still on the clipboard.
    await user.keyboard("{Meta>}v{/Meta}");
    const pasted = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(pasted.nodes.length).toBe(EXAMPLE_TEMPLATE.nodes.length);
  });

  it("nudges the selection with the arrow keys, 10px with Shift", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);
    const start = EXAMPLE_TEMPLATE.nodes.find((n) => n.id === "db")!;

    fireEvent.click(screen.getByText("Postgres"));
    await user.keyboard("{ArrowRight}");
    let latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "db")!.x).toBe(start.x + 1);

    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "db")!.y).toBe(start.y + 10);
  });

  it("leaves the arrow keys to the timeline when nothing is selected", async () => {
    // The two uses cannot both own the arrows; selection decides which wins.
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    const before = onChange.mock.calls.length;
    await user.keyboard("{ArrowRight}");
    expect(onChange.mock.calls.length).toBe(before);
  });

  it("inserts a node, group, text note and zone from single keys", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    await user.keyboard("n");
    await user.keyboard("g");
    await user.keyboard("t");
    await user.keyboard("z");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length + 3);
    expect(latest.nodes.some((n) => n.kind === "text" && n.id.startsWith("text"))).toBe(true);
    expect(latest.zones ?? []).toHaveLength(1);
  });

  it("does not insert while typing in a field", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    // "n", "g", "t" and "z" are all ordinary letters — the typing guard is the
    // only thing stopping a search for "gateway" from inserting four nodes.
    await user.click(screen.getByPlaceholderText(/Search/));
    await user.keyboard("gateway");

    const latest = onChange.mock.calls.at(-1)?.[0] as DiagramTemplate | undefined;
    expect(latest?.nodes.length ?? EXAMPLE_TEMPLATE.nodes.length).toBe(
      EXAMPLE_TEMPLATE.nodes.length,
    );
  });

  it("groups a selection into a container with ⌘G and unwraps it with ⌘⇧G", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    await user.keyboard("{Meta>}g{/Meta}");

    let latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const group = latest.nodes.find((n) => n.kind === "group" && n.id !== "vpc")!;
    expect(group).toBeTruthy();
    // Real nesting, not a selection set — the node is parented to the frame.
    expect(latest.nodes.find((n) => n.id === "db")!.parentId).toBe(group.id);

    fireEvent.click(screen.getByText("New Group"));
    await user.keyboard("{Meta>}{Shift>}g{/Shift}{/Meta}");

    latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === group.id)).toBeUndefined();
    // The child survives, back at the top level and where it started.
    const db = latest.nodes.find((n) => n.id === "db")!;
    expect(db.parentId).toBeNull();
    expect(db.x).toBe(EXAMPLE_TEMPLATE.nodes.find((n) => n.id === "db")!.x);
  });

  it("locks and unlocks the selection with ⌘⇧L", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    await user.keyboard("{Meta>}{Shift>}l{/Shift}{/Meta}");
    let latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "db")!.locked).toBe(true);

    await user.keyboard("{Meta>}{Shift>}l{/Shift}{/Meta}");
    latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect("locked" in latest.nodes.find((n) => n.id === "db")!).toBe(false);
  });

  it("refuses to nudge a locked node", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);
    const start = EXAMPLE_TEMPLATE.nodes.find((n) => n.id === "db")!;

    fireEvent.click(screen.getByText("Postgres"));
    await user.keyboard("{Meta>}{Shift>}l{/Shift}{/Meta}");
    await user.keyboard("{ArrowRight}");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "db")!.x).toBe(start.x);
  });

  it("restacks a selected zone with ⌘] and ⌘[", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Cloud Region"));
    await user.keyboard("{Meta>}]{/Meta}");
    const raised = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const region = raised.zones!.find((z) => z.id === "region")!;
    const vendor = raised.zones!.find((z) => z.id === "vendor")!;
    expect(region.z ?? 0).toBeGreaterThan(vendor.z ?? 0);
  });

  it("opens the shortcuts sheet with ? and closes it with Escape", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);

    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    await user.keyboard("?");
    const sheet = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    // It advertises what actually exists.
    expect(sheet).toHaveTextContent("Group selection into a container");
    expect(sheet).toHaveTextContent("Nudge 1px");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("does not burn an undo step on the Show-hidden view toggle", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);

    const undo = screen.getByRole("button", { name: "Undo" });
    expect(undo).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /^View/ }));
    await user.click(screen.getByRole("checkbox", { name: /Show hidden nodes/ }));
    await user.click(screen.getByRole("checkbox", { name: /Show hidden nodes/ }));

    // Ghost mode is a view change, not a document change — nothing to undo.
    expect(undo).toBeDisabled();
  });

  it("shows owning-team badges and hides them via the View menu", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);

    // The REST API node carries team "Platform" in the example document.
    expect(screen.getByText("Platform")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^View/ }));
    await user.click(screen.getByRole("checkbox", { name: "Show team badges" }));
    expect(screen.queryByText("Platform")).not.toBeInTheDocument();

    // Purely presentational: hiding badges is not an edit, nothing to undo.
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("sets a node's owning team from the inspector", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    await user.type(screen.getByLabelText("Owning team"), "Data");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "db")!.team).toBe("Data");
    // The badge appears on the node immediately.
    expect(screen.getByText("Data")).toBeInTheDocument();
  });

  it("sets lifecycle status from the inspector and renders its convention", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />,
    );

    fireEvent.click(screen.getByText("Postgres"));
    await user.selectOptions(screen.getByLabelText("Lifecycle status"), "deprecated");

    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "db")!.status).toBe("deprecated");
    expect(container.querySelector('[data-id="db"] .as-node--status-deprecated')).not.toBeNull();

    // Back to active removes the field entirely.
    await user.selectOptions(screen.getByLabelText("Lifecycle status"), "active");
    const reverted = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect("status" in reverted.nodes.find((n) => n.id === "db")!).toBe(false);
  });

  it("shows the version tag chip, edits it, and moves it between corners", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} onChange={onChange} />);

    // Renders from meta.versionTag; click to edit.
    await user.click(screen.getByRole("button", { name: "v2.1" }));
    const input = screen.getByLabelText("Version tag");
    await user.clear(input);
    await user.type(input, "v3.0{Enter}");

    expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).meta?.versionTag).toBe("v3.0");
    expect(screen.getByRole("button", { name: "v3.0" })).toBeInTheDocument();

    // Adjustable spot: the corner select moves it, as a committed edit.
    await user.click(screen.getByRole("button", { name: "v3.0" }));
    await user.selectOptions(screen.getByLabelText("Version tag corner"), "bottom-right");
    expect(
      (onChange.mock.calls.at(-1)![0] as DiagramTemplate).meta?.versionTagPosition,
    ).toBe("bottom-right");
  });

  it("offers Set version tag in the View menu when none exists", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    await fromMenu(user, /^View/, /Set version tag/);
    expect((onChange.mock.calls.at(-1)![0] as DiagramTemplate).meta?.versionTag).toBe("v0.1");
    expect(screen.getByRole("button", { name: "v0.1" })).toBeInTheDocument();
  });

  it("surfaces lint findings in Checks and jumps to the offender", async () => {
    const user = userEvent.setup();
    const bad: DiagramTemplate = {
      version: 1,
      nodes: [
        { id: "ext", label: "Partner", kind: "external", icon: "globe", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
        { id: "db", label: "Ledger", kind: "database", icon: "database", description: "", parentId: null, x: 400, y: 0, w: 170, h: 76 },
      ],
      edges: [{ id: "e", source: "ext", target: "db", label: "", style: "solid", color: "slate" }],
    };
    const { container } = mount(<ArchitectureStudio defaultValue={bad} />);

    await user.click(screen.getByRole("button", { name: /Checks \(/ }));
    await user.click(
      screen.getByRole("menuitem", { name: /External system reaches a datastore/ }),
    );

    // The finding's nodes are selected so the offence is visible.
    expect(container.querySelector('[data-id="ext"]')?.classList.contains("selected")).toBe(true);
    expect(container.querySelector('[data-id="db"]')?.classList.contains("selected")).toBe(true);
  });

  it("boxes text notes by default and lets the Outline toggle opt out", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />,
    );

    const note = () => container.querySelector('[data-id="note"] .as-annotation');
    expect(note()!.classList.contains("as-annotation--boxed")).toBe(true);

    fireEvent.click(screen.getByText(/Tenant isolation enforced/));
    await user.click(await screen.findByRole("checkbox", { name: "Outline" }));

    let latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "note")!.plain).toBe(true);
    expect(note()!.classList.contains("as-annotation--boxed")).toBe(false);

    // Re-checking removes the field rather than storing the default.
    await user.click(screen.getByRole("checkbox", { name: "Outline" }));
    latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect("plain" in latest.nodes.find((n) => n.id === "note")!).toBe(false);
  });

  it("shows a note's description as a dim sub-line, and lets the inspector set one", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const withDesc = validateTemplate({
      ...EXAMPLE_TEMPLATE,
      nodes: EXAMPLE_TEMPLATE.nodes.map((n) =>
        n.id === "note" ? { ...n, description: "Reviewed 2026-Q1" } : n,
      ),
    });
    const { container } = mount(<ArchitectureStudio defaultValue={withDesc} onChange={onChange} />);

    const desc = container.querySelector('[data-id="note"] .as-annotation__desc');
    expect(desc).toHaveTextContent("Reviewed 2026-Q1");

    // The note's own sentence stays the label; the description is editable
    // from the inspector, which is the only place to type one.
    fireEvent.click(screen.getByText(/Tenant isolation enforced/));
    const input = await screen.findByLabelText("Node description");
    expect(input).toHaveValue("Reviewed 2026-Q1");
    await user.clear(input);
    await user.type(input, "Owner: Platform");

    await waitFor(() => {
      const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(latest.nodes.find((n) => n.id === "note")!.description).toBe("Owner: Platform");
    });
  });

  it("commits inline annotation edits on blur", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />,
    );

    const note = screen.getByText(/Tenant isolation enforced/);
    fireEvent.doubleClick(note);
    // Scope to the inline editor — the toolbar search is also a textbox.
    const box = container.querySelector(".as-annotation__input") as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    await user.clear(box);
    await user.type(box, "Rewritten note");
    fireEvent.blur(box);

    // The commit rides a microtask (commitLater → queueMicrotask); wait for it.
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "note")!.label).toBe("Rewritten note");
    // And it is undoable.
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  // ── Compare mode ──────────────────────────────────────────────────────────
  // The document with Redis removed, the API renamed, and a service added —
  // one of each diff state against EXAMPLE_TEMPLATE as the baseline.
  const mutatedForDiff = validateTemplate({
    ...EXAMPLE_TEMPLATE,
    nodes: [
      ...EXAMPLE_TEMPLATE.nodes
        .filter((n) => n.id !== "cache")
        .map((n) => (n.id === "api" ? { ...n, label: "REST API v2" } : n)),
      { id: "search", label: "Search Service", kind: "service", icon: "box", description: "", parentId: null, x: 1030, y: 430, w: 170, h: 76 },
    ],
    edges: EXAMPLE_TEMPLATE.edges.filter((e) => e.source !== "cache" && e.target !== "cache"),
  });

  it("renders the diff overlay for a diffBase prop", () => {
    const { container } = mount(
      <ArchitectureStudio value={mutatedForDiff} onChange={vi.fn()} diffBase={EXAMPLE_TEMPLATE} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("vs baseline");
    // The removed node renders, ghosted in place, even though the current
    // document no longer contains it.
    expect(screen.getByText("Redis")).toBeInTheDocument();
    expect(container.querySelector(".as-diff--removed")).not.toBeNull();
    expect(container.querySelector(".as-diff--added")).not.toBeNull();
    expect(container.querySelector(".as-diff--changed")).not.toBeNull();
    // Prop-driven baseline: exiting is the host's call, not a button.
    expect(screen.queryByRole("button", { name: "Exit compare" })).not.toBeInTheDocument();
  });

  it("draws the connections in the diff overlay, not just the boxes", async () => {
    const { container } = mount(
      <ArchitectureStudio value={mutatedForDiff} onChange={vi.fn()} diffBase={EXAMPLE_TEMPLATE} />,
    );
    // Every handle is declared as a source, so the overlay's canvas has to run
    // in ConnectionMode.Loose — in strict mode React Flow resolves no edge
    // position and silently renders a diagram with no lines in it at all.
    await waitFor(() =>
      expect(container.querySelectorAll(".as-edge__stroke").length).toBeGreaterThan(0),
    );
  });

  it("still draws connections when editing is disabled", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} readOnly />);
    // Read-only hides the connect affordance; it must not unmount the handles,
    // because React Flow positions every edge from their measured bounds.
    await waitFor(() =>
      expect(container.querySelectorAll(".as-edge__stroke").length).toBe(
        EXAMPLE_TEMPLATE.edges.length,
      ),
    );
  });

  it("enters and exits compare via the toolbar without touching the document", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio defaultValue={mutatedForDiff} onChange={onChange} />,
    );

    const inputs = container.querySelectorAll('input[type="file"]');
    const compareInput = inputs[inputs.length - 1] as HTMLInputElement;
    const file = new File([JSON.stringify(EXAMPLE_TEMPLATE)], "baseline.json", {
      type: "application/json",
    });
    fireEvent.change(compareInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText("Redis")).toBeInTheDocument());
    expect(container.querySelector(".as-diff--removed")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Exit compare" }));
    expect(screen.queryByText("Redis")).not.toBeInTheDocument();
    // Compare is a view: nothing was ever committed.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps the document untouched through compare in StrictMode + controlled mode", () => {
    const onChange = vi.fn();
    const changedValue = validateTemplate({
      ...mutatedForDiff,
      meta: { ...mutatedForDiff.meta, title: "Retitled mid-diff" },
    });

    const { rerender } = mount(
      <StrictMode>
        <ArchitectureStudio value={mutatedForDiff} onChange={onChange} diffBase={EXAMPLE_TEMPLATE} />
      </StrictMode>,
    );
    expect(screen.getByText("Redis")).toBeInTheDocument();

    // An external value change arrives MID-DIFF (the controlled host moved
    // on); then the host clears the baseline.
    rerender(
      <StrictMode>
        <ArchitectureStudio value={changedValue} onChange={onChange} diffBase={EXAMPLE_TEMPLATE} />
      </StrictMode>,
    );
    rerender(
      <StrictMode>
        <ArchitectureStudio value={changedValue} onChange={onChange} />
      </StrictMode>,
    );

    // The editor shows the latest document; the overlay's injected removals
    // never leaked into it, and no spurious commit ever fired.
    expect(screen.getByText("REST API v2")).toBeInTheDocument();
    expect(screen.queryByText("Redis")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  // ── Zone styling ──────────────────────────────────────────────────────────

  it("recolours a zone from the inspector's swatch row, and Auto restores", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} onChange={onChange} />);

    // Select the region via its header label to open the zone inspector.
    fireEvent.click(screen.getByText("Cloud Region"));
    // The picker chooses the OUTLINE colour; GCP's default is one of the
    // provider swatches on offer.
    await user.click(await screen.findByRole("button", { name: "Zone colour GCP" }));
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(last.zones!.find((z) => z.id === "region")?.color).toBe("#4285f4");
    });

    // Auto clears the override back to the provider's colour.
    await user.click(screen.getByRole("button", { name: "Auto" }));
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(last.zones!.find((z) => z.id === "region")?.color).toBeUndefined();
    });
  });

  it("offers another zone's custom colour as a swatch for easy matching", async () => {
    const doc = validateTemplate({
      ...EXAMPLE_ZONED_TEMPLATE,
      zones: EXAMPLE_ZONED_TEMPLATE.zones!.map((z) =>
        z.id === "vendor" ? { ...z, color: "#e11d48" } : z,
      ),
    });
    mount(<ArchitectureStudio defaultValue={doc} />);
    fireEvent.click(screen.getByText("Cloud Region"));
    // The vendor zone's custom rose shows up in the region's palette.
    const swatch = await screen.findByRole("button", { name: /Zone colour Custom \(Stripe\)/ });
    expect(swatch).toHaveStyle({ background: "#e11d48" });
  });

  it("sets outline style and fill from the inspector", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Cloud Region"));
    await user.selectOptions(await screen.findByLabelText("Zone outline style"), "dashed");
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(last.zones!.find((z) => z.id === "region")?.outline).toBe("dashed");
    });

    await user.click(screen.getByLabelText(/Fill$/));
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(last.zones!.find((z) => z.id === "region")?.fill).toBe(false);
    });
  });

  // ── Timeline mode ─────────────────────────────────────────────────────────
  // Three phases against one undated backdrop: the shape every roadmap has.
  const dated = validateTemplate({
    version: 1,
    nodes: [
      { id: "core", label: "Core API", kind: "service", icon: "box", description: "", parentId: null, x: 0, y: 0, w: 170, h: 76 },
      { id: "wrk", label: "Worker", kind: "service", icon: "gear", description: "", parentId: null, date: "2026-06-15", x: 240, y: 0, w: 170, h: 76 },
      { id: "pay", label: "Payments", kind: "external", icon: "lock", description: "", parentId: null, date: "2026-09-30", x: 480, y: 0, w: 170, h: 76 },
    ],
    edges: [
      { id: "e1", source: "core", target: "wrk", label: "", style: "solid", color: "slate" },
    ],
  });

  /**
   * Walk the scrubber to one end. The cursor OPENS on today held inside the
   * plan's span, so a test that named a slider value would drift as the real
   * date moves; clicking until the step button gives out cannot.
   */
  const scrubToEnd = async (
    user: ReturnType<typeof userEvent.setup>,
    which: "Previous" | "Next",
  ) => {
    const name = `${which} dated point`;
    for (let guard = 0; guard < 20; guard++) {
      const button = screen.getByRole("button", { name });
      if ((button as HTMLButtonElement).disabled) return;
      await user.click(button);
    }
    throw new Error("scrubber never reached the end of the plan");
  };

  it("renders a node's date as a chip, abbreviated month-and-day", () => {
    mount(<ArchitectureStudio defaultValue={dated} />);
    // 2026 is not the current year at time of writing, so the year shows.
    expect(screen.getByText(/^Jun 15/)).toBeInTheDocument();
    expect(screen.getByText(/^Sep 30/)).toBeInTheDocument();
  });

  it("offers the timeline only once something is dated", () => {
    const { unmount } = mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);
    expect(screen.queryByRole("button", { name: /Timeline/ })).not.toBeInTheDocument();
    unmount();

    mount(<ArchitectureStudio defaultValue={dated} />);
    expect(screen.getByRole("button", { name: /Timeline/ })).toBeInTheDocument();
  });

  it("scrubs to the first stop, showing only that date plus the undated", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={dated} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    // Everything later is hidden outright rather than greyed.
    await user.click(screen.getByRole("button", { name: "Hide later" }));
    await scrubToEnd(user, "Previous");

    await waitFor(() => expect(screen.queryByText("Payments")).not.toBeInTheDocument());
    expect(screen.getByText("Core API")).toBeInTheDocument();
    expect(screen.getByText("Worker")).toBeInTheDocument();
    // Scrubbing is a view — it must never commit.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows every node at the last stop", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={dated} />);

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    await user.click(screen.getByRole("button", { name: "Hide later" }));
    await scrubToEnd(user, "Next");

    await waitFor(() => expect(screen.getByText("Payments")).toBeInTheDocument());
    expect(screen.getByRole("group", { name: "Timeline scrubber" })).toHaveTextContent("all here");
  });

  it("keeps later nodes on the canvas, disabled, in ghost mode", async () => {
    const user = userEvent.setup();
    const { container } = mount(<ArchitectureStudio defaultValue={dated} />);

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    await scrubToEnd(user, "Previous");

    await waitFor(() => expect(container.querySelector(".as-future")).not.toBeNull());
    // Present, but marked — the difference from "Hide later".
    expect(screen.getByText("Payments")).toBeInTheDocument();
  });

  it("leaves the document exactly as it was on exit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={dated} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    await user.click(screen.getByRole("button", { name: "Hide later" }));
    await scrubToEnd(user, "Previous");
    await waitFor(() => expect(screen.queryByText("Payments")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Exit timeline" }));
    // Everything the scrub hid is back, and nothing was ever committed.
    await waitFor(() => expect(screen.getByText("Payments")).toBeInTheDocument());
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("exports the slice it is showing, not the whole diagram", async () => {
    const user = userEvent.setup();
    const seen: DiagramTemplate[] = [];
    mount(
      <ArchitectureStudio
        defaultValue={dated}
        registry={{
          exporters: {
            probe: {
              label: "Probe",
              // Returns nothing: this exporter exists to capture the subject
              // it was handed, not to produce a file.
              run: ({ template }) => {
                seen.push(template);
              },
            },
            fullprobe: {
              label: "Fullprobe",
              // Declares it carries its own timeline — the HTML exporter's
              // contract — so the hide-mode slice must not apply to it.
              fullDocument: true,
              run: ({ template }) => {
                seen.push(template);
              },
            },
          },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    await user.click(screen.getByRole("button", { name: "Hide later" }));
    await scrubToEnd(user, "Previous");
    await fromMenu(user, "Export ▾", "Probe");

    // A PNG of the June view must not come back as the finished architecture.
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0].nodes.map((n) => n.id).sort()).toEqual(["core", "wrk"]);

    // A fullDocument exporter gets everything even while the slice is showing.
    await fromMenu(user, "Export ▾", "Fullprobe");
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1].nodes).toHaveLength(3);

    // Ghost mode shows the whole document, so it exports the whole document.
    await user.click(screen.getByRole("button", { name: "Ghost later" }));
    await fromMenu(user, "Export ▾", "Probe");
    await waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[2].nodes).toHaveLength(3);
  });

  it("keeps editing live while scrubbing, without losing hidden elements", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={dated} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    await user.click(screen.getByRole("button", { name: "Hide later" }));
    await scrubToEnd(user, "Previous");
    await waitFor(() => expect(screen.queryByText("Payments")).not.toBeInTheDocument());

    // Insert while the September node is hidden — the commit this causes is
    // exactly the moment a re-materializing design would delete it.
    await fromMenu(user, "Insert ▾", /^Node /);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(last.nodes.some((n) => n.id === "pay")).toBe(true);
    expect(last.nodes.length).toBe(dated.nodes.length + 1);
  });

  it("undoes a delete made while scrubbing, and the view re-hides the future", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={dated} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    await user.click(screen.getByRole("button", { name: "Hide later" }));
    await scrubToEnd(user, "Previous");

    fireEvent.click(screen.getByText("Worker"));
    fireEvent.keyDown(window, { key: "Delete" });
    await waitFor(() => {
      const t = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(t.nodes.some((n) => n.id === "wrk")).toBe(false);
      // The hidden September node rode through the delete's commit untouched.
      expect(t.nodes.some((n) => n.id === "pay")).toBe(true);
    });

    await user.click(screen.getByRole("button", { name: "Undo" }));
    const t = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(t.nodes).toHaveLength(dated.nodes.length);
    // Undo re-materializes the canvas; the display pass must reapply on top,
    // so the restored September node comes back HIDDEN, not revealed.
    expect(screen.queryByText("Payments")).not.toBeInTheDocument();
    expect(screen.getByText("Worker")).toBeInTheDocument();
  });

  it("stamps the scrub cursor onto elements inserted in timeline mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={dated} onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    await scrubToEnd(user, "Previous");
    // The hanging tab says what the insert will inherit. (Located by text —
    // it is deliberately not a live region, so scrubbing doesn't triple-
    // announce every tick.)
    expect(screen.getByText(/New elements dated/)).toBeInTheDocument();

    await fromMenu(user, "Insert ▾", /^Node /);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const last = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const added = last.nodes.find((n) => !dated.nodes.some((d) => d.id === n.id));
    // First stop of the fixture — where scrubToEnd("Previous") lands.
    expect(added?.date).toBe("2026-06-15");
  });

  it("jumps to a typed date from the readout, including between stops", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={dated} />);

    await user.click(screen.getByRole("button", { name: /Timeline/ }));
    await user.click(screen.getByRole("button", { name: "Hide later" }));
    // The readout is a button; clicking it swaps in a date field.
    await user.click(screen.getByTitle("Jump to a specific date"));
    fireEvent.change(screen.getByLabelText("Jump to a date"), {
      target: { value: "2026-08-01" },
    });

    // August: June's worker landed, September's payments has not — a view no
    // stop-index scrubber could reach, since nothing is dated in August.
    await waitFor(() => expect(screen.queryByText("Payments")).not.toBeInTheDocument());
    expect(screen.getByText("Worker")).toBeInTheDocument();
  });

  it("sets and clears a date from the node inspector", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    fireEvent.click(screen.getByText("Postgres"));
    const field = await screen.findByLabelText("Node date");
    fireEvent.change(field, { target: { value: "2026-03-04" } });

    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(last.nodes.find((n) => n.id === "db")?.date).toBe("2026-03-04");
    });

    await user.click(screen.getByRole("button", { name: "Clear date" }));
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(last.nodes.find((n) => n.id === "db")?.date).toBeUndefined();
    });
  });

  // ── File workspace chrome ─────────────────────────────────────────────────

  const workspaceFiles = [
    { id: "f1", name: "Platform", kind: "arch" },
    { id: "f2", name: "Order flow", kind: "seq" },
  ];

  it("replaces the brand with the file selector when files are provided", async () => {
    const user = userEvent.setup();
    mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} files={workspaceFiles} activeFileId="f1" />,
    );

    expect(screen.queryByText("arch·studio")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    expect(screen.getByRole("menuitem", { name: /Order flow/ })).toBeInTheDocument();
    // Kind badges render.
    expect(screen.getByText("arch")).toBeInTheDocument();
    expect(screen.getByText("seq")).toBeInTheDocument();
  });

  it("selects a file, closing the menu, and creates one from the footer", async () => {
    const user = userEvent.setup();
    const onFileSelect = vi.fn();
    const onFileCreate = vi.fn();
    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        files={workspaceFiles}
        activeFileId="f1"
        onFileSelect={onFileSelect}
        onFileCreate={onFileCreate}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /Order flow/ }));
    expect(onFileSelect).toHaveBeenCalledWith("f2");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /New file/ }));
    expect(onFileCreate).toHaveBeenCalledTimes(1);
  });

  it("renames a file inline via ✎: type, Enter commits; Escape cancels", async () => {
    const user = userEvent.setup();
    const onFileRename = vi.fn();
    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        files={workspaceFiles}
        activeFileId="f1"
        onFileRename={onFileRename}
      />,
    );

    // One title, two homes: the document's own meta.title pushes out to the
    // host on mount, so the dropdown reflects what exports will print.
    await waitFor(() => expect(onFileRename).toHaveBeenCalledWith("f1", "Clinic platform"));
    onFileRename.mockClear();

    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    await user.click(screen.getByRole("button", { name: "Rename Platform" }));
    const input = screen.getByLabelText("File name");
    await user.clear(input);
    await user.type(input, "Core Platform{Enter}");
    expect(onFileRename).toHaveBeenCalledWith("f1", "Core Platform");
    onFileRename.mockClear();

    // Escape cancels without firing.
    await user.click(screen.getByRole("button", { name: "Rename Platform" }));
    await user.type(screen.getByLabelText("File name"), "{Escape}");
    expect(onFileRename).not.toHaveBeenCalled();
  });

  it("renaming the active file writes the document's meta.title", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        onChange={onChange}
        files={workspaceFiles}
        activeFileId="f1"
        onFileRename={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    await user.click(screen.getByRole("button", { name: "Rename Platform" }));
    const input = screen.getByLabelText("File name");
    await user.clear(input);
    await user.type(input, "Core Platform{Enter}");

    // The rename is a document edit too — committed, emitted, undoable.
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(last.meta?.title).toBe("Core Platform");
    });
  });

  it("adopts a host-side rename as the document's title instead of fighting it", async () => {
    const onChange = vi.fn();
    const onFileRename = vi.fn();
    const filesAt = (name: string) => [{ id: "f1", name, kind: "arch" }];
    const { rerender } = mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        onChange={onChange}
        files={filesAt("Platform")}
        activeFileId="f1"
        onFileRename={onFileRename}
      />,
    );

    // Mount: the document names itself ("Clinic platform" pushes out).
    await waitFor(() => expect(onFileRename).toHaveBeenCalledWith("f1", "Clinic platform"));
    onFileRename.mockClear();

    // The HOST renames the file — its own UI, another tab, an API sync. The
    // name moved while the title didn't, so the editor adopts the name as the
    // title rather than pushing the stale title back.
    rerender(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        onChange={onChange}
        files={filesAt("Renamed Elsewhere")}
        activeFileId="f1"
        onFileRename={onFileRename}
      />,
    );
    await waitFor(() => {
      const last = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      expect(last.meta?.title).toBe("Renamed Elsewhere");
    });
    // And the old title was never pushed back over the host's rename.
    expect(onFileRename).not.toHaveBeenCalled();
  });

  it("deletes an EMPTY file immediately, including the last one", async () => {
    const user = userEvent.setup();
    const onFileDelete = vi.fn();
    const { unmount } = mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        files={[workspaceFiles[0], { ...workspaceFiles[1], empty: true }]}
        activeFileId="f1"
        onFileDelete={onFileDelete}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    await user.click(screen.getByRole("button", { name: "Delete Order flow" }));
    // Nothing to lose, so no dialog.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onFileDelete).toHaveBeenCalledWith("f2");
    unmount();

    // The last file offers × too — deleting it empties the workspace, which
    // the editor greets with the welcome modal rather than leaving a trap.
    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        files={[workspaceFiles[0]]}
        activeFileId="f1"
        onFileDelete={onFileDelete}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    expect(screen.getByRole("button", { name: "Delete Platform" })).toBeInTheDocument();
  });

  it("confirms before deleting a file that still has content", async () => {
    const user = userEvent.setup();
    const onFileDelete = vi.fn();
    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        files={workspaceFiles}
        activeFileId="f1"
        onFileDelete={onFileDelete}
      />,
    );

    // Cancel leaves the file alone.
    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    await user.click(screen.getByRole("button", { name: "Delete Order flow" }));
    const dialog = screen.getByRole("dialog", { name: "Delete Order flow?" });
    expect(within(dialog).getByText(/still has content/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onFileDelete).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Escape also cancels.
    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    await user.click(screen.getByRole("button", { name: "Delete Order flow" }));
    await user.keyboard("{Escape}");
    expect(onFileDelete).not.toHaveBeenCalled();

    // Confirming deletes.
    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    await user.click(screen.getByRole("button", { name: "Delete Order flow" }));
    await user.click(screen.getByRole("button", { name: "Delete file" }));
    expect(onFileDelete).toHaveBeenCalledWith("f2");
  });

  it("recovers a deleted file from the Recently removed modal", async () => {
    const user = userEvent.setup();
    const onFileRestore = vi.fn();
    const { unmount } = mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} files={workspaceFiles} activeFileId="f1" />,
    );
    // No trash, no entry.
    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    expect(screen.queryByRole("menuitem", { name: /Recently removed/ })).not.toBeInTheDocument();
    unmount();

    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        files={workspaceFiles}
        activeFileId="f1"
        removedFiles={[{ id: "gone", name: "Legacy", kind: "arch" }]}
        onFileRestore={onFileRestore}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Platform ▾" }));
    await user.click(screen.getByRole("menuitem", { name: /Recently removed/ }));

    const dialog = screen.getByRole("dialog", { name: "Recently removed" });
    await user.click(within(dialog).getByRole("button", { name: "Restore Legacy" }));
    expect(onFileRestore).toHaveBeenCalledWith("gone");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders file: urls as a jump to the linked file, https as a real link", async () => {
    const user = userEvent.setup();
    const onNavigateFile = vi.fn();
    const doc: DiagramTemplate = {
      version: 1,
      nodes: [
        { id: "a", label: "Orders", kind: "service", icon: "box", description: "", parentId: null, url: "file:Payments", x: 0, y: 0, w: 170, h: 76 },
        { id: "b", label: "Docs", kind: "service", icon: "box", description: "", parentId: null, url: "https://example.com", x: 300, y: 0, w: 170, h: 76 },
      ],
      edges: [],
    };
    const { container } = mount(
      <ArchitectureStudio defaultValue={doc} onNavigateFile={onNavigateFile} />,
    );

    await user.click(screen.getByRole("button", { name: "Open linked file Payments" }));
    expect(onNavigateFile).toHaveBeenCalledWith("Payments");
    // The plain https url stays a normal external link.
    const anchor = container.querySelector('a.as-node__link') as HTMLAnchorElement;
    expect(anchor.href).toContain("example.com");
    expect(anchor.target).toBe("_blank");
  });

  it("redoes an undone edit", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />);

    await fromMenu(user, "Insert ▾", /^Node /);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await user.click(screen.getByRole("button", { name: "Redo" }));

    const afterRedo = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(afterRedo.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length + 1);
  });
});

describe("ArchitectureStudio welcome modal", () => {
  const BLANK: DiagramTemplate = { version: 1, nodes: [], edges: [] };

  // The hand-off latch is module state; a prior test's dismissal must not
  // suppress this test's mount.
  beforeEach(() => clearWelcomeSuppression());

  it("shows over a brand-new document and dismisses via the manual CTA", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={BLANK} />);
    expect(screen.getByRole("dialog", { name: "Get started" })).toBeInTheDocument();
    expect(screen.getByText("BetterDiagrams")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Copy Schema & System Prompt/ }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Insert Node Manually/ }));
    expect(screen.queryByRole("dialog", { name: "Get started" })).not.toBeInTheDocument();
  });

  it("does not show over a document with content", () => {
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);
    expect(screen.queryByRole("dialog", { name: "Get started" })).not.toBeInTheDocument();
  });

  it("treats a zones-only document as content, not blank", () => {
    mount(
      <ArchitectureStudio
        defaultValue={validateTemplate({
          version: 1,
          zones: [{ id: "z", label: "Edge", shape: "rounded", x: 0, y: 0, w: 400, h: 300 }],
          nodes: [],
          edges: [],
        })}
      />,
    );
    expect(screen.queryByRole("dialog", { name: "Get started" })).not.toBeInTheDocument();
  });

  it("stays hidden when readOnly or welcome={false}", () => {
    const { unmount } = mount(<ArchitectureStudio defaultValue={BLANK} readOnly />);
    expect(screen.queryByRole("dialog", { name: "Get started" })).not.toBeInTheDocument();
    unmount();

    mount(<ArchitectureStudio defaultValue={BLANK} welcome={false} />);
    expect(screen.queryByRole("dialog", { name: "Get started" })).not.toBeInTheDocument();
  });

  it("in an empty workspace, the manual CTA creates a file to land in", async () => {
    const user = userEvent.setup();
    const onFileCreate = vi.fn();
    mount(<ArchitectureStudio value={BLANK} files={[]} onFileCreate={onFileCreate} />);
    expect(screen.getByRole("dialog", { name: "Get started" })).toBeInTheDocument();
    expect(screen.getByLabelText("File name")).toHaveValue("Untitled 1");

    await user.click(screen.getByRole("button", { name: /Insert Node Manually/ }));
    expect(onFileCreate).toHaveBeenCalledWith({ name: "Untitled 1", kind: "architecture" });
  });

  it("does not greet the blank file its own dismissal just created", async () => {
    const user = userEvent.setup();
    const onFileCreate = vi.fn();
    const first = mount(<ArchitectureStudio value={BLANK} files={[]} onFileCreate={onFileCreate} />);
    await user.click(screen.getByRole("button", { name: /Insert Node Manually/ }));
    expect(onFileCreate).toHaveBeenCalled();
    first.unmount();

    // The host now remounts the studio on the created (blank) file — the
    // hand-off latch keeps the modal from greeting all over again.
    const second = mount(
      <ArchitectureStudio value={BLANK} files={[{ id: "f1", name: "Untitled 1" }]} activeFileId="f1" />,
    );
    expect(screen.queryByRole("dialog", { name: "Get started" })).not.toBeInTheDocument();
    second.unmount();

    // The latch was cleared on that mount — the next genuinely new blank
    // file greets as usual.
    mount(<ArchitectureStudio defaultValue={BLANK} />);
    expect(screen.getByRole("dialog", { name: "Get started" })).toBeInTheDocument();
  });

  it("lays out a coordinate-less paste on insert instead of stacking at the origin", async () => {
    const user = userEvent.setup();
    const onFileCreate = vi.fn();
    mount(<ArchitectureStudio value={BLANK} files={[]} onFileCreate={onFileCreate} />);

    await user.click(screen.getByLabelText("Diagram JSON"));
    await user.paste(
      '{"version":1,"nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"edges":[]}',
    );
    await user.click(screen.getByRole("button", { name: "Insert" }));

    const doc = onFileCreate.mock.calls[0][0].doc as DiagramTemplate;
    const positions = new Set(doc.nodes.map((n) => `${n.x},${n.y}`));
    expect(positions.size).toBe(2);
  });

  it("keeps explicit coordinates untouched on insert", async () => {
    const user = userEvent.setup();
    const onFileCreate = vi.fn();
    mount(<ArchitectureStudio value={BLANK} files={[]} onFileCreate={onFileCreate} />);

    await user.click(screen.getByLabelText("Diagram JSON"));
    await user.paste(
      '{"version":1,"nodes":[{"id":"a","label":"A","x":100,"y":50},{"id":"b","label":"B","x":400,"y":50}],"edges":[]}',
    );
    await user.click(screen.getByRole("button", { name: "Insert" }));

    const doc = onFileCreate.mock.calls[0][0].doc as DiagramTemplate;
    expect(doc.nodes.map((n) => [n.x, n.y])).toEqual([
      [100, 50],
      [400, 50],
    ]);
  });

  it("the file menu's ＋ New file passes NO init — the click event must not leak", async () => {
    const user = userEvent.setup();
    const onFileCreate = vi.fn();
    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_TEMPLATE}
        files={[{ id: "f1", name: "One" }]}
        activeFileId="f1"
        onFileCreate={onFileCreate}
      />,
    );

    await user.click(screen.getByRole("button", { name: /One/ }));
    await user.click(screen.getByRole("menuitem", { name: /New file/ }));
    expect(onFileCreate).toHaveBeenCalledTimes(1);
    expect(onFileCreate.mock.calls[0]).toHaveLength(0);
  });
});

describe("multi-state export modal", () => {
  it("opens for a multi-state document, and Current exports directly", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);

    await fromMenu(user, "Export ▾", /SVG vector/);
    const dialog = screen.getByRole("dialog", { name: "Export SVG" });
    expect(within(dialog).getByRole("radio", { name: /Current state/ })).toBeChecked();
    // The axes are on display (greyed) even before Custom is chosen.
    expect(within(dialog).getByRole("group", { name: "Cloud Region" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "Dates" })).toBeInTheDocument();
    expect(within(dialog).getByText("1 file → architecture.svg")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    await screen.findByText("Exported architecture.svg");
    expect(screen.queryByRole("dialog", { name: "Export SVG" })).not.toBeInTheDocument();
  });

  it("All states exports one zip of every combination", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);

    await fromMenu(user, "Export ▾", /SVG vector/);
    const dialog = screen.getByRole("dialog", { name: "Export SVG" });
    await user.click(within(dialog).getByRole("radio", { name: /All states/ }));
    expect(within(dialog).getByText("9 files → architecture-states.zip")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Export" }));
    await screen.findByText("Exported 9 states → architecture-states.zip");
  });

  it("Custom disables Export when an axis is emptied, and recounts on reselect", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);

    await fromMenu(user, "Export ▾", /SVG vector/);
    const dialog = screen.getByRole("dialog", { name: "Export SVG" });
    await user.click(within(dialog).getByRole("radio", { name: /Custom/ }));

    const region = within(dialog).getByRole("group", { name: "Cloud Region" });
    for (const box of within(region).getAllByRole("checkbox")) await user.click(box);
    expect(within(dialog).getByText(/Select at least one option/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Export" })).toBeDisabled();

    await user.click(within(region).getAllByRole("checkbox")[1]);
    expect(within(dialog).getByText("3 files → architecture-states.zip")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Export" })).toBeEnabled();
  });

  it("PDF adds the page-layout choice", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_ZONED_TEMPLATE} />);

    await fromMenu(user, "Export ▾", /PDF document/);
    const dialog = screen.getByRole("dialog", { name: "Export PDF" });
    await user.click(within(dialog).getByRole("radio", { name: /All states/ }));
    expect(within(dialog).getByRole("radio", { name: /One PDF, one page/ })).toBeChecked();
    expect(within(dialog).getByText("9 pages → architecture-states.pdf")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("radio", { name: /One PDF per state/ }));
    expect(within(dialog).getByText("9 files → architecture-states.zip")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Export PDF" })).not.toBeInTheDocument();
  });

  it("single-state documents skip the modal and export immediately", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);

    await fromMenu(user, "Export ▾", /SVG vector/);
    expect(screen.queryByRole("dialog", { name: "Export SVG" })).not.toBeInTheDocument();
    await screen.findByText("Exported architecture.svg");
  });

  it("a host-overridden builtin keeps the direct path, no modal", async () => {
    const user = userEvent.setup();
    const run = vi.fn().mockReturnValue(undefined);
    mount(
      <ArchitectureStudio
        defaultValue={EXAMPLE_ZONED_TEMPLATE}
        registry={{ exporters: { svg: { label: "SVG vector", run } } }}
      />,
    );

    await fromMenu(user, "Export ▾", /SVG vector/);
    expect(screen.queryByRole("dialog", { name: "Export SVG" })).not.toBeInTheDocument();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("ArchitectureStudio cloud packs", () => {
  beforeEach(() => clearWelcomeSuppression());

  const AWS_DOC: DiagramTemplate = validateTemplate({
    version: 1,
    zones: [
      { id: "z", label: "AWS", shape: "rounded", x: 0, y: 0, w: 600, h: 400, providers: ["aws"], provider: "aws" },
    ],
    nodes: [{ id: "api", label: "API", kind: "service", x: 40, y: 40 }],
    edges: [],
  });

  it("lifts referenced clouds in the kind picker and demotes the rest", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={AWS_DOC} />);
    fireEvent.click(screen.getByText("API"));
    await user.click(await screen.findByRole("button", { name: "Node kind" }));

    expect(screen.getByRole("option", { name: "Lambda" }).closest(".as-kindmenu__dim")).toBeNull();
    expect(
      screen.getByRole("option", { name: "Cosmos DB" }).closest(".as-kindmenu__dim"),
    ).not.toBeNull();
    expect(
      screen.getByRole("option", { name: "Cloud Run" }).closest(".as-kindmenu__dim"),
    ).not.toBeNull();
  });

  it("retyping to a cloud kind adopts its icon", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={AWS_DOC} onChange={onChange} />);
    fireEvent.click(screen.getByText("API"));
    await user.click(await screen.findByRole("button", { name: "Node kind" }));
    await user.click(screen.getByRole("option", { name: "Lambda" }));

    await waitFor(() => {
      const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
      const node = latest.nodes.find((n) => n.id === "api")!;
      expect(node.kind).toBe("aws-lambda");
      expect(node.icon).toBe("bolt");
    });
  });

  it("the welcome modal's scope picker offers the real pack behind each chip", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={{ version: 1, nodes: [], edges: [] }} />);

    // A blank document starts unscoped — no cloud, so no checklist.
    expect(screen.getByRole("button", { name: "Azure" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByLabelText(/Blob Storage/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Azure" }));
    // The registry's own kinds, ticked whole — and only that cloud's.
    expect(screen.getByLabelText(/Blob Storage/)).toBeChecked();
    expect(screen.getByLabelText(/Key Vault/)).toBeChecked();
    expect(screen.queryByLabelText(/^Lambda/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByLabelText(/Blob Storage/)).not.toBeChecked();
  });

  it("cloud kinds survive a welcome-modal insert intact", async () => {
    const user = userEvent.setup();
    const onFileCreate = vi.fn();
    mount(
      <ArchitectureStudio
        value={{ version: 1, nodes: [], edges: [] }}
        files={[]}
        onFileCreate={onFileCreate}
      />,
    );
    await user.click(screen.getByLabelText("Diagram JSON"));
    await user.paste(
      '{"version":1,"nodes":[{"id":"f","label":"Checkout Fn","kind":"aws-lambda","x":10,"y":10}],"edges":[]}',
    );
    await user.click(screen.getByRole("button", { name: "Insert" }));

    const doc = onFileCreate.mock.calls[0][0].doc as DiagramTemplate;
    expect(doc.nodes[0].kind).toBe("aws-lambda");
  });
});

describe("ArchitectureStudio kind-usage relevance", () => {
  beforeEach(() => clearWelcomeSuppression());

  it("one cloud-kind node lifts that whole cloud in the picker — no providers needed", async () => {
    const user = userEvent.setup();
    // No zones, no providers arrays — the aws-lambda KIND alone is the signal.
    const doc = validateTemplate({
      version: 1,
      nodes: [{ id: "fn", label: "Checkout Fn", kind: "aws-lambda", x: 40, y: 40 }],
      edges: [],
    });
    mount(<ArchitectureStudio defaultValue={doc} />);
    fireEvent.click(screen.getByText("Checkout Fn"));
    await user.click(await screen.findByRole("button", { name: "Node kind" }));

    // The whole AWS pack is first-class…
    expect(
      screen.getByRole("option", { name: "DynamoDB" }).closest(".as-kindmenu__dim"),
    ).toBeNull();
    // …while untouched clouds stay demoted.
    expect(
      screen.getByRole("option", { name: "Vertex AI" }).closest(".as-kindmenu__dim"),
    ).not.toBeNull();
    expect(
      screen.getByRole("option", { name: "App Service" }).closest(".as-kindmenu__dim"),
    ).not.toBeNull();
  });
});

describe("welcome modal type picker (cross-kind insert)", () => {
  const BLANK: DiagramTemplate = { version: 1, nodes: [], edges: [] };
  const seqJson =
    '{"version":1,"participants":[{"id":"u","label":"User","kind":"actor"}],"messages":[]}';

  beforeEach(() => clearWelcomeSuppression());

  it("a sequence paste flips the picker and inserts via onFileCreate — even in a populated workspace", async () => {
    const user = userEvent.setup();
    const onFileCreate = vi.fn();
    const onChange = vi.fn();
    mount(
      <ArchitectureStudio
        value={BLANK}
        onChange={onChange}
        files={[{ id: "f1", name: "Arch", kind: "architecture" }]}
        activeFileId="f1"
        onFileCreate={onFileCreate}
      />,
    );

    const editor = screen.getByLabelText("Diagram JSON");
    await user.click(editor);
    await user.paste(seqJson);
    expect(screen.getByRole("button", { name: "Sequence" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Insert" }));
    expect(onFileCreate).toHaveBeenCalledTimes(1);
    const init = onFileCreate.mock.calls[0][0];
    expect(init.kind).toBe("sequence");
    expect(init.doc.participants).toHaveLength(1);
    expect(init.doc.meta.title).toBe("Arch");
    // The architecture document was never touched.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("without onFileCreate the sequence option is disabled", () => {
    mount(<ArchitectureStudio defaultValue={BLANK} />);
    expect(screen.getByRole("button", { name: "Sequence" })).toBeDisabled();
  });
});

describe("content/presentation split", () => {
  it("imports a layout file by re-dressing the current document", async () => {
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} />,
    );

    const { presentation } = splitTemplate(EXAMPLE_TEMPLATE);
    presentation.nodes!.u = { ...presentation.nodes!.u, x: 777, y: 555 };
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [
          new File([JSON.stringify(presentation)], "d.layout.json", { type: "application/json" }),
        ],
      },
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes.find((n) => n.id === "u")?.x).toBe(777);
    // Everything else kept its place — a layout file is not a shuffle.
    expect(latest.nodes.find((n) => n.id === "db")?.x).toBe(1030);
    expect(screen.getByText(/Applied layout to 9 elements/)).toBeInTheDocument();
  });

  it("counts unmatched records so a wrong-diagram layout can't read as success", async () => {
    const { container } = mount(<ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} />);
    const layout = {
      version: 1,
      format: PRESENTATION_FORMAT,
      nodes: {
        u: { x: 300, y: 300, w: 180, h: 76 },
        ghost: { x: 1, y: 2, w: 100, h: 50 },
      },
    };
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File([JSON.stringify(layout)], "other.layout.json", { type: "application/json" })],
      },
    });
    await waitFor(() =>
      expect(screen.getByText("Applied layout to 1 element · 1 unmatched")).toBeInTheDocument(),
    );
  });

  it("lays out an imported content file — a document that was never placed", async () => {
    const onChange = vi.fn();
    const { container } = mount(
      <ArchitectureStudio defaultValue={{ version: 1, nodes: [], edges: [] }} welcome={false} onChange={onChange} />,
    );

    const { content } = splitTemplate(EXAMPLE_TEMPLATE);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, {
      target: {
        files: [new File([JSON.stringify(content)], "d.content.json", { type: "application/json" })],
      },
    });

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(latest.nodes).toHaveLength(EXAMPLE_TEMPLATE.nodes.length);
    // autoLayout ran: the nodes are not piled at the origin.
    expect(latest.nodes.some((n) => n.x !== 0 || n.y !== 0)).toBe(true);
  });

  it("a content doc handed to the host door (defaultValue) lays itself out", () => {
    const { content } = splitTemplate(EXAMPLE_TEMPLATE);
    const { container } = mount(
      <ArchitectureStudio defaultValue={content as unknown as DiagramTemplate} welcome={false} />,
    );
    // Zones keep their boxes in content, so only real nodes prove the layout.
    const transforms = [...container.querySelectorAll(".react-flow__node-shape")].map(
      (el) => (el as HTMLElement).style.transform,
    );
    expect(transforms.length).toBeGreaterThan(0);
    expect(transforms.some((t) => t && t !== "translate(0px, 0px)")).toBe(true);
  });

  it("a content doc swapped in through the controlled value lays itself out", () => {
    const { content } = splitTemplate(EXAMPLE_TEMPLATE);
    const { container, rerender } = mount(
      <ArchitectureStudio value={EXAMPLE_TEMPLATE} onChange={vi.fn()} welcome={false} />,
    );
    rerender(
      <ArchitectureStudio
        value={content as unknown as DiagramTemplate}
        onChange={vi.fn()}
        welcome={false}
      />,
    );
    const transforms = [...container.querySelectorAll(".react-flow__node-shape")].map(
      (el) => (el as HTMLElement).style.transform,
    );
    expect(transforms.length).toBeGreaterThan(0);
    expect(transforms.some((t) => t && t !== "translate(0px, 0px)")).toBe(true);
  });

  it("refines through the content form and preserves the layout exactly", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { content } = splitTemplate(EXAMPLE_TEMPLATE);
    // The "model" renames the API, adds a metrics service, and wires it up —
    // pure content edits, no geometry anywhere.
    const reply = {
      ...content,
      nodes: [
        ...content.nodes.map((n) => (n.id === "api" ? { ...n, label: "REST API v2" } : n)),
        { id: "metrics", label: "Metrics", kind: "service", icon: "box", description: "", parentId: null },
      ],
      edges: [
        ...content.edges,
        { id: "e8", source: "api", target: "metrics", label: "", style: "dotted", color: "slate" },
      ],
    };
    const generate = vi.fn().mockResolvedValue(reply);
    mount(
      <ArchitectureStudio defaultValue={EXAMPLE_TEMPLATE} onChange={onChange} generate={generate} />,
    );

    await user.click(screen.getByRole("button", { name: "✦ AI" }));
    await user.type(
      screen.getByPlaceholderText('"make the queue edges dotted" · "add a CDN"'),
      "add metrics",
    );
    await user.click(screen.getByRole("button", { name: "Apply refinement" }));

    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const latest = onChange.mock.calls.at(-1)![0] as DiagramTemplate;

    // The request spoke the content form: no coordinates offered, none asked for.
    const req = generate.mock.calls[0][0];
    expect(req.mode).toBe("refine");
    expect(JSON.stringify(req.current)).not.toContain('"x"');
    expect(req.systemPrompt).toContain("NEVER emit x/y/w/h");
    // Node geometry gone from the skeleton (zone boxes stay — they are content).
    expect(req.systemPrompt).not.toContain('"w":170,"h":76');
    expect(req.systemPrompt).not.toContain('"labelT":0.5');

    // Every surviving element kept its exact place…
    const api = latest.nodes.find((n) => n.id === "api")!;
    expect(api.label).toBe("REST API v2");
    expect([api.x, api.y]).toEqual([30, 60]);
    const vpc = latest.nodes.find((n) => n.id === "vpc")!;
    expect([vpc.x, vpc.y, vpc.w, vpc.h]).toEqual([520, 40, 440, 380]);
    expect(latest.nodes.find((n) => n.id === "db")?.x).toBe(1030);
    // …and only the newcomer was placed, below the existing canvas.
    const metrics = latest.nodes.find((n) => n.id === "metrics")!;
    expect(metrics.y).toBeGreaterThan(500);
    expect(latest.edges.some((e) => e.id === "e8")).toBe(true);
  });
});

describe("drill-down (C4 levels)", () => {
  /** A card parent with two levels of detail, an outsider, and crossing edges. */
  const DRILL_DOC: DiagramTemplate = validateTemplate({
    version: 1,
    meta: { title: "Shop" },
    nodes: [
      { id: "web", label: "Storefront", kind: "service", icon: "globe", description: "", parentId: null, x: 100, y: 100, w: 170, h: 76 },
      { id: "pay", label: "Payments Core", kind: "service", icon: "box", description: "", parentId: null, x: 500, y: 100, w: 170, h: 76 },
      { id: "api", label: "Pay API", kind: "service", icon: "box", description: "", parentId: "pay", x: 28, y: 52, w: 170, h: 76 },
      { id: "guard", label: "Auth Guard", kind: "service", icon: "shield", description: "", parentId: "pay", x: 28, y: 180, w: 170, h: 76 },
      { id: "jobs", label: "Job Workers", kind: "group", icon: "none", description: "", parentId: "pay", x: 260, y: 52, w: 300, h: 200 },
      { id: "retry", label: "Retry Worker", kind: "worker", icon: "gear", description: "", parentId: "jobs", x: 20, y: 60, w: 170, h: 76 },
    ],
    edges: [
      { id: "buys", source: "web", target: "api", label: "buys", style: "solid", color: "sky" },
      { id: "wires", source: "api", target: "guard", label: "verifies", style: "solid", color: "slate" },
    ],
  });

  /** Double-click a node body and wait for the focus bar to appear. */
  async function drillIntoLabel(label: string) {
    fireEvent.doubleClick(screen.getByText(label));
    await waitFor(
      () => expect(screen.getByRole("navigation", { name: "Diagram level" })).toBeInTheDocument(),
      { timeout: 2000 },
    );
  }

  it("double-click drills in: focus chrome, children, ghosts", async () => {
    mount(<ArchitectureStudio defaultValue={DRILL_DOC} />);
    await drillIntoLabel("Payments Core");

    // Breadcrumbs: root › focus, with the C4 level chip and the way out.
    const bar = screen.getByRole("navigation", { name: "Diagram level" });
    expect(within(bar).getByText("Shop")).toBeInTheDocument();
    expect(within(bar).getByText("Payments Core")).toBeInTheDocument();
    expect(within(bar).getByText("C2 · Containers")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Exit focus" })).toBeInTheDocument();

    // The level: children visible, group child as a chip, outsider as ghost.
    expect(screen.getByText("Pay API")).toBeInTheDocument();
    expect(screen.getByText("Job Workers")).toBeInTheDocument();
    expect(screen.queryByText("Retry Worker")).not.toBeInTheDocument();
    expect(screen.getByTitle("External to this view — double-click to visit")).toBeInTheDocument();
  });

  it("drilling is a view change — no onChange, nothing to undo", async () => {
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={DRILL_DOC} onChange={onChange} />);
    await drillIntoLabel("Payments Core");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  });

  it("edits inside a level write through; everything else stays byte-identical", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    mount(<ArchitectureStudio defaultValue={DRILL_DOC} onChange={onChange} />);
    await drillIntoLabel("Payments Core");

    await fromMenu(user, "Insert ▾", /^Node /);
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const emitted = onChange.mock.calls.at(-1)![0] as DiagramTemplate;

    const oldIds = new Set(DRILL_DOC.nodes.map((n) => n.id));
    const added = emitted.nodes.filter((n) => !oldIds.has(n.id));
    expect(added).toHaveLength(1);
    expect(added[0].parentId).toBe("pay");

    const kept = emitted.nodes.filter((n) => oldIds.has(n.id));
    expect(JSON.stringify(kept)).toBe(JSON.stringify(DRILL_DOC.nodes));
    expect(JSON.stringify(emitted.edges)).toBe(JSON.stringify(DRILL_DOC.edges));
  });

  it("ghosts cannot be deleted and report their real id to the host", async () => {
    const onChange = vi.fn();
    const onSelectionChange = vi.fn();
    mount(
      <ArchitectureStudio
        defaultValue={DRILL_DOC}
        onChange={onChange}
        onSelectionChange={onSelectionChange}
      />,
    );
    await drillIntoLabel("Payments Core");

    const ghost = screen.getByTitle("External to this view — double-click to visit");
    fireEvent.click(ghost);
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith({ nodes: ["web"], edges: [], zones: [] }),
    );

    fireEvent.keyDown(window, { key: "Delete" });
    await screen.findByText("External elements are edited at their own level");
    expect(onChange).not.toHaveBeenCalled();
    // The ghost inspector is a signpost, not an edit form.
    expect(screen.getByRole("button", { name: "Go to definition" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Node label")).not.toBeInTheDocument();
  });

  it("Escape clears chrome first, then drills out", async () => {
    const user = userEvent.setup();
    mount(<ArchitectureStudio defaultValue={DRILL_DOC} />);
    await drillIntoLabel("Payments Core");

    await user.click(screen.getByRole("button", { name: "Insert ▾" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Diagram level" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Diagram level" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Storefront")).toBeInTheDocument();
  });

  it("breadcrumbs navigate across two levels", async () => {
    mount(<ArchitectureStudio defaultValue={DRILL_DOC} />);
    await drillIntoLabel("Payments Core");
    await drillIntoLabel("Job Workers");

    // The second drill swaps on a timer — wait for the deeper level chip.
    await waitFor(
      () =>
        expect(
          within(screen.getByRole("navigation", { name: "Diagram level" })).getByText(
            "C3 · Components",
          ),
        ).toBeInTheDocument(),
      { timeout: 2000 },
    );
    const bar = screen.getByRole("navigation", { name: "Diagram level" });
    expect(screen.getByText("Retry Worker")).toBeInTheDocument();

    // The root crumb exits everything.
    fireEvent.click(within(bar).getByRole("button", { name: /Shop/ }));
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Diagram level" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Storefront")).toBeInTheDocument();
  });

  it("a leaf drill lands in the empty-boundary state", async () => {
    mount(<ArchitectureStudio defaultValue={DRILL_DOC} />);
    await drillIntoLabel("Storefront");
    expect(screen.getByText(/has no internals yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "＋ Add node" })).toBeInTheDocument();
    // Its external contracts still show: the card it talks to stands in.
    expect(screen.getByTitle("External to this view — double-click to visit")).toBeInTheDocument();
  });

  it("saving while focused hands the host the FULL document", async () => {
    const onSave = vi.fn();
    mount(<ArchitectureStudio defaultValue={DRILL_DOC} onSave={onSave} />);
    await drillIntoLabel("Payments Core");

    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls.at(-1)![0] as DiagramTemplate;
    expect(saved.nodes.map((n) => n.id).sort()).toEqual(
      [...DRILL_DOC.nodes.map((n) => n.id)].sort(),
    );
  });

  it("compare mode exits the drill", async () => {
    const { rerender } = mount(<ArchitectureStudio defaultValue={DRILL_DOC} />);
    await drillIntoLabel("Payments Core");

    rerender(<ArchitectureStudio defaultValue={DRILL_DOC} diffBase={EXAMPLE_TEMPLATE} />);
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Diagram level" })).not.toBeInTheDocument(),
    );
  });

  it("a controlled swap that removes the focus node prunes to the root", async () => {
    function Host() {
      const [value, setValue] = useState<DiagramTemplate>(DRILL_DOC);
      return (
        <>
          <button type="button" onClick={() => setValue(EXAMPLE_TEMPLATE)}>
            swap-doc
          </button>
          <ArchitectureStudio value={value} onChange={setValue} />
        </>
      );
    }
    mount(<Host />);
    await drillIntoLabel("Payments Core");

    fireEvent.click(screen.getByText("swap-doc"));
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Diagram level" })).not.toBeInTheDocument(),
    );
    expect(screen.getByText("REST API")).toBeInTheDocument();
  });

  it("the drill badge counts children and single-click opens the level", async () => {
    mount(<ArchitectureStudio defaultValue={DRILL_DOC} />);
    const badge = screen.getByRole("button", { name: "Open Payments Core — 3 inside" });
    expect(badge).toHaveTextContent("⊞ 3");
    fireEvent.click(badge);
    await waitFor(
      () => expect(screen.getByRole("navigation", { name: "Diagram level" })).toBeInTheDocument(),
      { timeout: 2000 },
    );
  });

  it("readOnly can drill into detail but not into empty leaves", async () => {
    mount(<ArchitectureStudio defaultValue={DRILL_DOC} readOnly />);
    await drillIntoLabel("Payments Core");
    expect(screen.getByText("Pay API")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Diagram level" })).not.toBeInTheDocument(),
    );
    // A leaf has nothing to show a viewer: double-click stays put.
    fireEvent.doubleClick(screen.getByText("Storefront"));
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(screen.queryByRole("navigation", { name: "Diagram level" })).not.toBeInTheDocument();
  });
});

describe("drill-down AI scope", () => {
  const DRILL_DOC: DiagramTemplate = validateTemplate({
    version: 1,
    meta: { title: "Shop" },
    nodes: [
      { id: "web", label: "Storefront", kind: "service", icon: "globe", description: "", parentId: null, x: 100, y: 100, w: 170, h: 76 },
      { id: "pay", label: "Payments Core", kind: "service", icon: "box", description: "", parentId: null, x: 500, y: 100, w: 170, h: 76 },
      { id: "api", label: "Pay API", kind: "service", icon: "box", description: "", parentId: "pay", x: 28, y: 52, w: 170, h: 76 },
    ],
    edges: [{ id: "buys", source: "web", target: "api", label: "buys", style: "solid", color: "sky" }],
  });

  it("focused refine frames the scope; generate steps aside", async () => {
    const user = userEvent.setup();
    const { content } = splitTemplate(DRILL_DOC);
    const reply = {
      ...content,
      nodes: [
        ...content.nodes,
        { id: "ledger", label: "Ledger", kind: "database", icon: "database", description: "", parentId: "pay" },
      ],
    };
    const generate = vi.fn().mockResolvedValue(reply);
    mount(<ArchitectureStudio defaultValue={DRILL_DOC} generate={generate} />);

    fireEvent.doubleClick(screen.getByText("Payments Core"));
    await waitFor(
      () => expect(screen.getByRole("navigation", { name: "Diagram level" })).toBeInTheDocument(),
      { timeout: 2000 },
    );

    await user.click(screen.getByRole("button", { name: "✦ AI" }));
    // Generate is unavailable while focused — the panel hands the way out.
    expect(screen.queryByPlaceholderText(/Paste requirements/)).not.toBeInTheDocument();
    expect(screen.getByText(/Generate replaces the whole diagram/)).toBeInTheDocument();
    // The refine section says exactly where it will work.
    expect(screen.getByText(/Refining inside: “Payments Core” · C2 · Containers/)).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText('"add a cache between these" · "split the parser"'),
      "add a ledger",
    );
    await user.click(screen.getByRole("button", { name: "Apply refinement" }));

    await waitFor(() => expect(generate).toHaveBeenCalled());
    const req = generate.mock.calls[0][0];
    expect(req.input).toContain('drilled into "Payments Core" (node id "pay")');
    expect(req.input).toContain("add a ledger");

    // The reply lands, the focus survives, and the new part joins the level.
    await waitFor(() => expect(screen.getByText("Ledger")).toBeInTheDocument(), { timeout: 2000 });
    expect(screen.getByRole("navigation", { name: "Diagram level" })).toBeInTheDocument();
  });
});

describe("drill-down under StrictMode + controlled mode", () => {
  // The example app's exact wiring. StrictMode double-invokes render, which
  // is how half-advanced materialization refs have destroyed data before —
  // the drill's focus refs ride the same choreography, so prove the loop:
  // drill in, edit, and the controlled round-trip must lose nothing.
  it("drills, edits, and round-trips losslessly", async () => {
    const user = userEvent.setup();
    const DOC: DiagramTemplate = validateTemplate({
      version: 1,
      meta: { title: "Strict" },
      nodes: [
        { id: "web", label: "Storefront", kind: "service", icon: "globe", description: "", parentId: null, x: 100, y: 100, w: 170, h: 76 },
        { id: "pay", label: "Payments Core", kind: "service", icon: "box", description: "", parentId: null, x: 500, y: 100, w: 170, h: 76 },
        { id: "api", label: "Pay API", kind: "service", icon: "box", description: "", parentId: "pay", x: 28, y: 52, w: 170, h: 76 },
      ],
      edges: [{ id: "buys", source: "web", target: "api", label: "buys", style: "solid", color: "sky" }],
    });

    function Host() {
      const [value, setValue] = useState<DiagramTemplate>(DOC);
      return <ArchitectureStudio value={value} onChange={setValue} />;
    }
    mount(
      <StrictMode>
        <Host />
      </StrictMode>,
    );

    fireEvent.doubleClick(screen.getByText("Payments Core"));
    await waitFor(
      () => expect(screen.getByRole("navigation", { name: "Diagram level" })).toBeInTheDocument(),
      { timeout: 2000 },
    );

    // Edit inside the level, then leave it.
    await fromMenu(user, "Insert ▾", /^Node /);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("navigation", { name: "Diagram level" })).not.toBeInTheDocument(),
    );

    // Nothing was eaten by the double-invoked choreography: the outsider,
    // the card, its detail, and the crossing edge are all still on the doc.
    fireEvent.doubleClick(screen.getByText("Payments Core"));
    await waitFor(
      () => expect(screen.getByText("Pay API")).toBeInTheDocument(),
      { timeout: 2000 },
    );
    expect(
      screen.getByTitle("External to this view — double-click to visit"),
    ).toBeInTheDocument();
  });
});

describe("Tidy respects the level you are looking at", () => {
  it("arranges the focused level and leaves the visible canvas alone", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    // Two children piled at the same spot inside the card.
    const DOC: DiagramTemplate = validateTemplate({
      version: 1,
      meta: { title: "Shop" },
      nodes: [
        { id: "web", label: "Storefront", kind: "service", icon: "globe", description: "", parentId: null, x: 100, y: 100, w: 170, h: 76 },
        { id: "pay", label: "Payments Core", kind: "service", icon: "box", description: "", parentId: null, x: 500, y: 100, w: 170, h: 76 },
        { id: "api", label: "Pay API", kind: "service", icon: "box", description: "", parentId: "pay", x: 20, y: 20, w: 170, h: 76 },
        { id: "guard", label: "Auth Guard", kind: "service", icon: "shield", description: "", parentId: "pay", x: 20, y: 20, w: 170, h: 76 },
      ],
      edges: [{ id: "wires", source: "api", target: "guard", label: "", style: "solid", color: "slate" }],
    });

    mount(<ArchitectureStudio defaultValue={DOC} onChange={onChange} />);
    fireEvent.doubleClick(screen.getByText("Payments Core"));
    await waitFor(
      () => expect(screen.getByRole("navigation", { name: "Diagram level" })).toBeInTheDocument(),
      { timeout: 2000 },
    );

    await fromMenu(user, "Arrange ▾", /^Tidy/);
    await screen.findByText("Tidied this level");

    const emitted = onChange.mock.calls.at(-1)![0] as DiagramTemplate;
    const api = emitted.nodes.find((n) => n.id === "api")!;
    const guard = emitted.nodes.find((n) => n.id === "guard")!;
    // The pile was separated, in the card's own local coordinates…
    expect([api.x, api.y]).not.toEqual([guard.x, guard.y]);
    // …the card kept its own footprint on the level above…
    expect(emitted.nodes.find((n) => n.id === "pay")).toMatchObject({
      x: 500,
      y: 100,
      w: 170,
      h: 76,
    });
    // …and nothing on the visible canvas moved.
    expect(emitted.nodes.find((n) => n.id === "web")).toMatchObject({ x: 100, y: 100 });
  });
});
