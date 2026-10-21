/**
 * pick.ts — the operating system's own folder, file and save dialogs.
 *
 * A browser's pickers never tell the page where a folder or a file IS — but
 * the disk store runs on the same machine as the person using it, so it can
 * ask instead and get a real path back. macOS asks through `osascript`, Linux
 * through `zenity`; elsewhere there is no dialog and the app asks for a typed
 * path, or says so.
 */
import { exec, execFile, type ExecException } from "node:child_process";
import { platform } from "node:os";
import { nearestDir } from "./files";

/** `file` picks a diagram JSON to link; `open` any file, for Open file…, which reads more than JSON. */
export type PickKind = "folder" | "file" | "open" | "save";

export type PickResult = { path: string } | { cancelled: true } | { unsupported: true };

export interface PickRequest {
  /** The dialog's prompt. */
  prompt: string;
  /** Open in the nearest existing folder at or above this path. */
  near?: string;
  /** For a save dialog: the file name it suggests. */
  name?: string;
}

/**
 * The command standing in for each dialog — the e2e suite's, since no dialog
 * can be clicked in a headless run. It prints the path it "picked"; a save
 * stand-in reads the suggested name and folder from BD_PICK_NAME and BD_PICK_NEAR.
 * `none` stands for no dialog at all, as on a machine without one.
 */
export const PICKER_ENV: Record<PickKind, string> = {
  folder: "BD_FOLDER_PICKER",
  file: "BD_FILE_PICKER",
  open: "BD_OPEN_PICKER",
  save: "BD_SAVE_PICKER",
};

/** A stand-in that says there is no such dialog here. */
const NO_DIALOG = "none";

/** Can this machine show that dialog? */
export const canPick = (what: PickKind, env: NodeJS.ProcessEnv = process.env): boolean =>
  env[PICKER_ENV[what]] === NO_DIALOG ? false : Boolean(env[PICKER_ENV[what]]) || platform() === "darwin" || platform() === "linux";

/** The dialog waits on a person; give up only on one long since walked away from. */
const PICK_TIMEOUT_MS = 10 * 60_000;

const appleString = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

interface Ran {
  error: ExecException | null;
  stdout: string;
  stderr: string;
}

/** Show a dialog. Resolves to the picked path, `{ cancelled }`, or `{ unsupported }`. */
export function pick(what: PickKind, { prompt, near, name }: PickRequest, env: NodeJS.ProcessEnv = process.env): Promise<PickResult> {
  const start = near ? nearestDir(near) : null;
  const run = (command: string, args?: string[], extraEnv?: NodeJS.ProcessEnv) =>
    new Promise<Ran>((done) => {
      const finish = (error: ExecException | null, stdout: unknown, stderr: unknown) =>
        done({ error, stdout: String(stdout ?? "").trim(), stderr: String(stderr ?? "") });
      const options = { timeout: PICK_TIMEOUT_MS, env: { ...env, ...extraEnv } };
      if (args) execFile(command, args, options, finish);
      else exec(command, options, finish);
    });
  const picked = ({ error, stdout }: Ran, cancelled: (error: ExecException) => boolean): PickResult => {
    if (error) {
      if (cancelled(error)) return { cancelled: true };
      throw new Error(`The ${what} dialog failed: ${error.message}`);
    }
    return stdout ? { path: stdout } : { cancelled: true };
  };

  const standIn = env[PICKER_ENV[what]];
  if (standIn === NO_DIALOG) return Promise.resolve({ unsupported: true });
  if (standIn) return run(standIn, undefined, { BD_PICK_NAME: name ?? "", BD_PICK_NEAR: start ?? "" }).then((r) => picked(r, () => false));
  if (platform() === "darwin") {
    // `activate` brings osascript's own dialog to the front — it would
    // otherwise open behind the browser that asked for it.
    const location = start ? ` default location (POSIX file ${appleString(start)})` : "";
    const script =
      what === "file"
        ? `POSIX path of (choose file with prompt ${appleString(prompt)} of type {"public.json"}${location})`
        : what === "open"
          ? // Unfiltered: a .sql script has no type of its own to filter on.
            `POSIX path of (choose file with prompt ${appleString(prompt)}${location})`
          : what === "save"
            ? // The save panel asks before replacing a file that exists.
              `POSIX path of (choose file name with prompt ${appleString(prompt)}${name ? ` default name ${appleString(name)}` : ""}${location})`
            : `POSIX path of (choose folder with prompt ${appleString(prompt)}${location})`;
    return run("osascript", ["-e", "activate", "-e", script]).then((r) =>
      picked({ ...r, stdout: r.stdout.replace(/(.)\/$/, "$1") }, () => /-128/.test(r.stderr)),
    );
  }
  if (platform() === "linux") {
    const kind =
      what === "file"
        ? ["--file-selection", "--file-filter=Diagram JSON | *.json"]
        : what === "open"
          ? ["--file-selection", "--file-filter=Diagrams, schemas, CSV | *.json *.sql *.csv *.tsv", "--file-filter=All files | *"]
          : what === "save"
            ? ["--file-selection", "--save", "--confirm-overwrite", "--file-filter=Diagram JSON | *.json"]
            : ["--file-selection", "--directory"];
    const filename = start ? [`--filename=${start}/${what === "save" && name ? name : ""}`] : [];
    return run("zenity", [...kind, `--title=${prompt}`, ...filename]).then((r) =>
      (r.error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? { unsupported: true } : picked(r, (error) => error.code === 1),
    );
  }
  return Promise.resolve({ unsupported: true });
}
