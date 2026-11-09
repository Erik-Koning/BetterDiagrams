# Better Diagrams for VS Code

Open a Better Diagrams architecture or sequence diagram — the JSON a repo keeps beside its
code — in the same editor as the web app and the `better-diagrams` command: the same studio,
the same styling, the same default view (marketing cards, no minimap). Light or dark follows
VS Code's colour theme, or pick one (see **The Settings menu**). The AI panel draws and edits
with VS Code's own language models, and agents get the format and a check of what they wrote
(see **AI** and **Agents**).

The file's text in VS Code is the only copy. An edit in the diagram is one edit of the text, so
**⌘Z** and the toolbar's Undo and Redo, the dirty dot, **⌘S**, Save As, hot exit and source
control all work as they do for any file. Typing in the JSON (**Better Diagrams: Show JSON**
opens it beside the diagram), pulling a branch or an agent rewriting the file moves the picture
with it.

## Opening a diagram

- **Open With… → Better Diagrams** on any `.json` file, or **Open Diagram** from the explorer's
  context menu.
- A `.json` that is a diagram gets a button in its title bar: **Open Diagram to the Side**.
- **Better Diagrams: New Diagram File…** starts an empty one, architecture or sequence, titled
  after its name (as `better-diagrams --new` does). A file that is already there opens as it is,
  never written over. **New Diagram from Example…** starts from one of the web app's examples.

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

Where the web app opens a new workspace file, VS Code asks where to write one and opens it: an
import into a diagram that already has things in it, a sequence started from the welcome
screen, **Derive sequence**. **Import › Open file…** is VS Code's open dialog: a diagram opens in
its own tab, anything else (SQL, CSV, draw.io…) is read in. **Better Diagrams: Show JSON**
(**⌘L**) opens the text beside the diagram, and what's selected on the canvas is lit in it.

The canvas's shortcuts that VS Code also binds stay the canvas's while it has focus: **⌘K**
searches the diagram (rather than starting a chord — ⌘K then W would close the editors),
**⌘=**, **⌘−** and **⌘0** zoom the canvas rather than the window, **⇧⌘E** exports a PNG and
**⇧⌘G** ungroups. With focus anywhere else they are VS Code's as always.

## The Settings menu

The studio's toolbar has a **Settings** menu with what the web app keeps in its header:

- **Copy schema…**: the format for an AI agent, scoped to the clouds you tick (or the task-flow
  format). **Edit JSON…**: paste what an agent wrote, repaired and checked before it lands, or
  edit the whole document as text. **Derive sequence**: a new sequence file from the diagram's
  numbered connections (`seq`).
- **View**: light or dark (or follow VS Code), marketing or technical, gradients, minimap, lines
  on hover, the AI panel and the accent colour. These are VS Code settings (below), so they hold
  for every diagram and window. **Read-only** is this editor's alone.
- **Examples**: replace the diagram with the multi-cloud or plain example (⌘Z undoes it).

The title bar's ◐ button (**Better Diagrams: Toggle Light/Dark**) switches the theme too.

## AI

With a language model in VS Code — GitHub Copilot's, or any extension's that provides one — the
studio's **AI** button opens **Generate** and **Adjust with AI**, as in the web app. The requests
go to that model through VS Code (`vscode.lm`): there is no key to set, and the first one asks you
to allow Better Diagrams to use it. With more than one model, the panel's **Model** picker chooses
between them and keeps the choice in `betterDiagrams.aiModel`, which also takes a model's id, family
or name by hand; `betterDiagrams.ai: false` hides the panel.

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
| `betterDiagrams.presentation` | `marketing` | `marketing` (bigger type and icons, tucked-away labels) or `technical`. |
| `betterDiagrams.gradients` | `false` | Marketing's gradients, or one flat coat per card, on screen and in picture exports. |
| `betterDiagrams.minimap` | `false` | The overview in the canvas corner. |
| `betterDiagrams.linesOnHover` | `false` | Draw a connection only while the pointer is over a node it touches. |
| `betterDiagrams.accent` | (the theme's) | A hex colour for selection, focus and highlights. |
| `betterDiagrams.ai` | `true` | Offer the AI panel when VS Code has a language model. |
| `betterDiagrams.aiModel` | (the first) | The model the AI panel asks, by id, family or name. |

## Developing

The extension lives in `packages/vscode` of the
[Better Diagrams](https://github.com/Erik-Koning/BetterDiagrams) repo. Its webview renders the
library's `ArchitectureStudio` and `SequenceStudio` from source, with the web app's own document
handling (`example/src/documents.js`: registry, validation, loss report, default view), so a
diagram reads and renders the same in the browser and here.

```bash
npm run build          # dist/extension.cjs and dist/webview.{js,css}
npm test               # the sync rules, the agent text, settings, AI requests, JSON spans (Vitest)
npm run test:webview   # the webview, built, in Chromium under its own CSP (Playwright)
npm run test:vscode    # the extension in a real VS Code window, with a throwaway profile
npm run package        # better-diagrams.vsix — `code --install-extension better-diagrams.vsix`
```

After a build, **F5** with `packages/vscode` open in VS Code runs it in an Extension Development Host.

## Publishing

A version that isn't released yet publishes itself, never from a working tree: bump the version
in this `package.json` (and its CHANGELOG heading) and push it to `main`.
`.github/workflows/release-vscode.yml` runs the repo's CI on that commit, packages the `.vsix`
once, and publishes that file to the [VS Code Marketplace](https://marketplace.visualstudio.com)
and to [Open VSX](https://open-vsx.org) (where Cursor, Windsurf and VSCodium install from). Once
both have it, the commit is tagged `vscode-v<version>` with a GitHub Release carrying the `.vsix`.
A push whose version is already tagged publishes nothing; a release that failed part way is
finished by the next push, which skips a store that already has the version. Run by hand on
`main`, the workflow rehearses: the Open VSX sign-in is checked, nothing is published.

It publishes as `mosphere`. Once, before the first release:

1. **GitHub.** Environments `marketplace` and `openvsx`, deployments allowed from `main` only.
2. **Marketplace.** The `mosphere` publisher at
   [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage), signed in
   with a Microsoft account, and on its **Trusted Publishing** tab a policy for GitHub Actions:
   `Erik-Koning` / `BetterDiagrams`, workflow `release-vscode.yml`, environment `marketplace`. The
   workflow publishes with `vsce publish --oidc` (vsce 4.1.0 or later), no token.
3. **Open VSX.** An eclipse.org account with the Publisher Agreement signed; an access token
   from open-vsx.org → Settings → Access Tokens, saved as the `openvsx` environment's secret
   `OVSX_PAT`; then `OVSX_PAT=… npx ovsx create-namespace mosphere`, and claim the namespace
   (until it's claimed, anyone can publish into it).
