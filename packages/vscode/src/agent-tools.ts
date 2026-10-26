/**
 * agent-tools.ts — agent.ts in VS Code. Two language model tools, which
 * Copilot's agent mode (and any extension calling vscode.lm.invokeTool) uses
 * when it needs them, or when a person names them with #: the format, and a
 * check of a file. And the Add Agent Instructions command, for agents that
 * read files instead of calling tools (Claude Code, Codex, Cursor): the
 * format written into the repo, with a pointer to it from the files those
 * agents read first.
 */
import { isAbsolute, posix } from "node:path";
import * as vscode from "vscode";
import {
  CLOUDS,
  DIAGRAM_KINDS,
  INSTRUCTIONS_MARK,
  checkDiagram,
  instructionsMarkdown,
  schemaAnswer,
  withPointer,
  type DiagramKind,
} from "./agent";

export const SCHEMA_TOOL = "get_better_diagrams_schema";
export const VALIDATE_TOOL = "validate_better_diagram";

/** The files agents read on their own, where the command can leave a pointer. */
const AGENT_FILES = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];

const CLOUD_LABELS: Record<(typeof CLOUDS)[number], string> = { aws: "AWS", azure: "Azure", gcp: "Google Cloud" };

interface SchemaInput {
  kind?: DiagramKind;
  clouds?: string[];
  geometry?: boolean;
  file?: string;
}

interface ValidateInput {
  file?: string;
  json?: string;
}

const answer = (text: string) => new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);

/** A URI or an absolute path as one; undefined for a path relative to the workspace. */
const fixedUri = (path: string) =>
  /^[a-z][a-z0-9+.-]+:\/\//i.test(path) ? vscode.Uri.parse(path) : isAbsolute(path) ? vscode.Uri.file(path) : undefined;

/**
 * Before a tool reads a file outside the workspace's folders, the person is
 * asked: inside them it reads what the agent could read anyway.
 */
function askToReadOutside(path: string | undefined) {
  const uri = path ? fixedUri(path) : undefined;
  if (!uri || vscode.workspace.getWorkspaceFolder(uri)) return {};
  return {
    confirmationMessages: {
      title: "Read a file outside the workspace?",
      message: new vscode.MarkdownString(`Better Diagrams will read \`${path}\` for the agent.`),
    },
  };
}

/** A file an agent named: a URI, an absolute path, or a path in one of the workspace's folders. */
async function resolveFile(path: string): Promise<vscode.Uri> {
  const fixed = fixedUri(path);
  const candidates = fixed ? [fixed] : (vscode.workspace.workspaceFolders ?? []).map((folder) => vscode.Uri.joinPath(folder.uri, path));
  for (const uri of candidates) {
    if (vscode.workspace.textDocuments.some((document) => document.uri.toString() === uri.toString())) return uri;
    try {
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {
      // Not in this folder.
    }
  }
  throw new Error(`There's no file at ${path}. Give a path in the workspace, or an absolute one.`);
}

/** A file's text as VS Code has it: an open document's, unsaved edits included, else what's on disk. */
async function textOf(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  if (open) return open.getText();
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

class SchemaTool implements vscode.LanguageModelTool<SchemaInput> {
  prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<SchemaInput>) {
    const what = options.input.kind === "sequence" ? "sequence diagram" : options.input.kind === "tasks" ? "task flow" : "diagram";
    return { invocationMessage: `Reading the Better Diagrams ${what} format`, ...askToReadOutside(options.input.file) };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<SchemaInput>) {
    const { kind, clouds, geometry, file } = options.input;
    if (kind !== undefined && !DIAGRAM_KINDS.includes(kind)) {
      throw new Error(`kind is one of ${DIAGRAM_KINDS.join(", ")}, not ${kind}.`);
    }
    let existing: unknown;
    if (file) {
      const text = await textOf(await resolveFile(file));
      try {
        existing = JSON.parse(text);
      } catch {
        // Not JSON (yet): the format, untailored, is still the answer.
      }
    }
    return answer(schemaAnswer({ kind, clouds, geometry, existing }));
  }
}

class ValidateTool implements vscode.LanguageModelTool<ValidateInput> {
  prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<ValidateInput>) {
    const name = options.input.file ? vscode.workspace.asRelativePath(options.input.file) : "the diagram";
    return { invocationMessage: `Checking ${name} as Better Diagrams reads it`, ...askToReadOutside(options.input.file) };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<ValidateInput>) {
    const { file, json } = options.input;
    if (json !== undefined) return answer(checkDiagram("The JSON", json));
    if (!file) throw new Error("Give the diagram's path as file, or its JSON text as json.");
    const uri = await resolveFile(file);
    return answer(checkDiagram(vscode.workspace.asRelativePath(uri), await textOf(uri)));
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** `uri`'s text with a pointer to `target` in it, as an edit a person can undo. Saved unless they had unsaved changes there. */
async function addPointer(uri: vscode.Uri, target: vscode.Uri): Promise<"saved" | "unsaved"> {
  const path = posix.relative(posix.dirname(uri.path), target.path);
  if (!(await exists(uri))) {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(withPointer("", path)));
    return "saved";
  }
  const document = await vscode.workspace.openTextDocument(uri);
  const dirty = document.isDirty;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), withPointer(document.getText(), path));
  await vscode.workspace.applyEdit(edit);
  if (dirty) return "unsaved";
  await document.save();
  return "saved";
}

/** What Add Agent Instructions would otherwise ask, given up front (from a script, an agent or a test). */
export interface InstructionsChoices {
  /** The workspace folder whose agents these are. */
  folder?: vscode.Uri;
  clouds?: string[];
  /** The instructions file. */
  target?: vscode.Uri;
  /** Files to point at it, relative to the folder: from AGENTS.md, CLAUDE.md, .github/copilot-instructions.md. */
  pointers?: string[];
}

/**
 * Better Diagrams: Add Agent Instructions… — the format, written into the
 * repo (docs/better-diagrams.md to begin with) for agents that read files,
 * and a pointer to it from the files they read on their own. Resolves with
 * the instructions file, or undefined when nothing was written.
 */
async function addAgentInstructions(choices: InstructionsChoices = {}): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder = choices.folder
    ? { uri: choices.folder }
    : folders.length > 1
      ? await vscode.window.showWorkspaceFolderPick({ placeHolder: "Which folder's agents?" })
      : folders[0];
  if (!folder) {
    if (!folders.length) void vscode.window.showInformationMessage("Open the repo's folder first: the instructions go in it.");
    return undefined;
  }
  const clouds =
    choices.clouds ??
    (
      await vscode.window.showQuickPick(
        CLOUDS.map((id) => ({ label: CLOUD_LABELS[id], id })),
        {
          canPickMany: true,
          title: "Which clouds do the diagrams here use?",
          placeHolder: "Their component kinds join the instructions. None is fine.",
        },
      )
    )?.map((cloud) => cloud.id);
  if (!clouds) return undefined;
  const target =
    choices.target ??
    (await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(folder.uri, "docs", "better-diagrams.md"),
      filters: { Markdown: ["md"] },
      saveLabel: "Write Instructions",
      title: "Agent Instructions for Better Diagrams",
    }));
  if (!target) return undefined;
  const name = vscode.workspace.asRelativePath(target);
  if ((await exists(target)) && !(await textOf(target)).startsWith(INSTRUCTIONS_MARK)) {
    void vscode.window.showErrorMessage(`${name} is there already and wasn't written by Better Diagrams, so it wasn't written over.`);
    return undefined;
  }
  await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(instructionsMarkdown(clouds)));

  let pointers = choices.pointers?.filter((path) => AGENT_FILES.includes(path));
  if (!pointers) {
    const present = await Promise.all(AGENT_FILES.map((path) => exists(vscode.Uri.joinPath(folder.uri, path))));
    const picked = await vscode.window.showQuickPick(
      AGENT_FILES.map((path, i) => ({
        label: path,
        description: present[i] ? "add a pointer" : "create it, with a pointer",
        // The ones the repo has; AGENTS.md when it has none.
        picked: present[i] || (path === "AGENTS.md" && !present.some(Boolean)),
      })),
      {
        canPickMany: true,
        title: `Point agents at ${name}?`,
        placeHolder: "Each gets a short pointer, and nothing else in it changes",
      },
    );
    pointers = picked?.map((item) => item.label) ?? [];
  }
  const unsaved: string[] = [];
  for (const path of pointers) {
    if ((await addPointer(vscode.Uri.joinPath(folder.uri, path), target)) === "unsaved") unsaved.push(path);
  }
  const pointed = pointers.length ? ` and pointed ${pointers.join(", ")} at it` : "";
  const pending = unsaved.length ? ` ${unsaved.join(", ")} had unsaved changes, so the pointer is there unsaved too.` : "";
  void vscode.window.showInformationMessage(`Wrote ${name}${pointed}.${pending}`, "Open").then((choice) => {
    if (choice === "Open") void vscode.window.showTextDocument(target);
  });
  return target;
}

export function registerAgentTools(): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.lm.registerTool(SCHEMA_TOOL, new SchemaTool()),
    vscode.lm.registerTool(VALIDATE_TOOL, new ValidateTool()),
    vscode.commands.registerCommand("betterDiagrams.addAgentInstructions", addAgentInstructions),
  );
}
