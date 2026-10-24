/**
 * The webview as VS Code hosts it, for Playwright: the extension's own page
 * (webviewHtml) and the built bundle, served from memory and dist/, with
 * `acquireVsCodeApi` stood in for. What the page posts collects in
 * `window.__posted`; `host.send` delivers a message as the extension would.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";
import { webviewHtml } from "../src/html";
import type { HostMessage, TextRead, WebviewMessage } from "../src/protocol";

const ORIGIN = "https://webview.test";
const dist = (file: string) => fileURLToPath(new URL(`../dist/${file}`, import.meta.url));

export const json = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;

export const ARCHITECTURE = {
  version: 1,
  meta: { title: "Shop" },
  nodes: [
    { id: "web", label: "Storefront", kind: "service", icon: "globe", x: 0, y: 0 },
    { id: "api", label: "Orders API", kind: "service", x: 320, y: 0 },
    { id: "db", label: "Orders DB", kind: "database", x: 640, y: 0 },
  ],
  edges: [
    { id: "e1", source: "web", target: "api", label: "REST" },
    { id: "e2", source: "api", target: "db" },
  ],
};

export const SEQUENCE = {
  version: 1,
  meta: { title: "Checkout" },
  participants: [
    { id: "user", label: "Customer", kind: "actor" },
    { id: "api", label: "Order API", kind: "service" },
  ],
  messages: [{ id: "m1", from: "user", to: "api", label: "POST /orders" }],
};

export class Webview {
  /** Console errors, CSP refusals among them. */
  readonly errors: string[] = [];

  constructor(readonly page: Page) {
    page.on("console", (message) => {
      if (message.type() === "error") this.errors.push(message.text());
    });
    page.on("pageerror", (error) => this.errors.push(error.message));
  }

  /** Open the page as VS Code would, with `bodyClass` for its colour theme. */
  async open({ bodyClass = "vscode-dark" } = {}): Promise<void> {
    const html = webviewHtml({
      cspSource: ORIGIN,
      scriptUri: `${ORIGIN}/dist/webview.js`,
      styleUri: `${ORIGIN}/dist/webview.css`,
      nonce: "testnonce",
      title: "shop.json",
    })
      // What VS Code's preload adds: its theme's class on the body, its default stylesheet in the head.
      .replace("<body>", `<body class="${bodyClass}">`)
      .replace("<head>", '<head><style id="_defaultStyles">body { padding: 0 20px; }</style>');
    await this.page.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/index.html") return route.fulfill({ body: html, contentType: "text/html" });
      const file = path.replace(/^\/dist\//, "");
      return route.fulfill({
        body: readFileSync(dist(file)),
        contentType: file.endsWith(".css") ? "text/css" : "text/javascript",
      });
    });
    await this.page.addInitScript(() => {
      const w = window as unknown as { __posted: unknown[]; acquireVsCodeApi: () => unknown };
      w.__posted = [];
      w.acquireVsCodeApi = () => ({ postMessage: (message: unknown) => w.__posted.push(message) });
    });
    await this.page.goto(`${ORIGIN}/index.html`);
    await expect.poll(() => this.posted("ready")).toHaveLength(1);
  }

  /** Deliver a message as the extension does. */
  async send(message: HostMessage): Promise<void> {
    await this.page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), message);
  }

  async init(text: string, { read = { state: "diagram" } as TextRead, readOnly = false, theme = "auto" as const } = {}) {
    await this.send({ type: "init", text, read, readOnly, theme, filename: "shop" });
  }

  /** What the page has posted, of one type. */
  async posted<T extends WebviewMessage["type"]>(type: T): Promise<Extract<WebviewMessage, { type: T }>[]> {
    const all = (await this.page.evaluate(() => (window as unknown as { __posted: WebviewMessage[] }).__posted)) ?? [];
    return all.filter((message): message is Extract<WebviewMessage, { type: T }> => message.type === type);
  }

  get root() {
    return this.page.locator(".as-root");
  }

  nodeTitled(label: string) {
    return this.page.locator(".as-node__title").filter({ hasText: new RegExp(`^${label}$`) });
  }

  participant(label: string) {
    return this.page.locator(".as-seq-head__label").filter({ hasText: new RegExp(`^${label}$`) });
  }

  async fromMenu(label: string, item: RegExp): Promise<void> {
    await this.root.getByRole("button", { name: label, exact: true }).click();
    await this.root.getByRole("menu").getByRole("menuitem", { name: item }).click();
  }
}
