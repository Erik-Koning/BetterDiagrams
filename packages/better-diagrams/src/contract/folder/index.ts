/**
 * contract/folder — the folder format: a directory tree in, a document out,
 * and the diagram's own files back beside the tree.
 *
 * Pure: no `fs`, no React. `node.ts` is the Node adapter, on its own subpath
 * so a browser bundle never sees it.
 */
export { importFolder, detectDialect, dialectById, DIALECTS, validateOptionsFor } from "./import";
export { exportFolder, treeFiles } from "./export";
export { buildFolderTree, rerootTree, walkTree, normalizePath } from "./tree";
export {
  SIDECAR_DIR,
  LAYOUT_FILE,
  OVERRIDES_FILE,
  MANIFEST_FILE,
  validateOverrides,
  applyOverrides,
  collectOverrides,
} from "./sidecar";
export { genericDialect, GENERIC_DIALECT_ID, FOLDER_FORMAT, slugFolder } from "./dialects/generic";
export type { FolderManifest } from "./dialects/generic";
export {
  salesforceDialect,
  createSalesforceDialect,
  SALESFORCE_DIALECT_ID,
  SALESFORCE_KINDS,
  salesforceRegistry,
  parseFlatYaml,
  patchFlatYaml,
  classifySalesforceShape,
} from "./dialects/salesforce";
export type { SalesforceDialectOptions, SfShape, SfObjectSchema, SfField, SfForeignKey } from "./dialects/salesforce";
export { OVERRIDES_FORMAT } from "./types";
export type {
  Dialect,
  DialectRegistry,
  FolderExportOptions,
  FolderExportResult,
  FileMap,
  FolderEntry,
  FolderNode,
  FolderOverrides,
  FolderTree,
  FolderImportOptions,
  FolderImportResult,
  ImportStats,
  ImportWarning,
  ImportWarningCode,
  NodeBaseline,
  NodeOverride,
} from "./types";
