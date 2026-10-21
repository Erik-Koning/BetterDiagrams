/**
 * format.ts — how a diagram is written: the way the repo it lands in writes
 * JSON.
 *
 * A diagram kept beside a project's code is reviewed like that code, so it
 * should come out of the editor already formatted the way the project's own
 * tools would format it — otherwise every save from the editor fights the
 * project's pre-commit hook, and every diff is noise. A file covered by a
 * Prettier config is formatted by Prettier with that config: its overrides,
 * its `.editorconfig`, and its `.prettierignore` all count, as they do for
 * Prettier's own CLI. The Prettier that does it is the repo's own, from its
 * node_modules, so the bytes match what its editor and its CI write; one
 * installed beside this package is the fallback. Without a config the file
 * is `JSON.stringify(doc, null, 2)` and a newline, as it always was.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** The parts of Prettier's API used here — the same in Prettier 2 and 3 (where they're async). */
interface Prettier {
  format(source: string, options: Record<string, unknown>): string | Promise<string>;
  resolveConfig(file: string, options?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  resolveConfigFile(file?: string): Promise<string | null>;
  getFileInfo(file: string, options?: Record<string, unknown>): Promise<{ ignored: boolean }>;
  clearConfigCache?(): unknown;
}

/** A diagram as the editor has always written it, where no formatter says otherwise. */
export const plainJson = (doc: unknown): string => `${JSON.stringify(doc, null, 2)}\n`;

const loaded = new Map<string, Promise<Prettier | null>>();

function load(specifier: string): Promise<Prettier | null> {
  let module = loaded.get(specifier);
  if (!module) {
    // A variable specifier: bundlers leave it alone, and so does tsc — Prettier is optional.
    module = import(/* @vite-ignore */ specifier)
      .then((m) => (m?.default?.format ? m.default : m) as Prettier)
      .then((p) => (typeof p?.format === "function" && typeof p.resolveConfigFile === "function" ? p : null))
      .catch(() => null);
    loaded.set(specifier, module);
  }
  return module;
}

/** The Prettier that formats `file`: the one installed where it lives, else the one beside this package. */
async function prettierFor(file: string): Promise<Prettier | null> {
  try {
    // Resolved the way Node resolves it from that folder: its node_modules, then its parents'.
    const entry = createRequire(join(dirname(file), "noop.js")).resolve("prettier");
    const own = await load(pathToFileURL(entry).href);
    if (own) return own;
  } catch {
    // Not installed where the file lives.
  }
  return load("prettier");
}

/** The nearest `.prettierignore` from `from` up to `to` (inclusive), as Prettier's CLI would read one. */
function ignoreFile(from: string, to: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, ".prettierignore");
    if (existsSync(candidate)) return candidate;
    if (dir === to || dirname(dir) === dir) return undefined;
  }
}

export interface FormatOptions {
  /** Told once per config file when Prettier fails on it; the plain text is written instead. */
  warn?: (message: string) => void;
}

const warned = new Set<string>();

/**
 * The text to write for `doc` at `file` (the file's real path — where it
 * lives, not a link to it). Never throws: a Prettier that can't be loaded,
 * or fails on the config, falls back to plain JSON.
 */
export async function formatDiagram(file: string, doc: unknown, { warn }: FormatOptions = {}): Promise<string> {
  const plain = plainJson(doc);
  const prettier = await prettierFor(file);
  if (!prettier) return plain;
  let configFile: string | null = null;
  try {
    // A config edited while the server runs counts on the next save.
    await prettier.clearConfigCache?.();
    configFile = await prettier.resolveConfigFile(file);
    if (!configFile) return plain;
    const ignorePath = ignoreFile(dirname(file), dirname(configFile));
    if (ignorePath && (await prettier.getFileInfo(file, { ignorePath })).ignored) return plain;
    const options = (await prettier.resolveConfig(file, { editorconfig: true })) ?? {};
    // Fed the expanded form: Prettier keeps an object broken over lines when
    // its source was, so each key stays on a line of its own and a diff stays
    // one line per change — and the result is what `prettier --write` keeps.
    return await prettier.format(plain, { ...options, filepath: file });
  } catch (error) {
    const key = configFile ?? file;
    if (!warned.has(key)) {
      warned.add(key);
      warn?.(`Prettier couldn't format ${file} with ${configFile ?? "its config"} (${(error as Error)?.message ?? error}) — writing plain JSON`);
    }
    return plain;
  }
}
