/**
 * @vitest-environment jsdom
 *
 * schema-import.test.tsx — loading a real schema into the editor: a SQL
 * script through Import, a dbt project's target/ through Import folder, a
 * dbt manifest on its own, and DDL pasted into the welcome modal's parser.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ArchitectureStudio } from "./ArchitectureStudio";
import { parseArchitectureText } from "./welcome-parse";
import { sniffKind } from "./WelcomeModal";
import type { DiagramTemplate } from "../contract/schema";

afterEach(cleanup);

// The package root: jsdom's import.meta.url is not a file URL.
const fixture = (path: string) => readFileSync(resolve(process.cwd(), "src/contract/import/fixtures", path), "utf8");

function mount(ui: React.ReactElement) {
  return render(ui, {
    container: Object.assign(document.body.appendChild(document.createElement("div")), { style: "width: 1200px; height: 800px" }),
  });
}
const last = (onChange: ReturnType<typeof vi.fn>) => onChange.mock.calls.at(-1)?.[0] as DiagramTemplate | undefined;

describe("loading a schema", () => {
  it("Import reads a .sql script into tables, keys and schema groups, laid out, with its notes", async () => {
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio onChange={onChange} />);
    const input = container.querySelector('input[type="file"][accept*=".sql"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([fixture("postgres.sql")], "shop.sql", { type: "application/sql" })] } });
    await waitFor(() => expect(last(onChange)?.nodes.some((n) => n.id === "sales.order_lines")).toBe(true));
    const doc = last(onChange)!;
    expect(doc.meta?.title).toBe("shop");
    expect(doc.edges).toHaveLength(4);
    // Laid out, not piled at the origin.
    expect(new Set(doc.nodes.map((n) => `${n.x},${n.y}`)).size).toBeGreaterThan(2);
    expect(await screen.findByText(/Imported 4 tables · 4 keys from shop\.sql/)).toBeInTheDocument();
    expect(screen.getByText(/1 view skipped/)).toBeInTheDocument();
  });

  it("Import folder reads a dbt project's target/ — manifest and catalog together", async () => {
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio onChange={onChange} />);
    const input = container.querySelector("input[webkitdirectory]") as HTMLInputElement;
    const file = (path: string, text: string) => {
      const f = new File([text], path.slice(path.lastIndexOf("/") + 1), { type: "application/json" });
      Object.defineProperty(f, "webkitRelativePath", { value: path });
      return f;
    };
    fireEvent.change(input, {
      target: {
        files: [
          file("jaffle/target/manifest.json", fixture("dbt/manifest.json")),
          file("jaffle/target/catalog.json", fixture("dbt/catalog.json")),
          file("jaffle/target/run_results.json", "{}"),
        ],
      },
    });
    await waitFor(() => expect(last(onChange)?.nodes.some((n) => n.id === "marts.orders")).toBe(true));
    const customers = last(onChange)!.nodes.find((n) => n.id === "marts.customers")!;
    // The catalog's types arrived with it.
    expect(customers.fields!.find((f) => f.id === "customer_id")!.type).toBe("NUMBER");
    expect(await screen.findByText(/from the dbt manifest and catalog/)).toBeInTheDocument();
  });

  it("Import takes a dbt manifest.json on its own", async () => {
    const onChange = vi.fn();
    const { container } = mount(<ArchitectureStudio onChange={onChange} />);
    const input = container.querySelector('input[type="file"][accept*=".sql"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File([fixture("dbt/manifest.json")], "manifest.json", { type: "application/json" })] } });
    await waitFor(() => expect(last(onChange)?.meta?.title).toBe("jaffle_shop"));
  });

  it("the welcome modal takes pasted DDL as an architecture document", () => {
    const sql = fixture("sqlite.sql");
    expect(sniffKind(sql)).toBe("architecture");
    const doc = parseArchitectureText(sql);
    expect(doc.nodes.map((n) => n.id)).toEqual(["artists", "albums"]);
    expect(doc.nodes.some((n) => n.x !== 0 || n.y !== 0)).toBe(true);
    // Keys added to tables the script never creates: nothing to draw.
    expect(() => parseArchitectureText("ALTER TABLE missing ADD CONSTRAINT pk PRIMARY KEY (id);")).toThrow(/No CREATE TABLE/);
  });
});
