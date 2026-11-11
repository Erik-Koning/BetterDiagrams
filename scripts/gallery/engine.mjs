/**
 * The layout engine of one checkout, as a plain module node can import: the
 * contract (and the gallery fixtures, where that checkout has them) bundled
 * with the repo's rolldown. A checkout is the working tree or a worktree at a
 * git ref, so the same documents can be arranged by two versions of the code.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export async function loadEngine(checkout, outDir) {
  mkdirSync(outDir, { recursive: true });
  const src = join(checkout, "packages/better-diagrams/src/contract");
  const fixtures = join(src, "arrange.fixtures.ts");
  const lint = join(src, "layout-lint.ts");
  const entry = join(outDir, "entry.ts");
  writeFileSync(
    entry,
    `export * from ${JSON.stringify(join(src, "index.ts"))};\n` +
      (existsSync(fixtures) ? `export { ARRANGE_FIXTURES } from ${JSON.stringify(fixtures)};\n` : "") +
      // The linter's own constants, which the fit separates its cost by.
      (existsSync(lint) ? `export * as lintInternals from ${JSON.stringify(lint)};\n` : ""),
  );
  const file = join(outDir, "engine.mjs");
  const run = spawnSync(
    join(REPO, "node_modules/.bin/rolldown"),
    [entry, "--format", "esm", "--file", file, "--platform", "node", "--log-level", "silent"],
    { encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`bundling the engine in ${checkout} failed:\n${run.stderr || run.stdout}`);
  return import(`${pathToFileURL(file).href}?${Date.now()}`);
}
