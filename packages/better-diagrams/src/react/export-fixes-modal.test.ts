/**
 * @vitest-environment jsdom
 *
 * The "which states?" modal's refusal. It lives in its own file because it is
 * the one export regression that needs a DOM; `createElement` stands in for
 * JSX so the file stays a `.ts` beside the rest of the export fixes.
 */
import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createRegistry } from "./create-registry";
import { ExportStatesModal } from "./ExportStatesModal";
import type { StateAxes } from "../contract/states";

const registry = createRegistry();

/** 3 zones × 3 providers × 10 dates = 270 renders — past any sane limit. */
const hugeAxes: StateAxes = {
  zones: ["a", "b", "c"].map((id) => ({
    zoneId: id,
    label: id.toUpperCase(),
    slug: id,
    providers: ["aws", "azure", "gcp"],
    current: "aws",
  })),
  stops: Array.from({ length: 10 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}-01`),
};

const mount = (axes: StateAxes) =>
  render(
    createElement(ExportStatesModal, {
      format: "png" as const,
      axes,
      registry,
      filename: "diagram",
      onCancel: () => {},
      onConfirm: () => {},
    }),
  );

describe("ExportStatesModal", () => {
  it("refuses 'all states' on the same terms it refuses a custom selection", async () => {
    mount(hugeAxes);
    const exportButton = screen.getByRole("button", { name: "Export" });
    expect(exportButton).toBeEnabled();

    // The count line has always said "too many"; the button used to start the
    // 270 renders anyway, because only Custom was gated.
    await userEvent.click(screen.getByRole("radio", { name: /All states/ }));
    expect(screen.getByText(/270 states — too many/)).toBeTruthy();
    expect(exportButton).toBeDisabled();

    await userEvent.click(screen.getByRole("radio", { name: /Custom/ }));
    expect(exportButton).toBeDisabled();
  });

  it("still allows a selection that is merely large", async () => {
    mount({ zones: hugeAxes.zones.slice(0, 1), stops: hugeAxes.stops });
    await userEvent.click(screen.getByRole("radio", { name: /All states/ }));
    expect(screen.getByRole("button", { name: "Export" })).toBeEnabled();
  });
});
