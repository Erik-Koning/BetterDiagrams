import { expect, SMALL_TEMPLATE, test } from "./fixtures";
import type { Route } from "@playwright/test";

/** What the example's server route receives (see packages/…/contract/llm.ts). */
interface GenerateRequest {
  mode: "create" | "refine";
  input: string;
  systemPrompt: string;
  current?: { nodes: Array<{ id: string; label: string; kind: string }>; edges: unknown[] };
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

test.describe("AI generation through the host's proxy route", () => {
  test("generate replaces the diagram with the model's reply", async ({ page, studio }) => {
    await studio.goto();
    const requests: GenerateRequest[] = [];
    await page.route("**/api/diagram", (route) => {
      requests.push(route.request().postDataJSON());
      // Raw text with a code fence, the way a model actually answers — the
      // client is expected to strip and repair it.
      return json(route, 200, { text: "```json\n" + JSON.stringify(SMALL_TEMPLATE) + "\n```" });
    });

    await studio.root.getByRole("button", { name: "✦ AI" }).click();
    const panel = studio.root.locator(".as-panel");
    await panel.getByPlaceholder(/Paste requirements/).fill("An auth service backed by a users database");
    await panel.getByRole("button", { name: "Generate diagram" }).click();

    await expect(studio.nodeTitled("Auth Service")).toBeVisible();
    await expect(studio.nodeTitled("Users DB")).toBeVisible();
    await expect(studio.nodeTitled("REST API")).toHaveCount(0);

    expect(requests).toHaveLength(1);
    expect(requests[0].mode).toBe("create");
    expect(requests[0].input).toBe("An auth service backed by a users database");
    // The system prompt is generated from the registry, so the host's custom
    // kinds are offered to the model without any wiring.
    expect(requests[0].systemPrompt).toContain("vault");
  });

  test("refine sends the current document and applies the edited reply", async ({ page, studio }) => {
    await studio.goto();
    const requests: GenerateRequest[] = [];
    await page.route("**/api/diagram", (route) => {
      const request: GenerateRequest = route.request().postDataJSON();
      requests.push(request);
      const current = request.current!;
      return json(route, 200, {
        template: {
          ...current,
          nodes: [...current.nodes, { id: "edge-cdn", label: "Edge CDN", kind: "gateway" }],
        },
      });
    });

    await studio.root.getByRole("button", { name: "✦ AI" }).click();
    const refine = studio.root.locator(".as-panel").getByPlaceholder(/add a CDN/);
    await refine.fill("add a CDN in front of the API");
    await refine.press("Enter");

    await expect(studio.nodeTitled("Edge CDN")).toBeVisible();
    await expect(studio.nodeTitled("REST API")).toBeVisible();

    expect(requests).toHaveLength(1);
    expect(requests[0].mode).toBe("refine");
    expect(requests[0].current?.nodes.map((node) => node.id)).toContain("api");
  });

  test("shows the server's error message in the panel and leaves the diagram alone", async ({ page, studio }) => {
    await studio.goto();
    await page.route("**/api/diagram", (route) => json(route, 503, { error: "Model unavailable" }));

    await studio.root.getByRole("button", { name: "✦ AI" }).click();
    const panel = studio.root.locator(".as-panel");
    await panel.getByPlaceholder(/Paste requirements/).fill("anything");
    await panel.getByRole("button", { name: "Generate diagram" }).click();

    await expect(panel.locator(".as-error")).toContainText("Model unavailable");
    await expect(studio.nodeTitled("REST API")).toBeVisible();
    await expect(studio.saveButton).toHaveText("Save");
  });

  test("the host can withhold the generator, which removes the AI button", async ({ page, studio }) => {
    await studio.goto();
    const ai = studio.root.getByRole("button", { name: "✦ AI" });

    await expect(ai).toBeVisible();
    await page.getByLabel("AI panel", { exact: true }).uncheck();
    await expect(ai).toBeHidden();
  });
});
