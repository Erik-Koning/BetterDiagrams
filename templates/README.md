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

Seven ship:

- `multi-cloud-deployment`: zones and provider toggles.
- `order-flow`: a sequence.
- `bakery-data-model`: entities, fields, and key paths.
- `task-flow`: a work plan, with tasks carrying points, assignees and done
  checks, prerequisite arrows, and hover-only dependencies.
- `project-process`: a project run as phases. Four phase frames (Discover →
  Design → Build → Launch) hold the tasks that flow down them, with arrows
  crossing between phases.
- `roadmap`: a dated plan, arranged by date on a calendar under a ruler.
- `charity-phases`: phases and gates, not dates. Three phase frames stacked
  top to bottom, joined by milestone gates; each card's team badge is the
  track that owns it, and a plain text note under each header stands in for
  a subtitle.

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

Its `.json` diagrams appear under **Linked / tracker** in the menu — at any
depth, by their path in it (`docs/architecture/BetterDiagram.json`) — and are
live like `examples/`: edits in the app save back to the original file, and
edits made there (by an editor, a script, an agent working in that project)
reload in the app. In a git work tree the listing is what git calls the
project, so whatever its `.gitignore` leaves out stays out. The app never
deletes a file in a linked folder, never recreates a linked folder that has
gone, never writes outside it, and never writes over a JSON file that isn't a
diagram: a `package.json` beside the diagram isn't listed at all (the menu
counts it under the folder).

Saves are written the way that repo writes JSON: by its own Prettier, with its
config, when it has one (see the main README).

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
recreate the file. **Re-link…** — on the save warning, or beside the link in
the menu — points the link at where the file is now; the link keeps its name,
so what was open from it syncs again (asking first if your copy and the file
differ). A link made by hand
(`ln -s ~/work/tracker/plan.json templates/symlinks/`) works the same.

A file opened through a link answers to the file the link pointed at, not to
the link's name: if a link goes (a `git clean -X` takes this folder) and
another file of the same name is linked later, the copy that was open from the
first one stops syncing rather than writing into the second.

**Save as…** (the editor's file menu, `⇧⌘S`) makes links here too: it writes
the open file wherever the system's save dialog says — another repo, say — and
links it as if it had been opened from there. Saved into a linked folder, it is
bound there instead. **New file on disk…** (beside Link a file on disk…) does
the same with a blank diagram, for a file that isn't there yet; a name picked
that is there already is linked as it is, never written over.
