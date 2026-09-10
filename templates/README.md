# templates

Diagrams as plain `.json` files — the same `DiagramTemplate` / `SequenceTemplate`
shape that `Import`, the paste box, and the LLM all speak. Both folders are
listed under the example app's **Settings ▾ → Templates** while `npm run dev`
is running (the route lives in `example/vite-plugin-templates.js`, dev-only).

## `examples/` — curated, tracked

Templates worth keeping. The app can **read** these but never writes here:
loading one and editing it lands the edited copy in `scratch/`, and the
example stays as committed. Add one by dropping a file in (or copying it up
from `scratch/`); it appears the next time the menu opens.

## `scratch/` — auto-save, git-ignored

Where every open file is written as you work, one `.json` per workspace file,
debounced. Renaming a file renames the JSON and removes the old one; deleting a
file deletes it. It's rewritten on every session, which is exactly why it's
ignored — promote anything you want to keep into `examples/`.
