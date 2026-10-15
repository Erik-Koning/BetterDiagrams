import { expect, SMALL_TEMPLATE, test } from "./fixtures";
import type { Page, Route } from "@playwright/test";

/** What the example's server route receives (see packages/…/contract/llm.ts). */
interface GenerateRequest {
  mode: "create" | "refine";
  input: string;
  systemPrompt: string;
  current?: { nodes: Array<{ id: string; label: string; kind: string }>; edges: unknown[] };
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** The model's reply to a chat turn: a note for the user, then the document. */
const chatReply = (note: string, doc: unknown) => `${note}\n\`\`\`json\n${JSON.stringify(doc)}\n\`\`\``;

/** Answer every chat turn by adding one gateway node, in the shape a model replies in. */
async function answerByAdding(page: Page, requests: GenerateRequest[]) {
  await page.route("**/api/diagram", (route) => {
    const request: GenerateRequest = route.request().postDataJSON();
    requests.push(request);
    const current = request.current!;
    const n = requests.length;
    return json(route, 200, {
      text: chatReply(`Added gateway ${n}.`, {
        ...current,
        nodes: [...current.nodes, { id: `gw-${n}`, label: `Gateway ${n}`, kind: "gateway" }],
      }),
    });
  });
}

test.describe("AI generation through the host's proxy route", () => {
  // The host opens with the panel withheld; every case here needs it on.
  test.beforeEach(async ({ studio }) => {
    await studio.goto();
    await (await studio.setting("AI panel")).check();
  });

  test("generate replaces the diagram with the model's reply", async ({ page, studio }) => {
    const requests: GenerateRequest[] = [];
    await page.route("**/api/diagram", (route) => {
      requests.push(route.request().postDataJSON());
      // Raw text with a code fence, the way a model actually answers — the
      // client is expected to strip and repair it.
      return json(route, 200, { text: "```json\n" + JSON.stringify(SMALL_TEMPLATE) + "\n```" });
    });

    await studio.root.getByRole("button", { name: "AI" }).click();
    const panel = studio.root.locator(".as-panel");
    // On a diagram the panel leads with the chat; Generate is folded below it.
    await panel.getByText("New diagram from a description").click();
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

  test("a chat message sends the current document and applies the edited reply", async ({ page, studio }) => {
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

    await studio.root.getByRole("button", { name: "AI" }).click();
    const panel = studio.root.locator(".as-panel");
    const message = panel.getByPlaceholder(/add a CDN/);
    await message.fill("add a CDN in front of the API");
    await message.press("Enter");

    await expect(studio.nodeTitled("Edge CDN")).toBeVisible();
    await expect(studio.nodeTitled("REST API")).toBeVisible();
    // The conversation stays open with both sides of the turn in it; a reply
    // with no note says what changed, counted.
    const thread = panel.getByRole("log", { name: "Conversation" });
    await expect(thread.locator(".as-chat__msg--user")).toHaveText("add a CDN in front of the API");
    await expect(thread.locator(".as-chat__msg--assistant")).toContainText("Done.");
    await expect(thread.locator(".as-chat__detail")).toHaveText("1 added");
    await expect(message).toHaveValue("");

    expect(requests).toHaveLength(1);
    expect(requests[0].mode).toBe("refine");
    expect(requests[0].current?.nodes.map((node) => node.id)).toContain("api");
    // A chat turn asks for a sentence for the user before the JSON.
    expect(requests[0].systemPrompt).toContain("This is a conversation with the user");
    expect(requests[0].history).toBeUndefined();

    // One undo step takes the whole turn back.
    await studio.undoButton.click();
    await expect(studio.nodeTitled("Edge CDN")).toHaveCount(0);
  });

  test("the chat remembers the conversation and shows the model's note", async ({ page, studio }) => {
    const requests: GenerateRequest[] = [];
    await answerByAdding(page, requests);

    await studio.root.getByRole("button", { name: "AI" }).click();
    const panel = studio.root.locator(".as-panel");
    const message = panel.getByRole("textbox", { name: "Message" });
    const thread = panel.getByRole("log", { name: "Conversation" });

    await message.fill("add a gateway");
    await panel.getByRole("button", { name: "Send" }).click();
    await expect(thread.locator(".as-chat__msg--assistant").first()).toContainText("Added gateway 1.");
    await expect(studio.nodeTitled("Gateway 1")).toBeVisible();

    await message.fill("and another one");
    await message.press("Enter");
    await expect(studio.nodeTitled("Gateway 2")).toBeVisible();
    await expect(thread.locator(".as-chat__msg")).toHaveCount(4);

    // The second turn carries the first, as typed and as answered — the
    // diagram itself travels fresh in `current`, never in the history.
    expect(requests[1].history).toEqual([
      { role: "user", content: "add a gateway" },
      { role: "assistant", content: "Added gateway 1." },
    ]);
    expect(requests[1].current?.nodes.map((node) => node.id)).toContain("gw-1");

    // Shift+Enter is a new line, not a send.
    await message.fill("first line");
    await message.press("Shift+Enter");
    await message.pressSequentially("second line");
    await expect(message).toHaveValue("first line\nsecond line");
    expect(requests).toHaveLength(2);

    // A new chat forgets the conversation, not the diagram.
    await panel.getByRole("button", { name: "New chat" }).click();
    await expect(thread.locator(".as-chat__msg")).toHaveCount(0);
    await expect(studio.nodeTitled("Gateway 2")).toBeVisible();
  });

  test("a failed turn says so in the chat, leaves the diagram alone, and is not remembered", async ({ page, studio }) => {
    const requests: GenerateRequest[] = [];
    let fail = true;
    await page.route("**/api/diagram", (route) => {
      const request: GenerateRequest = route.request().postDataJSON();
      requests.push(request);
      if (fail) return json(route, 401, { error: "Claude Opus 5.5 did not accept the key in ANTHROPIC_API_KEY." });
      return json(route, 200, { text: chatReply("Nothing to change.", request.current) });
    });

    await studio.root.getByRole("button", { name: "AI" }).click();
    const panel = studio.root.locator(".as-panel");
    const message = panel.getByRole("textbox", { name: "Message" });
    const thread = panel.getByRole("log", { name: "Conversation" });

    await message.fill("add a cache");
    await message.press("Enter");
    await expect(thread.locator(".as-chat__msg--failed")).toContainText("did not accept the key in ANTHROPIC_API_KEY");
    await expect(studio.nodeTitled("REST API")).toBeVisible();
    await expect(studio.saveButton).toHaveText("Save");

    // A reply that changes nothing says so, and still keeps the diagram as is.
    fail = false;
    await message.fill("does this look right?");
    await message.press("Enter");
    await expect(thread.locator(".as-chat__msg--assistant").last()).toContainText("Nothing to change.");
    await expect(thread.locator(".as-chat__detail").last()).toHaveText("No changes to the diagram");
    await expect(studio.saveButton).toHaveText("Save");
    // The failed turn's user message stays in the history; its error does not.
    expect(requests[1].history).toEqual([{ role: "user", content: "add a cache" }]);
  });

  test("Stop cancels a turn in flight", async ({ page, studio }) => {
    let release: () => void = () => {};
    await page.route("**/api/diagram", async (route) => {
      // Held until the test lets go, as a slow model would hold it.
      await new Promise<void>((resolve) => (release = resolve));
      await route.abort().catch(() => {});
    });

    await studio.root.getByRole("button", { name: "AI" }).click();
    const panel = studio.root.locator(".as-panel");
    const message = panel.getByRole("textbox", { name: "Message" });
    await message.fill("add a queue");
    await message.press("Enter");
    await expect(panel.locator(".as-chat__msg--pending")).toBeVisible();

    await panel.getByRole("button", { name: "Stop" }).click();
    await expect(panel.locator(".as-chat__msg--failed")).toHaveText("Stopped. The diagram is unchanged.");
    await expect(panel.getByRole("button", { name: "Send" })).toBeVisible();
    release();
  });

  test("shows the server's error message in the panel and leaves the diagram alone", async ({ page, studio }) => {
    await page.route("**/api/diagram", (route) => json(route, 503, { error: "Model unavailable" }));

    await studio.root.getByRole("button", { name: "AI" }).click();
    const panel = studio.root.locator(".as-panel");
    await panel.getByText("New diagram from a description").click();
    await panel.getByPlaceholder(/Paste requirements/).fill("anything");
    await panel.getByRole("button", { name: "Generate diagram" }).click();

    await expect(panel.locator(".as-error")).toContainText("Model unavailable");
    await expect(studio.nodeTitled("REST API")).toBeVisible();
    await expect(studio.saveButton).toHaveText("Save");
  });

  test("the host can withhold the generator, which removes the AI button", async ({ studio }) => {
    const ai = studio.root.getByRole("button", { name: "AI" });

    await expect(ai).toBeVisible();
    await (await studio.setting("AI panel")).uncheck();
    await expect(ai).toBeHidden();
  });
});

test.describe("AI keys in the server's environment", () => {
  test("turn the panel on by themselves, and the panel names the model", async ({ page, studio }) => {
    // What the dev server answers when it started with ANTHROPIC_API_KEY set.
    await page.route("**/api/ai", (route) =>
      json(route, 200, { provider: "anthropic", model: "claude-opus-5-5", label: "Claude Opus 5.5", configured: true }),
    );
    await studio.goto();

    await studio.root.getByRole("button", { name: "AI" }).click();
    const panel = studio.root.locator(".as-panel");
    await expect(panel.getByRole("heading", { name: "Adjust with AI" })).toBeVisible();
    await expect(panel.locator(".as-panel__foot")).toContainText("Answered by Claude Opus 5.5.");
  });

  test("leave the panel off when the server has none", async ({ studio }) => {
    // The suite's dev server runs with BD_AI=off: nothing configured.
    await studio.goto();
    await expect(studio.root.getByRole("button", { name: "AI" })).toBeHidden();
  });
});
