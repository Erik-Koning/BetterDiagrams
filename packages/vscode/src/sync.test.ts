import { describe, expect, it } from "vitest";
import type { HostMessage } from "./protocol";
import { DocumentSync, changedSpan, readText, type SyncHost } from "./sync";

const diagram = (title: string) => ({ version: 1, meta: { title }, nodes: [], edges: [] });
const json = (doc: unknown) => `${JSON.stringify(doc, null, 2)}\n`;
const textMessage = (text: string): HostMessage => ({ type: "text", text, read: readText(text) });

/** A promise held open until `release()`. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => (release = resolve));
  return { opened, release };
}

/** A document in memory, standing in for VS Code's, with what the webview was sent. */
function fakeHost(text: string, overrides: Partial<SyncHost> = {}) {
  const posted: HostMessage[] = [];
  const writes: string[] = [];
  const asked: string[][] = [];
  const failures: string[] = [];
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
    writeFailed: (reason) => failures.push(reason),
    ...overrides,
  };
  return { host, doc, posted, writes, asked, failures };
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
    // Fixed in the JSON: the editor hears of it, and tells the webview.
    doc.text = json(diagram("A"));
    sync.textChanged();
    await sync.edit(diagram("B"));
    expect(writes).toEqual([json(diagram("B"))]);
  });

  it("drops an edit when the text is undone while it's formatted, and shows the webview the undo", async () => {
    // T0 → T1 was an earlier edit. The person edits again (T2) and presses ⌘Z at once.
    const { host, doc, posted, writes } = fakeHost(json(diagram("T1")));
    const formatting = gate();
    host.format = async (value) => {
      await formatting.opened;
      return json(value);
    };
    const sync = new DocumentSync(host);
    sync.start();
    const written = sync.edit(diagram("T2"));
    // VS Code undoes T1 → T0 while Prettier is still at T2.
    doc.text = json(diagram("T0"));
    formatting.release();
    await written;
    expect(writes).toEqual([]);
    expect(doc.text).toBe(json(diagram("T0")));
    expect(posted).toEqual([textMessage(json(diagram("T0")))]);
    // The editor's own news of the undo, a moment later, is news of nothing.
    sync.textChanged();
    expect(posted).toHaveLength(1);
  });

  it("drops an edit made before the webview heard of an undo", async () => {
    const { host, doc, posted, writes } = fakeHost(json(diagram("T1")));
    const sync = new DocumentSync(host);
    sync.start();
    // ⌘Z: the editor waits for typing to pause before it tells the webview.
    doc.text = json(diagram("T0"));
    // Meanwhile the webview, still showing T1, sends a drag.
    await sync.edit(diagram("T1 dragged"));
    expect(writes).toEqual([]);
    expect(doc.text).toBe(json(diagram("T0")));
    expect(posted).toEqual([textMessage(json(diagram("T0")))]);
  });

  it("writes an edit that comes before the webview was shown any text", async () => {
    const { host, writes } = fakeHost(json(diagram("A")));
    const sync = new DocumentSync(host);
    await sync.edit(diagram("B"));
    expect(writes).toEqual([json(diagram("B"))]);
  });

  it("drops an edit when the text changes while the person is asked about a loss", async () => {
    const asking = gate();
    const { host, doc, posted, writes } = fakeHost(json(diagram("A")), {
      confirmLoss: async () => {
        await asking.opened;
        return true;
      },
    });
    const sync = new DocumentSync(host);
    sync.start();
    sync.lossReported(["something"]);
    const written = sync.edit(diagram("B"));
    doc.text = json(diagram("Agent"));
    asking.release();
    await written;
    expect(writes).toEqual([]);
    expect(posted).toEqual([textMessage(json(diagram("Agent")))]);
  });

  it("doesn't send the webview the text from before its own edit while that edit is written", async () => {
    const started = gate();
    const writing = gate();
    const { host, doc, posted } = fakeHost(json(diagram("A")), {
      replaceText: async (next) => {
        started.release();
        await writing.opened;
        doc.text = next;
        return true;
      },
    });
    const sync = new DocumentSync(host);
    sync.start();
    const written = sync.edit(diagram("B"));
    // The editor's news of an earlier change arrives mid-write, with the text still A.
    await started.opened;
    sync.textChanged();
    expect(posted).toEqual([]);
    writing.release();
    await written;
    expect(doc.text).toBe(json(diagram("B")));
    expect(posted).toEqual([]);
  });

  it("sends a change that landed during a write once the write is done", async () => {
    const started = gate();
    const writing = gate();
    const { host, doc, posted } = fakeHost(json(diagram("A")), {
      replaceText: async (next) => {
        doc.text = next;
        started.release();
        await writing.opened;
        return true;
      },
    });
    const sync = new DocumentSync(host);
    sync.start();
    const written = sync.edit(diagram("B"));
    await started.opened;
    // Undone the moment it landed, and the editor heard while the write was still settling.
    doc.text = json(diagram("A"));
    sync.textChanged();
    expect(posted).toEqual([]);
    writing.release();
    await written;
    expect(posted).toEqual([textMessage(json(diagram("A")))]);
  });

  it("settles once the edits sent so far are written, so an undo steps back the newest", async () => {
    const formatting = gate();
    const { host, writes } = fakeHost(json(diagram("A")));
    const format = host.format;
    host.format = async (value) => {
      await formatting.opened;
      return format(value);
    };
    const sync = new DocumentSync(host);
    sync.start();
    await sync.settled();
    void sync.edit(diagram("B"));
    let settled = false;
    const done = sync.settled().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    formatting.release();
    await done;
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

  it("puts the webview back when VS Code refuses the edit, and says so", async () => {
    const original = json(diagram("A"));
    const { host, posted, failures } = fakeHost(original, { replaceText: async () => false });
    const sync = new DocumentSync(host);
    sync.start();
    await sync.edit(diagram("B"));
    expect(posted).toEqual([{ type: "text", text: original, read: { state: "diagram" } }]);
    expect(failures).toEqual(["VS Code refused it."]);
  });

  it("puts the webview back when writing throws, says why, and writes the next edit", async () => {
    const original = json(diagram("A"));
    let fail = true;
    const { host, doc, posted, failures } = fakeHost(original, {
      replaceText: async (next) => {
        if (fail) throw new Error("The file is read-only.");
        doc.text = next;
        return true;
      },
    });
    const sync = new DocumentSync(host);
    sync.start();
    await sync.edit(diagram("B"));
    expect(posted).toEqual([textMessage(original)]);
    expect(failures).toEqual(["The file is read-only."]);
    expect(doc.text).toBe(original);
    fail = false;
    await sync.edit(diagram("C"));
    expect(doc.text).toBe(json(diagram("C")));
  });
});

describe("changedSpan", () => {
  const apply = (before: string, after: string) => {
    const span = changedSpan(before, after);
    return before.slice(0, span.start) + span.text + before.slice(span.end);
  };

  it("replaces only what changed", () => {
    expect(changedSpan('{ "a": 1, "b": 2 }', '{ "a": 1, "b": 3 }')).toEqual({ start: 15, end: 16, text: "3" });
    expect(changedSpan("abc", "abXc")).toEqual({ start: 2, end: 2, text: "X" });
    expect(changedSpan("aaa", "aa")).toEqual({ start: 2, end: 3, text: "" });
    expect(changedSpan("same", "same")).toEqual({ start: 4, end: 4, text: "" });
    expect(changedSpan("", "new")).toEqual({ start: 0, end: 0, text: "new" });
  });

  it("never cuts through a surrogate pair or a CRLF", () => {
    // 😀 and 😁 share their first code unit.
    expect(changedSpan("a😀b", "a😁b")).toEqual({ start: 1, end: 3, text: "😁" });
    expect(changedSpan("a\r\nb", "a\r\r\nb").start).not.toBe(2);
    for (const [before, after] of [
      ["a😀b", "a😁b"],
      ["😀😀", "😀"],
      ["x\r\ny", "x\r\nz\r\ny"],
      ["a\r\nb", "a\r\r\nb"],
      [json(diagram("A")), json(diagram("A — renamed"))],
    ]) {
      expect(apply(before, after)).toBe(after);
    }
  });
});
