/**
 * The built editor `better-diagrams` serves must ship with the package: it is
 * built from the example app, outside this package, so `npm run build` here
 * doesn't make it. `npm run release` at the repo root does (`build:app`); a
 * publish from this folder without it would ship a command with no editor.
 */
import { existsSync } from "node:fs";

if (!existsSync(new URL("../app/index.html", import.meta.url))) {
  console.error("app/ is missing — run `npm run build:app` at the repo root (or publish with `npm run release` there).");
  process.exit(1);
}
