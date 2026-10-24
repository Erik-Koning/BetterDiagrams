/**
 * Better Diagrams for VS Code: a diagram's JSON opens in the same editor the
 * web app and the `better-diagrams` command show — the library's studio, its
 * styling, and the app's default view — with the file's text in VS Code as
 * the only copy.
 *
 *   Open With… → Better Diagrams, on any .json
 *   Better Diagrams: Open Diagram / Open Diagram to the Side   (a diagram's JSON)
 *   Better Diagrams: Show JSON                                  (from the diagram)
 *   Better Diagrams: New Diagram File…
 *   Better Diagrams: Add Agent Instructions…                    (for agents that read files)
 *   #betterDiagramsSchema, #betterDiagramsValidate               (tools for agents in VS Code's chat)
 */
import * as vscode from "vscode";
import { formatDiagram, plainJson } from "@mosphere/better-diagrams/disk";
import { registerAgentTools } from "./agent-tools";
import { DiagramEditorProvider, EditorProbe, VIEW_TYPE } from "./editor";
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

/**
 * A new, empty diagram, as `better-diagrams --new` starts one: titled after
 * its file and written the way its repo formats JSON. A name that's there
 * already opens as it is, never written over.
 */
async function newDiagram(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
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
    const title = (target.path.split("/").pop() ?? "diagram").replace(/\.json$/i, "");
    const doc = { version: 1, meta: { title }, nodes: [], edges: [] };
    const text = target.scheme === "file" && vscode.workspace.isTrusted ? await formatDiagram(target.fsPath, doc) : plainJson(doc);
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
    registerAgentTools(),
    trackActiveDiagram(),
  );
}

export function deactivate(): void {}
