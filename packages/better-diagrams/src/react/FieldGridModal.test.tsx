/**
 * @vitest-environment jsdom
 *
 * FieldGridModal.test.tsx — the grid sorts, filters, walks with the
 * keyboard, follows references, pins, copies and downloads; Escape closes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { validateTemplate, type DiagramTemplate } from "../contract/schema";
import { FieldGridModal } from "./FieldGridModal";

afterEach(cleanup);

const DOC: DiagramTemplate = validateTemplate({
  version: 1,
  nodes: [
    {
      id: "contact", label: "Contact", kind: "table", icon: "none", description: "", parentId: null, x: 0, y: 0, w: 230, h: 120,
      fields: [{ id: "Id", name: "Id", key: "pk" }, { id: "AccountId", name: "AccountId", key: "fk", type: "→ Account" }],
      data: {
        fields: [
          { name: "Id", type: "id" },
          { name: "AccountId", label: "Account ID", type: "reference", relationship: { referenceTo: ["Account"] } },
          { name: "Email", label: "Email", type: "email", visible: false },
          { name: "Score", label: "Score", type: "double", formula: "1 + 1", unique: true },
        ],
      },
    },
    { id: "account", label: "Account", kind: "table", icon: "none", description: "", parentId: null, x: 400, y: 0, w: 230, h: 96, fields: [{ id: "Id", name: "Id", key: "pk" }] },
  ],
  edges: [{ id: "c-a", source: "contact", target: "account", label: "", style: "solid", color: "slate", startField: "AccountId", endField: "Id" }],
});

function mountGrid(over: Partial<React.ComponentProps<typeof FieldGridModal>> = {}) {
  const props = {
    node: DOC.nodes[0],
    doc: DOC,
    filename: "shop",
    pins: [],
    onTogglePin: vi.fn(),
    onNavigate: vi.fn(),
    onDownload: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  const utils = render(<FieldGridModal {...props} />);
  return { ...utils, props };
}

const rowIds = () => screen.getAllByRole("row").slice(1).map((r) => r.getAttribute("data-field-id"));

describe("FieldGridModal", () => {
  it("lists every field record, rows and data-only, in a labelled dialog", () => {
    mountGrid();
    expect(screen.getByRole("dialog", { name: "Contact — fields" })).toBeInTheDocument();
    expect(rowIds()).toEqual(["Id", "AccountId", "Email", "Score"]);
    expect(screen.getByText("4 fields")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Email/ }).className).toContain("as-grid__row--data");
    expect(within(screen.getByRole("row", { name: /Email/ })).getByText("hidden")).toBeInTheDocument();
  });

  it("sorts by a column header, ascending then descending then off", () => {
    mountGrid();
    const th = screen.getByRole("columnheader", { name: /Label/ });
    fireEvent.click(within(th).getByRole("button"));
    expect(th).toHaveAttribute("aria-sort", "ascending");
    expect(rowIds()).toEqual(["AccountId", "Email", "Score", "Id"]);
    fireEvent.click(within(th).getByRole("button"));
    expect(th).toHaveAttribute("aria-sort", "descending");
    expect(rowIds()[0]).toBe("Id");
    fireEvent.click(within(th).getByRole("button"));
    expect(th).toHaveAttribute("aria-sort", "none");
    expect(rowIds()).toEqual(["Id", "AccountId", "Email", "Score"]);
  });

  it("filters, and says how many remain", () => {
    mountGrid();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter fields" }), { target: { value: "acc" } });
    expect(rowIds()).toEqual(["AccountId"]);
    expect(screen.getByText("1 / 4")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter fields" }), { target: { value: "zzz" } });
    expect(screen.getByText("No field matches the filter")).toBeInTheDocument();
  });

  it("opens on a field, and walks rows with the keyboard; Enter follows a reference, p pins", () => {
    const { props } = mountGrid({ initialFieldId: "Email" });
    const email = screen.getByRole("row", { name: /Email/ });
    expect(email).toHaveAttribute("aria-selected", "true");
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    const accountId = screen.getByRole("row", { name: /AccountId/ });
    expect(accountId).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(grid, { key: "Enter" });
    // The table, plus which field was followed and through what — so the
    // parent can mark both halves of the join.
    expect(props.onNavigate).toHaveBeenCalledWith("account", {
      from: { nodeId: "contact", fieldId: "AccountId" },
      target: { label: "Account", nodeId: "account", edgeId: "c-a" },
    });
    fireEvent.keyDown(grid, { key: "p" });
    expect(props.onTogglePin).toHaveBeenCalledWith({ nodeId: "contact", fieldId: "AccountId" });
    fireEvent.keyDown(grid, { key: "End" });
    expect(screen.getByRole("row", { name: /Score/ })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(grid, { key: "Home" });
    expect(screen.getByRole("row", { name: /\bId\b/ })).toHaveAttribute("aria-selected", "true");
  });

  it("reference cells are links; the pin column mirrors the pins", () => {
    const { props } = mountGrid({ pins: [{ nodeId: "contact", fieldId: "Id" }] });
    fireEvent.click(screen.getByRole("button", { name: "Go to Account" }));
    expect(props.onNavigate).toHaveBeenCalledWith("account", {
      from: { nodeId: "contact", fieldId: "AccountId" },
      target: { label: "Account", nodeId: "account", edgeId: "c-a" },
    });
    expect(screen.getByRole("button", { name: "Unpin Id" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Pin Email" }));
    expect(props.onTogglePin).toHaveBeenCalledWith({ nodeId: "contact", fieldId: "Email" });
  });

  it("copies TSV of the visible rows and downloads CSV", async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const { props } = mountGrid();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter fields" }), { target: { value: "score" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy TSV" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const tsv = writeText.mock.calls[0][0] as string;
    expect(tsv.split("\n")[1].split("\t")[1]).toBe("Score");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(props.onDownload).toHaveBeenCalledTimes(1);
    const [blob, name] = (props.onDownload as ReturnType<typeof vi.fn>).mock.calls[0] as [Blob, string];
    expect(name).toBe("shop-contact-fields.csv");
    expect(blob.type).toBe("text/csv");
  });

  it("Escape and Close both close", () => {
    const { props } = mountGrid();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
