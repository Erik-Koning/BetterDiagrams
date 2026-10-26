import { describe, expect, it } from "vitest";
import type { HostMessage } from "./protocol";
import { DocumentSync, readText, type SyncHost } from "./sync";

const diagram = (title: string) => ({ version: 1, meta: { title }, nodes: [], edges: [] });
const json = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;

/** A document in memory, standing in for VS Code's, with what the webview was sent. */
function fakeHost(text: string, overrides: Partial<SyncHost> = {}) {
  const posted: HostMessage[] = [];
  const writes: string[] = [];
  const asked: string[][] = [];
  const doc = { text };
  const host: SyncHost = {
    getText: () => doc.text,
    replaceText: async (next) => {
      writes.push(next);
      doc.text = next;
      return true;
    },
    format: async (value) => json(value),
    post: (message) => posted.push(message),
    confirmLoss: async (lines) => {
      asked.push(lines);
      return true;
    },
    ...overrides,
  };
  return { host, doc, posted, writes, asked };
}

describe("readText", () => {
  it("tells a diagram, an empty file, and everything else apart", () => {
    expect(readText(json(diagram("A")))).toEqual({ state: "diagram" });
    expect(readText(json({ version: 1, participants: [], messages: [] }))).toEqual({ state: "diagram" });
    expect(readText("  \n")).toEqual({ state: "empty" });
    expect(readText('{ "nodes": [').state).toBe("invalid");
    expect(readText(json({ name: "my-package", version: "1.0.0" }))).toEqual({
      state: "invalid",
      reason: "It's JSON, but not a diagram.",
    });
    // A React Flow export is converted on import, never edited in place.
    expect(readText(json({ nodes: [{ id: "a", position: { x: 0, y: 0 } }], edges: [] })).state).toBe("invalid");
  });
});

describe("DocumentSync", () => {
  it("writes an edit as the whole text, formatted, and doesn't echo it back", async () => {
    const { host, doc, posted, writes } = fakeHost(json(diagram("A")));
    const sync = new DocumentSync(host);
    sync.start();
    await sync.edit(diagram("B"));
    expect(writes).toEqual([json(diagram("B"))]);
    sync.textChanged();
    expect(posted).toEqual([]);
    expect(doc.text).toBe(json(diagram("B")));
  });

  it("sends the webview a text changed anywhere else", () => {
    const { host, doc, posted } = fakeHost(json(diagram("A")));
    const sync = new DocumentSync(host);
    sync.start();
    doc.text = json(diagram("Typed"));
    sync.textChanged();
    expect(posted).toEqual([{ type: "text", text: json(diagram("Typed")), read: { state: "diagram" } }]);
    // Told once: the same text again is news of nothing.
    sync.textChanged();
    expect(posted).toHaveLength(1);
  });

  it("takes the same text with other line endings as the same", async () => {
    const { host, doc, posted, writes } = fakeHost(json(diagram("A")), {
      // VS Code writes an edit with the document's own line endings.
      replaceText: async (next) => {
        writes.push(next);
        doc.text = next.replace(/\n/g, "\r\n");
        return true;
      },
    });
    const sync = new DocumentSync(host);
    sync.start();
    await sync.edit(diagram("B"));
    sync.textChanged();
    expect(posted).toEqual([]);
  });

  it("collapses edits made while one is written to the newest", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { host, writes } = fakeHost(json(diagram("A")));
    const format = host.format;
    host.format = async (value) => {
      await gate;
      return format(value);
    };
    const sync = new DocumentSync(host);
    sync.start();
    const first = sync.edit(diagram("B"));
    void sync.edit(diagram("C"));
    const last = sync.edit(diagram("D"));
    release();
    await Promise.all([first, last]);
    expect(writes).toEqual([json(diagram("B")), json(diagram("D"))]);
  });

  it("starts writing again after a drain that had nothing to wait on", async () => {
    const { host, doc, writes } = fakeHost('{ "nodes": [');
    const sync = new DocumentSync(host);
    sync.start();
    await sync.edit(diagram("refused"));
    doc.text = json(diagram("A"));
    await sync.edit(diagram("B"));
    expect(writes).toEqual([json(diagram("B"))]);
  });

  it("never writes over text that isn't a diagram, and puts the webview back", async () => {
    const { host, posted, writes } = fakeHost(json({ name: "my-package" }));
    const sync = new DocumentSync(host);
    sync.start();
    await sync.edit(diagram("B"));
    expect(writes).toEqual([]);
    expect(posted).toEqual([
      { type: "text", text: json({ name: "my-package" }), read: { state: "invalid", reason: "It's JSON, but not a diagram." } },
    ]);
  });

  it("writes a new diagram into an empty file", async () => {
    const { host, writes } = fakeHost("");
    const sync = new DocumentSync(host);
    expect(sync.start().read).toEqual({ state: "empty" });
    await sync.edit(diagram("New"));
    expect(writes).toEqual([json(diagram("New"))]);
  });

  it("asks once before the first edit that drops something", async () => {
    const { host, asked, writes } = fakeHost(json(diagram("A")));
    const sync = new DocumentSync(host);
    sync.start();
    sync.lossReported(['"colour" at /nodes/0 isn\'t a node property, so it was dropped.']);
    await sync.edit(diagram("B"));
    await sync.edit(diagram("C"));
    expect(asked).toHaveLength(1);
    expect(writes).toEqual([json(diagram("B")), json(diagram("C"))]);
  });

  it("keeps the file as it is when the question is declined", async () => {
    const original = json(diagram("A"));
    const { host, posted, writes } = fakeHost(original, { confirmLoss: async () => false });
    const sync = new DocumentSync(host);
    sync.start();
    sync.lossReported(["something"]);
    await sync.edit(diagram("B"));
    expect(writes).toEqual([]);
    expect(posted).toEqual([{ type: "text", text: original, read: { state: "diagram" } }]);
  });

  it("asks again when the text comes back with something to drop", async () => {
    const { host, asked } = fakeHost(json(diagram("A")));
    const sync = new DocumentSync(host);
    sync.start();
    sync.lossReported(["something"]);
    await sync.edit(diagram("B"));
    // Undone in VS Code: the webview loads the old text and reports its loss again.
    sync.lossReported(["something"]);
    await sync.edit(diagram("C"));
    expect(asked).toHaveLength(2);
  });

  it("puts the webview back when VS Code refuses the edit", async () => {
    const original = json(diagram("A"));
    const { host, posted } = fakeHost(original, { replaceText: async () => false });
    const sync = new DocumentSync(host);
    sync.start();
    await sync.edit(diagram("B"));
    expect(posted).toEqual([{ type: "text", text: original, read: { state: "diagram" } }]);
  });
});
