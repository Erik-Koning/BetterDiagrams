/**
 * The extension in VS Code itself (run by test/vscode/run.mjs): it activates,
 * a diagram opens in the custom editor, the webview starts under VS Code's
 * own content security policy and reads the file, and an edit from the
 * webview lands in the text as one formatted, undoable edit.
 */
const assert = require("node:assert/strict");
const vscode = require("vscode");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, check, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** What the editor's webview for `uri` has said, after saying `message` for it. */
const webview = (uri, message) => vscode.commands.executeCommand("betterDiagrams.test.webview", uri.toString(), message);

const tests = {
  async "opens a diagram in the custom editor, and the webview reads it"(folder) {
    const shop = vscode.Uri.joinPath(folder, "shop.json");
    await vscode.commands.executeCommand("vscode.openWith", shop, "betterDiagrams.editor");
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab.input instanceof vscode.TabInputCustom, "the active tab is a custom editor");
    assert.equal(tab.input.viewType, "betterDiagrams.editor");
    await until("the webview to start", async () => (await webview(shop)).some((m) => m.type === "ready"));
    const loss = await until("the webview to read the file", async () => (await webview(shop)).find((m) => m.type === "loss"));
    assert.deepEqual(loss.lines, []);
  },

  async "writes an edit as one formatted, undoable edit of the text"(folder) {
    const shop = vscode.Uri.joinPath(folder, "shop.json");
    await vscode.commands.executeCommand("vscode.openWith", shop, "betterDiagrams.editor");
    await until("the webview to start", async () => (await webview(shop)).some((m) => m.type === "ready"));
    const document = await vscode.workspace.openTextDocument(shop);
    const before = document.getText();
    const doc = JSON.parse(before);
    doc.nodes.push({ id: "cache", label: "Cache", kind: "service", x: 0, y: 240 });
    await webview(shop, { type: "edit", doc });
    await until("the edit to land", () => document.getText().includes('"Cache"'));
    // Dirty, not saved behind VS Code's back. (VS Code tells extensions the
    // dirty state apart from the text, so it can arrive a moment later.)
    await until("the file to be dirty", () => document.isDirty);
    // The workspace's .prettierrc asks for tabs, and its Prettier wrote them.
    assert.match(document.getText(), /^\{\n\t"version": 1,/);
    // As ⌘Z in the diagram: VS Code undoes the text, the history every view of it shares.
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    await vscode.commands.executeCommand("undo");
    await until("undo to put the text back", () => document.getText() === before);
  },

  async "the studio's Undo and Redo buttons step VS Code's history of the text"(folder) {
    const shop = vscode.Uri.joinPath(folder, "shop.json");
    await vscode.commands.executeCommand("vscode.openWith", shop, "betterDiagrams.editor");
    await until("the webview to start", async () => (await webview(shop)).some((m) => m.type === "ready"));
    await vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    const document = await vscode.workspace.openTextDocument(shop);
    const before = document.getText();
    const doc = JSON.parse(before);
    doc.nodes.push({ id: "queue", label: "Queue", kind: "service", x: 320, y: 240 });
    await webview(shop, { type: "edit", doc });
    await until("the edit to land", () => document.getText().includes('"Queue"'));
    const edited = document.getText();
    await webview(shop, { type: "undo" });
    await until("Undo to put the text back", () => document.getText() === before);
    await webview(shop, { type: "redo" });
    await until("Redo to bring the edit back", () => document.getText() === edited);
    await webview(shop, { type: "undo" });
    await until("the text to be as it was", () => document.getText() === before);
  },

  async "follows a file: link to the diagram it names"(folder) {
    const shop = vscode.Uri.joinPath(folder, "shop.json");
    await vscode.commands.executeCommand("vscode.openWith", shop, "betterDiagrams.editor");
    await until("the webview to start", async () => (await webview(shop)).some((m) => m.type === "ready"));
    const opened = (file) => {
      const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      return input instanceof vscode.TabInputCustom && input.viewType === "betterDiagrams.editor" && input.uri.path.endsWith(`/${file}`);
    };
    // The name the web app saves "Order flow" under: order-flow.json.
    await webview(shop, { type: "navigate", ref: "Order flow" });
    await until("order-flow.json to open", () => opened("order-flow.json"));
    // No file by that name, but a diagram beside it with that title.
    await webview(shop, { type: "navigate", ref: "Card payments" });
    await until("billing.json to open", () => opened("billing.json"));
  },

  async "never writes over JSON that isn't a diagram"(folder) {
    const settings = vscode.Uri.joinPath(folder, "settings.json");
    await vscode.commands.executeCommand("vscode.openWith", settings, "betterDiagrams.editor");
    await until("the webview to start", async () => (await webview(settings)).some((m) => m.type === "ready"));
    const document = await vscode.workspace.openTextDocument(settings);
    const before = document.getText();
    await webview(settings, { type: "edit", doc: { version: 1, nodes: [], edges: [] } });
    await sleep(500);
    assert.equal(document.getText(), before);
    assert.ok(!document.isDirty);
  },

  async "gives agents the format and a check, as language model tools"(folder) {
    const names = vscode.lm.tools.map((tool) => tool.name);
    assert.ok(names.includes("get_better_diagrams_schema"), "the schema tool is registered");
    assert.ok(names.includes("validate_better_diagram"), "the validate tool is registered");
    const text = (result) => result.content.map((part) => part.value).join("");
    const schema = text(await vscode.lm.invokeTool("get_better_diagrams_schema", { input: {}, toolInvocationToken: undefined }));
    assert.match(schema, /^This is the prompt Better Diagrams gives its own AI/);
    assert.match(schema, /You convert software requirements/);
    const sequence = text(await vscode.lm.invokeTool("get_better_diagrams_schema", { input: { kind: "sequence" }, toolInvocationToken: undefined }));
    assert.match(sequence, /SEQUENCE DIAGRAM/);
    const checked = text(await vscode.lm.invokeTool("validate_better_diagram", { input: { file: "shop.json" }, toolInvocationToken: undefined }));
    assert.match(checked, /^shop\.json: an architecture diagram, 2 nodes, 1 edge\.\n\nThe editor reads it exactly as written/);
    const notOne = text(await vscode.lm.invokeTool("validate_better_diagram", { input: { file: vscode.Uri.joinPath(folder, "settings.json").fsPath }, toolInvocationToken: undefined }));
    assert.match(notOne, /JSON, but not a Better Diagrams diagram/);
    await assert.rejects(
      vscode.lm.invokeTool("validate_better_diagram", { input: { file: "missing.json" }, toolInvocationToken: undefined }),
      /There's no file at missing\.json/,
    );
  },

  async "writes agent instructions, and points agents' own files at them"(folder) {
    const read = async (uri) => new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    const write = (uri, text) => vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    const agents = vscode.Uri.joinPath(folder, "AGENTS.md");
    await write(agents, "# Agents\n\nRun the tests.\n");
    const target = vscode.Uri.joinPath(folder, "docs", "better-diagrams.md");
    const choices = { folder, clouds: ["aws"], target, pointers: ["AGENTS.md", "CLAUDE.md"] };
    const written = await vscode.commands.executeCommand("betterDiagrams.addAgentInstructions", choices);
    assert.equal(written?.toString(), target.toString());
    const instructions = await read(target);
    assert.match(instructions, /^<!-- Written by Better Diagrams for VS Code/);
    assert.match(instructions, /aws-lambda/);
    const pointed = await read(agents);
    assert.ok(pointed.startsWith("# Agents\n\nRun the tests.\n\n<!-- better-diagrams -->"), pointed);
    assert.match(pointed, /\[docs\/better-diagrams\.md\]\(docs\/better-diagrams\.md\)/);
    assert.match(await read(vscode.Uri.joinPath(folder, "CLAUDE.md")), /^<!-- better-diagrams -->/);
    // Run again: the same files, not a second pointer.
    await vscode.commands.executeCommand("betterDiagrams.addAgentInstructions", choices);
    assert.equal(await read(agents), pointed);
    // A file of someone else's is never written over.
    const notes = vscode.Uri.joinPath(folder, "notes.md");
    await write(notes, "# My notes\n");
    const refused = await vscode.commands.executeCommand("betterDiagrams.addAgentInstructions", { ...choices, target: notes, pointers: [] });
    assert.equal(refused, undefined);
    assert.equal(await read(notes), "# My notes\n");
  },

  async "contributes its commands"() {
    const commands = await vscode.commands.getCommands(true);
    for (const command of ["betterDiagrams.open", "betterDiagrams.openToSide", "betterDiagrams.showJson", "betterDiagrams.new", "betterDiagrams.addAgentInstructions"]) {
      assert.ok(commands.includes(command), `${command} is registered`);
    }
  },
};

exports.run = async function run() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(folder, "a workspace folder is open");
  const extension = vscode.extensions.all.find((e) => e.packageJSON.name === "better-diagrams-vscode");
  assert.ok(extension, "the extension is installed");
  await extension.activate();
  const failures = [];
  for (const [name, test] of Object.entries(tests)) {
    try {
      await test(folder);
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.log(`  ✘ ${name}\n    ${error?.stack ?? error}`);
    }
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor").then(undefined, () => {});
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  }
  if (failures.length) throw new Error(`${failures.length} failed: ${failures.join(", ")}`);
};
