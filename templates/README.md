# templates

Diagrams the example app auto-saves while you develop, one `.json` per open
file. Written by the dev-only route in `example/vite-plugin-templates.js`, so
this folder fills up under `npm run dev` and never in a production build.

Each file is a plain `DiagramTemplate` (or `SequenceTemplate`) — the same shape
`Import`, the paste box, and the LLM all speak. That means:

- **Hand-editing works.** Change a file here and it shows up in the app's
  Settings ▾ → *Saved templates* the next time that menu opens.
- **Dropping files in works.** Copy a template into this folder and it is
  listed alongside the rest.
- **Git works.** These are ordinary files: diff them, review them, commit the
  ones worth keeping.

The app is the authority while it is running: renaming a file renames the JSON,
and deleting a file deletes it. If you want a template kept out of that loop,
move it somewhere else in the repo.
