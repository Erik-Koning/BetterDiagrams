/**
 * The built editor `better-diagrams` serves must ship with the package: it is
 * built from the example app, outside this package, so `npm run build` here
 * doesn't make it. The release workflow builds it (`build:app`) before it
 * publishes, as `npm run release:dry` at the repo root does; a publish
 * without it would ship a command with no editor.
 */
import { existsSync } from "node:fs";

if (!existsSync(new URL("../app/index.html", import.meta.url))) {
  console.error("app/ is missing — run `npm run build:app` at the repo root first (`npm run release:dry` there does both).");
  process.exit(1);
}
