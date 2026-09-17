#!/usr/bin/env node
/**
 * bd-folder — the folder format from the command line.
 *
 *   bd-folder import <dir> [--out template.json] [--fields keys|visible|all]
 *                          [--edges business|all] [--poly collapse|in-model|none]
 *                          [--dialect salesforce-datamodel|generic]
 *   bd-folder export <template.json> <dir> [--mode sidecar|full] [--write-object-yaml]
 *   bd-folder check <dir>      import, re-export the sidecar, diff against what
 *                              is on disk; exit 1 on drift
 *
 * Runs against the built package (`npm run build` first when developing).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const contract = await import(new URL("../dist/contract.js", import.meta.url).href).catch(() => null);
const node = await import(new URL("../dist/contract-folder-node.js", import.meta.url).href).catch(() => null);
if (!contract || !node) {
  console.error("bd-folder: the package is not built — run `npm run build` in packages/better-diagrams first.");
  process.exit(2);
}
const { importFolder, exportFolder, buildFolderTree, SIDECAR_DIR } = contract;
const { readFolderToFileMap, writeFileMap } = node;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function printWarnings(warnings) {
  for (const w of warnings) console.error(`  ! ${w.code}${w.path ? ` (${w.path})` : ""}: ${w.message}`);
}

const usage = () => {
  console.error(
    [
      "usage:",
      "  bd-folder import <dir> [--out template.json] [--fields keys|visible|all] [--edges business|all] [--poly collapse|in-model|none] [--dialect id]",
      "  bd-folder export <template.json> <dir> [--mode sidecar|full] [--write-object-yaml]",
      "  bd-folder check <dir>",
    ].join("\n"),
  );
  process.exit(2);
};

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command] = positional;

async function importDir(dir, opts = {}) {
  const files = await readFolderToFileMap(resolve(dir));
  const result = importFolder(files, opts);
  return { files, result };
}

function importOptions() {
  return {
    ...(flags.fields ? { fields: flags.fields } : {}),
    ...(flags.edges ? { edges: flags.edges } : {}),
    ...(flags.poly ? { polymorphic: flags.poly } : {}),
    ...(flags.dialect ? { dialect: flags.dialect } : {}),
  };
}

if (command === "import") {
  const [, dir] = positional;
  if (!dir) usage();
  const { result } = await importDir(dir, importOptions());
  const text = `${JSON.stringify(result.template, null, 2)}\n`;
  if (flags.out) await writeFile(resolve(flags.out), text, "utf8");
  else process.stdout.write(text);
  console.error(
    `bd-folder: ${result.dialect} · ${result.stats.nodes} nodes · ${result.stats.edges} edges · ${result.stats.fields} fields · ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}`,
  );
  printWarnings(result.warnings);
} else if (command === "export") {
  const [, templatePath, dir] = positional;
  if (!templatePath || !dir) usage();
  const template = JSON.parse(await readFile(resolve(templatePath), "utf8"));
  const mode = flags.mode ?? undefined;
  // The source tree gives the sidecar an exact baseline; without one on disk
  // the export still works from the dialect's own reading of each node.
  let tree = null;
  try {
    tree = buildFolderTree(await readFolderToFileMap(resolve(dir)));
  } catch {
    tree = null;
  }
  const out = exportFolder(template, {
    ...(mode ? { mode } : {}),
    tree,
    writeObjectYaml: flags["write-object-yaml"] === true,
  });
  await writeFileMap(resolve(dir), out.files, out.deletions);
  console.error(`bd-folder: wrote ${out.files.size} file${out.files.size === 1 ? "" : "s"} (${out.mode}, ${out.dialect}) to ${dir}`);
  printWarnings(out.warnings);
} else if (command === "check") {
  const [, dir] = positional;
  if (!dir) usage();
  const { files, result } = await importDir(dir);
  const out = exportFolder(result.template, { mode: "sidecar", tree: buildFolderTree(files) });
  let drift = 0;
  for (const [path, content] of out.files) {
    if (!path.startsWith(`${SIDECAR_DIR}/`)) continue;
    const existing = files.get(path);
    if (existing === undefined) {
      console.error(`  missing: ${path}`);
      drift++;
    } else if (existing !== content) {
      console.error(`  differs: ${path}`);
      drift++;
    }
  }
  printWarnings(result.warnings);
  if (drift) {
    console.error(`bd-folder: ${drift} sidecar file${drift === 1 ? "" : "s"} out of date — run \`bd-folder export\``);
    process.exit(1);
  }
  console.error("bd-folder: sidecar up to date");
} else {
  usage();
}
