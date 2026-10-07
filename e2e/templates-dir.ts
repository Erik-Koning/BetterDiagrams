/**
 * The templates folder the e2e dev server uses instead of the repo's own —
 * `playwright.config.ts` hands it to the server as `BD_TEMPLATES_DIR`, and
 * the disk-sync spec writes its files here. Outside the repo, so a test run
 * can never leave a file in `templates/`.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_TEMPLATES_DIR = join(tmpdir(), "better-diagrams-e2e-templates");

/**
 * The folder the e2e dev server links from "outside the repo" — handed to it
 * as `BD_LINKED_DIRS`. It must exist before the server starts (a missing
 * linked folder is skipped, never created), so the Playwright config makes it.
 */
export const E2E_LINKED_DIR = join(tmpdir(), "better-diagrams-e2e-linked");

/** Where the e2e tests make folders to link from the menu, one per test. */
export const E2E_LINKS_ROOT = join(tmpdir(), "better-diagrams-e2e-links");

/**
 * What the dev server's "folder dialog" answers under test: no dialog can be
 * clicked in a headless run, so `BD_FOLDER_PICKER` is a command that prints
 * this path, as the real dialog would.
 */
export const E2E_PICK_DIR = join(tmpdir(), "better-diagrams-e2e-pick");

/**
 * What the dev server's "file dialog" answers under test — `BD_FILE_PICKER`
 * prints this path, as Link a file… expects the real dialog to.
 */
export const E2E_PICK_FILE = join(tmpdir(), "better-diagrams-e2e-pick-file", "picked-plan.json");
