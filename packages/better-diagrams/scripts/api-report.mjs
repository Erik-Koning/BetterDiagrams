/**
 * The public API, as checked-in reports — one per package entry, in etc/.
 *
 *   npm run api:update   # after `npm run build`: rewrite etc/*.api.md
 *   npm run api:check    # in CI: fail when the built types differ from them
 *
 * api-surface.test.ts pins the exported NAMES; these pin the shapes — every
 * signature, prop and type — so a change to the API shows up as a diff a
 * reviewer reads, rather than as a consumer's broken build.
 */
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const check = process.argv.includes("--check");
const projectFolder = fileURLToPath(new URL("..", import.meta.url));
const ENTRIES = ["better-diagrams", "contract", "contract-folder-node", "server"];
const quiet = { logLevel: "none" };
mkdirSync(`${projectFolder}etc`, { recursive: true });

let failed = false;
for (const entry of ENTRIES) {
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder,
      mainEntryPointFilePath: `<projectFolder>/dist/${entry}.d.ts`,
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            jsx: "react-jsx",
            types: ["node"],
            strict: true,
            skipLibCheck: true,
          },
        },
      },
      apiReport: {
        enabled: true,
        reportFileName: `${entry}.api.md`,
        reportFolder: "<projectFolder>/etc/",
        reportTempFolder: "<projectFolder>/temp/api-report/",
      },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      messages: {
        compilerMessageReporting: { default: { logLevel: "warning" } },
        // The report is about shapes; release tags and doc-comment syntax
        // aren't used in this codebase.
        extractorMessageReporting: {
          default: { logLevel: "warning" },
          "ae-missing-release-tag": quiet,
          "ae-forgotten-export": quiet,
          "ae-internal-missing-underscore": quiet,
          "ae-undocumented": quiet,
          "ae-unresolved-link": quiet,
        },
        tsdocMessageReporting: { default: quiet },
      },
    },
    packageJsonFullPath: `${projectFolder}package.json`,
  });
  const result = Extractor.invoke(config, { localBuild: !check, showVerboseMessages: false });
  if (check && result.apiReportChanged) {
    console.error(`✗ ${entry}: the public API changed — run \`npm run api:update\` and review etc/${entry}.api.md`);
    failed = true;
  } else if (!result.succeeded) {
    console.error(`✗ ${entry}: ${result.errorCount} errors, ${result.warningCount} warnings`);
    failed = true;
  } else {
    console.log(`✓ ${entry}${result.apiReportChanged ? " (report updated)" : ""}`);
  }
}
process.exit(failed ? 1 : 0);
