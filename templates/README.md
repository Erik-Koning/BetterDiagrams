# templates

Diagrams as plain `.json` files — the same `DiagramTemplate` / `SequenceTemplate`
shape that `Import`, the paste box, and the LLM all speak. Both folders are
listed under the example app's **Settings ▾ → Templates** while `npm run dev`
is running (the route lives in `example/vite-plugin-templates.js`, dev-only).

**Files here are live.** Open one from the menu and it becomes its own
workspace file, bound to the file:

- Edits in the app save back to it within about a second.
- Edits made to it on disk, by any program, reload in the app straight away.
  The file on disk wins.
- An edit made while the app was closed is picked up at startup.

## `examples/` — curated, tracked

Templates worth keeping. Opening one and editing it in the app saves those
edits back here, so they show in `git diff` like any other change. Add one by
dropping a file in (or copying it up from `scratch/`); it appears the next time
the menu opens. The app never deletes a file here.

Five ship:

- `multi-cloud-deployment`: zones and provider toggles.
- `order-flow`: a sequence.
- `bakery-data-model`: entities, fields, and key paths.
- `task-flow`: a work plan, with tasks carrying points, assignees and done
  checks, prerequisite arrows, and hover-only dependencies.
- `project-process`: a project run as phases. Four phase frames (Discover →
  Design → Build → Launch) hold the tasks that flow down them, with arrows
  crossing between phases.

Every architecture here is also a round-trip case in
`folder/generic.test.ts` — it must survive export → import unchanged, so a file
dropped in has to be a document the folder format can carry.

`bakery-data-model.json` is `folders/datamodel/` as the importer reads it
today, not a hand-edited file. Regenerate it rather than patching it when the
tree or the dialect changes.

## `scratch/` — auto-save, git-ignored

Where a file made in the app is written as you work, one `.json` per workspace
file, debounced. Renaming such a file renames the JSON and removes the old one;
deleting a file deletes it. Scratch files are live like any other here: edit
one on disk and the open app reloads it. The folder is git-ignored because it
changes on every edit, so promote anything you want to keep into `examples/`.

## Linked folders — outside the repo

A diagram that belongs to another project can stay there. Link its folder from
**Settings → Templates → Link a folder…**: type the path, or press **Browse…**
for the system's folder dialog (the dev server shows it, so it learns the real
path). Links are remembered in `linked.json` here, which is git-ignored. Or
name folders when starting the dev server:

```sh
BD_LINKED_DIRS=~/work/tracker npm run dev        # several: ~/work/tracker:~/notes
```

Its `.json` diagrams appear under **Linked / tracker** in the menu and are live
like `examples/`: edits in the app save back to the original file, and edits
made there (by an editor, a script, an agent working in that project) reload
in the app. The app never deletes a file in a linked folder, never recreates a
linked folder that has gone, and never writes over a JSON file that isn't a
diagram: a `package.json` beside the diagram is listed but can't be opened.

If the folder moves, the files bound to it stop syncing and a warning says so;
**Re-link…** points them at the folder's new place, and asks before choosing
between your edits and the file when the two differ.

## `symlinks/` — single files from other folders, git-ignored

Linking a whole folder lists everything in it. To bring in one diagram that
lives elsewhere — one an agent wrote in another project, say — use **Link a
file on disk…**: on the welcome modal of a new file, in the editor's **Import**
menu, or under **Settings → Templates → Link a file…**. The dev server shows
the system's file dialog and makes a symlink to the pick here, named after the
file (a name another link holds gets a number).

The file opens bound to its link and is live like `examples/`: edits in the
app save through the link to the file itself, and edits made to the file where
it lives reload in the app. Picking a file the menu already lists (an example,
a linked folder's, or one linked before) just opens it.

**Unlink** beside a link in the menu removes the link, never the file. If the
file moves, its link is listed as missing and saves to it fail rather than
recreate the file; link it again from where it is now. A link made by hand
(`ln -s ~/work/tracker/plan.json templates/symlinks/`) works the same.
