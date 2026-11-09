/**
 * Better Diagrams for VS Code: a diagram's JSON opens in the same editor the
 * web app and the `better-diagrams` command show — the library's studio, its
 * styling, and the app's default view — with the file's text in VS Code as
 * the only copy.
 *
 *   Open With… → Better Diagrams, on any .json
 *   Better Diagrams: Open Diagram / Open Diagram to the Side   (a diagram's JSON)
 *   Better Diagrams: Show JSON                                  (from the diagram)
 *   Better Diagrams: New Diagram File… / New Diagram from Example…
 *   Better Diagrams: Derive Sequence…                           (a sequence from an architecture's numbered flow)
 *   Better Diagrams: Copy Schema                                (the format, for an AI agent elsewhere)
 *   Better Diagrams: Toggle Light/Dark                          (the editor's theme)
 *   Better Diagrams: Add Agent Instructions…                    (for agents that read files)
 *   #betterDiagramsSchema, #betterDiagramsValidate               (tools for agents in VS Code's chat)
 */
import * as vscode from "vscode";
import {
  EXAMPLE_SEQUENCE,
  EXAMPLE_TEMPLATE,
  EXAMPLE_ZONED_TEMPLATE,
  sequenceFromTemplate,
  type DiagramTemplate,
} from "@mosphere/better-diagrams";
import { kindOf, validateDoc } from "@app/documents.js";
import { schemaPrompt } from "./agent";
import { registerAgentTools } from "./agent-tools";
import { DiagramEditorProvider, EditorProbe, VIEW_TYPE, readView, writeView } from "./editor";
import { createDiagramFile, diagramText, fileName, folderNear } from "./files";
import type { WebviewMessage } from "./protocol";
import { SNIFF_LIMIT, readText } from "./sync";

/** The file a command is about: the one it was invoked on, else the active editor's, text or diagram. */
function targetOf(uri: unknown): vscode.Uri | undefined {
  if (uri instanceof vscode.Uri) return uri;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

async function openDiagram(uri: unknown, viewColumn: vscode.ViewColumn): Promise<void> {
  const target = targetOf(uri);
  if (!target) {
    void vscode.window.showInformationMessage("Open a diagram's .json file first.");
    return;
  }
  await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE, viewColumn);
}

async function showJson(uri: unknown): Promise<void> {
  const target = targetOf(uri);
  if (!target) return;
  const document = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
}

/** The diagram a command is about, parsed: the file it was invoked on, else the active one. */
async function diagramOf(uri: unknown): Promise<{ target: vscode.Uri; doc: unknown } | undefined> {
  const target = targetOf(uri);
  if (!target) {
    void vscode.window.showInformationMessage("Open a diagram's .json file first.");
    return undefined;
  }
  const text = (await vscode.workspace.openTextDocument(target)).getText();
  if (readText(text).state !== "diagram") {
    void vscode.window.showInformationMessage(`${fileName(target)} isn't a diagram.`);
    return undefined;
  }
  return { target, doc: JSON.parse(text) };
}

/** A new diagram file holding a sequence derived from the architecture's numbered flow, as the web app's Derive sequence makes one. */
async function deriveSequence(uri: unknown): Promise<void> {
  const found = await diagramOf(uri);
  if (!found) return;
  if (kindOf(found.doc) !== "architecture") {
    void vscode.window.showInformationMessage("Derive a sequence from an architecture diagram: its numbered connections (seq) become the messages.");
    return;
  }
  const doc = validateDoc("architecture", found.doc) as DiagramTemplate;
  const title = doc.meta?.title?.trim() || fileName(found.target).replace(/\.json$/i, "");
  await createDiagramFile(found.target, sequenceFromTemplate(doc), `${title} — sequence`);
}

/** The diagram's format on the clipboard, tailored to its kind and clouds, for an AI agent elsewhere. */
async function copySchema(uri: unknown): Promise<void> {
  const found = await diagramOf(uri);
  if (!found) return;
  await vscode.env.clipboard.writeText(schemaPrompt({ existing: found.doc }));
  void vscode.window.showInformationMessage(
    `Copied the ${kindOf(found.doc)} schema for ${fileName(found.target)}. Paste it into your AI agent to have it write this diagram.`,
  );
}

/** Light ⇄ dark for every diagram editor; from "follow VS Code", the opposite of what's showing. */
async function toggleTheme(): Promise<void> {
  const { theme } = readView();
  const kind = vscode.window.activeColorTheme.kind;
  const showing =
    theme !== "auto" ? theme : kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? "light" : "dark";
  await writeView({ theme: showing === "light" ? "dark" : "light" });
}

const EXAMPLES = [
  { label: "Multi-cloud", description: "Architecture", detail: "Services across clouds, in zones", doc: EXAMPLE_ZONED_TEMPLATE, name: "Multi-cloud example" },
  { label: "Plain", description: "Architecture", detail: "The same system without zones", doc: EXAMPLE_TEMPLATE, name: "Example" },
  { label: "Checkout", description: "Sequence", detail: "Messages between participants over time", doc: EXAMPLE_SEQUENCE, name: "Sequence example" },
];

/** One of the web app's examples, as a new file to look around in. */
async function newFromExample(): Promise<void> {
  const picked = await vscode.window.showQuickPick(EXAMPLES, { title: "New Diagram from Example", placeHolder: "Which example?" });
  if (!picked) return;
  await createDiagramFile(targetOf(undefined), picked.doc, picked.name);
}

/**
 * A new, empty diagram, as `better-diagrams --new` starts one: titled after
 * its file and written the way its repo formats JSON. A name that's there
 * already opens as it is, never written over.
 */
async function newDiagram(): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: "Architecture", detail: "Components and their connections — also data models and task plans", diagram: "architecture" as const },
      { label: "Sequence", detail: "Messages between participants over time", diagram: "sequence" as const },
    ],
    { title: "New Diagram File", placeHolder: "What kind of diagram?" },
  );
  if (!picked) return;
  const folder = folderNear(targetOf(undefined));
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, "diagram.json") : undefined,
    filters: { "Diagram JSON": ["json"] },
    saveLabel: "Create",
    title: "New Diagram File",
  });
  if (!target) return;
  let existing: string | undefined;
  try {
    existing = new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
  } catch {
    // Not there yet: make it.
  }
  if (existing !== undefined) {
    if (readText(existing).state === "invalid") {
      void vscode.window.showErrorMessage(`${target.path.split("/").pop()} is there already and isn't a diagram, so it wasn't written over.`);
      return;
    }
  } else {
    const title = fileName(target).replace(/\.json$/i, "");
    const doc =
      picked.diagram === "sequence"
        ? { version: 1, meta: { title }, participants: [], messages: [] }
        : { version: 1, meta: { title }, nodes: [], edges: [] };
    const text = await diagramText(target, doc);
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
  }
  await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
}

/** `betterDiagrams.activeIsDiagram`: the active text editor holds a diagram, so the title bar offers to open it. */
function trackActiveDiagram(): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: boolean | undefined;
  const update = () => {
    const document = vscode.window.activeTextEditor?.document;
    const text = document && /\.json$/i.test(document.uri.path) ? document.getText() : "";
    const isDiagram = text.length > 0 && text.length < SNIFF_LIMIT && readText(text).state === "diagram";
    if (isDiagram === last) return;
    last = isDiagram;
    void vscode.commands.executeCommand("setContext", "betterDiagrams.activeIsDiagram", isDiagram);
  };
  update();
  const subscriptions = [
    vscode.window.onDidChangeActiveTextEditor(update),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document !== vscode.window.activeTextEditor?.document) return;
      clearTimeout(timer);
      timer = setTimeout(update, 300);
    }),
  ];
  return new vscode.Disposable(() => {
    clearTimeout(timer);
    for (const subscription of subscriptions) subscription.dispose();
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("Better Diagrams", { log: true });
  const probe = context.extensionMode === vscode.ExtensionMode.Test ? new EditorProbe() : undefined;
  if (probe) {
    // test/vscode: what an editor's webview said, after saying `message` for it.
    context.subscriptions.push(
      vscode.commands.registerCommand("betterDiagrams.test.webview", (uri: string, message?: WebviewMessage) => {
        if (message) probe.say(uri, message);
        return probe.messages(uri);
      }),
    );
  }
  context.subscriptions.push(
    log,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, new DiagramEditorProvider(context.extensionUri, log, probe), {
      // React Flow's viewport, the selection and the studio's panels survive switching tabs.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand("betterDiagrams.open", (uri?: vscode.Uri) => openDiagram(uri, vscode.ViewColumn.Active)),
    vscode.commands.registerCommand("betterDiagrams.openToSide", (uri?: vscode.Uri) => openDiagram(uri, vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand("betterDiagrams.showJson", showJson),
    vscode.commands.registerCommand("betterDiagrams.new", newDiagram),
    vscode.commands.registerCommand("betterDiagrams.newFromExample", newFromExample),
    vscode.commands.registerCommand("betterDiagrams.deriveSequence", deriveSequence),
    vscode.commands.registerCommand("betterDiagrams.copySchema", copySchema),
    vscode.commands.registerCommand("betterDiagrams.toggleTheme", toggleTheme),
    // VS Code hears every key pressed in a webview. The keys the canvas uses
    // that VS Code also binds (⌘K's chords, ⌘= zooming the window, ⇧⌘E the
    // Explorer…) come here while the diagram has focus, and do nothing more
    // than the canvas already did with them. See package.json's keybindings.
    vscode.commands.registerCommand("betterDiagrams.canvasKey", () => undefined),
    registerAgentTools(),
    trackActiveDiagram(),
  );
}

export function deactivate(): void {}
