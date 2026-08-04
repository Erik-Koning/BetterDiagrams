/**
 * @vitest-environment jsdom
 *
 * KindSelect — the relevance-aware node-type picker. Core kinds first, the
 * referenced clouds' kinds un-demoted, everything else grayed at the bottom
 * but still selectable.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { KindSelect } from "./KindSelect";
import { createRegistry } from "./create-registry";

const registry = createRegistry();

function mountPicker(relevant: string[] = [], onChange = vi.fn()) {
  render(
    <KindSelect
      registry={registry}
      value="service"
      onChange={onChange}
      relevantProviders={new Set(relevant)}
    />,
  );
  return onChange;
}

const open = async (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("button", { name: "Node kind" }));

describe("KindSelect", () => {
  it("opens a listbox with the core kinds in the main area", async () => {
    const user = userEvent.setup();
    mountPicker();
    await open(user);
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeInTheDocument();
    const service = screen.getByRole("option", { name: "Service" });
    expect(service).toHaveAttribute("aria-selected", "true");
    expect(service.closest(".as-kindmenu__dim")).toBeNull();
  });

  it("demotes every cloud into the bottom section when none is referenced", async () => {
    const user = userEvent.setup();
    mountPicker([]);
    await open(user);
    expect(screen.getByText("Other clouds")).toBeInTheDocument();
    for (const label of ["Lambda", "Functions", "Pub/Sub"]) {
      expect(screen.getByRole("option", { name: label }).closest(".as-kindmenu__dim")).not.toBeNull();
    }
  });

  it("lifts a referenced cloud out of the demoted section", async () => {
    const user = userEvent.setup();
    mountPicker(["aws"]);
    await open(user);
    // AWS kinds sit in the main area under an AWS header…
    expect(screen.getByRole("option", { name: "Lambda" }).closest(".as-kindmenu__dim")).toBeNull();
    expect(screen.getByText("AWS")).toBeInTheDocument();
    // …while the other clouds stay demoted.
    expect(
      screen.getByRole("option", { name: "Cosmos DB" }).closest(".as-kindmenu__dim"),
    ).not.toBeNull();
    expect(
      screen.getByRole("option", { name: "Cloud Run" }).closest(".as-kindmenu__dim"),
    ).not.toBeNull();
  });

  it("selecting an option fires onChange and closes", async () => {
    const user = userEvent.setup();
    const onChange = mountPicker(["aws"]);
    await open(user);
    await user.click(screen.getByRole("option", { name: "DynamoDB" }));
    expect(onChange).toHaveBeenCalledWith("aws-dynamodb");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("demoted options are still selectable", async () => {
    const user = userEvent.setup();
    const onChange = mountPicker(["aws"]);
    await open(user);
    await user.click(screen.getByRole("option", { name: "Service Bus" }));
    expect(onChange).toHaveBeenCalledWith("azure-service-bus");
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    mountPicker();
    await open(user);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
