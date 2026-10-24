# Better Diagrams for VS Code

Open a Better Diagrams architecture or sequence diagram — the JSON a repo keeps beside its
code — in the same editor as the web app and the `better-diagrams` command: the same studio,
the same styling, the same default view (marketing cards, no minimap). Light or dark follows
VS Code's colour theme. Agents get the format and a check of what they wrote (see **Agents**).

The file's text in VS Code is the only copy. An edit in the diagram is one edit of the text, so
**⌘Z** and the toolbar's Undo and Redo, the dirty dot, **⌘S**, Save As, hot exit and source
control all work as they do for any file. Typing in the JSON (**Better Diagrams: Show JSON**
opens it beside the diagram), pulling a branch or an agent rewriting the file moves the picture
with it.

## Opening a diagram

- **Open With… → Better Diagrams** on any `.json` file, or **Open Diagram** from the explorer's
  context menu.
- A `.json` that is a diagram gets a button in its title bar: **Open Diagram to the Side**.
- **Better Diagrams: New Diagram File…** starts an empty one, titled after its name (as
  `better-diagrams --new` does). A file that is already there opens as it is, never written over.

To make it the default for a folder's diagrams, map them in your settings:

```json
"workbench.editorAssociations": {
  "**/docs/diagrams/*.json": "betterDiagrams.editor"
}
```

## What it keeps

- **Written the way the repo writes JSON.** Every edit is formatted for where the file lives,
  exactly as the `better-diagrams` command saves it: by the repo's own Prettier and its config
  (`.editorconfig` and `.prettierignore` count) when it has one, else
  `JSON.stringify(doc, null, 2)` and a newline. In an untrusted workspace the repo's Prettier
  isn't run, and edits are plain JSON.
- **Nothing is dropped without asking.** A key the editor doesn't know, or a value outside its
  vocabulary, loads fine but would be gone after an edit. The first edit that would drop
  something asks first; the full list goes to the **Better Diagrams** output. Undo brings it all
  back.
- **Never written over.** JSON that isn't a diagram (a `package.json`, say) shows why and is
  never edited. While the JSON is half-typed the last good picture stays up, read-only.
- **Opening a file never changes it.** Only what follows your own input in the diagram is
  written.
- A file VS Code can't write (an old revision from git, a read-only file system) is shown, never
  edited.

Exports (PNG, SVG, PDF, HTML, Mermaid, …) ask where to save, beside the diagram to begin with.
A node linked with `file:Name` opens the diagram called that in the same folder (`Name.json`,
`name.json` as the web app names it, or one titled `Name`).

## Agents

An agent writing a diagram needs the format, and a way to check what it wrote. Both are the
editor's own: the format is the prompt the editor's **Copy Schema & System Prompt** button copies
(with the same extra node kinds), and the check is how the editor reads a file as it opens it,
plus the diagram's **Checks**.

- **Agents in VS Code's chat** (Copilot's agent mode, or any extension that calls
  `vscode.lm.invokeTool`) get two tools, which they use unasked or when you name them:
  - `#betterDiagramsSchema`: the format. It takes `kind` (`architecture`, `tasks` or
    `sequence`), `clouds` (`aws`, `azure`, `gcp`: their component kinds join the vocabulary),
    `geometry: false` (no positions; the editor lays it out) and `file`: an existing diagram,
    which tailors the format to its kind and the clouds it uses.
  - `#betterDiagramsValidate`: a check of a `file` (as VS Code has it, unsaved edits included)
    or of `json` text. It says whether the file opens, what the editor would repair or drop
    (unknown keys, values outside the vocabulary, edges to nothing) and lists the Checks.
- **Agents that read files** (Claude Code, Codex, Cursor): **Better Diagrams: Add Agent
  Instructions…** writes the format into the repo (`docs/better-diagrams.md` to begin with,
  with the clouds you pick) and adds a short pointer to it to `AGENTS.md`, `CLAUDE.md` or
  `.github/copilot-instructions.md`, whichever you choose. Nothing else in those files changes,
  and running it again refreshes the file and leaves a single pointer. It never writes over a
  file it didn't write. A script can skip the questions:
  `executeCommand("betterDiagrams.addAgentInstructions", { clouds, target, pointers })`.

## Settings

| Setting | Default | |
|---|---|---|
| `betterDiagrams.theme` | `auto` | `auto` follows VS Code's light or dark; `light` or `dark` pins one. |

## Developing

The extension lives in `packages/vscode` of the
[Better Diagrams](https://github.com/Erik-Koning/BetterDiagrams) repo. Its webview renders the
library's `ArchitectureStudio` and `SequenceStudio` from source, with the web app's own document
handling (`example/src/documents.js`: registry, validation, loss report, default view), so a
diagram reads and renders the same in the browser and here.

```bash
npm run build          # dist/extension.cjs and dist/webview.{js,css}
npm test               # the sync rules and the agent text (Vitest)
npm run test:webview   # the webview, built, in Chromium under its own CSP (Playwright)
npm run test:vscode    # the extension in a real VS Code window, with a throwaway profile
npm run package        # better-diagrams.vsix — `code --install-extension better-diagrams.vsix`
```

After a build, **F5** with `packages/vscode` open in VS Code runs it in an Extension Development Host.

## Publishing

A tag publishes it, never a working tree: `vscode-v<version>` (the version in this
`package.json`) runs `.github/workflows/release-vscode.yml`, which runs the repo's CI on the tagged
commit, packages the `.vsix` once, and — as you approve each store's environment — publishes that
file to [Open VSX](https://open-vsx.org) (where Cursor, Windsurf and VSCodium install from) and the
[VS Code Marketplace](https://marketplace.visualstudio.com), and attaches it to a GitHub Release.
Run by hand on `main`, the workflow rehearses: each store's sign-in is checked, nothing is published.

```bash
git tag vscode-v0.1.0 && git push origin vscode-v0.1.0
```

It publishes as `mosphere`. Once, before the first release:

1. **GitHub.** Environments `openvsx` and `vscode-marketplace`, each with you as a required
   reviewer and deployments allowed from `main` and `vscode-v*` tags.
2. **Open VSX.** An eclipse.org account with the Publisher Agreement signed; an access token
   from open-vsx.org → Settings → Access Tokens, saved as the `openvsx` environment's secret
   `OVSX_PAT`; then `OVSX_PAT=… npx ovsx create-namespace mosphere`, and claim the namespace
   (until it's claimed, anyone can publish into it).
3. **Marketplace.** The `mosphere` publisher at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage). It signs in
   with Microsoft Entra ID, not a token (global Azure DevOps PATs end on 1 December 2026): an
   Azure user-assigned managed identity with a federated credential for
   `repo:Erik-Koning/BetterDiagrams:environment:vscode-marketplace`, added to the publisher as a
   Contributor, its client and tenant IDs in the environment's variables `AZURE_CLIENT_ID` and
   `AZURE_TENANT_ID`. If the Marketplace won't take that sign-in for your publisher, upload the
   GitHub Release's `.vsix` on the manage page instead — no token either way.
