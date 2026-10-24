#!/usr/bin/env node
/**
 * Runs test/vscode/suite.cjs inside a real VS Code, with this extension
 * loaded from the folder (built first: `npm run build`) and a throwaway
 * profile and workspace.
 *
 *   npm run test:vscode
 *   VSCODE_PATH=/path/to/code-executable npm run test:vscode
 *
 * VS Code is found at its usual macOS place, else VSCODE_PATH. It opens a
 * window of its own while the suite runs.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../..", import.meta.url));
const suite = fileURLToPath(new URL("./suite.cjs", import.meta.url));
const executable =
  process.env.VSCODE_PATH ??
  ["/Applications/Visual Studio Code.app/Contents/MacOS/Code", "/Applications/Visual Studio Code.app/Contents/MacOS/Electron"].find(existsSync);
if (!executable || !existsSync(executable)) {
  console.error("test:vscode: no VS Code found — set VSCODE_PATH to its executable.");
  process.exit(2);
}
if (!existsSync(join(extension, "dist", "extension.cjs"))) {
  console.error("test:vscode: the extension isn't built — run `npm run build` first.");
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), "bd-vscode-"));
const workspace = join(root, "workspace");
const user = join(root, "user");
mkdirSync(workspace);
mkdirSync(join(user, "User"), { recursive: true });
const write = (file, value) => writeFileSync(join(workspace, file), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
write("shop.json", {
  version: 1,
  meta: { title: "Shop" },
  nodes: [
    { id: "web", label: "Storefront", kind: "service", x: 0, y: 0 },
    { id: "api", label: "Orders API", kind: "service", x: 320, y: 0 },
  ],
  edges: [{ id: "e1", source: "web", target: "api" }],
});
write("settings.json", { "editor.tabSize": 2 });
// What a node's `file:` link names: by the web app's file name, and by title.
const lone = (title) => ({ version: 1, meta: { title }, nodes: [{ id: "a", label: title, kind: "service", x: 0, y: 0 }], edges: [] });
write("order-flow.json", lone("Order flow"));
write("billing.json", lone("Card payments"));
// The repo's own formatting, which an edit must follow.
write(".prettierrc", { useTabs: true });
writeFileSync(
  join(user, "User", "settings.json"),
  JSON.stringify({
    "security.workspace.trust.enabled": false,
    "workbench.startupEditor": "none",
    "update.mode": "none",
    // No chat input holding the focus: it would take the suite's undo.
    "chat.disableAIFeatures": true,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
  }),
);

// Nothing from a VS Code this shell may be running inside: its IPC hooks would hand the run to that window.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VSCODE_") && !key.startsWith("ELECTRON_")));
const child = spawn(
  executable,
  [
    workspace,
    `--extensionDevelopmentPath=${extension}`,
    `--extensionTestsPath=${suite}`,
    `--user-data-dir=${user}`,
    `--extensions-dir=${join(root, "extensions")}`,
    "--disable-extensions",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    "--new-window",
  ],
  { env, stdio: "inherit" },
);
child.on("exit", (code, signal) => {
  rmSync(root, { recursive: true, force: true });
  process.exit(signal ? 1 : (code ?? 1));
});
