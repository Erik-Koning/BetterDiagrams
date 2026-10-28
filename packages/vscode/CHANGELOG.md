# Changelog

## 0.1.0 (unreleased)

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
