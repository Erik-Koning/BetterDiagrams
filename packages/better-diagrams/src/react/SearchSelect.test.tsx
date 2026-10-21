/**
 * @vitest-environment jsdom
 *
 * SearchSelect — the inspector's pickers, searchable: a box at the top of the
 * menu, focused on open, and a key typed on the closed button opens it
 * already searching.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { matchesQuery, SearchSelect } from "./SearchSelect";
import { KindSelect } from "./KindSelect";
import { createRegistry } from "./create-registry";

const OPTIONS = [
  { value: "database", label: "database" },
  { value: "server", label: "server" },
  { value: "layers", label: "layers", disabled: true },
  { value: "none", label: "no icon" },
];

function mount(props: Partial<Parameters<typeof SearchSelect>[0]> = {}) {
  const onChange = vi.fn();
  render(<SearchSelect value="server" options={OPTIONS} onChange={onChange} aria-label="Node icon" {...props} />);
  return onChange;
}

const rows = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("matchesQuery", () => {
  it("wants every word, in any order, ignoring case", () => {
    expect(matchesQuery("", "Lambda")).toBe(true);
    expect(matchesQuery("AWS lam", "Lambda", "aws-lambda", "AWS")).toBe(true);
    expect(matchesQuery("lam gcp", "Lambda", "aws-lambda", "AWS")).toBe(false);
  });
});

describe("SearchSelect", () => {
  it("opens with the search box focused, and typing narrows the rows", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Node icon" }));
    const box = screen.getByRole("combobox", { name: "Search Node icon" });
    expect(box).toHaveFocus();
    expect(rows()).toEqual(["database", "server", "layers", "no icon"]);
    await user.keyboard("er");
    expect(rows()).toEqual(["server", "layers"]);
    await user.keyboard("zz");
    expect(rows()).toEqual([]);
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("a key typed on the closed button opens it already searching", async () => {
    const user = userEvent.setup();
    const onChange = mount();
    screen.getByRole("button", { name: "Node icon" }).focus();
    await user.keyboard("dat");
    expect(screen.getByRole("combobox", { name: "Search Node icon" })).toHaveValue("dat");
    expect(rows()).toEqual(["database"]);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("database");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Node icon" })).toHaveFocus();
  });

  it("keeps the keys it takes from the editor's shortcuts on window, and only those", async () => {
    const user = userEvent.setup();
    mount();
    const onWindowKey = vi.fn((event: KeyboardEvent) => event.key);
    window.addEventListener("keydown", onWindowKey);
    try {
      screen.getByRole("button", { name: "Node icon" }).focus();
      await user.keyboard("d");
      expect(onWindowKey).not.toHaveBeenCalled();
      await user.keyboard("{Escape}{ArrowDown}");
      expect(onWindowKey.mock.results.map((r) => r.value)).not.toContain("ArrowDown");
      await user.keyboard("{Escape}{Meta>}z{/Meta}");
      expect(onWindowKey.mock.results.map((r) => r.value)).toContain("z");
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("finds a row by its value as well as its label", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Node icon" }));
    await user.keyboard("none");
    expect(rows()).toEqual(["no icon"]);
  });

  it("opens on the current row; arrows skip a disabled one, and clicking it does nothing", async () => {
    const user = userEvent.setup();
    const onChange = mount();
    await user.click(screen.getByRole("button", { name: "Node icon" }));
    expect(screen.getByRole("option", { name: "server" })).toHaveAttribute("data-active", "true");
    // Down from server, past layers, to no icon.
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith("none");

    await user.click(screen.getByRole("button", { name: "Node icon" }));
    await user.click(screen.getByRole("option", { name: "layers" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("Escape closes without choosing and gives focus back to the button", async () => {
    const user = userEvent.setup();
    const onChange = mount();
    await user.click(screen.getByRole("button", { name: "Node icon" }));
    await user.keyboard("dat{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Node icon" })).toHaveFocus();
    // And the search starts fresh next time.
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("combobox", { name: "Search Node icon" })).toHaveValue("");
  });

  it("a mixed selection reads Mixed, ticks nothing, and takes any pick", async () => {
    const user = userEvent.setup();
    const onChange = mount({ mixed: true });
    expect(screen.getByRole("button", { name: "Node icon" })).toHaveTextContent("Mixed");
    await user.click(screen.getByRole("button", { name: "Node icon" }));
    expect(screen.getAllByRole("option").every((o) => o.getAttribute("aria-selected") === "false")).toBe(true);
    // Even the value the first node already has: the others take it too.
    await user.click(screen.getByRole("option", { name: "server" }));
    expect(onChange).toHaveBeenCalledWith("server");
  });

  it("a value no row offers reads as itself, not as Mixed", () => {
    mount({ value: "12" });
    expect(screen.getByRole("button", { name: "Node icon" })).toHaveTextContent("12");
  });

  it("closes when something around it scrolls, as a native select does", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Node icon" }));
    // Its own list scrolling is the menu working, not the page moving.
    screen.getByRole("listbox").dispatchEvent(new Event("scroll"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    document.dispatchEvent(new Event("scroll"));
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  });

  it("a disabled picker neither opens nor searches", async () => {
    const user = userEvent.setup();
    mount({ disabled: true });
    const button = screen.getByRole("button", { name: "Node icon" });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});

describe("KindSelect searches every section at once", () => {
  const registry = createRegistry();

  it("by kind name and by cloud", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<KindSelect registry={registry} value="service" onChange={onChange} relevantProviders={new Set()} />);
    await user.click(screen.getByRole("button", { name: "Node kind" }));
    await user.keyboard("datab");
    // A core kind, and a demoted cloud's — the cloud headers come along.
    expect(screen.getByRole("option", { name: "Database" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Service" })).not.toBeInTheDocument();

    await user.clear(screen.getByRole("combobox", { name: "Search Node kind" }));
    await user.keyboard("aws dynamo");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["DynamoDB"]);
    expect(screen.getByText("AWS")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("aws-dynamodb");
  });
});
