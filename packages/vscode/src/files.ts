/**
 * files.ts — new diagram files: where the web app opens a new workspace file
 * (an import, a derived sequence, an example, the welcome modal's other kind),
 * the extension writes one where the person picks — beside the diagram it
 * came from to begin with — and opens it in the diagram editor.
 */
import * as vscode from "vscode";
import { formatDiagram, plainJson } from "@mosphere/better-diagrams/disk";
import { templateFile } from "@app/documents.js";
import { VIEW_TYPE } from "./protocol";
import { readText } from "./sync";

export const fileName = (uri: vscode.Uri) => uri.path.split("/").pop() ?? uri.path;

/** The text to write for `doc` at `target`: the repo's own formatting where it may run, else plain JSON. */
export function diagramText(target: vscode.Uri, doc: unknown): Promise<string> {
  return target.scheme === "file" && vscode.workspace.isTrusted ? formatDiagram(target.fsPath, doc) : Promise.resolve(plainJson(doc));
}

/** The folder a new file starts in: the one `near` is in, else the first workspace folder. */
export function folderNear(near: vscode.Uri | undefined): vscode.Uri | undefined {
  if (near && near.scheme !== "untitled") return vscode.Uri.joinPath(near, "..");
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** `doc` titled `title`, unless it has a title of its own. */
function titled(doc: unknown, title: string): unknown {
  if (!doc || typeof doc !== "object") return doc;
  const meta = (doc as { meta?: Record<string, unknown> }).meta;
  if (typeof meta?.title === "string" && meta.title.trim()) return doc;
  return { ...(doc as object), meta: { ...(meta ?? {}), title } };
}

/**
 * Write `doc` to a new file the person names — `name`, or the document's
 * title, as the web app would save it — and open it in the diagram editor.
 * Resolves the file, or nothing when the person cancelled.
 */
export async function createDiagramFile(near: vscode.Uri | undefined, doc: unknown, name?: string): Promise<vscode.Uri | undefined> {
  const own = (doc as { meta?: { title?: unknown } } | null)?.meta?.title;
  const title = (name?.trim() || (typeof own === "string" ? own.trim() : "") || "diagram").slice(0, 120);
  const folder = folderNear(near);
  const target = await vscode.window.showSaveDialog({
    defaultUri: folder ? vscode.Uri.joinPath(folder, templateFile(title, "diagram")) : undefined,
    filters: { "Diagram JSON": ["json"] },
    saveLabel: "Create",
    title: `New Diagram File: ${title}`,
  });
  if (!target) return undefined;
  const text = await diagramText(target, titled(doc, title));
  if (readText(text).state !== "diagram") {
    void vscode.window.showErrorMessage(`That isn't a diagram, so ${fileName(target)} wasn't written.`);
    return undefined;
  }
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
  await vscode.commands.executeCommand("vscode.openWith", target, VIEW_TYPE);
  return target;
}
