import { writeFile } from "node:fs/promises";
import { expect, test } from "./fixtures";

test.describe("Compare", () => {
  test("overlays a baseline file and reports what was added, removed, and changed", async ({ page, studio }, testInfo) => {
    await studio.goto();
    const live = await studio.liveDoc();

    // The baseline knows a node the live document doesn't, and calls CDN
    // something else; the live document, in turn, gets a node of its own.
    const baseline = {
      ...live,
      nodes: [
        ...live.nodes.map((node) => (node.id === "cdn" ? { ...node, label: "Edge cache" } : node)),
        { id: "legacy", label: "Legacy Gateway", kind: "gateway", x: 900, y: 40, w: 170, h: 76 },
      ],
    };
    const file = testInfo.outputPath("baseline.json");
    await writeFile(file, JSON.stringify(baseline));
    await studio.fromMenu("Insert", /^Node /);

    const chooser = page.waitForEvent("filechooser");
    await studio.root.getByRole("button", { name: "Compare", exact: true }).click();
    await (await chooser).setFiles(file);

    const bar = studio.root.getByRole("status").filter({ hasText: "vs baseline" });
    await expect(bar).toBeVisible();
    await expect(bar.locator(".as-diffbar__chip--added")).toHaveText("+1");
    await expect(bar.locator(".as-diffbar__chip--removed")).toHaveText("−1");
    await expect(bar.locator(".as-diffbar__chip--changed")).toHaveText("~1");

    // Leaving the overlay hands back the document exactly as it was.
    await bar.getByRole("button", { name: "Exit compare" }).click();
    await expect(bar).toBeHidden();
    await expect(studio.nodeTitled("New Service")).toBeVisible();
    await expect(studio.nodeTitled("CDN")).toBeVisible();
    const after = await studio.liveDoc();
    expect(after.nodes).toHaveLength(live.nodes.length + 1);
  });
});
