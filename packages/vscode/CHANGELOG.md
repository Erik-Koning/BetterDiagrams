# Changelog

## Unreleased

- A **Settings** menu in the studio's toolbar with what the web app keeps in its header: Copy
  schema (scoped to the clouds you tick), Edit JSON (paste what an AI agent wrote), Derive
  sequence, the examples, and View: light or dark or follow VS Code, marketing or technical,
  gradients, minimap, lines on hover, the AI panel, the accent colour, and read-only for the
  editor. The view switches are settings (`betterDiagrams.presentation`, `.gradients`,
  `.minimap`, `.linesOnHover`, `.accent`, `.ai`), so they hold for every diagram.
- **Toggle Light/Dark** (◐ in the editor's title bar), **Copy Schema**, **Derive Sequence…** and
  **New Diagram from Example…** commands; **New Diagram File…** asks architecture or sequence.
- The AI panel (Generate, Adjust with AI), answered by one of VS Code's language models, such as
  GitHub Copilot's: no key to set. The panel's **Model** picker chooses between VS Code's models and
  keeps the choice in `betterDiagrams.aiModel`.
- Where the web app opens a new workspace file, VS Code writes one where you pick and opens it:
  an import into a diagram with things in it (it used to replace the diagram), a sequence started
  from the welcome screen, a derived sequence. Import › Open file… is VS Code's open dialog.
- What's selected on the canvas is lit in the JSON beside it; **⌘L** opens the JSON (Show JSON).
- Fixed: the canvas's shortcuts that VS Code also binds did both. ⌘K started VS Code's chord, so
  searching the canvas for a word starting with w closed the editors (⌘K W); ⌘=, ⌘− and ⌘0
  zoomed the window as well; ⇧⌘E and ⇧⌘G opened the Explorer and Source Control. While the
  diagram has focus they are the canvas's alone.
- Lines that meet one side of a box enter it side by side, and stay put while the boxes at their
  other ends are dragged (the library's change).

## 0.1.1 — 2026-11-04

- Found by its name written as one word, BetterDiagrams, in the Marketplace, Open VSX and VS
  Code's Extensions view, and by better-diagrams, diagrams, data-model and erd.

## 0.1.0 — 2026-11-03

- The Better Diagrams custom editor for `.json` diagrams: architecture and sequence, in the web
  app's studio, styling and default view, with VS Code's text as the only copy.
- Open Diagram, Open Diagram to the Side, Show JSON, New Diagram File….
- The studio's toolbar Undo and Redo step VS Code's history of the text, as ⌘Z does: one history.
- Edits formatted the way the repo writes JSON; the first edit that would drop something asks;
  JSON that isn't a diagram is never written over.
- Exports save through VS Code's save dialog; `file:` links open the diagram they name, and a
  node's ↗ (or the inspector's) opens its web link the way VS Code opens any link.
- `betterDiagrams.theme`: follow VS Code's light or dark, or pin one.
- For agents: the `#betterDiagramsSchema` and `#betterDiagramsValidate` language model tools,
  and **Add Agent Instructions…**, which writes the format into the repo for agents that read
  files and points `AGENTS.md` / `CLAUDE.md` / `.github/copilot-instructions.md` at it.
- Needs VS Code 1.95 or later.
